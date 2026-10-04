// 손동작 판정 테스트. fixtures/hands.json은 MediaPipe 공식 샘플 사진에서
// HandLandmarker(1.0.1)로 뽑은 실제 랜드마크다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeHand, GestureTracker, fingersToPreset } from '../src/gestures.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/hands.json', import.meta.url)));
const hands = (name) => {
  const f = fixtures[name];
  return f.hands.map((h) => analyzeHand(h.landmarks, f.width / f.height));
};

test('실제 손 사진: 손가락 개수', () => {
  const expected = {
    fist: [0],
    thumb_up: [0], // 엄지만 펴면 주먹과 같이 "정지"
    pointing_up: [1],
    pointing_up_2: [1],
    pointing_sideways: [1], // 옆으로 눕혀도 1개
    victory: [2],
    victory_blurry: [2],
    open_two_hands: [5, 5],
    flat_hands_side: [4, 4], // 엄지를 붙인 납작한 손 → 4개 (화음 구성은 5개와 같음)
  };
  for (const [name, want] of Object.entries(expected)) {
    assert.deepEqual(hands(name).map((h) => h.fingers), want, name);
  }
});

test('주먹 판정과 화음 구성 번호', () => {
  assert.equal(hands('fist')[0].fist, true);
  assert.equal(hands('thumb_up')[0].fist, true);
  assert.equal(hands('victory')[0].fist, false);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(fingersToPreset), [0, 1, 2, 3, 4, 4]);
});

// 편 손에서 특정 손가락만 접은 모양을 만든다 (3개 · 4개 사진이 없어서 합성)
function curl(landmarks, fingerIndexes) {
  const p = landmarks.map((q) => [...q]);
  const joints = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  for (const f of fingerIndexes) {
    const [mcp, pip, dip, tip] = joints[f];
    const toWrist = p[0].map((v, k) => v - p[mcp][k]);
    const back = p[pip].map((v, k) => v - p[mcp][k]);
    p[dip] = p[pip].map((v, k) => v - back[k] * 0.6);
    p[tip] = p[mcp].map((v, k) => v + toWrist[k] * 0.15);
  }
  return p;
}

test('편 손에서 손가락을 접으면 개수가 줄어든다', () => {
  const f = fixtures.open_two_hands;
  const open = f.hands[1].landmarks;
  const aspect = f.width / f.height;
  assert.equal(analyzeHand(curl(open, [3]), aspect).fingers, 3); // 새끼 접기 (엄지 포함 4개지만 엄지는 5개일 때만 셈)
  assert.equal(analyzeHand(curl(open, [2, 3]), aspect).fingers, 2);
  assert.equal(analyzeHand(curl(open, [1, 2, 3]), aspect).fingers, 1);
  assert.equal(analyzeHand(curl(open, [0, 1, 2, 3]), aspect).fingers, 0);
});

const fake = (fingers, x = 0.5, y = 0.5, size = 0.2) => ({ fingers, fist: fingers === 0, palm: { x, y }, size, extended: [] });

test('추적기: 손가락 개수는 잠깐 바뀐 값에 흔들리지 않는다', () => {
  const t = new GestureTracker({ holdMs: 90 });
  assert.equal(t.update([fake(2)], 0).fingers, 2);
  assert.equal(t.update([fake(3)], 33).fingers, 2); // 한 프레임만 3
  assert.equal(t.update([fake(2)], 66).fingers, 2);
  t.update([fake(3)], 100);
  assert.equal(t.update([fake(3)], 150).fingers, 2); // 아직 50ms
  assert.equal(t.update([fake(3)], 200).fingers, 3); // 100ms 유지 → 바뀜
});

test('추적기: 손이 잠깐 사라져도 유지, 오래 사라지면 화음 없음', () => {
  const t = new GestureTracker({ lostMs: 250 });
  t.update([fake(2)], 0);
  assert.equal(t.update([], 100).present, true);
  const gone = t.update([], 300);
  assert.equal(gone.present, false);
  assert.equal(gone.preset, 0);
});

