import test from 'node:test';
import assert from 'node:assert/strict';
import { Performance } from '../src/performance.js';
import { WheelController } from '../src/wheel-controller.js';
import { cloneConfig, STORAGE_KEY } from '../core/chords.js';

// Exercise the real state/controller methods without constructing WheelUI or requesting devices.
function setup(t, state = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const page = { hidden: false, focused: true, hasFocus() { return this.focused; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  const events = [];
  const audio = {
    accompaniment: {
      release: options => events.push(['release', options]),
      setChord: notes => { events.push(['chord', notes]); return true; },
    },
    setGesture: gesture => events.push(['gesture', gesture]),
    setOutputMuted: muted => events.push(['muted', muted]),
    setProduct: product => events.push(['product', product]),
  };
  const env = { ready: true, camera: true };
  const p = Object.create(Performance.prototype);
  p.state = {
    product: 'chord', hands: 'one', input: 'hands', config: cloneConfig(),
    current: { chord: null, root: null, quality: null, choir: null }, armed: false, status: '',
    ...state,
  };
  p.controller = new WheelController();
  p.blocked = false;
  p.lastCameraFrame = -Infinity;
  p.getAudio = () => audio;
  p.isReady = () => env.ready;
  p.hasCamera = () => env.camera;
  p.onStop = () => events.push(['stop-all']);
  p.onTransition = (product, field) => events.push(['transition', product, field]);
  p.notify = message => events.push(['notice', message]);
  p.render = () => {};
  p.ui = {
    settingsOpen: false,
    getWheelGeometry: () => (p.state.hands === 'two' ? [100, 300] : [100])
      .map(x => ({ center: { x, y: 100 }, radius: 80 })),
  };
  p.storage = { setItem: (key, value) => events.push(['save', key, value]) };
  return { p, page, env, events };
}

const atTop = [{ palm: { x: 100, y: 40 }, pinch: true }];
const identity = point => point;
const sounds = events => events.filter(event => event[0] === 'chord');

for (const [hidden, focused] of [[true, false], [false, false], [true, true]]) {
  test(`background camera frames cannot clear stop or resume notes (hidden=${hidden}, focused=${focused})`, t => {
    const { p, page, events } = setup(t);
    p.stop('window left', true);
    events.length = 0;
    page.hidden = hidden;
    page.focused = focused;
    // This exact sequence previously unblocked the performer and played C3 while hidden.
    p.cameraHands([], identity, 0);
    p.cameraHands(atTop, identity, 10);
    p.cameraHands(atTop, identity, 200);
    assert.equal(p.blocked, true);
    assert.equal(p.state.armed, false);
    assert.deepEqual(events, []);
    page.hidden = false;
    page.focused = true;
    p.cameraHands(atTop, identity, 300);
    p.cameraHands(atTop, identity, 500);
    assert.equal(sounds(events).length, 0, 'returning with the same hand is not fresh intent');
    p.cameraHands([], identity, 510);
    p.cameraHands(atTop, identity, 520);
    p.cameraHands(atTop, identity, 700);
    assert.deepEqual(sounds(events), [['chord', [48, 52, 55]]]);
    assert.equal(p.state.armed, true);
  });
}

test('manual selection is independent of a camera and requires a ready, visible, closed-settings session', t => {
  const { p, page, env, events } = setup(t, { input: 'manual' });
  env.camera = false;
  const selection = { type: 'chord', value: { root: 0, quality: 'maj' } };
  env.ready = false;
  p.select(selection);
  env.ready = true;
  page.hidden = true;
  p.select(selection);
  page.hidden = false;
  p.ui.settingsOpen = true;
  p.select(selection);
  assert.deepEqual(events, []);
  p.ui.settingsOpen = false;
  p.select(selection);
  assert.deepEqual(sounds(events), [['chord', [48, 52, 55]]]);
  assert.equal(p.state.armed, true);
  const stopAt = events.length;
  p.stop();
  assert.equal(p.blocked, true);
  assert.equal(p.state.current.chord, null);
  const stopped = events.slice(stopAt);
  assert.deepEqual(stopped[0], ['release', { immediate: true }]);
  assert.equal(stopped[1][0], 'gesture');
  assert.equal(stopped[1][1].present, false);
  assert.equal(stopped[1][1].fist, true);
  assert.ok(!stopped.some(event => ['muted', 'stop-all'].includes(event[0])),
    'center OFF must preserve the master and existing loop playback');
  p.select(selection);
  assert.equal(sounds(events).length, 2, 'a fresh manual selection may rearm without camera input');
});

test('global stop additionally mutes the master and asks the app to pause existing loops', t => {
  const { p, events } = setup(t, { input: 'manual' });
  p.select({ type: 'chord', value: { root: 0, quality: 'maj' } });
  const stopAt = events.length;
  p.stop('all sounds stopped', true);
  assert.equal(p.state.armed, false);
  assert.equal(p.state.current.chord, null);
  const stopped = events.slice(stopAt);
  assert.deepEqual(stopped[0], ['release', { immediate: true }]);
  assert.equal(stopped[1][0], 'gesture');
  assert.equal(stopped[1][1].present, false);
  assert.deepEqual(stopped.slice(2), [['muted', true], ['stop-all']]);
});

test('two-wheel manual mode waits for both choices and does not reuse selections after a mode change', t => {
  const { p, events } = setup(t, { input: 'manual' });
  p.select({ type: 'chord', value: { root: 0, quality: 'maj' } });
  p.change('hands', 'two');
  assert.equal(p.state.armed, false);
  assert.equal(p.state.current.chord, null);
  assert.equal(p.state.current.root, null);
  assert.ok(events.some(event => event[0] === 'stop-all'));
  const stoppedCount = sounds(events).length;
  p.select({ type: 'root', value: 2 });
  assert.equal(sounds(events).length, stoppedCount);
  assert.equal(p.state.armed, false);
  p.select({ type: 'quality', value: 'min' });
  assert.deepEqual(sounds(events).at(-1), ['chord', [50, 53, 57]]);
  assert.equal(p.state.armed, true);
  p.change('product', 'choir');
  assert.equal(p.state.hands, 'one');
  assert.equal(p.state.armed, false);
  assert.equal(p.state.current.chord, null);
  const before = events.length;
  p.change('hands', 'two');
  assert.equal(p.state.hands, 'one');
  assert.equal(events.length, before);
});

test('a live manual chord session cannot switch to hands without a camera session', t => {
  const { p, env, events } = setup(t, { input: 'manual' });
  env.camera = false;
  p.change('input', 'hands');
  assert.equal(p.state.input, 'manual');
  assert.ok(events.some(event => event[0] === 'notice'));
  assert.ok(!events.some(event => event[0] === 'transition'));
  env.camera = true;
  p.change('input', 'hands');
  assert.equal(p.state.input, 'hands');
  assert.ok(events.some(event => event[0] === 'stop-all'));
  assert.deepEqual(events.at(-1), ['transition', 'chord', 'input']);
  const before = events.length;
  p.select({ type: 'chord', value: { root: 0, quality: 'maj' } });
  assert.equal(events.length, before, 'manual callbacks cannot own a hands session');
});

test('valid configuration changes stop performance, save only settings, and preserve caller ownership', t => {
  const { p, events } = setup(t, { input: 'manual' });
  p.select({ type: 'chord', value: { root: 0, quality: 'maj' } });
  const config = cloneConfig();
  config.chords.reverse();
  config.device = 'must not persist';
  assert.equal(p.apply(config), true);
  assert.equal(p.blocked, true);
  assert.equal(p.state.armed, false);
  assert.equal(p.state.current.chord, null);
  assert.equal(p.state.input, 'manual');
  const saved = events.find(event => event[0] === 'save');
  assert.equal(saved[1], STORAGE_KEY);
  assert.deepEqual(JSON.parse(saved[2]), p.state.config);
  assert.equal('device' in JSON.parse(saved[2]), false);
  assert.ok(events.findIndex(event => event[0] === 'stop-all') < events.indexOf(saved));
  config.chords[0].root = 1;
  assert.equal(p.state.config.chords[0].root, 10);
  assert.equal(config.device, 'must not persist');
});

test('invalid settings preserve the current configuration; storage errors retain only the session edit', t => {
  const { p, events } = setup(t, { input: 'manual' });
  const original = p.state.config;
  assert.equal(p.apply({ ...cloneConfig(), chords: [] }), false);
  assert.equal(p.state.config, original);
  assert.ok(!events.some(event => ['save', 'stop-all'].includes(event[0])));
  p.storage = { setItem() { throw new Error('QuotaExceededError'); } };
  const config = cloneConfig();
  config.roots = [7, 0];
  assert.equal(p.apply(config), true);
  assert.deepEqual(p.state.config.roots, [7, 0]);
  assert.equal(p.blocked, true);
  assert.match(events.at(-1)[1], /이번 세션|저장하지 못/);
});

test('legacy gestures retain motion data, honor configured preset order, and stop while settings or stop is active', t => {
  const { p, events } = setup(t, { product: 'choir' });
  p.state.config.choir = [4, 2];
  const gesture = { present: true, fist: false, pinch: true, preset: 1, level: .8, brightness: .3,
    screen: { palm: { x: .2, y: .3 } }, velocity: { x: 1, y: 2 } };
  const mapped = p.routeLegacy(gesture);
  assert.equal(mapped.preset, 4);
  assert.equal(mapped.pinch, true);
  assert.deepEqual(mapped.screen, gesture.screen);
  assert.deepEqual(mapped.velocity, gesture.velocity);
  assert.equal(gesture.preset, 1);
  assert.equal(p.routeLegacy({ ...gesture, preset: 4 }).preset, 2);
  p.stop();
  const before = events.length;
  assert.equal(p.routeLegacy(gesture).present, false);
  assert.equal(events.length, before);
  p.ui.settingsOpen = true;
  p.rearmLegacy();
  assert.equal(p.blocked, true);
  p.ui.settingsOpen = false;
  p.rearmLegacy();
  assert.equal(p.routeLegacy(gesture).preset, 4);
});

test('camera watchdog releases active sound and requires a fresh hand after input resumes', t => {
  const { p, events } = setup(t);
  p.cameraHands(atTop, identity, 0);
  p.cameraHands(atTop, identity, 180);
  assert.equal(p.state.armed, true);
  const stopAt = events.length;
  p.tick(481, true);
  assert.equal(p.state.armed, false);
  assert.equal(p.blocked, true);
  const stopped = events.slice(stopAt);
  assert.deepEqual(stopped[0], ['release', { immediate: true }]);
  assert.equal(stopped[1][0], 'gesture');
  assert.equal(stopped[1][1].present, false);
  assert.ok(!stopped.some(event => ['muted', 'stop-all'].includes(event[0])),
    'loss of live hand input must not stop recorded loops');
  p.cameraHands(atTop, identity, 500);
  p.cameraHands(atTop, identity, 700);
  assert.equal(sounds(events).length, 1);
  p.cameraHands([], identity, 710);
  p.cameraHands(atTop, identity, 720);
  p.cameraHands(atTop, identity, 900);
  assert.equal(sounds(events).length, 2);
});

for (const count of ['one', 'two']) {
  test(`${count} camera hands release notes without stopping loops or interrupting video, then require fresh dwell`, t => {
    const { p, events } = setup(t, { hands: count });
    p.onInterrupt = reason => events.push(['interrupt', reason]);
    const hands = count === 'one' ? atTop : [...atTop, { palm: { x: 300, y: 40 }, pinch: true }];
    p.cameraHands(hands, identity, 0);
    p.cameraHands(hands, identity, 150);
    assert.equal(p.state.armed, true);
    for (let i = 0; i < hands.length; i++) {
      const start = 200 + i * 300;
      const before = events.length;
      p.cameraHands(hands.map((hand, j) => ({ ...hand, pinch: j !== i })), identity, start);
      assert.equal(p.state.armed, false);
      assert.deepEqual(p.state.current, { chord: null, root: null, quality: null, choir: null });
      assert.equal(p.blocked, false);
      assert.ok(events.slice(before).some(event => event[0] === 'release'));
      assert.ok(!events.slice(before).some(event => ['muted', 'stop-all', 'interrupt'].includes(event[0])));
      p.cameraHands(hands, identity, start + 10);
      p.cameraHands(hands, identity, start + 159);
      assert.equal(p.state.armed, false, 'old selection/dwell is not reused');
      p.cameraHands(hands, identity, start + 160);
      assert.equal(p.state.armed, true);
    }
  });
}

test('one or both missing camera hands clear the complete chord and require a new pair', t => {
  const { p } = setup(t, { hands: 'two' });
  const hands = [...atTop, { palm: { x: 300, y: 40 }, pinch: true }];
  p.cameraHands(hands, identity, 0);
  p.cameraHands(hands, identity, 150);
  for (const [index, remaining] of [[0, hands.slice(0, 1)], [1, hands.slice(1)], [2, []]]) {
    const now = 200 + index * 300;
    p.cameraHands(remaining, identity, now);
    assert.equal(p.state.armed, false);
    assert.equal(p.state.current.chord, null);
    p.cameraHands(hands, identity, now + 10);
    assert.equal(p.state.armed, false);
    p.cameraHands(hands, identity, now + 160);
    assert.equal(p.state.armed, true);
  }
});

test('after blur stop, releasing the pinch rearms without a separate OFF or removing the hand', t => {
  const { p } = setup(t);
  p.cameraHands(atTop, identity, 0);
  p.cameraHands(atTop, identity, 150);
  p.stop('blur', true);
  p.cameraHands(atTop, identity, 200);
  p.cameraHands(atTop, identity, 400);
  assert.equal(p.state.armed, false);
  p.cameraHands([{ ...atTop[0], pinch: false }], identity, 410);
  assert.equal(p.blocked, false);
  p.cameraHands(atTop, identity, 420);
  assert.equal(p.state.armed, false);
  p.cameraHands(atTop, identity, 570);
  assert.equal(p.state.armed, true);
});

test('camera termination and watchdog release the live instrument without a global stop', t => {
  for (const terminated of [true, false]) {
    const { p, env, events } = setup(t);
    p.cameraHands(atTop, identity, 0);
    p.cameraHands(atTop, identity, 150);
    const before = events.length;
    if (terminated) env.camera = false;
    p.tick(terminated ? 160 : 401, true);
    assert.equal(p.state.armed, false);
    assert.equal(p.state.current.chord, null);
    assert.equal(p.blocked, true);
    assert.ok(!events.slice(before).some(event => ['muted', 'stop-all'].includes(event[0])));
    env.camera = true;
    p.cameraHands(atTop, identity, 450);
    p.cameraHands(atTop, identity, 650);
    assert.equal(p.state.armed, false, 'held input cannot revive the old chord after an interruption');
  }
});

test('choir camera loss/fist clears the preset without assigning pinch to a new gesture', t => {
  const { p } = setup(t, { product: 'choir' });
  const singing = { present: true, fist: false, pinch: false, preset: 2, level: .7, brightness: .5 };
  assert.equal(p.routeLegacy(singing).preset, 2);
  assert.equal(p.state.armed, true);
  p.routeLegacy({ ...singing, present: false });
  assert.equal(p.state.armed, false);
  assert.equal(p.state.current.choir, null);
  p.routeLegacy({ ...singing, preset: 3 });
  p.routeLegacy({ ...singing, fist: true, preset: 0 });
  assert.equal(p.state.armed, false);
  assert.equal(p.state.current.choir, null);
});

test('화음 성격: 보이싱을 바꾸면 들고 있는 코드를 바로 다시 쌓고, 합창 성격은 엔진에 넘기고, 선택만 저장한다', t => {
  const { p, events } = setup(t, { input: 'manual' });
  p.styles = { choir: 'classic', voicing: 'close', smooth: true };
  const params = [];
  p.getAudio().setParams = value => params.push(value);
  p.select({ type: 'chord', value: { root: 0, quality: 'maj' } });
  assert.deepEqual(sounds(events).at(-1), ['chord', [48, 52, 55]]);

  assert.equal(p.setStyle('voicing', 'open'), true);
  assert.deepEqual(sounds(events).at(-1), ['chord', [36, 43, 52, 60, 67]], '연주 중인 C를 오픈 보이싱으로');
  assert.equal(p.state.armed, true);
  assert.match(p.state.status, /C · 오픈 연주 중/);
  const saved = events.filter(event => event[0] === 'save' && event[1] === 'airchoir.harmony.v1').at(-1);
  assert.deepEqual(JSON.parse(saved[2]), { choir: 'classic', voicing: 'open', smooth: true, swipe: true });

  assert.equal(p.setStyle('voicing', 'open'), false, '같은 값은 다시 쌓지 않음');
  assert.equal(p.setStyle('voicing', '없는 성격'), false);
  assert.equal(p.setStyle('volume', 1), false);
  assert.equal(p.setStyle('choir', 'ballad'), true);
  assert.deepEqual(params.at(-1), { style: 'ballad' });

  // H 키: 지금 악기(코드)의 성격을 다음으로
  assert.equal(p.cycleStyle(), true);
  assert.equal(p.styles.voicing, 'power');
  assert.deepEqual(sounds(events).at(-1), ['chord', [36, 43, 48, 55]]);

  // 부드럽게 잇기: 공통음 C를 남기고 F로. 전체 정지 뒤에는 기본 높이에서 새로
  p.setStyle('voicing', 'close');
  p.select({ type: 'chord', value: { root: 5, quality: 'maj' } });
  assert.deepEqual(sounds(events).at(-1), ['chord', [48, 53, 57]]);
  p.stop('all', true);
  p.select({ type: 'chord', value: { root: 5, quality: 'maj' } });
  assert.deepEqual(sounds(events).at(-1), ['chord', [53, 57, 60]]);
  assert.equal(p.setStyle('smooth', false), true);
  p.select({ type: 'chord', value: { root: 0, quality: 'maj' } });
  assert.deepEqual(sounds(events).at(-1), ['chord', [48, 52, 55]]);
});

test('화음 성격: 합창에서 H는 합창 쌓기 방식을 바꾸고 설명을 상태 줄에 보여 준다', t => {
  const { p } = setup(t, { product: 'choir', input: 'hands' });
  p.styles = { choir: 'drone', voicing: 'close', smooth: true };
  const params = [];
  p.getAudio().setParams = value => params.push(value);
  assert.equal(p.cycleStyle(), true);
  assert.equal(p.styles.choir, 'classic', '마지막 다음은 처음');
  assert.deepEqual(params, [{ style: 'classic' }]);
  assert.match(p.state.status, /정석 3도/);
  assert.equal(p.styles.voicing, 'close');
});

test('키보드 연주: 숫자 줄로 휠 항목을 고르고, 울리는 항목의 키를 다시 누르면 OFF', t => {
  const { p, events } = setup(t, { input: 'manual' });
  p.styles = { choir: 'classic', voicing: 'close', smooth: false };
  assert.equal(p.keySelect('Digit1'), true);
  assert.deepEqual(sounds(events).at(-1), ['chord', [48, 52, 55]]);
  assert.equal(p.state.armed, true);
  p.keySelect('Digit6'); // 기본 휠 여섯째 = Am
  assert.deepEqual(p.state.current.chord, { root: 9, quality: 'min' });
  const before = sounds(events).length;
  assert.equal(p.keySelect('Digit6'), true);
  assert.equal(p.state.armed, false, '같은 키 = OFF');
  assert.equal(sounds(events).length, before);
  assert.equal(p.keySelect('Digit9'), true, '휠에 없는 자리는 다른 단축키로 넘기지 않고 무시');
  assert.equal(p.state.armed, false);
  assert.equal(p.keySelect('KeyZ'), false, '한 손 코드는 아래 줄을 쓰지 않음');

  // 두 손: 숫자 줄 = 근음, 아래 줄 = 코드 종류
  p.change('hands', 'two');
  p.keySelect('Digit4');
  assert.equal(p.state.armed, false, '근음만으로는 소리 나지 않음');
  p.keySelect('KeyX');
  assert.deepEqual(p.state.current.chord, { root: 5, quality: 'min' });
  assert.deepEqual(sounds(events).at(-1), ['chord', [53, 56, 60]]);
});

test('키보드 연주: 손동작 조작·설정 중·세션 전에는 키를 가로채지 않는다', t => {
  const { p, env, events } = setup(t, { input: 'hands' });
  assert.equal(p.keySelect('Digit1'), false);
  p.state.input = 'manual';
  p.ui.settingsOpen = true;
  assert.equal(p.keySelect('Digit1'), false);
  p.ui.settingsOpen = false;
  env.ready = false;
  assert.equal(p.keySelect('Digit1'), false);
  assert.deepEqual(sounds(events), []);
});

test('키보드 연주: 합창 휠은 숫자로 인원을 고르고, Shift+H(이전)로 화음 성격을 되돌린다', t => {
  const { p, events } = setup(t, { product: 'choir', input: 'manual' });
  p.styles = { choir: 'classic', voicing: 'close', smooth: true };
  p.getAudio().setParams = () => {};
  const flashes = [];
  p.ui.flashStyle = info => flashes.push(info.id);
  p.keySelect('Digit3');
  const gesture = events.filter(event => event[0] === 'gesture').at(-1)[1];
  assert.equal(gesture.preset, 3);
  assert.equal(p.state.current.choir, 3);
  p.keySelect('Digit3');
  assert.equal(p.state.current.choir, null, '같은 키 = OFF');
  assert.equal(p.cycleStyle(-1), true);
  assert.equal(p.styles.choir, 'drone', '처음의 이전은 마지막');
  p.cycleStyle(1);
  assert.equal(p.styles.choir, 'classic');
  assert.deepEqual(flashes, ['drone', 'classic'], '바꿀 때마다 무대에 이름을 띄운다');
});

test('손 휙으로 화음 성격: 손동작 조작에서만, 끄면 넘기지 않고, 소리 없이 정지 뒤에도 바꿀 수 있다', t => {
  const { p, page, env } = setup(t, { product: 'choir', input: 'hands' });
  p.styles = { choir: 'classic', voicing: 'close', smooth: true, swipe: true };
  p.getAudio().setParams = () => {};
  assert.equal(p.swipeStyle(1), true);
  assert.equal(p.styles.choir, 'ballad');
  assert.equal(p.swipeStyle(-1), true);
  assert.equal(p.styles.choir, 'classic');
  assert.equal(p.swipeStyle(0), false);
  p.stop('all', true);
  assert.equal(p.swipeStyle(1), true, '전체 정지 뒤에도');
  p.setStyle('swipe', false);
  assert.equal(p.swipeStyle(1), false, '꺼 두면 넘기지 않음');
  assert.equal(p.styles.choir, 'ballad');
  p.setStyle('swipe', true);
  page.hidden = true;
  assert.equal(p.swipeStyle(1), false, '페이지가 숨겨지면');
  page.hidden = false;
  p.ui.settingsOpen = true;
  assert.equal(p.swipeStyle(1), false, '설정 중');
  p.ui.settingsOpen = false;
  env.ready = false;
  assert.equal(p.swipeStyle(1), false, '세션 전');
  env.ready = true;
  p.state.input = 'manual';
  assert.equal(p.swipeStyle(1), false, '클릭·키보드 조작');
  // 코드 악기 손동작에서는 보이싱을 넘긴다
  p.state.product = 'chord'; p.state.input = 'hands';
  assert.equal(p.swipeStyle(1), true);
  assert.equal(p.styles.voicing, 'ballad');
});
