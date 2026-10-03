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

  // 손바닥 중심 (원래 0~1 좌표)
  let cx = 0;
  let cy = 0;
  for (const i of PALM) {
    cx += Array.isArray(landmarks[i]) ? landmarks[i][0] : landmarks[i].x;
    cy += Array.isArray(landmarks[i]) ? landmarks[i][1] : landmarks[i].y;
  }
  cx /= PALM.length;
  cy /= PALM.length;

  return { extended, fingers, fist: raised === 0, palm: { x: cx, y: cy }, size: palmSize };
}

// 손가락 개수 → 화음 구성 번호 (dsp.js의 PRESETS)
export const fingersToPreset = (n) => Math.max(0, Math.min(4, n));

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// 프레임마다 들어오는 판정을 안정시켜 오디오 제어값으로 바꾼다.
// - 손가락 개수는 같은 값이 holdMs 이상 유지되어야 바뀐다 (떨림 방지)
// - 손이 잠깐 안 보여도 lostMs 동안은 마지막 상태를 유지한다
// - 높이(음량)와 좌우(밝기)는 부드럽게 따라간다
export class GestureTracker {
  constructor({ holdMs = 90, lostMs = 250, smooth = 0.35 } = {}) {
    this.holdMs = holdMs;
    this.lostMs = lostMs;
    this.smooth = smooth;
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
  }

  // hands: analyzeHand 결과 배열 (이미 좌우 반전된 화면 기준 x를 쓰려면 mirrored=true)
  update(hands, now, { mirrored = true } = {}) {
    const hand = hands.length ? hands.reduce((a, b) => (b.size > a.size ? b : a)) : null;
    if (!hand) {
      if (now - this.lastSeen > this.lostMs) {
        this.present = false;
        this.hand = null;
        this.candidate = null;
      }
      return this.state();
    }
    this.lastSeen = now;
    this.hand = hand;
    if (!this.present) {
      // 손이 새로 들어오면 첫 판정을 바로 쓴다
      this.present = true;
      this.fingers = hand.fingers;
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

    const x = mirrored ? 1 - hand.palm.x : hand.palm.x;
    const targetLevel = clamp01((0.85 - hand.palm.y) / 0.65);
    const targetBright = clamp01((x - 0.15) / 0.7);
    this.level += (targetLevel - this.level) * this.smooth;
    this.brightness += (targetBright - this.brightness) * this.smooth;
    return this.state();
  }

  state() {
    const fist = this.present && this.fingers === 0;
    return {
      present: this.present,
      fingers: this.fingers,
      fist,
      preset: this.present ? fingersToPreset(this.fingers) : 0,
      level: this.level,
      brightness: this.brightness,
      hand: this.hand,
    };
  }
}
