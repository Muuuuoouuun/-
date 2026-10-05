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

const atTop = [{ palm: { x: 100, y: 40 } }];
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
