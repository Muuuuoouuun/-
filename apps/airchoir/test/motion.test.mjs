// 손 움직임 판정: 실제 손 사진 랜드마크를 MediaPipe 같은 잡음과 함께 여러 프레임률로 움직여
// '옆으로 휙'은 잡고, 지휘·되돌아오는 손·핀치는 넘기지 않는지 본다. 카메라 안내 조건도 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHand, GestureTracker, SENSITIVITY } from '../src/gestures.js';
import { SwipeDetector, CameraGuide, cameraCondition, meanLuma, GUIDE } from '../src/motion.js';
import { ASPECT, POSES, place, noisy, rng, NOISE } from './gesture-sim.mjs';

const OPEN = POSES[5];

// path(t) → { pose, x, y } (x, y 는 사용자가 보는 거울 화면 좌표) 또는 null(손 없음)
function run(path, { fps = 30, seconds, seed = 1, noise = NOISE } = {}) {
  const r = rng(seed);
  const tracker = new GestureTracker(SENSITIVITY.normal.tracker);
  const swipe = new SwipeDetector();
  const fires = [];
  for (let i = 0; i < seconds * fps; i++) {
    const now = (i * 1000) / fps;
    const at = path(now / 1000);
    const lm = at ? noisy(place(at.pose, 1 - at.x, at.y), r, noise) : null;
    const hands = lm ? [{ ...analyzeHand(lm, ASPECT), landmarks: lm }] : [];
    // 앱의 카메라 경로와 같게: 손이 안 보이면 바로 놓는다
    const state = tracker.update(hands, now, { immediateRelease: true });
    const dir = swipe.update(state, now, hands);
    if (dir) fires.push({ t: now / 1000, dir });
  }
  return fires;
}

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * u));
// from → to 로 dur 초 동안 휙 (start 초에 시작)
const sweep = (from, to, start, dur) => (t) => from + (to - from) * ease((t - start) / dur);

test('옆으로 휙: 편 손을 0.25초에 화면 40% 움직이면 방향대로 한 번만 넘긴다 (12·30·60fps, 잡음)', () => {
  for (const fps of [12, 30, 60]) {
    for (let seed = 1; seed <= 5; seed++) {
      const right = run((t) => ({ pose: OPEN, x: sweep(0.3, 0.7, 1, 0.25)(t), y: 0.5 }), { fps, seconds: 2.5, seed });
      assert.deepEqual(right.map((f) => f.dir), [1], `${fps}fps seed ${seed} 오른쪽: ${JSON.stringify(right)}`);
      assert.ok(right[0].t >= 1 && right[0].t <= 1.45, `늦지 않게: ${right[0].t}s`);
      const left = run((t) => ({ pose: OPEN, x: sweep(0.7, 0.3, 1, 0.25)(t), y: 0.5 }), { fps, seconds: 2.5, seed });
      assert.deepEqual(left.map((f) => f.dir), [-1], `${fps}fps seed ${seed} 왼쪽`);
    }
  }
});

test('옆으로 휙: 넘긴 뒤 손을 되돌리는 동작은 반대로 세지 않고, 다시 휙 하면 또 넘긴다', () => {
  for (const fps of [12, 30]) {
    const x = (t) => (t < 1.5 ? sweep(0.3, 0.7, 1, 0.25)(t) : t < 3 ? sweep(0.7, 0.3, 1.5, 0.35)(t) : sweep(0.3, 0.7, 3, 0.25)(t));
    const fires = run((t) => ({ pose: OPEN, x: x(t), y: 0.5 }), { fps, seconds: 4.5, seed: 3 });
    assert.deepEqual(fires.map((f) => f.dir), [1, 1], `${fps}fps: ${JSON.stringify(fires)}`);
  }
});

