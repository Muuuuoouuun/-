// 손동작 감도: 실제 손 사진 랜드마크(fixtures)를 MediaPipe 같은 잡음과 함께 여러 프레임률로 재생해
// 오판(떨림)과 반응 지연을 잰다. SENSITIVITY 값을 바꾸면 이 테스트가 그 효과를 보여 준다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHand, GestureTracker, SENSITIVITY, DEFAULT_SENSITIVITY, loadSensitivity, saveSensitivity, SENSITIVITY_KEY } from '../src/gestures.js';
import { WheelController } from '../src/wheel-controller.js';
import { ASPECT, POSES, partial, place, noisy, rng } from './gesture-sim.mjs';

const frame = (lm, r, x = 0.5, y = 0.5) => { const n = noisy(place(lm, x, y), r); return n ? [analyzeHand(n, ASPECT)] : []; };

function borderlinePerMin(make, fps, seconds = 30) {
  let changes = 0;
  let total = 0;
  for (const amount of [0.28, 0.3, 0.32]) {
    const r = rng(17 + amount * 100);
    const t = make();
    let prev = null;
    for (let i = 0; i < seconds * fps; i++) {
      const s = t.update(frame(partial(amount), r), i * 1000 / fps);
      if (prev !== null && s.fingers !== prev) changes++;
      prev = s.fingers;
      total += 1000 / fps;
    }
  }
  return changes / (total / 60000);
}

function changeLatency(make, fps) {
  const lat = [];
  for (const [a, b] of [[5, 2], [2, 3], [3, 0], [0, 5], [1, 2]]) {
    for (let seed = 1; seed <= 3; seed++) {
      const r = rng(seed * 13 + a * 7 + b);
      const t = make();
      const hold = Math.round(1.5 * fps);
      for (let i = 0; i < hold; i++) t.update(frame(POSES[a], r), i * 1000 / fps);
      let got = null;
      for (let i = hold; i < hold + 2 * fps; i++) {
        const s = t.update(frame(POSES[b], r), i * 1000 / fps);
        if (s.fingers === b && got === null) got = (i - hold) * 1000 / fps;
        if (s.fingers !== b) got = null;
      }
      lat.push(got ?? 2000);
    }
  }
  lat.sort((x, y) => x - y);
  return lat[lat.length >> 1];
}

const make = (name) => () => new GestureTracker(SENSITIVITY[name].tracker);

test('감도: 가만히 든 손은 어느 설정·프레임률에서도 개수가 바뀌지 않는다', () => {
  for (const name of Object.keys(SENSITIVITY)) {
    for (const fps of [12, 30]) {
      for (const [want, lm] of Object.entries(POSES)) {
        const r = rng(97 + +want + fps);
        const t = make(name)();
        for (let i = 0; i < 8 * fps; i++) {
          const s = t.update(frame(lm, r), i * 1000 / fps);
          if (s.present) assert.equal(s.fingers, +want, `${name} ${fps}fps 손가락 ${want}`);
        }
      }
    }
  }
});

test('감도: 접힘 경계에 걸친 손가락도 깜빡이지 않고, 반응은 예전(hold 90ms)만큼 빠르다', () => {
  const legacy = () => new GestureTracker({ holdMs: 90, hysteresis: 0 });
  for (const fps of [12, 30]) {
    const old = borderlinePerMin(legacy, fps);
    const now = borderlinePerMin(make(DEFAULT_SENSITIVITY), fps);
    assert.ok(old > 8, `기준 재현: 예전 방식은 ${old.toFixed(1)}회/분 깜빡임 (${fps}fps)`);
    assert.ok(now < old / 4 && now < 2.5, `보통: ${now.toFixed(1)}회/분, 예전 ${old.toFixed(1)} (${fps}fps)`);
    assert.ok(changeLatency(make(DEFAULT_SENSITIVITY), fps) <= changeLatency(legacy, fps), `보통 반응 ${fps}fps`);
  }
  assert.ok(changeLatency(make('quick'), 30) < changeLatency(make('normal'), 30), '빠르게가 더 빠름');
  assert.ok(borderlinePerMin(make('stable'), 30) <= borderlinePerMin(make('normal'), 30), '안정적으로가 더 안정');
});

