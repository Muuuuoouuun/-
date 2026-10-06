// 손 랜드마크(MediaPipe 21점) → 손가락 개수 · 주먹 · 높이 · 좌우 위치
// 화면이나 오디오에 의존하지 않는 순수 로직이라 Node에서 테스트한다.

// MediaPipe 랜드마크 번호
const WRIST = 0;
const THUMB = [1, 2, 3, 4]; // CMC, MCP, IP, TIP
const FINGERS = [
  [5, 6, 7, 8], // 검지  MCP, PIP, DIP, TIP
  [9, 10, 11, 12], // 중지
  [13, 14, 15, 16], // 약지
  [17, 18, 19, 20], // 새끼
];
const PALM = [0, 5, 9, 13, 17];

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
export const FINGER_TIPS = [4, 8, 12, 16, 20];

// 판정 기준값. test/gestures.test.mjs가 실제 손 사진 랜드마크로 검증한다.
export const THRESHOLDS = {
  fingerStraight: 0.55, // PIP 관절에서 손가락이 곧은 정도 (두 마디 방향의 cos)
  fingerReach: 1.12, // 손목→끝마디 거리 / 손목→PIP 거리
  thumbStraight: 0.7,
  thumbAway: 0.62, // 엄지 끝이 검지 뿌리에서 떨어진 정도 (손바닥 크기 대비)
  // 핀치(엄지 끝 + 검지 끝). 주먹도 두 끝이 가까워서(0.19) 거리만으로는 구분이 안 된다.
  // 주먹은 검지 끝이 손바닥 쪽으로 말리고(0.71) 엄지 끝이 검지 뿌리에 붙는다(0.27).
  pinchOn: 0.32, // 이보다 가까우면 핀치 시작
  pinchOff: 0.5, // 이보다 멀어지면 핀치 끝 (사이 구간은 이전 상태 유지)
  pinchIndexReach: 0.85, // 검지 끝이 손바닥 쪽으로 말려 있지 않아야 함
  pinchThumbAway: 0.45, // 엄지가 뻗어 나와 있어야 함
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const dist = (a, b) => len(sub(a, b));
const cos = (a, b) => {
  const la = len(a);
  const lb = len(b);
  return la && lb ? (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb) : 0;
};

// MediaPipe 결과({x,y,z} 또는 [x,y,z])를 가로세로 비율이 맞는 좌표로 바꾼다.
// x, y는 이미지 폭·높이로 각각 0~1 정규화되어 있어서, 폭이 넓은 영상이면 x를 늘려야 실제 모양이 된다.
export function toPoints(landmarks, aspect = 1) {
  return landmarks.map((p) => {
    const x = Array.isArray(p) ? p[0] : p.x;
    const y = Array.isArray(p) ? p[1] : p.y;
    const z = Array.isArray(p) ? p[2] : p.z;
    return [x * aspect, y, z * aspect];
  });
}

export function analyzeHand(landmarks, aspect = 1, t = THRESHOLDS) {
  const p = toPoints(landmarks, aspect);
  const palmSize = dist(p[WRIST], p[9]);

  const extended = [];
  // scores: 손가락마다 판정 기준을 얼마나 넘었는지 (음수 = 접힘). 추적기가 히스테리시스에 쓴다.
  const scores = [];
  // 엄지: 마디가 곧고, 끝이 검지 뿌리에서 충분히 떨어져 있어야 편 것으로 본다
  const thumbStraight = cos(sub(p[THUMB[2]], p[THUMB[1]]), sub(p[THUMB[3]], p[THUMB[2]]));
  const thumbAway = dist(p[THUMB[3]], p[5]) / palmSize;
  extended.push(thumbStraight > t.thumbStraight && thumbAway > t.thumbAway);
  scores.push(Math.min(thumbStraight - t.thumbStraight, thumbAway - t.thumbAway));

  for (const [mcp, pip, , tip] of FINGERS) {
    const straight = cos(sub(p[pip], p[mcp]), sub(p[tip], p[pip]));
    const reach = dist(p[tip], p[WRIST]) / dist(p[pip], p[WRIST]);
    extended.push(straight > t.fingerStraight && reach > t.fingerReach);
    // 두 조건 중 더 아슬아슬한 쪽 (reach 는 범위가 좁아 3배로 맞춤)
    scores.push(Math.min(straight - t.fingerStraight, (reach - t.fingerReach) * 3));
  }

  const raised = extended.slice(1).filter(Boolean).length;
  const fingers = raised === 4 && extended[0] ? 5 : raised;

  // 핀치 판정 재료
  const pinchDist = dist(p[4], p[8]) / palmSize;
  const pinchShape = dist(p[8], p[WRIST]) / dist(p[6], p[WRIST]) > t.pinchIndexReach && thumbAway > t.pinchThumbAway;
  const raw = (i, k) => (Array.isArray(landmarks[i]) ? landmarks[i][k] : landmarks[i][k ? 'y' : 'x']);
  const pinchPoint = { x: (raw(4, 0) + raw(8, 0)) / 2, y: (raw(4, 1) + raw(8, 1)) / 2 };

  // 손바닥 중심 (원래 0~1 좌표)
  let cx = 0;
  let cy = 0;
  for (const i of PALM) {
    cx += Array.isArray(landmarks[i]) ? landmarks[i][0] : landmarks[i].x;
    cy += Array.isArray(landmarks[i]) ? landmarks[i][1] : landmarks[i].y;
  }
  cx /= PALM.length;
  cy /= PALM.length;

  return {
    extended,
    scores,
    fingers,
    fist: raised === 0 && !(pinchShape && pinchDist < t.pinchOff),
    palm: { x: cx, y: cy },
    size: palmSize,
    pinchDist,
    pinchShape,
    pinch: pinchShape && pinchDist < t.pinchOn,
    pinchPoint,
  };
}

// 손가락 개수 → 화음 구성 번호 (dsp.js의 PRESETS)
export const fingersToPreset = (n) => Math.max(0, Math.min(4, n));

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// One Euro 필터: 손이 멈춰 있으면 떨림을 강하게 거르고, 빨리 움직이면 지연을 줄인다.
// (Casiez et al. 2012) 프레임 수가 아니라 시간으로 계산하므로 카메라가 12fps 든 60fps 든 같은 느낌이다.
export class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, nowMs) {
    if (this.x === null || this.t === null || !(nowMs > this.t)) {
      if (this.x === null || this.t === null) {
        this.x = value;
        this.t = nowMs;
      }
      return this.x;
    }
    const dt = Math.min(0.5, (nowMs - this.t) / 1000);
    this.t = nowMs;
    const rawDx = (value - this.x) / dt;
    this.dx += (rawDx - this.dx) * OneEuro.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (value - this.x) * OneEuro.alpha(cutoff, dt);
    return this.x;
  }
}

