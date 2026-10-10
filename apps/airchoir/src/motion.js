// 카메라 손동작의 '움직임' 판정. 화면·오디오에 의존하지 않는 순수 로직이라 Node에서
// 실제 손 사진 랜드마크 + MediaPipe 같은 잡음(test/gesture-sim.mjs)으로 검증한다.

// ───────────── 옆으로 휙: 화음 성격 넘기기 ─────────────
// 편 손(손가락 4개 이상, 핀치·주먹 아님)을 짧은 시간에 옆으로 크게 움직이면 한 번 넘긴다.
// - 지휘하듯 천천히 좌우로 움직이는 손(밝기 조절)은 넘기지 않는다: 0.3초 안에 화면 폭의 28% 이상
// - 비스듬하거나 떨듯이 흔드는 손은 넘기지 않는다: 세로 이동은 가로의 60% 이하, 곧게 움직인 비율 75% 이상
// - 넘긴 뒤 손을 되돌리는 동작은 반대 방향으로 세지 않는다 (rearmMs)
// - 빠른 손은 MediaPipe 가 한두 프레임 놓칠 수 있어 짧은 공백(gapMs)은 이어서 본다
// - 손이 순간이동한 것(두 손 중 다른 손으로 바뀜, 손이 사라졌다 다른 곳에 나타남, 영상이 끊김)은 휙이 아니다:
//   세 프레임 이상에 걸쳐 움직여야 하고, 한 프레임에 전체 거리의 대부분을 건너뛰면 버린다.
//   두 손이 보이면 앞 프레임과 가까운 손을 계속 따라간다.
export const SWIPE = Object.freeze({
  windowMs: 350,
  minDistance: 0.28, // 화면 폭 비율
  maxSlope: 0.6,
  straightness: 0.75,
  minFingers: 4,
  minSamples: 3,
  maxStepShare: 0.8, // 한 프레임 이동 / 전체 이동 (순간이동은 거의 1)
  gapMs: 160,
  cooldownMs: 900,
  rearmMs: 1500,
});

export class SwipeDetector {
  constructor(options = {}) {
    this.options = { ...SWIPE, ...options };
    this.reset();
  }

  reset() {
    this.trail = [];
    this.lastFire = -Infinity;
    this.lastDir = 0;
    this.lastSeen = -Infinity;
  }

  /**
   * state: GestureTracker.state() (screen.palm 은 거울처럼 뒤집힌 화면 좌표 0~1).
   * hands: 이 프레임의 손들(analyzeHand 결과, palm 은 카메라 원본 좌표). 주면 앞 프레임과 가까운 손을 따라간다.
   * 반환: +1 = 화면 오른쪽으로 휙(다음), -1 = 왼쪽(이전), 0 = 없음.
   */
  update(state, now, hands = null) {
    const o = this.options;
    if (!state?.present || !state.screen) {
      if (now - this.lastSeen > o.gapMs) this.trail.length = 0;
      return 0;
    }
    this.lastSeen = now;
    if (state.pinch || state.fist || state.fingers < o.minFingers) {
      this.trail.length = 0;
      return 0;
    }
    let { x, y } = state.screen.palm;
    const last = this.trail.at(-1);
    if (last && hands?.length > 1) {
      // 두 손: 가장 큰 손이 아니라 방금까지 움직이던 손 (거울 화면 좌표로 비교)
      let best = Infinity;
      for (const hand of hands) {
        const hx = 1 - hand.palm.x;
        const d = Math.hypot(hx - last.x, hand.palm.y - last.y);
        if (d < best) { best = d; x = hx; y = hand.palm.y; }
      }
    }
    this.trail.push({ t: now, x, y });
    while (this.trail.length > 1 && now - this.trail[0].t > o.windowMs) this.trail.shift();
    if (now - this.lastFire < o.cooldownMs || this.trail.length < o.minSamples) return 0;

    const first = this.trail[0];
    const dx = x - first.x;
    const dy = y - first.y;
    if (Math.abs(dx) < o.minDistance || Math.abs(dy) > o.maxSlope * Math.abs(dx)) return 0;
    let path = 0;
    let step = 0;
    for (let i = 1; i < this.trail.length; i++) {
      const d = Math.abs(this.trail[i].x - this.trail[i - 1].x);
      path += d;
      step = Math.max(step, d);
    }
    if (Math.abs(dx) < o.straightness * path) return 0;
    if (step > o.maxStepShare * Math.abs(dx)) return 0; // 순간이동
    const dir = Math.sign(dx);
    if (dir === -this.lastDir && now - this.lastFire < o.rearmMs) return 0; // 되돌아오는 손
    this.lastFire = now;
    this.lastDir = dir;
    this.trail.length = 0;
    return dir;
  }
}