test('옆으로 휙: 지휘하듯 좌우·위아래로 움직이는 손은 30초 동안 한 번도 넘기지 않는다', () => {
  for (const fps of [12, 30, 60]) {
    // 밝기 조절: 화면 절반을 2초에 한 번 왕복 + 음량 조절: 위아래
    const sway = run((t) => ({ pose: OPEN, x: 0.5 + 0.25 * Math.sin(Math.PI * t), y: 0.5 + 0.15 * Math.sin(2.3 * t) }), { fps, seconds: 30, seed: 7 });
    assert.deepEqual(sway, [], `${fps}fps 좌우 지휘`);
    const updown = run((t) => ({ pose: OPEN, x: 0.5 + 0.05 * Math.sin(t), y: 0.5 + 0.3 * Math.sin(2 * Math.PI * t) }), { fps, seconds: 30, seed: 8 });
    assert.deepEqual(updown, [], `${fps}fps 위아래`);
    // 떨듯이 빠르게 흔드는 손 (비브라토처럼): 곧게 움직이지 않음
    const shake = run((t) => ({ pose: OPEN, x: 0.5 + 0.08 * Math.sin(2 * Math.PI * 6 * t), y: 0.5 }), { fps, seconds: 10, seed: 9 });
    assert.deepEqual(shake, [], `${fps}fps 떨기`);
  }
});

test('옆으로 휙: 주먹·손가락 3개 이하·비스듬한 움직임은 넘기지 않는다', () => {
  for (const pose of [POSES[0], POSES[2], POSES[3]]) {
    const fires = run((t) => ({ pose, x: sweep(0.3, 0.75, 1, 0.25)(t), y: 0.5 }), { seconds: 2.5, seed: 4 });
    assert.deepEqual(fires, []);
  }
  const diagonal = run((t) => ({ pose: OPEN, x: sweep(0.3, 0.7, 1, 0.25)(t), y: sweep(0.2, 0.75, 1, 0.25)(t) }), { seconds: 2.5, seed: 5 });
  assert.deepEqual(diagonal, [], '대각선');
});

test('옆으로 휙: 핀치(오브 던지기·끌기) 중에는 넘기지 않는다', () => {
  const swipe = new SwipeDetector();
  let fired = 0;
  for (let i = 0; i < 30; i++) {
    const x = 0.2 + i * 0.03;
    fired += Math.abs(swipe.update({ present: true, pinch: true, fist: false, fingers: 5, screen: { palm: { x, y: 0.5 } } }, i * 33));
  }
  assert.equal(fired, 0);
});

test('옆으로 휙: 빠른 손을 카메라가 몇 프레임 놓쳐도 잡는다', () => {
  let hits = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const fires = run((t) => ({ pose: OPEN, x: sweep(0.25, 0.7, 1, 0.25)(t), y: 0.5 }),
      { fps: 30, seconds: 2.5, seed, noise: { ...NOISE, drop: 0.2 } });
    if (fires.length === 1 && fires[0].dir === 1) hits++;
    assert.ok(fires.length <= 1, '두 번 넘기지 않음');
  }
  assert.ok(hits >= 8, `프레임 20%를 놓쳐도 10번 중 ${hits}번`);
});

test('옆으로 휙: 순간이동은 휙이 아니다 (영상이 끊김·손이 사라졌다 다른 곳에·두 손 사이를 오감)', () => {
  for (const fps of [7, 12, 30, 60]) {
    // 손이 한 프레임에 화면 반대쪽으로 (영상 장면 전환)
    const jump = run((t) => ({ pose: OPEN, x: t < 1 ? 0.25 : 0.75, y: 0.5 }), { fps, seconds: 2.5, seed: 11 });
    assert.deepEqual(jump, [], `${fps}fps 순간이동`);
    // 손이 잠깐 사라졌다가 다른 곳에서 나타남
    const reappear = run((t) => (t > 1 && t < 1.08 ? null : { pose: OPEN, x: t < 1 ? 0.25 : 0.75, y: 0.5 }), { fps, seconds: 2.5, seed: 12 });
    assert.deepEqual(reappear, [], `${fps}fps 다시 나타남`);
  }
  // 비슷한 크기의 두 손이 보이고 추적기가 프레임마다 다른 손을 고름: 가까운 손을 따라가므로 넘기지 않는다
  const swipe = new SwipeDetector();
  const a = { palm: { x: 0.75, y: 0.5 } }; // 거울 화면 x = 0.25
  const b = { palm: { x: 0.25, y: 0.5 } }; // 거울 화면 x = 0.75
  let fired = 0;
  for (let i = 0; i < 60; i++) {
    const big = i % 2 ? b : a;
    const state = { present: true, pinch: false, fist: false, fingers: 5, screen: { palm: { x: 1 - big.palm.x, y: 0.5 } } };
    fired += Math.abs(swipe.update(state, i * 33, [a, b]));
  }
  assert.equal(fired, 0, '두 손 사이를 오가는 선택');
});