// 손동작 감도. 'stable' 은 떨림·오판이 적고, 'quick' 은 반응이 빠르다.
// 값은 test/gesture-sensitivity.test.mjs 의 잡음 섞인 실제 손 랜드마크 재생으로 맞췄다.
export const SENSITIVITY = {
  stable: {
    label: '안정적으로',
    description: '손이 떨리거나 카메라가 느린 기기(휴대폰)에 좋아요. 오판이 가장 적고 반응은 조금 느려요.',
    tracker: { holdMs: 60, scoreMs: 50, hysteresis: 0.15, lostMs: 320, pinchOnMs: 80, pinchOffMs: 160, filter: { minCutoff: 0.8, beta: 1.2 } },
    wheel: { dwellMs: 160, lostMs: 320, hysteresis: 0.12, smoothing: { minCutoff: 1.0, beta: 0.4 } },
  },
  normal: {
    label: '보통',
    description: '대부분의 환경에 맞춘 기본값. 예전과 같은 빠르기로 반응하면서 흔들림은 훨씬 적어요.',
    tracker: { holdMs: 20, scoreMs: 35, hysteresis: 0.12, lostMs: 280, pinchOnMs: 60, pinchOffMs: 130, filter: { minCutoff: 1.4, beta: 2.0 } },
    wheel: { dwellMs: 120, lostMs: 280, hysteresis: 0.09, smoothing: { minCutoff: 1.6, beta: 0.7 } },
  },
  quick: {
    label: '빠르게',
    description: '밝고 빠른 카메라(노트북·30fps 이상)에서 가장 민첩해요. 경계에서 가끔 흔들릴 수 있어요.',
    tracker: { holdMs: 0, scoreMs: 20, hysteresis: 0.1, lostMs: 250, pinchOnMs: 40, pinchOffMs: 110, filter: { minCutoff: 2.4, beta: 3.5 } },
    wheel: { dwellMs: 90, lostMs: 250, hysteresis: 0.06, smoothing: { minCutoff: 2.6, beta: 1.2 } },
  },
};
export const DEFAULT_SENSITIVITY = 'normal';
export const SENSITIVITY_KEY = 'airchoir.gesture.v1';

