import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport, OrbStation, orbMix } from '../src/orbs.js';

function fakeAudio() {
  const log = [];
  return {
    log,
    capture: (orb) => {
      log.push(['capture', orb.id, +orb.begin.toFixed(3), +orb.len.toFixed(3)]);
      return Promise.resolve();
    },
    play: (orb) => log.push(['play', orb.id]),
    stop: (orb) => log.push(['stop', orb.id]),
    mix: (orb) => log.push(['mix', orb.id]),
  };
}

// 화면 기준 좌표로 손 상태를 만든다
const hand = ({ x = 0.3, y = 0.6, pinch = false, fist = false, fingers = 2, vx = 0, vy = 0 } = {}) => ({
  present: true,
  pinch,
  fist,
  fingers,
  screen: { palm: { x, y }, pinchPoint: { x, y } },
  velocity: { x: vx, y: vy },
});
const gone = { present: false };

// BPM 120 → 한 박 0.5초, 한 마디 2초
function setup() {
  const audio = fakeAudio();
  const st = new OrbStation({ transport: new Transport(120, 0), audio });
  return { st, audio };
}

// t부터 t1까지 1/60초 간격으로 같은 손 상태를 넣는다
function run(st, g, t, t1) {
  for (; t < t1; t += 1 / 60) st.update(typeof g === 'function' ? g(t) : g, t);
  return t1;
}

test('박자 그리드: 다음 마디, 박 위치', () => {
  const T = new Transport(120, 0);
  assert.equal(T.bar, 2);
  assert.equal(T.nextBar(0.1), 2);
  assert.equal(T.nextBar(2), 2);
  assert.equal(T.nextBar(1.2, 1), 4); // 최소 1초 뒤
  assert.deepEqual(T.position(2.75), { beat: 1, frac: 0.5 });
});

test('핀치 유지 → 다음 마디부터 녹음 → 놓으면 마디 끝에서 오브 완성', async () => {
  const { st, audio } = setup();
  let t = run(st, hand(), 0, 0.3);
  st.update(hand({ pinch: true }), t); // t=0.3: 최소 2박(1초) 뒤 첫 마디 = 2초
  assert.equal(st.mode, 'countin');
  assert.equal(st.rec.begin, 2);
  t = run(st, hand({ pinch: true }), t, 2.03);
  assert.equal(st.mode, 'recording');
  t = run(st, hand({ pinch: true }), t, 4.6); // 1.3마디 녹음 후 놓기
  st.update(hand({ pinch: false }), t);
  assert.equal(st.mode, 'finishing');
  assert.equal(st.rec.end, 6); // 다음 마디 끝까지
  t = run(st, hand(), t, 6.05);
  assert.equal(st.mode, 'holding');
  assert.equal(st.count, 1);
  const orb = st.orbs[0];
  assert.equal(orb.bars, 2);
  assert.deepEqual(audio.log[0], ['capture', 1, 2, 4]);
  await Promise.resolve();
  assert.equal(orb.ready, true);
  assert.ok(!audio.log.some((e) => e[0] === 'play'), '던지기 전에는 재생 안 함');
});

test('카운트인 중에 손을 떼면 취소', () => {
  const { st } = setup();
  st.update(hand({ pinch: true }), 0.1);
  st.update(hand({ pinch: false }), 0.5);
  assert.equal(st.mode, 'idle');
  assert.equal(st.count, 0);
});

test('최대 4마디에서 자동으로 끝난다', () => {
  const { st } = setup();
  st.update(hand({ pinch: true }), 0.1);
  run(st, hand({ pinch: true }), 0.12, 2 + 8.05);
  assert.equal(st.mode, 'holding');
  assert.equal(st.orbs[0].bars, 4);
});

async function makeHeldOrb(st, x = 0.3, y = 0.6) {
  st.update(hand({ x, y, pinch: true }), 0.1);
  let t = run(st, hand({ x, y, pinch: true }), 0.12, 2.5);
  st.update(hand({ x, y }), t);
  t = run(st, hand({ x, y }), t, 4.05);
  await Promise.resolve();
  return t;
}