test('추적기: 가장 큰(가까운) 손을 쓰고, 높이·좌우를 음량·밝기로 바꾼다', () => {
  const t = new GestureTracker({ smooth: 1 });
  const s = t.update([fake(1, 0.2, 0.2, 0.1), fake(3, 0.8, 0.8, 0.3)], 0);
  assert.equal(s.fingers, 3);
  const high = t.update([fake(3, 0.5, 0.2)], 10);
  assert.ok(high.level > 0.95, `높이 올린 음량 ${high.level}`);
  const low = t.update([fake(3, 0.5, 0.85)], 20);
  assert.ok(low.level < 0.05, `내린 음량 ${low.level}`);
  // 화면은 거울처럼 보이므로 카메라 원본 x가 작을수록(사용자 기준 오른쪽) 밝다
  assert.ok(t.update([fake(3, 0.1, 0.5)], 30).brightness > 0.95);
  assert.ok(t.update([fake(3, 0.9, 0.5)], 40).brightness < 0.05);
});

// 편 손에서 검지를 구부려 엄지 끝에 붙인 모양 (OK 사인처럼 나머지 손가락은 편 채로)
function pinchFrom(landmarks) {
  const p = landmarks.map((q) => [...q]);
  const thumbTip = p[4];
  const pip = p[6];
  p[8] = thumbTip.map((v, k) => v + (pip[k] - thumbTip[k]) * 0.05);
  p[7] = pip.map((v, k) => (v + p[8][k]) / 2 + (p[5][k] - p[0][k]) * 0.15);
  return p;
}

test('핀치: 실제 사진 속 손은 하나도 핀치로 잡히지 않는다 (주먹 포함)', () => {
  for (const name of Object.keys(fixtures)) {
    for (const h of hands(name)) assert.equal(h.pinch, false, name);
  }
  assert.equal(hands('fist')[0].fist, true);
});

test('핀치: 검지를 엄지에 붙이면 핀치, 주먹으로는 판정하지 않는다', () => {
  const f = fixtures.open_two_hands;
  const aspect = f.width / f.height;
  for (const h of f.hands) {
    const a = analyzeHand(pinchFrom(h.landmarks), aspect);
    assert.equal(a.pinch, true, `거리 ${a.pinchDist.toFixed(2)}`);
    assert.equal(a.fist, false);
  }
});

test('추적기: 핀치는 잠깐 끊겨도 유지되고, 그동안 손가락 개수는 고정된다', () => {
  const t = new GestureTracker({ pinchOnMs: 50, pinchOffMs: 120 });
  const pin = (on, fingers = 2) => ({ ...fake(fingers), pinch: on, pinchShape: true, pinchDist: on ? 0.1 : 0.9, pinchPoint: { x: 0.4, y: 0.5 } });
  t.update([pin(false, 2)], 0);
  assert.equal(t.update([pin(true, 0)], 30).pinch, false); // 아직 50ms 안 됨
  const on = t.update([pin(true, 0)], 90);
  assert.equal(on.pinch, true);
  assert.equal(on.fist, false);
  assert.equal(t.update([pin(true, 3)], 300).fingers, 2); // 핀치 중 개수 고정
  assert.equal(t.update([pin(false, 2)], 320).pinch, true); // 한 프레임 끊김
  assert.equal(t.update([pin(true, 2)], 340).pinch, true);
  t.update([pin(false, 2)], 400);
  assert.equal(t.update([pin(false, 2)], 540).pinch, false); // 120ms 넘게 떨어지면 끝
  assert.deepEqual(on.screen.pinchPoint, { x: 0.6, y: 0.5 }); // 화면은 거울
});

test('추적기: 손 속도 (던지기 판정용)', () => {
  const t = new GestureTracker();
  t.update([fake(2, 0.8, 0.5)], 0);
  let s;
  for (let i = 1; i <= 5; i++) s = t.update([fake(2, 0.8 - 0.05 * i, 0.5)], i * 33);
  // 카메라 원본에서 왼쪽으로 = 화면에서 오른쪽으로 약 1.5 화면폭/초
  assert.ok(s.velocity.x > 1.2 && s.velocity.x < 1.7, `속도 ${s.velocity.x}`);
  assert.ok(Math.abs(s.velocity.y) < 0.01);
});