test('옆으로 휙: 느린 카메라(7fps)도 0.4초쯤 휙 하면 잡는다', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const fires = run((t) => ({ pose: OPEN, x: sweep(0.25, 0.72, 1, 0.4)(t), y: 0.5 }), { fps: 7, seconds: 3, seed });
    assert.deepEqual(fires.map((f) => f.dir), [1], `seed ${seed}: ${JSON.stringify(fires)}`);
  }
});

const scaleAt = (lm, k) => {
  const cx = lm.reduce((a, p) => a + p[0], 0) / lm.length;
  const cy = lm.reduce((a, p) => a + p[1], 0) / lm.length;
  return lm.map(([x, y, z]) => [cx + (x - cx) * k, cy + (y - cy) * k, z * k]);
};
const hand = (lm) => ({ ...analyzeHand(lm, ASPECT), landmarks: lm });

test('카메라 안내: 멀거나 가장자리에 걸린 손, 어두운 방, 느린 인식을 알려 준다', () => {
  const ok = place(scaleAt(OPEN, 0.45), 0.5, 0.5);
  assert.equal(cameraCondition({ hands: [hand(ok)], fps: 30, luma: 0.4 }), null, '적당한 손');
  assert.equal(cameraCondition({ hands: [hand(place(scaleAt(OPEN, 0.18), 0.5, 0.5))], fps: 30 }).id, 'far');
  assert.equal(cameraCondition({ hands: [hand(place(scaleAt(OPEN, 0.45), 0.04, 0.5))], fps: 30 }).id, 'edge');
  assert.equal(cameraCondition({ hands: [{ size: 0.7, landmarks: [[0.5, 0.5, 0]] }], fps: 30 }).id, 'near');
  assert.equal(cameraCondition({ hands: [hand(ok)], fps: 30, luma: 0.08 }).id, 'dark');
  const slow = cameraCondition({ hands: [hand(ok)], fps: 9.6 });
  assert.equal(slow.id, 'slow');
  assert.match(slow.text, /10fps.*안정적으로/);
  assert.doesNotMatch(cameraCondition({ hands: [], fps: 9, stable: true }).text, /안정적으로/, '이미 안정적이면 다른 방법을');
  assert.equal(cameraCondition({ hands: [], fps: 0, luma: null }), null, '아직 잴 수 없으면 조용히');
  // 실제 손 사진(가까이 찍은 사진·멀리 찍은 사진)은 '멀다'로 보지 않는다
  for (const size of [0.104, 0.123, 0.133]) assert.ok(size > GUIDE.farSize, `실제 사진의 작은 손 ${size}`);
});

test('카메라 안내: 잠깐 스친 조건은 띄우지 않고, 사라져도 잠시 유지한다', () => {
  const guide = new CameraGuide();
  const far = { hands: [hand(place(scaleAt(OPEN, 0.18), 0.5, 0.5))], fps: 30 };
  const fine = { hands: [hand(place(scaleAt(OPEN, 0.45), 0.5, 0.5))], fps: 30 };
  assert.equal(guide.update(far, 0), null);
  assert.equal(guide.update(far, 500), null, '0.5초는 아직');
  assert.equal(guide.update(fine, 600), null, '스치고 지나감');
  guide.update(far, 1000);
  assert.equal(guide.update(far, 1800)?.id, 'far', '0.7초 넘게 이어지면');
  assert.equal(guide.update(fine, 2000)?.id, 'far', '좋아져도 바로 지우지 않음');
  assert.equal(guide.update(fine, 2700), null, '0.6초 뒤 지움');
});

test('영상 밝기: RGBA 평균 밝기', () => {
  assert.equal(meanLuma(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255])), 0);
  assert.ok(Math.abs(meanLuma(new Uint8ClampedArray([255, 255, 255, 255])) - 1) < 1e-9);
  assert.ok(Math.abs(meanLuma(new Uint8ClampedArray([128, 128, 128, 255])) - 128 / 255) < 1e-9);
});
