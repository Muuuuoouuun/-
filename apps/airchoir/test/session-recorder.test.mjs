import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRecorder } from '../src/session-recorder.js';

class Clock {
  now = 0;
  nextId = 1;
  timers = new Map();
  set(fn, delay, repeat = false) {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.now + delay, delay, repeat });
    return id;
  }
  advance(ms) {
    const end = this.now + ms;
    while (true) {
      const entry = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry;
      this.now = timer.at;
      if (timer.repeat) timer.at += timer.delay;
      else this.timers.delete(id);
      timer.fn();
    }
    this.now = end;
  }
}

class Track {
  constructor(kind) { this.kind = kind; this.readyState = 'live'; this.stops = 0; this.listeners = new Set(); this.clones = []; }
  clone() { const clone = new Track(this.kind); this.clones.push(clone); return clone; }
  stop() { this.stops++; this.readyState = 'ended'; }
  addEventListener(type, fn) { assert.equal(type, 'ended'); this.listeners.add(fn); }
  removeEventListener(type, fn) { assert.equal(type, 'ended'); this.listeners.delete(fn); }
  end() { this.readyState = 'ended'; for (const fn of [...this.listeners]) fn(); }
}

class Stream {
  constructor(tracks) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}

function setup(options = {}, limits = {}) {
  const clock = new Clock();
  const records = [], videos = [], changes = [], downloads = [], revoked = [];
  const urls = new Map();
  const audio = new Track('audio');
  const camera = new Track('video'); // Deliberately shared stream: camera must never enter the capture.
  const audioStream = new Stream([audio, camera]);
  const canvas = { captureStream(fps) {
    assert.equal(fps, 30);
    if (options.captureError) throw new Error('capture blocked');
    const video = new Track('video'); videos.push(video);
    return new Stream([video]);
  } };
  class Recorder {
    static isTypeSupported(mime) { return (options.supported || ['video/webm;codecs=vp9,opus']).includes(mime); }
    constructor(stream, settings) {
      if (options.constructorError) throw new Error('encoder unavailable');
      this.stream = stream; this.settings = settings;
      this.mimeType = options.mime ?? settings.mimeType;
      this.state = 'inactive'; this.stopCalls = 0;
      records.push(this);
    }
    start(timeslice) {
      assert.equal(timeslice, 1000);
      if (options.startError) throw new Error('start failed');
      this.state = 'recording';
    }
    chunk(data) { this.ondataavailable?.({ data }); }
    stop() {
      this.stopCalls++;
      if (options.stopError) throw new Error('stop failed');
      this.state = 'inactive';
      if (options.finalChunk) this.chunk(options.finalChunk);
      if (options.syncStop !== false) this.finish();
    }
    finish() { this.state = 'inactive'; this.onstop?.(); }
    fail(message) { this.onerror?.({ error: new Error(message) }); }
  }
  let nextUrl = 0;
  const deps = {
    MediaRecorder: Recorder, MediaStream: Stream, Blob,
    now: () => clock.now,
    setInterval: (fn, ms) => clock.set(fn, ms, true), clearInterval: id => clock.timers.delete(id),
    setTimeout: (fn, ms) => clock.set(fn, ms), clearTimeout: id => clock.timers.delete(id),
    URL: {
      createObjectURL(blob) { const url = `blob:test-${++nextUrl}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); urls.delete(url); },
    },
    document: {
      createElement(tag) {
        assert.equal(tag, 'a');
        return { click() { downloads.push([this.href, this.download]); }, remove() {} };
      },
      body: { append() {} },
    },
  };
  const recorder = new SessionRecorder({ deps, onChange: state => changes.push(state), ...limits });
  return { recorder, records, clock, audio, camera, audioStream, canvas, videos, changes, downloads, urls, revoked,
    start: () => recorder.start({ canvas, audioStream, label: 'my/session' }) };
}

test('capability probes formats in order and unsupported browsers fail before capturing tracks', () => {
  const mp4 = setup({ supported: ['video/mp4'] });
  assert.deepEqual(mp4.recorder.capability(mp4.canvas), { supported: true, mime: 'video/mp4', reason: null });
  const noFormat = setup({ supported: [] });
  assert.equal(noFormat.recorder.capability().supported, false);
  assert.equal(noFormat.start(), false);
  assert.match(noFormat.recorder.state.error, /형식/);
  assert.equal(noFormat.videos.length, 0);
  assert.equal(mp4.recorder.capability({}).supported, false);
  const absent = new SessionRecorder({ deps: { MediaRecorder: undefined } });
  assert.equal(absent.capability().supported, false);
});

test('start owns only canvas video and cloned audio; explicit stop preserves a downloadable file', async () => {
  const h = setup();
  assert.equal(h.start(), true);
  const active = h.records[0];
  assert.deepEqual(active.stream.getTracks(), [h.videos[0], h.audio.clones[0]]);
  assert.equal(h.start(), false);
  assert.equal(h.recorder.discard(), false);
  h.clock.advance(1250);
  active.chunk(new Blob(['first'], { type: 'video/webm' }));
  active.chunk(new Blob(['second'], { type: 'video/webm' }));
  const result = await h.recorder.stop();
  assert.equal(result.status, 'ready');
  assert.equal(result.elapsedMs, 1250);
  assert.equal(result.sizeBytes, 11);
  assert.equal(await result.blob.text(), 'firstsecond');
  assert.equal(result.extension, 'webm');
  assert.equal(result.filename, 'my_session.webm');
  assert.equal(h.audio.stops, 0);
  assert.equal(h.camera.stops, 0);
  assert.equal(h.audio.clones[0].stops, 1);
  assert.equal(h.videos[0].stops, 1);
  assert.equal(h.audio.listeners.size, 0);
  assert.equal(h.clock.timers.size, 0);
  assert.deepEqual(h.downloads, []);
  assert.equal(h.recorder.download(), true);
  assert.deepEqual(h.downloads, [[result.url, 'my_session.webm']]);
  const snapshot = h.recorder.state;
  snapshot.status = 'idle';
  assert.equal(h.recorder.state.status, 'ready');
  assert.equal(h.start(), false, 'completed files must be explicitly discarded before replacement');
  assert.equal(h.recorder.state.blob, result.blob);
  h.recorder.discard();
  assert.deepEqual(h.revoked, [result.url]);
  assert.equal(h.start(), true);
  await h.recorder.dispose();
});

test('actual recorder MIME wins over requested format; chunk MIME fills an empty recorder MIME', async () => {
  for (const mime of ['video/mp4', '']) {
    const h = setup({ mime });
    h.start();
    h.records[0].chunk(new Blob(['encoded'], { type: 'video/mp4' }));
    const result = await h.recorder.stop();
    assert.equal(result.mime, 'video/mp4');
    assert.equal(result.blob.type, 'video/mp4');
    assert.equal(result.extension, 'mp4');
    assert.match(result.filename, /\.mp4$/);
  }
});

test('constructor/start/capture failures clean partial tracks and allow an explicit retry', async () => {
  for (const field of ['constructorError', 'startError', 'captureError']) {
    const options = { [field]: true };
    const h = setup(options);
    assert.equal(h.start(), false);
    assert.equal(h.recorder.state.status, 'error');
    assert.equal(h.audio.stops, 0);
    assert.equal(h.camera.stops, 0);
    assert.ok(h.videos.every(track => track.stops === 1));
    assert.ok(h.audio.clones.every(track => track.stops === 1));
    assert.equal(h.clock.timers.size, 0);
    options[field] = false;
    assert.equal(h.start(), true);
    await h.recorder.dispose();
  }
});

test('empty or uncloneable audio fails without ever stopping shared source tracks', () => {
  const h = setup();
  assert.equal(h.recorder.start({ canvas: h.canvas, audioStream: new Stream([]) }), false);
  h.audio.clone = () => h.audio;
  assert.equal(h.start(), false);
  assert.equal(h.audio.stops, 0);
  assert.equal(h.camera.stops, 0);
  assert.equal(h.videos[0].stops, 1);
});

test('empty stop returns an actionable error and synchronous stop resolves without timer leaks', async () => {
  const h = setup();
  h.start();
  const result = await h.recorder.stop();
  assert.equal(result.status, 'error');
  assert.match(result.error, /데이터가 없/);
  assert.equal(result.blob, null);
  assert.equal(h.recorder.download(), false);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.records[0].stopCalls, 1);
});

test('stop is idempotent and accepts final chunks while stopping, ignoring stale callbacks afterward', async () => {
  const h = setup({ syncStop: false });
  h.start();
  const native = h.records[0];
  native.chunk(new Blob(['before']));
  const lateData = native.ondataavailable;
  const lateError = native.onerror;
  const a = h.recorder.stop('user');
  const b = h.recorder.stop('second');
  assert.equal(a, b);
  assert.equal(h.recorder.state.status, 'stopping');
  native.chunk(new Blob(['final']));
  native.finish();
  const result = await a;
  lateData({ data: new Blob(['too late']) });
  lateError({ error: new Error('too late') });
  assert.equal(await h.recorder.state.blob.text(), 'beforefinal');
  assert.equal(h.recorder.state.reason, 'user');
  assert.equal(h.recorder.state.error, null);
  assert.equal(h.recorder.state.url, result.url);
  assert.equal(native.stopCalls, 1);
});

test('recorder and malformed chunk errors preserve the received portion', async () => {
  for (const failure of ['recorder', 'chunk']) {
    const h = setup();
    h.start();
    h.records[0].chunk(new Blob(['saved']));
    if (failure === 'recorder') h.records[0].fail('encoder lost');
    else h.records[0].chunk({ size: 10 });
    const result = h.recorder.state;
    assert.equal(result.status, 'ready');
    assert.equal(await result.blob.text(), 'saved');
    assert.equal(result.reason, `${failure}-error`);
    assert.ok(result.error);
    assert.equal(h.audio.stops, 0);
    assert.equal(h.clock.timers.size, 0);
  }
});

test('size cap keeps only the contiguous prefix and never accepts further oversized chunks', async () => {
  const h = setup({ syncStop: false }, { maxBytes: 10 });
  h.start();
  const native = h.records[0];
  native.chunk(new Blob(['123456']));
  native.chunk(new Blob(['78901']));
  for (let i = 0; i < 100; i++) native.chunk(new Blob(['more']));
  assert.equal(h.recorder.state.status, 'stopping');
  assert.equal(h.recorder.state.sizeBytes, 6);
  native.finish();
  assert.equal(h.recorder.state.reason, 'size-limit');
  assert.equal(await h.recorder.state.blob.text(), '123456');
  assert.ok(h.recorder.state.error);
  assert.deepEqual(h.downloads, []);
  const oversized = setup({}, { maxBytes: 3 });
  oversized.start();
  oversized.records[0].chunk(new Blob(['too big']));
  assert.equal(oversized.recorder.state.status, 'error');
  assert.equal(oversized.recorder.state.blob, null);
  assert.equal(oversized.recorder.state.sizeBytes, 0);
});

test('exact byte and time limits automatically stop without downloading', () => {
  const bytes = setup({}, { maxBytes: 3 });
  bytes.start();
  bytes.records[0].chunk(new Blob(['123']));
  assert.equal(bytes.recorder.state.status, 'ready');
  assert.equal(bytes.recorder.state.reason, 'size-limit');
  const time = setup({}, { maxDurationMs: 500 });
  time.start();
  time.records[0].chunk(new Blob(['part']));
  time.clock.advance(500);
  assert.equal(time.recorder.state.status, 'ready');
  assert.equal(time.recorder.state.reason, 'time-limit');
  assert.equal(time.recorder.state.elapsedMs, 500);
  assert.deepEqual(time.downloads, []);
  const caps = setup({}, { maxBytes: 1e12, maxDurationMs: 1e12 });
  assert.equal(caps.recorder.maxBytes, 128 * 1024 * 1024);
  assert.equal(caps.recorder.maxDurationMs, 600000);
});

test('missing chunks and a missing stop event have bounded timeouts and retain available data', async () => {
  const stall = setup({}, { stallTimeoutMs: 500 });
  stall.start();
  stall.records[0].chunk(new Blob(['part']));
  stall.clock.advance(500);
  assert.equal(stall.recorder.state.reason, 'stall');
  assert.equal(stall.recorder.state.status, 'ready');
  for (const stopError of [false, true]) {
    const h = setup({ syncStop: false, stopError }, { stopTimeoutMs: 500 });
    h.start();
    h.records[0].chunk(new Blob(['before stall']));
    const pending = h.recorder.stop();
    h.clock.advance(500);
    const result = await pending;
    assert.equal(result.status, 'ready');
    assert.equal(result.reason, 'stop-timeout');
    assert.equal(await result.blob.text(), 'before stall');
    assert.ok(result.error);
    assert.equal(h.clock.timers.size, 0);
    assert.equal(h.videos[0].stops, 1);
    assert.equal(h.audio.stops, 0);
  }
});

test('ended canvas, cloned audio, or original mix source stops recording without stopping originals', () => {
  for (const kind of ['video', 'clone', 'original']) {
    const h = setup();
    h.start();
    h.records[0].chunk(new Blob(['part']));
    const track = kind === 'video' ? h.videos[0] : kind === 'clone' ? h.audio.clones[0] : h.audio;
    track.end();
    assert.equal(h.recorder.state.status, 'ready');
    assert.equal(h.recorder.state.reason, 'source-ended');
    assert.equal(h.audio.stops, 0);
    assert.equal(h.camera.stops, 0);
    assert.equal(track.listeners.size, 0);
  }
});

test('dispose can preserve completed data for an explicit download, or release it and its URL', async () => {
  const h = setup();
  h.start();
  h.records[0].chunk(new Blob(['keep']));
  const ready = await h.recorder.dispose({ preserve: true });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.reason, 'dispose');
  assert.equal(h.urls.has(ready.url), true);
  assert.equal(h.start(), false);
  assert.equal(h.recorder.download(), true);
  await h.recorder.dispose();
  assert.equal(h.recorder.state.status, 'idle');
  assert.equal(h.urls.size, 0);
  assert.deepEqual(h.revoked, [ready.url]);
  await h.recorder.dispose();
  assert.deepEqual(h.revoked, [ready.url]);
  assert.equal(h.audio.stops, 0);
  assert.equal(h.camera.stops, 0);
});

test('URL/download failures preserve the completed blob and permit an explicit retry', async () => {
  const h = setup();
  h.start();
  h.records[0].chunk(new Blob(['keep after link failure']));
  const create = h.recorder.deps.URL.createObjectURL;
  h.recorder.deps.URL.createObjectURL = () => { throw new Error('object URL unavailable'); };
  const result = await h.recorder.stop();
  assert.equal(result.status, 'ready');
  assert.equal(result.url, null);
  assert.ok(result.error);
  assert.equal(h.recorder.download(), false);
  assert.equal(h.recorder.state.blob, result.blob);
  assert.deepEqual(h.downloads, []);
  h.recorder.deps.URL.createObjectURL = create;
  assert.equal(h.recorder.download(), true);
  assert.equal(h.downloads.length, 1);
  assert.equal(await h.recorder.state.blob.text(), 'keep after link failure');
  await h.recorder.dispose();
  assert.equal(h.urls.size, 0);
});

test('default browser timers retain their Window receiver through start, progress, stop and cleanup', async t => {
  const h = setup({ syncStop: false });
  const deps = { ...h.recorder.deps };
  const calls = [];
  for (const name of ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']) {
    delete deps[name]; // Exercise the production defaults, not injected arrow-function timers.
    t.mock.method(globalThis, name, function (...args) {
      assert.equal(this, globalThis, `${name} requires the browser global receiver`);
      calls.push(name);
      return h.recorder.deps[name](...args);
    });
  }
  const recorder = new SessionRecorder({ deps });
  assert.equal(recorder.start({ canvas: h.canvas, audioStream: h.audioStream }), true);
  h.clock.advance(250);
  assert.equal(recorder.state.elapsedMs, 250);
  h.records[0].chunk(new Blob(['native timer lifecycle']));
  const stopping = recorder.stop();
  assert.equal(recorder.state.status, 'stopping');
  h.records[0].finish();
  const result = await stopping;
  assert.equal(result.status, 'ready');
  assert.equal(await result.blob.text(), 'native timer lifecycle');
  assert.equal(h.clock.timers.size, 0);
  for (const name of ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']) {
    assert.ok(calls.includes(name), `${name} was exercised`);
  }
});
