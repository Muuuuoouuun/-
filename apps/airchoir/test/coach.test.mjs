import test from 'node:test';
import assert from 'node:assert/strict';
import { Coach, COACH_KEY, COACH_STEPS, DONE_VISIBLE_MS } from '../src/coach.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)) };
}

const base = { eligible: true, mode: 'pointer', source: 'demo', voiced: false, voices: 0, handUp: false, fist: false, orbs: 0 };

// 관찰값을 frameMs 간격으로 ms 동안 계속 넣는다.
function feed(coach, clock, obs, ms, frameMs = 70) {
  for (let t = 0; t < ms; t += frameMs) { clock.now += frameMs; coach.observe({ ...base, ...obs }, clock.now); }
}

test('walks voice → harmony → grow → stop → orb only when each condition holds', () => {
  const storage = memoryStorage();
  const coach = new Coach({ storage });
  const clock = { now: 1000 };
  assert.equal(coach.begin(clock.now), true);
  assert.equal(coach.view().id, 'voice');

  feed(coach, clock, { voiced: true }, 300);
  assert.equal(coach.step.id, 'voice', 'needs the voice to hold');
  assert.ok(coach.view().progress > 0 && coach.view().progress < 1);
  feed(coach, clock, { voiced: false }, 70);
  assert.equal(coach.view().progress, 0, 'a gap resets the hold');
  feed(coach, clock, { voiced: true }, 700);
  assert.equal(coach.step.id, 'harmony');

  feed(coach, clock, { voiced: true, handUp: true, voices: 0 }, 1500);
  assert.equal(coach.step.id, 'harmony', 'a hand without sounding harmony is not enough');
  feed(coach, clock, { voiced: true, handUp: true, voices: 2 }, 900);
  assert.equal(coach.step.id, 'grow');
  feed(coach, clock, { voiced: true, handUp: true, voices: 3 }, 900);
  assert.equal(coach.step.id, 'stop');
  feed(coach, clock, { fist: false, handUp: false }, 1000);
  assert.equal(coach.step.id, 'stop');
  feed(coach, clock, { fist: true }, 400);
  assert.equal(coach.step.id, 'orb');
  assert.equal(storage.data.get(COACH_KEY), undefined, 'nothing saved before completion');
  feed(coach, clock, { orbs: 1 }, 70);
  assert.equal(coach.phase, 'done');
  assert.equal(storage.data.get(COACH_KEY), 'done');
  const view = coach.view();
  assert.equal(view.phase, 'done');
  assert.match(view.text, /초 만에/);
});

test('advances at most one step per frame even if later goals are already met', () => {
  const coach = new Coach();
  const clock = { now: 0 };
  coach.begin(0);
  feed(coach, clock, { voiced: true, handUp: true, voices: 4, orbs: 2 }, 700);
  assert.equal(coach.step.id, 'harmony');
  feed(coach, clock, { voiced: true, handUp: true, voices: 4, orbs: 2 }, 900);
  assert.equal(coach.step.id, 'grow');
});

test('pauses while not eligible: no progress and no elapsed time', () => {
  const coach = new Coach();
  const clock = { now: 0 };
  coach.begin(0);
  feed(coach, clock, { eligible: false, voiced: true }, 5000);
  assert.equal(coach.step.id, 'voice');
  assert.equal(coach.elapsedMs, 0);
  assert.equal(coach.view(), null, 'hidden while paused');
  feed(coach, clock, { voiced: true }, 700);
  assert.equal(coach.step.id, 'harmony');
  assert.ok(coach.elapsedMs < 1000);
});

test('a long frame gap (background tab) does not count as practice time', () => {
  const coach = new Coach();
  coach.begin(0);
  coach.observe({ ...base }, 16);
  coach.observe({ ...base }, 60_000);
  assert.ok(coach.elapsedMs <= 16 + 250);
});

test('skip records skipped steps and the finish text says so', () => {
  const storage = memoryStorage();
  const coach = new Coach({ storage });
  coach.begin(0);
  for (let i = 0; i < COACH_STEPS.length; i++) coach.skip(i);
  assert.equal(coach.phase, 'done');
  assert.deepEqual(coach.skipped, COACH_STEPS.map((s) => s.id));
  assert.match(coach.view().text, /다시 보기/);
  assert.equal(storage.data.get(COACH_KEY), 'done');
});

test('remembered completion or dismissal suppresses auto start; force replays', () => {
  const storage = memoryStorage();
  const coach = new Coach({ storage });
  coach.begin(0);
  coach.dismiss();
  assert.equal(coach.view(), null);
  assert.equal(storage.data.get(COACH_KEY), 'dismissed');
  assert.equal(coach.begin(10), false);
  assert.equal(coach.phase, 'off');
  assert.equal(coach.begin(10, { force: true }), true);
  assert.equal(coach.step.id, 'voice');
});

test('dismissing the finished card does not overwrite completion', () => {
  const storage = memoryStorage();
  const coach = new Coach({ storage });
  coach.begin(0);
  for (let i = 0; i < COACH_STEPS.length; i++) coach.skip(i);
  coach.dismiss();
  assert.equal(storage.data.get(COACH_KEY), 'done');
});

test('finished card hides itself after a while', () => {
  const coach = new Coach();
  coach.begin(0);
  for (let i = 0; i < COACH_STEPS.length; i++) coach.skip(100);
  coach.observe({ ...base }, 100 + DONE_VISIBLE_MS - 1);
  assert.equal(coach.view().phase, 'done');
  coach.observe({ ...base }, 100 + DONE_VISIBLE_MS + 1);
  assert.equal(coach.view(), null);
});

test('storage failures never break the guide', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const coach = new Coach({ storage: broken });
  assert.equal(coach.begin(0), true);
  for (let i = 0; i < COACH_STEPS.length; i++) coach.skip(i);
  assert.equal(coach.phase, 'done');
});

test('instructions follow the input: camera gestures vs mouse keys, mic vs demo', () => {
  const coach = new Coach();
  const clock = { now: 0 };
  coach.begin(0);
  feed(coach, clock, { source: 'mic' }, 70);
  assert.match(coach.view().text, /이어폰/);
  feed(coach, clock, { source: 'demo' }, 70);
  assert.match(coach.view().text, /데모/);
  coach.skip(clock.now);
  feed(coach, clock, { mode: 'camera' }, 70);
  assert.match(coach.view().text, /손가락 하나/);
  feed(coach, clock, { mode: 'pointer' }, 70);
  assert.match(coach.view().text, /1 키/);
});