export function loadSensitivity(storage) {
  try {
    const value = storage?.getItem(SENSITIVITY_KEY);
    return Object.hasOwn(SENSITIVITY, value) ? value : DEFAULT_SENSITIVITY;
  } catch {
    return DEFAULT_SENSITIVITY;
  }
}

export function saveSensitivity(storage, value) {
  if (!Object.hasOwn(SENSITIVITY, value)) return false;
  try {
    storage?.setItem(SENSITIVITY_KEY, value);
    return true;
  } catch {
    return false; // 개인 정보 보호 모드 등: 이번 세션에만 적용
  }
}

// 프레임마다 들어오는 판정을 안정시켜 오디오·오브 제어값으로 바꾼다.
// - 손가락 개수는 같은 값이 holdMs 이상 유지되어야 바뀐다 (떨림 방지)
// - 손가락마다 히스테리시스: 펴짐/접힘 경계에 걸친 손가락이 프레임마다 뒤집히지 않는다
// - 핀치 중에는 손가락 개수를 고정한다 (검지가 구부러져 개수가 흔들리므로)
// - 손이 잠깐 안 보여도 lostMs 동안은 마지막 상태를 유지한다
// - 높이(음량)와 좌우(밝기)는 One Euro 필터로 떨림 없이 따라간다
// 좌표: palm·pinchPoint는 카메라 원본(0~1), screen*은 거울처럼 뒤집힌 화면 기준(0~1)
export class GestureTracker {
  constructor({ holdMs = 90, lostMs = 280, smooth = null, pinchOnMs = 60, pinchOffMs = 130,
    hysteresis = 0.12, scoreMs = 35, filter = { minCutoff: 1.4, beta: 2.0 } } = {}) {
    this.holdMs = holdMs;
    this.lostMs = lostMs;
    // smooth(0~1, 프레임당 비율)를 주면 예전 방식 그대로: 1 이면 바로 따라감
    this.smooth = smooth;
    this.pinchOnMs = pinchOnMs;
    this.pinchOffMs = pinchOffMs;
    this.hysteresis = hysteresis;
    this.scoreMs = scoreMs; // 손가락 점수 평균 시간 (튀는 프레임 제거 뒤)
    this.filterOptions = filter;
    this.reset();
  }

  reset() {
    this.present = false;
    this.lastSeen = -Infinity;
    this.fingers = 0;
    this.candidate = null;
    this.candidateSince = 0;
    this.level = 0.6;
    this.brightness = 0.5;
    this.hand = null;
    this.pinch = false;
    this.pinchFlipSince = null;
    this.screen = null;
    this.velocity = { x: 0, y: 0 };
    this.lastPos = null;
    this.ext = null;
    this.scoreHist = null;
    this.scoreAvg = null;
    this.scoreTime = null;
    this.fx = new OneEuro(this.filterOptions);
    this.fy = new OneEuro(this.filterOptions);
  }

  // 손가락마다: 최근 3프레임 중앙값(튀는 프레임 제거) → 시간 평균 → 히스테리시스.
  // 점수가 없는 입력(마우스 모드 등)은 그대로 쓴다.
  countFingers(hand, fresh, now) {
    const scores = hand.scores;
    if (!Array.isArray(scores) || scores.length !== 5 || !(this.hysteresis > 0)) {
      this.ext = null;
      return hand.fingers;
    }
    if (fresh || !this.ext) {
      this.scoreHist = scores.map((v) => [v]);
      this.scoreAvg = [...scores];
      this.scoreTime = now;
      this.ext = scores.map((v) => v > 0);
    } else {
      const dt = Math.max(0, now - this.scoreTime);
      this.scoreTime = now;
      const a = this.scoreMs > 0 ? 1 - Math.exp(-dt / this.scoreMs) : 1;
      this.scoreAvg = scores.map((v, i) => {
        const h = this.scoreHist[i];
        h.push(v);
        if (h.length > 3) h.shift();
        const med = h.length === 3 ? [...h].sort((x, y) => x - y)[1] : v;
        return this.scoreAvg[i] + (med - this.scoreAvg[i]) * a;
      });
      // 비대칭 띠: 접혔다고 보려면 -h 아래로 확실히 내려가야 하고, 다시 편 것은 +h/4 만 넘으면 된다.
      // (대칭이면 기준을 살짝 넘는 정도로 편 엄지가 한 번 접힌 뒤 영영 돌아오지 못한다)
      this.ext = this.scoreAvg.map((v, i) => (this.ext[i] ? v > -this.hysteresis : v > this.hysteresis / 4));
    }
    const raised = this.ext.slice(1).filter(Boolean).length;
    return raised === 4 && this.ext[0] ? 5 : raised;
  }

