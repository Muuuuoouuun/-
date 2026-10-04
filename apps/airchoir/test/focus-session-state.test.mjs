import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusSession } from '../src/focus-session.js';
import { Performance } from '../src/performance.js';
import { cloneConfig } from '../core/chords.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

// Real coordination methods with tiny media/UI doubles. No DOM constructor,
// device access, MediaRecorder, canvas or fullscreen permission is invoked.
function setup(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const page = {
    hidden: false, dialog: false, fullscreenElement: null,
    documentElement: {}, querySelector: () => page.dialog ? {} : null,
    async exitFullscreen() { page.fullscreenElement = null; },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  const events = [], renders = [];
  const env = { ready: true, camera: true, supported: true };
  const track = { readyState: 'live', muted: false };
  const audioStream = { getAudioTracks: () => [] };
  const state = { status: 'idle', blob: null, url: null, error: null, elapsedMs: 0, sizeBytes: 0, mime: '', filename: '' };
  const recorder = {
    state,
    capability: () => ({ supported: env.supported, reason: env.supported ? null : '녹화 형식을 지원하지 않아요.' }),
    start(options) {
      events.push(['start', options]);
      if (!env.supported) { state.status = 'error'; state.error = '녹화 형식을 지원하지 않아요.'; return false; }
      if (state.status === 'recording' || state.status === 'stopping' || state.blob) return false;
      state.status = 'recording'; return true;
    },
    stop(reason) {
      events.push(['record-stop', reason]); state.status = 'stopping';
      return Promise.resolve(state);
    },
  };
  const focus = Object.create(FocusSession.prototype);
  Object.assign(focus, {
    active: false, exiting: false, message: '', mutedSince: null, lastDraw: -Infinity, lastRender: -Infinity,
    video: { hidden: false, readyState: 4, srcObject: { getVideoTracks: () => [track] } },
    isReady: () => env.ready, isCameraReady: () => env.camera,
    getAudio: () => ({ getRecordingStream() { events.push(['audio-stream']); return audioStream; } }),
    getPerformance: () => ({ product: 'chord', hands: 'two', status: '선택 대기' }),
    onStop: () => events.push(['sound-stop']), notify: message => events.push(['notice', message]),
    capture: {
      canvas: {},
      resizeForRecording() { events.push(['resize']); },
      draw() { events.push(['draw']); return this.canvas; },
    },
    recorder,
    ui: { enter: () => events.push(['ui-enter']), exit: () => events.push(['ui-exit']), render: view => renders.push(view) },
  });
  return { focus, page, env, track, recorder, state, audioStream, events, renders };
}

const recordStops = events => events.filter(event => event[0] === 'record-stop');

test('entering focus stops live sound but never starts recording automatically', t => {
  const { focus, env, events, renders } = setup(t);
  env.ready = false;
  assert.equal(focus.enter(), false);
  assert.deepEqual(events, []);
  env.ready = true;
  assert.equal(focus.enter(), true);
  assert.equal(focus.active, true);
  assert.deepEqual(events, [['sound-stop'], ['ui-enter']]);
  assert.equal(renders.at(-1).recording, false);
  assert.equal(renders.at(-1).canRecord, true);
  assert.equal(focus.enter(), true);
  assert.equal(events.length, 2, 'reentering does not repeat startup effects');
});

test('camera-free performance focus remains usable while video recording is unavailable', t => {
  const { focus, env, events, renders } = setup(t);
  env.camera = false;
  assert.equal(focus.enter(), true);
  assert.equal(renders.at(-1).active, true);
  assert.equal(renders.at(-1).canRecord, false);
  assert.match(renders.at(-1).recordingError, /카메라/);
  assert.equal(focus.startRecording(), false);
  assert.ok(!events.some(event => ['resize', 'draw', 'audio-stream', 'start'].includes(event[0])));
});

test('recording start requires an explicit action in a ready visible camera session with no dialog', t => {
  const { focus, env, track, page, events } = setup(t);
  for (const invalid of ['inactive', 'not-ready', 'camera-session', 'hidden-video', 'video-not-ready', 'ended-track', 'hidden-page', 'dialog']) {
    Object.assign(env, { ready: true, camera: true });
    track.readyState = 'live'; page.hidden = page.dialog = false;
    Object.assign(focus.video, { hidden: false, readyState: 4 });
    events.length = 0;
    focus.active = true;
    if (invalid === 'inactive') focus.active = false;
    if (invalid === 'not-ready') env.ready = false;
    if (invalid === 'camera-session') env.camera = false;
    if (invalid === 'hidden-video') focus.video.hidden = true;
    if (invalid === 'video-not-ready') focus.video.readyState = 1;
    if (invalid === 'ended-track') track.readyState = 'ended';
    if (invalid === 'hidden-page') page.hidden = true;
    if (invalid === 'dialog') page.dialog = true;
    assert.equal(focus.startRecording(), false, invalid);
    assert.ok(!events.some(event => event[0] === 'start'), invalid);
  }
});

test('explicit recording start passes only the existing canvas and application audio stream', t => {
  const { focus, events, audioStream, renders } = setup(t);
  focus.enter(); events.length = 0;
  assert.equal(focus.startRecording(), true);
  assert.deepEqual(events.map(event => event[0]), ['resize', 'draw', 'audio-stream', 'start']);
  assert.deepEqual(events.at(-1)[1], { canvas: focus.capture.canvas, audioStream, label: 'airchoir-performance' });
  assert.equal(renders.at(-1).recording, true);
});

test('unsupported recording preserves focus, explains the failure and never reports recording', t => {
  const { focus, env, renders, state } = setup(t);
  env.supported = false;
  focus.enter();
  assert.equal(renders.at(-1).canRecord, false);
  assert.equal(focus.startRecording(), false);
  assert.equal(focus.active, true);
  assert.notEqual(state.status, 'recording');
  assert.match(renders.at(-1).recordingError, /지원/);
});

test('a completed clip blocks replacement before the canvas or audio tap is touched', t => {
  const { focus, state, events, renders } = setup(t);
  const blob = new Blob(['previous take'], { type: 'video/webm' });
  Object.assign(state, { status: 'ready', blob, url: 'blob:previous', filename: 'previous.webm', sizeBytes: blob.size });
  focus.enter(); events.length = 0;
  assert.equal(focus.startRecording(), false);
  assert.equal(state.blob, blob);
  assert.equal(state.url, 'blob:previous');
  assert.equal(renders.at(-1).canRecord, false);
  assert.match(focus.message, /기존 영상/);
  assert.deepEqual(events, []);
});

test('recording boundaries request stop synchronously and pass through its finalization promise', async t => {
  const { focus, state, recorder, events } = setup(t);
  const finish = deferred();
  recorder.stop = reason => { events.push(['record-stop', reason]); state.status = 'stopping'; return finish.promise; };
  state.status = 'recording';
  const pending = focus.boundary('settings');
  assert.equal(pending, finish.promise);
  assert.deepEqual(recordStops(events), [['record-stop', 'settings']]);
  assert.match(focus.message, /설정/);
  const clip = { status: 'ready', blob: new Blob(['last chunk']) };
  finish.resolve(clip);
  assert.equal(await pending, clip);
  state.status = 'ready'; state.blob = clip.blob;
  assert.equal(await focus.boundary('mode-change'), state);
  assert.equal(recordStops(events).length, 1, 'a completed clip is never stopped or discarded');
});

test('a boundary pauses a completed clip preview immediately without discarding the clip', async t => {
  const { focus, state, events, renders } = setup(t);
  const blob = new Blob(['completed take'], { type: 'video/webm' });
  Object.assign(state, { status: 'ready', blob, url: 'blob:completed', filename: 'completed.webm',
    mime: blob.type, sizeBytes: blob.size, elapsedMs: 1200 });
  let playing = true;
  focus.ui.pausePreview = () => { playing = false; events.push(['preview-paused']); };
  const pending = focus.boundary('mode-change');
  assert.equal(playing, false, 'pause happens before the boundary promise resolves');
  assert.deepEqual(events, [['preview-paused']]);
  assert.equal(await pending, state);
  assert.equal(state.status, 'ready');
  assert.equal(state.blob, blob);
  assert.equal(state.url, 'blob:completed');
  focus.render();
  assert.equal(renders.at(-1).result.filename, 'completed.webm');
  assert.equal(renders.at(-1).result.url, 'blob:completed');
  assert.equal(recordStops(events).length, 0, 'a ready clip has no active recorder to stop');
});

test('async focus exit waits for the final clip and preserves it after leaving fullscreen', async t => {
  const { focus, recorder, state, page, events, renders } = setup(t);
  focus.active = true; state.status = 'recording'; page.fullscreenElement = {};
  const finish = deferred();
  recorder.stop = reason => { events.push(['record-stop', reason]); state.status = 'stopping'; return finish.promise; };
  const exit = focus.exit();
  assert.equal(focus.exiting, true);
  assert.equal(focus.active, true);
  assert.equal(focus.enter(), false);
  await focus.exit();
  assert.equal(recordStops(events).length, 1, 'a repeated exit cannot replace finalization');
  assert.ok(!events.some(event => event[0] === 'ui-exit'));
  const blob = new Blob(['completed take'], { type: 'video/webm' });
  Object.assign(state, { status: 'ready', blob, url: 'blob:finished', mime: 'video/webm', filename: 'take.webm', sizeBytes: blob.size });
  finish.resolve(state);
  await exit;
  assert.equal(focus.active, false); assert.equal(focus.exiting, false);
  assert.equal(page.fullscreenElement, null);
  assert.equal(state.blob, blob);
  assert.equal(renders.at(-1).result.filename, 'take.webm');
  assert.equal(renders.at(-1).result.url, 'blob:finished');
  assert.deepEqual(recordStops(events), [['record-stop', 'exit-focus']]);
});

test('session end requests finalization before returning while retaining the eventual result', async t => {
  const { focus, recorder, state, events, renders } = setup(t);
  focus.active = true; state.status = 'recording';
  const finish = deferred();
  recorder.stop = reason => { events.push(['record-stop', reason]); state.status = 'stopping'; return finish.promise; };
  focus.sessionEnded();
  assert.equal(focus.active, false);
  assert.deepEqual(events, [['record-stop', 'session-ended'], ['ui-exit']]);
  const blob = new Blob(['session tail']);
  Object.assign(state, { status: 'ready', blob, filename: 'tail.webm', sizeBytes: blob.size });
  finish.resolve(state); await finish.promise;
  focus.render();
  assert.equal(state.blob, blob);
  assert.equal(renders.at(-1).result.filename, 'tail.webm');
});

test('ended camera stops recording but missing hand landmarks alone do not', t => {
  const { focus, state, track, events } = setup(t);
  focus.active = true; state.status = 'recording';
  // A hand-tracker watchdog releases instrument notes but does not interrupt the
  // separate recording boundary while video frames and the camera stay healthy.
  const performer = Object.create(Performance.prototype);
  performer.state = { product: 'chord', input: 'hands', armed: true };
  performer.lastCameraFrame = 0;
  performer.hasCamera = () => track.readyState === 'live' && !track.muted;
  performer.controller = { tick: () => ({ active: false }) };
  performer.stop = () => { performer.state.armed = false; events.push(['hand-sound-stop']); };
  performer.onInterrupt = reason => focus.boundary(reason);
  performer.tick(400, true);
  focus.tick(400);
  assert.equal(state.status, 'recording');
  assert.equal(recordStops(events).length, 0);
  assert.ok(events.some(event => event[0] === 'draw'));
  track.readyState = 'ended';
  focus.tick(450);
  assert.deepEqual(recordStops(events), [['record-stop', 'camera-ended']]);
});

test('a briefly muted camera can recover, while continuous mute stops after its grace period', t => {
  const { focus, state, track, events } = setup(t);
  focus.active = true; state.status = 'recording';
  track.muted = true; focus.tick(0); focus.tick(1490);
  assert.equal(recordStops(events).length, 0);
  track.muted = false; focus.tick(1495);
  assert.equal(focus.mutedSince, null);
  track.muted = true; focus.tick(1600); focus.tick(3100);
  assert.equal(recordStops(events).length, 0);
  focus.tick(3101);
  assert.deepEqual(recordStops(events), [['record-stop', 'camera-muted']]);
});

test('capture failures stop recording without throwing through the animation frame', t => {
  const { focus, state, events } = setup(t);
  for (const draw of [() => false, () => { throw new Error('canvas unavailable'); }]) {
    events.length = 0; focus.lastDraw = -Infinity;
    focus.active = true; state.status = 'recording'; focus.capture.draw = draw;
    assert.doesNotThrow(() => focus.tick(100));
    assert.deepEqual(recordStops(events), [['record-stop', 'render-error']]);
  }
});

test('blob URL failure still exposes the result and retry-download metadata', t => {
  const { focus, state, renders } = setup(t);
  const blob = new Blob(['recoverable video'], { type: 'video/webm' });
  Object.assign(state, { status: 'ready', blob, url: null, filename: 'recoverable.webm', mime: blob.type,
    sizeBytes: blob.size, elapsedMs: 2450, error: '파일 링크를 만들지 못했습니다. 다운로드를 다시 눌러 주세요.' });
  focus.active = true; focus.render();
  assert.deepEqual(renders.at(-1).result, { url: null, filename: 'recoverable.webm', mimeType: 'video/webm', durationMs: 2450, size: blob.size });
  assert.equal(renders.at(-1).canRecord, false);
  assert.match(renders.at(-1).recordingError, /다운로드를 다시/);
  focus.sessionEnded();
  assert.equal(state.blob, blob);
  assert.equal(renders.at(-1).result.filename, 'recoverable.webm');
});

test('fullscreen entry or exit rejection leaves the focus layout usable', async t => {
  const { focus, page, events, renders } = setup(t);
  focus.active = true;
  page.documentElement.requestFullscreen = async () => { throw new Error('denied'); };
  await focus.toggleFullscreen();
  assert.equal(focus.active, true);
  assert.match(renders.at(-1).recordingError, /현재 집중 화면/);
  page.fullscreenElement = {};
  page.exitFullscreen = async () => { throw new Error('denied'); };
  await focus.toggleFullscreen();
  assert.equal(focus.active, true);
  assert.deepEqual(events, []);
  await focus.exit();
  assert.equal(focus.active, false, 'leaving application focus must work even if fullscreen exit fails');
  assert.ok(events.some(event => event[0] === 'ui-exit'));
});

test('performance mode/settings changes invoke the recording boundary before changing product or wheel data', t => {
  const { focus, state, events } = setup(t);
  const performer = Object.create(Performance.prototype);
  performer.state = { product: 'chord', hands: 'one', input: 'manual', config: cloneConfig() };
  performer.onInterrupt = reason => {
    events.push(['boundary-snapshot', performer.state.product, performer.state.config.chords[0].root]);
    focus.boundary(reason);
  };
  performer.stop = () => {};
  performer.render = () => {};
  performer.onTransition = () => {};
  performer.notify = () => {};
  performer.storage = { setItem() {} };
  state.status = 'recording';
  performer.change('product', 'choir');
  assert.deepEqual(events.slice(0, 2), [['boundary-snapshot', 'chord', 0], ['record-stop', 'mode-change']]);
  assert.equal(performer.state.product, 'choir');
  state.status = 'recording'; events.length = 0;
  const config = cloneConfig(); config.chords.reverse();
  assert.equal(performer.apply(config), true);
  assert.deepEqual(events.slice(0, 2), [['boundary-snapshot', 'choir', 0], ['record-stop', 'settings']]);
  assert.equal(performer.state.config.chords[0].root, 10);
});