// ───────────── 카메라 안내: 인식이 잘 안 될 조건 ─────────────
// 손이 너무 멀거나(작게 보임) 너무 가깝거나, 화면 가장자리에 걸리거나, 방이 어둡거나, 손 인식이 느리면
// 무대에 한 줄로 알려 준다. 조건이 잠깐 스치는 것으로는 띄우지 않고(showMs), 사라져도 잠시 유지한다(hideMs).
export const GUIDE = Object.freeze({
  farSize: 0.09, // 손목~중지 뿌리 길이 / 영상 높이. 이보다 작으면 손가락 판정이 흔들린다
  nearSize: 0.6,
  edge: 0.01, // 랜드마크가 영상 가장자리 1% 안이면 잘린 손
  darkLuma: 0.15, // 영상 평균 밝기 (0~1)
  lowFps: 12,
  showMs: 700,
  hideMs: 600,
});

const HINTS = {
  dark: '방이 어두워요 · 조명을 켜거나 밝은 쪽을 보면 손을 더 잘 알아봐요',
  slow: (fps, stable) => `손 인식이 느려요 (${Math.round(fps)}fps) · ${stable ? '다른 탭·앱을 닫거나 밝은 곳에서 해 보세요' : '설정 › 손동작 감도를 ‘안정적으로’로 바꿔 보세요'}`,
  edge: '손이 화면 가장자리에 걸렸어요 · 조금 안쪽으로',
  far: '손이 멀어요 · 카메라에 조금 더 가까이',
  near: '손이 너무 가까워요 · 조금 뒤로',
};

/** 한 프레임의 조건 하나 (가장 급한 것). hands: analyzeHand 결과(+landmarks), aspect: 영상 폭/높이 */
export function cameraCondition({ hands = [], fps = 0, luma = null, stable = false }, g = GUIDE) {
  if (luma != null && luma < g.darkLuma) return { id: 'dark', text: HINTS.dark };
  if (fps > 0 && fps < g.lowFps) return { id: 'slow', text: HINTS.slow(fps, stable) };
  if (!hands.length) return null;
  const hand = hands.reduce((a, b) => (b.size > a.size ? b : a));
  const lm = hand.landmarks || [];
  const at = (p, k) => (Array.isArray(p) ? p[k] : k ? p.y : p.x);
  if (lm.some((p) => at(p, 0) < g.edge || at(p, 0) > 1 - g.edge || at(p, 1) < g.edge || at(p, 1) > 1 - g.edge)) {
    return { id: 'edge', text: HINTS.edge };
  }
  if (hand.size < g.farSize) return { id: 'far', text: HINTS.far };
  if (hand.size > g.nearSize) return { id: 'near', text: HINTS.near };
  return null;
}

export class CameraGuide {
  constructor(options = {}) {
    this.options = { ...GUIDE, ...options };
    this.reset();
  }

  reset() {
    this.shown = null;
    this.pending = null;
    this.pendingSince = 0;
    this.clearSince = null;
  }

  /** 반환: 지금 보여 줄 안내 { id, text } 또는 null */
  update(input, now) {
    const o = this.options;
    const seen = cameraCondition(input, o);
    if (seen && this.shown?.id === seen.id) {
      this.shown = seen; // 같은 조건: 숫자(fps)만 새로
      this.clearSince = null;
      return this.shown;
    }
    if (seen) {
      if (this.pending?.id !== seen.id) { this.pending = seen; this.pendingSince = now; }
      if (now - this.pendingSince >= o.showMs) { this.shown = seen; this.pending = null; this.clearSince = null; }
    } else {
      this.pending = null;
    }
    if (this.shown && (!seen || seen.id !== this.shown.id)) {
      this.clearSince ??= now;
      if (now - this.clearSince >= o.hideMs) { this.shown = null; this.clearSince = null; }
    }
    return this.shown;
  }
}

/** 영상 한 장면의 평균 밝기(0~1). data: RGBA 바이트 (작게 줄인 캔버스의 getImageData) */
export function meanLuma(data) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    n++;
  }
  return n ? sum / n / 255 : 0;
}