test('감도: 음량(손 높이)은 프레임률이 낮아도 빨리 따라가고, 멈추면 떨지 않는다', () => {
  for (const fps of [12, 30]) {
    const t = make(DEFAULT_SENSITIVITY)();
    const r = rng(6);
    for (let i = 0; i < fps; i++) t.update(frame(POSES[5], r, 0.5, 0.7), i * 1000 / fps);
    const from = (0.85 - 0.7) / 0.65;
    const to = (0.85 - 0.3) / 0.65;
    let resp = null;
    const values = [];
    for (let i = fps; i < 4 * fps; i++) {
      const s = t.update(frame(POSES[5], r, 0.5, 0.3), i * 1000 / fps);
      if (resp === null && s.level >= from + 0.9 * (to - from)) resp = (i - fps) * 1000 / fps;
      if (i > 2 * fps) values.push(s.level);
    }
    assert.ok(resp !== null && resp <= 170, `${fps}fps 90% 도달 ${resp}ms`);
    const mean = values.reduce((a, b) => a + b) / values.length;
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    assert.ok(std < 0.004, `${fps}fps 떨림 ${std}`);
  }
});

test('감도: 휠 OFF 경계 근처에 손을 두어도 소리가 끊기지 않고, 일부러 OFF 로 가면 바로 끈다', () => {
  const center = { x: 1, y: 1 };
  const at = (rad) => ({ x: center.x, y: center.y - rad });
  const run = (opts, rad, fps, seed) => {
    const c = new WheelController(opts);
    c.configure({ hands: 'one', counts: [8], centers: [center], radius: 1 });
    const r = rng(seed);
    let offs = 0;
    let armed = false;
    for (let i = 0; i < 12 * fps; i++) {
      const s = r.u() < 0.03 ? 0.045 : 0.012;
      const p = at(rad);
      const st = c.update([{ palm: { x: p.x + r.g() * s, y: p.y + r.g() * s } }], i * 1000 / fps);
      if (st.active) armed = true;
      else if (armed && st.reason === 'off') { offs++; armed = false; }
    }
    return offs;
  };
  let legacy = 0;
  let tuned = 0;
  for (const seed of [1, 2, 3]) {
    legacy += run({}, 0.57, 30, seed);
    tuned += run(SENSITIVITY[DEFAULT_SENSITIVITY].wheel, 0.57, 30, seed);
  }
  assert.ok(legacy > 2, `기준 재현: 예전 방식 ${legacy}번 끊김`);
  assert.equal(tuned, 0, '보통 설정은 끊기지 않음');
  // 중앙 OFF 로 손을 옮기면 한 프레임 안에 꺼진다
  const c = new WheelController(SENSITIVITY[DEFAULT_SENSITIVITY].wheel);
  c.configure({ hands: 'one', counts: [8], centers: [center], radius: 1 });
  for (let i = 0; i <= 10; i++) c.update([{ palm: at(0.75) }], i * 33);
  assert.equal(c.state().active, true);
  const off = c.update([{ palm: at(0.05) }], 400);
  const off2 = off.active ? c.update([{ palm: at(0.05) }], 433) : off;
  assert.equal(off2.active, false);
});

test('감도 설정 저장: 알 수 없는 값·저장 실패에도 기본값으로 동작', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(loadSensitivity(storage), DEFAULT_SENSITIVITY);
  assert.equal(saveSensitivity(storage, 'quick'), true);
  assert.equal(store.get(SENSITIVITY_KEY), 'quick');
  assert.equal(loadSensitivity(storage), 'quick');
  assert.equal(saveSensitivity(storage, 'turbo'), false);
  store.set(SENSITIVITY_KEY, 'turbo');
  assert.equal(loadSensitivity(storage), DEFAULT_SENSITIVITY);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadSensitivity(broken), DEFAULT_SENSITIVITY);
  assert.equal(saveSensitivity(broken, 'stable'), false);
  assert.equal(loadSensitivity(null), DEFAULT_SENSITIVITY);
});
