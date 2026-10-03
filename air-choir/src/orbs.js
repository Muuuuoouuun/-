// 오브 모드: 핀치로 녹음 → 손 위에 오브 → 던지면 그 자리에서 루프
// 화면·오디오와 분리된 순수 로직. 오디오 동작은 생성자에 넘기는 audio 객체가 맡는다.
//   audio.capture(orb) → Promise   녹음 구간을 버퍼로 받아 orb.buffer에 넣는다
//   audio.play(orb) / audio.stop(orb) / audio.mix(orb)
// 시간 단위는 초(오디오 컨텍스트 시간), 좌표는 화면 기준 0~1 (y는 아래로 증가).

export const MAX_ORBS = 6;
export const MAX_BARS = 4;

export class Transport {
  constructor(bpm = 90, origin = 0, beatsPerBar = 4) {
    this.beatsPerBar = beatsPerBar;
    this.set(bpm, origin);
  }
  set(bpm, origin = this.origin) {
    this.bpm = bpm;
    this.origin = origin;
    this.beat = 60 / bpm;
    this.bar = this.beat * this.beatsPerBar;
  }
  // t + minGap 이후 첫 마디 시작 시각
  nextBar(t, minGap = 0) {
    const k = Math.ceil((t + minGap - this.origin) / this.bar - 1e-9);
    return this.origin + k * this.bar;
  }
  // 지금 몇 번째 박인지(0~3)와 박 안에서의 위치(0~1)
  position(t) {
    const beats = (t - this.origin) / this.beat;
    const whole = Math.floor(beats);
    return { beat: ((whole % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar, frac: beats - whole };
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 오브 반지름 (화면 높이 대비). 길수록 크다.
export const orbRadius = (bars) => 0.06 + 0.014 * bars;

// 위치 → 소리: 좌우는 패닝, 위로 갈수록 크게
export function orbMix(orb) {
  return {
    pan: clamp((orb.x - 0.5) * 2 * 0.9, -0.9, 0.9),
    gain: orb.muted ? 0 : 0.2 + 0.9 * clamp((0.9 - orb.y) / 0.8, 0, 1),
  };
}

export const THROW_SPEED = 1.6; // 화면 폭/초. 이보다 빠르게 휘두르면 던진 것으로 본다
export const MUTE_DWELL = 0.8; // 편 손을 오브 위에 이만큼 대고 있으면 음소거 전환
const HOLD_TIMEOUT = 4; // 던지지 않으면 이 시간 뒤 그 자리에 내려놓음

export class OrbStation {
  constructor({ transport, audio, maxOrbs = MAX_ORBS, maxBars = MAX_BARS }) {
    this.transport = transport;
    this.audio = audio;
    this.maxOrbs = maxOrbs;
    this.maxBars = maxBars;
    this.aspect = 16 / 9; // 무대 가로/세로. 원 판정에 쓴다
    // 오브가 머무를 수 있는 영역 (위쪽 HUD, 오른쪽 음량 게이지, 아래 밝기 바를 피한다). 앱이 화면에 맞게 고친다
    this.bounds = { x0: 0.03, x1: 0.92, y0: 0.2, y1: 0.88 };
    this.orbs = [];
    this.pops = []; // 터진 오브 애니메이션
    this.mode = 'idle'; // idle | countin | recording | finishing | holding | drag
    this.rec = null;
    this.held = null;
    this.drag = null;
    this.dwell = null;
    this.prev = { pinch: false, fist: false };
    this.lastPoint = { x: 0.5, y: 0.5 };
    this.lastNow = null;
    this.nextId = 1;
    this.listeners = {};
    this.message = null; // 화면에 잠깐 띄울 안내
  }

  on(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, data) {
    (this.listeners[type] || []).forEach((fn) => fn(data));
  }

  get count() {
    return this.orbs.length;
  }

  hit(point, scale = 1.25) {
    let best = null;
    let bd = Infinity;
    for (const o of this.orbs) {
      if (o.state !== 'placed') continue;
      const d = Math.hypot((o.x - point.x) * this.aspect, o.y - point.y);
      if (d < o.r * scale && d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  // g: GestureTracker.state() 결과
  update(g, now) {
    const dt = this.lastNow == null ? 0 : Math.min(0.1, Math.max(0, now - this.lastNow));
    this.lastNow = now;
    const present = !!g?.present;
    const pinch = present && !!g.pinch;
    const fist = present && !!g.fist;
    const point = present && g.screen ? g.screen.pinchPoint : null;
    const palm = present && g.screen ? g.screen.palm : null;
    if (palm) this.lastPoint = palm;
    const pinchStart = pinch && !this.prev.pinch;
    const fistStart = fist && !this.prev.fist;
    this.prev = { pinch, fist };
    const T = this.transport;

    switch (this.mode) {
      case 'idle':
        if (pinchStart && point) {
          const orb = this.hit(point);
          if (orb) {
            this.mode = 'drag';
            this.drag = { orb, dx: orb.x - point.x, dy: orb.y - point.y };
            this.emit('grab', orb);
          } else if (this.orbs.length >= this.maxOrbs) {
            this.say(`오브가 가득 찼어요 (최대 ${this.maxOrbs}개). 주먹으로 하나를 터뜨려 주세요`, now);
          } else {
            this.mode = 'countin';
            this.rec = { begin: T.nextBar(now, 2 * T.beat), asked: now };
            this.emit('countin', this.rec);
          }
        }
        break;

      case 'countin':
        if (!pinch) {
          this.mode = 'idle';
          this.rec = null;
          this.emit('cancel');
        } else if (now >= this.rec.begin) {
          this.mode = 'recording';
          this.emit('record', this.rec);
        }
        break;

      case 'recording': {
        const limit = this.rec.begin + this.maxBars * T.bar;
        if (!pinch || now >= limit) {
          this.rec.end = Math.min(limit, Math.max(this.rec.begin + T.bar, T.nextBar(now)));
          this.mode = 'finishing';
          this.emit('finishing', this.rec);
        }
        break;
      }

      case 'finishing':
        if (now >= this.rec.end) this.makeOrb(now);
        break;

      case 'holding': {
        const orb = this.held;
        if (present && palm) {
          orb.x = palm.x;
          orb.y = palm.y - orb.r * 0.9;
          this.keepInside(orb);
          const v = g.velocity || { x: 0, y: 0 };
          const speed = Math.hypot(v.x, v.y / this.aspect);
          if (speed > THROW_SPEED && now - this.heldSince > 0.15) {
            orb.vx = v.x * 0.4;
            orb.vy = v.y * 0.4;
            orb.state = 'flying';
            this.release();
            this.emit('throw', orb);
          } else if (pinchStart) {
            this.place(orb); // 핀치하면 그 자리에 내려놓기
            this.release();
          }
        } else {
          this.place(orb); // 손이 사라지면 마지막 자리에
          this.release();
        }
        if (this.held && now - this.heldSince > HOLD_TIMEOUT) {
          this.place(orb);
          this.release();
        }
        break;
      }

      case 'drag': {
        const orb = this.drag.orb;
        if (!pinch || !point || !this.orbs.includes(orb)) {
          this.mode = 'idle';
          this.drag = null;
          this.emit('drop', orb);
        } else {
          orb.x = point.x + this.drag.dx;
          orb.y = point.y + this.drag.dy;
          this.keepInside(orb);
          this.audio.mix(orb);
        }
        break;
      }
    }

    // 오브 위에서 주먹 → 터뜨리기, 편 손을 대고 있기 → 음소거 전환
    if (this.mode === 'idle' && palm) {
      if (fistStart) {
        const orb = this.hit(palm, 1.4);
        if (orb) this.pop(orb, now);
      }
      const open = !pinch && !fist && g.fingers >= 4;
      const under = open ? this.hit(palm, 1.2) : null;
      if (!under) this.dwell = null;
      else if (!this.dwell || this.dwell.orb !== under) this.dwell = { orb: under, since: now, done: false };
      else if (!this.dwell.done && now - this.dwell.since >= MUTE_DWELL) {
        under.muted = !under.muted;
        this.audio.mix(under);
        this.dwell.done = true;
        this.emit('mute', under);
      }
    } else {
      this.dwell = null;
    }

    this.physics(dt);
    this.pops = this.pops.filter((p) => now - p.t < 0.5);
    if (this.message && now - this.message.t > 2.5) this.message = null;
  }

  makeOrb(now) {
    const { begin, end } = this.rec;
    const bars = Math.max(1, Math.round((end - begin) / this.transport.bar));
    const orb = {
      id: this.nextId++,
      bars,
      begin,
      len: end - begin,
      r: orbRadius(bars),
      x: this.lastPoint.x,
      y: this.lastPoint.y,
      vx: 0,
      vy: 0,
      state: 'held', // held | flying | placed
      muted: false,
      ready: false,
      midi: null,
      born: now,
    };
    this.orbs.push(orb);
    this.rec = null;
    this.mode = 'holding';
    this.held = orb;
    this.heldSince = now;
    this.emit('orb', orb);
    Promise.resolve(this.audio.capture(orb)).then(
      () => {
        orb.ready = true;
        if (orb.state === 'placed' && this.orbs.includes(orb)) this.audio.play(orb);
      },
      () => {
        this.remove(orb);
        this.say('녹음을 가져오지 못했어요. 다시 해 주세요', now);
      },
    );
  }

  // 오브를 영역 안으로. 벽에 닿았는지 돌려준다
  keepInside(o) {
    const b = this.bounds;
    const rx = o.r / this.aspect;
    const x = clamp(o.x, b.x0 + rx, b.x1 - rx);
    const y = clamp(o.y, b.y0 + o.r, b.y1 - o.r);
    const hit = { x: x !== o.x, y: y !== o.y };
    o.x = x;
    o.y = y;
    return hit;
  }

  release() {
    this.held = null;
    this.mode = 'idle';
  }

  place(orb) {
    orb.state = 'placed';
    orb.vx = orb.vy = 0;
    this.audio.mix(orb);
    if (orb.ready) this.audio.play(orb);
    this.emit('place', orb);
  }

  physics(dt) {
    if (!dt) return;
    const damp = Math.exp(-3.2 * dt);
    for (const o of this.orbs) {
      if (o.state !== 'flying') continue;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      const hit = this.keepInside(o);
      if (hit.x) o.vx = -o.vx * 0.5;
      if (hit.y) o.vy = -o.vy * 0.5;
      o.vx *= damp;
      o.vy *= damp;
      if (Math.hypot(o.vx, o.vy) < 0.06) this.place(o);
    }
  }

  pop(orb, now) {
    this.pops.push({ x: orb.x, y: orb.y, r: orb.r, midi: orb.midi, t: now });
    this.remove(orb);
    this.emit('pop', orb);
  }

  remove(orb) {
    this.audio.stop(orb);
    this.orbs = this.orbs.filter((o) => o !== orb);
    if (this.held === orb) this.release();
    if (this.drag?.orb === orb) {
      this.drag = null;
      this.mode = 'idle';
    }
  }

  clear() {
    for (const o of [...this.orbs]) this.remove(o);
    this.mode = 'idle';
    this.rec = null;
  }

  say(text, now) {
    this.message = { text, t: now };
    this.emit('message', text);
  }
}
