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
  // 엄지: 마디가 곧고, 끝이 검지 뿌리에서 충분히 떨어져 있어야 편 것으로 본다
  const thumbStraight = cos(sub(p[THUMB[2]], p[THUMB[1]]), sub(p[THUMB[3]], p[THUMB[2]]));
  const thumbAway = dist(p[THUMB[3]], p[5]) / palmSize;
  extended.push(thumbStraight > t.thumbStraight && thumbAway > t.thumbAway);

  for (const [mcp, pip, , tip] of FINGERS) {
    const straight = cos(sub(p[pip], p[mcp]), sub(p[tip], p[pip]));
    const reach = dist(p[tip], p[WRIST]) / dist(p[pip], p[WRIST]);
    extended.push(straight > t.fingerStraight && reach > t.fingerReach);
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

// 프레임마다 들어오는 판정을 안정시켜 오디오·오브 제어값으로 바꾼다.
// - 손가락 개수는 같은 값이 holdMs 이상 유지되어야 바뀐다 (떨림 방지)
// - 핀치 중에는 손가락 개수를 고정한다 (검지가 구부러져 개수가 흔들리므로)
// - 손이 잠깐 안 보여도 lostMs 동안은 마지막 상태를 유지한다
// - 높이(음량)와 좌우(밝기)는 부드럽게 따라간다
// 좌표: palm·pinchPoint는 카메라 원본(0~1), screen*은 거울처럼 뒤집힌 화면 기준(0~1)
export class GestureTracker {
  constructor({ holdMs = 90, lostMs = 250, smooth = 0.35, pinchOnMs = 50, pinchOffMs = 120 } = {}) {
    this.holdMs = holdMs;
    this.lostMs = lostMs;
    this.smooth = smooth;
    this.pinchOnMs = pinchOnMs;
    this.pinchOffMs = pinchOffMs;
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
  }

  // hands: analyzeHand 결과 배열. mirrored=true면 화면이 거울처럼 보인다고 보고 좌우를 뒤집는다.
  update(hands, now, { mirrored = true, immediateRelease = false } = {}) {
    const hand = hands.length ? hands.reduce((a, b) => (b.size > a.size ? b : a)) : null;
    if (!hand) {
      // Camera performance must not sustain an old preset through a missing hand.
      // Pointer/orb callers may still opt into the existing loss grace period.
      if (immediateRelease) { this.reset(); return this.state(); }
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
    if (immediateRelease && hand.fist) {
      this.fingers = 0;
      this.pinch = false;
      this.pinchFlipSince = null;
      this.candidate = null;
    } else if (fresh) {
      // 손이 새로 들어오면 첫 판정을 바로 쓴다
      this.fingers = hand.fingers;
      this.candidate = null;
    } else if (this.pinch) {
      this.candidate = null;
    } else if (hand.fingers !== this.fingers) {
      if (this.candidate !== hand.fingers) {
        this.candidate = hand.fingers;
        this.candidateSince = now;
      } else if (now - this.candidateSince >= this.holdMs) {
        this.fingers = hand.fingers;
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
    // 손 속도 (화면 폭/초). 던지기 판정에 쓴다.
    if (this.lastPos && now > this.lastPos.t) {
      const dt = (now - this.lastPos.t) / 1000;
      const a = 0.5;
      this.velocity = {
        x: this.velocity.x + ((sx - this.lastPos.x) / dt - this.velocity.x) * a,
        y: this.velocity.y + ((sy - this.lastPos.y) / dt - this.velocity.y) * a,
      };
    }
    this.lastPos = { x: sx, y: sy, t: now };

    const targetLevel = clamp01((0.85 - sy) / 0.65);
    const targetBright = clamp01((sx - 0.15) / 0.7);
    this.level += (targetLevel - this.level) * this.smooth;
    this.brightness += (targetBright - this.brightness) * this.smooth;
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
