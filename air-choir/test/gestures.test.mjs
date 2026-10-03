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