test('휙 던지면 날아가서 멈춘 자리에서 재생', async () => {
  const { st, audio } = setup();
  let t = await makeHeldOrb(st);
  const orb = st.orbs[0];
  st.update(hand({ x: 0.35, vx: 2.5, vy: -0.3 }), t + 0.2); // 오른쪽 위로 휙
  assert.equal(orb.state, 'flying');
  assert.equal(st.mode, 'idle');
  t = run(st, hand({ x: 0.35 }), t + 0.21, t + 3);
  assert.equal(orb.state, 'placed');
  assert.ok(orb.x > 0.6, `날아간 x ${orb.x}`);
  assert.ok(audio.log.some((e) => e[0] === 'play' && e[1] === orb.id));
  const mix = orbMix(orb);
  assert.ok(mix.pan > 0.2, '오른쪽에 떨어지면 오른쪽으로 패닝');
});

test('던지지 않고 손을 내리면(사라지면) 그 자리에 놓인다', async () => {
  const { st, audio } = setup();
  const t = await makeHeldOrb(st, 0.2, 0.3);
  st.update(gone, t + 0.1);
  const orb = st.orbs[0];
  assert.equal(orb.state, 'placed');
  assert.ok(Math.abs(orb.x - 0.2) < 1e-9);
  assert.ok(audio.log.some((e) => e[0] === 'play'));
  assert.ok(orbMix(orb).gain > orbMix({ x: 0.2, y: 0.9, muted: false }).gain, '위에 있을수록 크게');
});

test('핀치로 잡아 옮기기, 주먹으로 터뜨리기, 편 손 대기로 음소거', async () => {
  const { st, audio } = setup();
  let t = await makeHeldOrb(st, 0.3, 0.6);
  st.update(gone, t + 0.05);
  const orb = st.orbs[0];
  const at = { x: orb.x, y: orb.y };
  t += 0.1;
  // 옮기기
  st.update(hand({ ...at }), t);
  st.update(hand({ ...at, pinch: true }), (t += 0.02));
  assert.equal(st.mode, 'drag');
  st.update(hand({ x: at.x + 0.3, y: at.y - 0.2, pinch: true }), (t += 0.02));
  assert.ok(Math.abs(orb.x - (at.x + 0.3)) < 1e-9);
  st.update(hand({ x: at.x + 0.3, y: at.y - 0.2 }), (t += 0.02));
  assert.equal(st.mode, 'idle');
  // 음소거: 편 손을 0.8초 대기
  const on = { x: orb.x, y: orb.y, fingers: 5 };
  t = run(st, hand(on), t, t + 0.5);
  assert.equal(orb.muted, false);
  t = run(st, hand(on), t, t + 0.4);
  assert.equal(orb.muted, true);
  assert.equal(orbMix(orb).gain, 0);
  t = run(st, hand(on), t, t + 1); // 계속 대고 있어도 다시 바뀌지 않음
  assert.equal(orb.muted, true);
  // 터뜨리기
  st.update(hand({ x: orb.x, y: orb.y, fingers: 0, fist: true }), (t += 0.02));
  assert.equal(st.count, 0);
  assert.ok(audio.log.some((e) => e[0] === 'stop' && e[1] === orb.id));
  assert.equal(st.pops.length, 1);
});

test('오브는 최대 6개', async () => {
  const audio = fakeAudio();
  const st = new OrbStation({ transport: new Transport(120, 0), audio, maxOrbs: 1 });
  const t = await makeHeldOrb(st, 0.2, 0.3);
  st.update(gone, t + 0.05);
  st.update(hand({ x: 0.8, y: 0.3 }), t + 0.1);
  st.update(hand({ x: 0.8, y: 0.3, pinch: true }), t + 0.12);
  assert.equal(st.mode, 'idle');
  assert.match(st.message.text, /가득/);
});