  // hands: analyzeHand 결과 배열. mirrored=true면 화면이 거울처럼 보인다고 보고 좌우를 뒤집는다.
  update(hands, now, { mirrored = true } = {}) {
    const hand = hands.length ? hands.reduce((a, b) => (b.size > a.size ? b : a)) : null;
    if (!hand) {
      if (now - this.lastSeen > this.lostMs) {
        this.present = false;
        this.hand = null;
        this.candidate = null;
        this.pinch = false;
        this.pinchFlipSince = null;
        this.lastPos = null;
        this.velocity = { x: 0, y: 0 };
      }
      return this.state();
    }
    const fresh = !this.present;
    this.lastSeen = now;
    this.hand = hand;
    this.present = true;

    this.updatePinch(hand, now, fresh);
    const seen = this.countFingers(hand, fresh, now);
    if (fresh) {
      // 손이 새로 들어오면 첫 판정을 바로 쓴다
      this.fingers = seen;
      this.candidate = null;
    } else if (this.pinch) {
      this.candidate = null;
    } else if (seen !== this.fingers) {
      if (this.candidate !== seen) {
        this.candidate = seen;
        this.candidateSince = now;
      } else if (now - this.candidateSince >= this.holdMs) {
        this.fingers = seen;
        this.candidate = null;
      }
    } else {
      this.candidate = null;
    }

    const flip = (x) => (mirrored ? 1 - x : x);
    const sx = flip(hand.palm.x);
    const sy = hand.palm.y;
    this.screen = {
      palm: { x: sx, y: sy },
      pinchPoint: hand.pinchPoint ? { x: flip(hand.pinchPoint.x), y: hand.pinchPoint.y } : { x: sx, y: sy },
    };
    // 손 속도 (화면 폭/초). 던지기 판정에 쓴다. 원본 위치로 재야 빨리 반응한다.
    // 프레임 간격과 무관하게 약 45ms 시간 상수로 다듬는다.
    if (this.lastPos && now > this.lastPos.t) {
      const dt = (now - this.lastPos.t) / 1000;
      const a = 1 - Math.exp(-dt / 0.045);
      this.velocity = {
        x: this.velocity.x + ((sx - this.lastPos.x) / dt - this.velocity.x) * a,
        y: this.velocity.y + ((sy - this.lastPos.y) / dt - this.velocity.y) * a,
      };
    }
    this.lastPos = { x: sx, y: sy, t: now };

    if (fresh) {
      this.fx.reset();
      this.fy.reset();
    }
    let px = sx;
    let py = sy;
    if (this.smooth == null) {
      px = this.fx.filter(sx, now);
      py = this.fy.filter(sy, now);
    }
    const targetLevel = clamp01((0.85 - py) / 0.65);
    const targetBright = clamp01((px - 0.15) / 0.7);
    if (this.smooth == null) {
      this.level = targetLevel;
      this.brightness = targetBright;
    } else {
      this.level += (targetLevel - this.level) * this.smooth;
      this.brightness += (targetBright - this.brightness) * this.smooth;
    }
    return this.state();
  }

  updatePinch(hand, now, fresh) {
    const t = THRESHOLDS;
    const want = this.pinch
      ? hand.pinchShape !== false && (hand.pinchDist ?? 1) < t.pinchOff // 잡고 있는 동안은 느슨하게
      : !!hand.pinch;
    if (want === this.pinch) {
      this.pinchFlipSince = null;
      return;
    }
    if (fresh) {
      this.pinch = want;
      return;
    }
    if (this.pinchFlipSince == null) this.pinchFlipSince = now;
    if (now - this.pinchFlipSince >= (want ? this.pinchOnMs : this.pinchOffMs)) {
      this.pinch = want;
      this.pinchFlipSince = null;
    }
  }

  state() {
    const fist = this.present && !this.pinch && this.fingers === 0;
    return {
      present: this.present,
      fingers: this.fingers,
      fist,
      pinch: this.present && this.pinch,
      preset: this.present ? fingersToPreset(this.fingers) : 0,
      level: this.level,
      brightness: this.brightness,
      hand: this.hand,
      screen: this.present ? this.screen : null,
      velocity: this.velocity,
    };
  }
}
