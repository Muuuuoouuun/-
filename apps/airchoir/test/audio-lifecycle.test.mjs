import test from 'node:test';
import assert from 'node:assert/strict';
import { ChoirAudio } from '../src/audio.js';
import { OrbStation, Transport } from '../src/orbs.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fakeWebAudio(t, load = async () => {}) {
  const contexts = [];
  class Node {
    constructor() {
      this.disconnected = false;
      this.connections = [];
      this.gain = this.frequency = this.Q = this.pan = {
        value: 0,
        setTargetAtTime(value) { this.value = value; },
        setValueAtTime(value) { this.value = value; },
        exponentialRampToValueAtTime(value) { this.value = value; },
        linearRampToValueAtTime(value) { this.value = value; },
        cancelScheduledValues() {},
      };
      this.port = { messages: [], postMessage(m) { this.messages.push(m); }, close() {} };
    }
    connect(node) { this.connections.push(node); return node; }
    disconnect() { this.disconnected = true; this.connections = []; }
    start() {}
    stop() { this.stopped = true; }
  }
  class Context {
    constructor() {
      contexts.push(this);
      this.state = 'running'; this.currentTime = 5; this.sampleRate = 8000;
      this.destination = new Node();
      this.audioWorklet = { addModule: load };
      this.oscillators = [];
      this.mediaDestinations = [];
    }
    createGain() { return new Node(); }
    createBiquadFilter() { return new Node(); }
    createConvolver() { return new Node(); }
    createStereoPanner() { return new Node(); }
    createBufferSource() { return new Node(); }
    createMediaStreamSource() { return new Node(); }
    createMediaStreamDestination() {
      const track = () => ({
        kind: 'audio', readyState: 'live', stops: 0,
        stop() { this.stops++; this.readyState = 'ended'; },
        clone() { return track(); },
      });
      const tracks = [track()];
      const destination = new Node();
      destination.stream = { getTracks: () => [...tracks], getAudioTracks: () => [...tracks] };
      this.mediaDestinations.push(destination);
      return destination;
    }
    createOscillator() { const node = new Node(); this.oscillators.push(node); return node; }
    createBuffer(channels, len, sr) {
      const data = Array.from({ length: channels }, () => new Float32Array(len));
      return { length: len, sampleRate: sr, getChannelData: (c) => data[c], copyToChannel: (ch, c) => data[c].set(ch) };
    }
    async close() { this.state = 'closed'; }
    async resume() { this.state = 'running'; }
  }
  t.mock.method(globalThis, 'AudioContext', function (...args) { return new Context(...args); });
  t.mock.method(globalThis, 'AudioWorkletNode', function (...args) { return new Node(...args); });
  return contexts;
}

// node:test mock.method requires existing properties in Node, where WebAudio is absent.
globalThis.AudioContext ||= function () {};
globalThis.AudioWorkletNode ||= function () {};

test('failed worklet init closes the partial graph and can retry', async (t) => {
  let fail = true;
  const contexts = fakeWebAudio(t, async () => { if (fail) { fail = false; throw new Error('worklet unavailable'); } });
  const audio = new ChoirAudio();
  await assert.rejects(audio.init(), /unavailable/);
  assert.equal(contexts[0].state, 'closed');
  await audio.init();
  assert.equal(audio.ready, true);
  assert.equal(contexts.length, 2);
});

test('concurrent init callers both wait for a complete graph', async (t) => {
  const load = deferred();
  const contexts = fakeWebAudio(t, () => load.promise);
  const audio = new ChoirAudio();
  const first = audio.init();
  let secondDone = false;
  const second = audio.init().then(() => { secondDone = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(secondDone, false);
  load.resolve();
  await Promise.all([first, second]);
  assert.equal(audio.ready, true);
  assert.equal(contexts.length, 1);
});

test('removing an orb cancels a pending capture and ignores late worklet data', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  const orb = { id: 1, begin: 2, len: 2 };
  const capture = audio.capture(orb);
  const rejected = assert.rejects(capture, { name: 'AbortError' });
  const request = audio.recorder.port.messages.at(-1);
  audio.stop(orb);
  // Complete the fake response even on the buggy baseline, so no timer remains running.
  audio.recorder.port.onmessage({ data: { type: 'data', id: request.id, channels: [new Float32Array(16000), new Float32Array(16000)] } });
  await rejected;
  assert.equal(audio.reqs.size, 0);
  assert.equal(orb.buffer, undefined);
  assert.ok(audio.recorder.port.messages.some((m) => m.type === 'cancel' && m.id === request.id));
});

test('a cleared orb cannot show a late capture failure over a new session', async () => {
  const pending = deferred();
  const station = new OrbStation({ transport: new Transport(), audio: { capture: () => pending.promise, stop() {} } });
  station.rec = { begin: 0, end: 2 };
  station.makeOrb(2);
  station.clear();
  pending.reject(new Error('expired'));
  await Promise.resolve();
  assert.equal(station.count, 0);
  assert.equal(station.message, null);
});

test('a synchronous capture failure returns the station to idle', async () => {
  const station = new OrbStation({ transport: new Transport(), audio: { capture() { throw new Error('not ready'); }, stop() {} } });
  station.rec = { begin: 0, end: 2 };
  assert.doesNotThrow(() => station.makeOrb(2));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(station.mode, 'idle');
  assert.equal(station.count, 0);
  assert.match(station.message.text, /다시/);
});

test('a late microphone grant cannot replace a newer demo selection', async (t) => {
  fakeWebAudio(t);
  const permission = deferred();
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => permission.promise } } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', oldNavigator));
  const audio = new ChoirAudio();
  await audio.init();
  const mic = audio.useMic();
  const rejected = assert.rejects(mic, { name: 'AbortError' });
  await Promise.resolve(); await Promise.resolve();
  await audio.useDemo();
  let stopped = 0;
  permission.resolve({ getTracks: () => [{ stop: () => stopped++ }] });
  await rejected;
  assert.equal(audio.source.kind, 'demo');
  assert.equal(stopped, 1);
  await audio.dispose();
});

test('dispose cancels recording, stops loops and closes the context', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  const ctx = audio.ctx;
  const orb = { id: 3, begin: 2, len: 2, x: 0.4, y: 0.5, buffer: ctx.createBuffer(2, 16000, 8000) };
  audio.play(orb);
  const nodes = audio.orbNodes.get(orb.id);
  const rejected = assert.rejects(audio.capture({ id: 4, begin: 5, len: 2 }), { name: 'AbortError' });
  await audio.dispose();
  await rejected;
  assert.equal(nodes.src.stopped, true);
  assert.equal(nodes.pan.disconnected, true);
  assert.equal(audio.reqs.size, 0);
  assert.equal(audio.orbNodes.size, 0);
  assert.equal(audio.ready, false);
  assert.equal(ctx.state, 'closed');
});

test('dispose during worklet loading prevents a late graph from becoming ready', async (t) => {
  const load = deferred();
  const contexts = fakeWebAudio(t, () => load.promise);
  const audio = new ChoirAudio();
  const rejected = assert.rejects(audio.init(), { name: 'AbortError' });
  await audio.dispose();
  load.resolve();
  await rejected;
  assert.equal(audio.ready, false);
  assert.equal(audio.ctx, null);
  assert.equal(contexts[0].state, 'closed');
});

test('product and output mute selected before init survive graph creation without starting tones', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  audio.setProduct('chord');
  audio.setOutputMuted(true);
  await audio.init();
  assert.equal(audio.product, 'chord');
  assert.equal(audio.voiceRecord.gain.value, 0);
  assert.equal(audio.accompRecord.gain.value, 1);
  assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.ctx.oscillators.length, 0);
  assert.deepEqual(audio.accompaniment.output.connections, [audio.master, audio.accompRecord]);
  assert.deepEqual(audio.accompRecord.connections, [audio.recBus]);
  audio.setOutputMuted(false);
  assert.ok(audio.master.gain.value > 0 && audio.master.gain.value <= 1);
  assert.throws(() => audio.setProduct('unknown'), TypeError);
  assert.equal(audio.product, 'chord');
  await audio.dispose();
});

test('product switches choose one recording bus, stop mic tracks, and release chord tones', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  assert.equal(audio.product, 'choir');
  assert.equal(audio.voiceRecord.gain.value, 1);
  assert.equal(audio.accompRecord.gain.value, 0);
  const input = audio.ctx.createMediaStreamSource();
  let stopped = 0;
  audio.connectSource(input, 'mic', { stream: { getTracks: () => [{ stop: () => stopped++ }] } });
  assert.deepEqual(input.connections, [audio.node, audio.dry, audio.voiceRecord]);
  assert.ok(audio.harmGain.connections.includes(audio.voiceRecord));
  assert.ok(audio.reverb.connections.includes(audio.voiceRecord));
  assert.deepEqual(audio.voiceRecord.connections, [audio.recBus]);
  audio.setDry(0.4);
  audio.setGesture({ present: true, fist: false, level: 0.5, brightness: 0.5, preset: 2 });
  assert.ok(audio.harmGain.gain.value > 0);
  audio.setProduct('chord');
  assert.equal(stopped, 1);
  assert.equal(audio.source, null);
  assert.equal(input.disconnected, true);
  assert.equal(audio.voiceRecord.gain.value, 0);
  assert.equal(audio.accompRecord.gain.value, 1);
  assert.equal(audio.dry.gain.value, 0);
  assert.equal(audio.harmGain.gain.value, 0);
  audio.setGesture({ present: true, fist: false, level: 1, brightness: 1, preset: 4 });
  assert.equal(audio.harmGain.gain.value, 0);
  audio.accompaniment.setChord([48, 52, 55]);
  assert.equal(audio.accompaniment.count, 3);
  audio.setProduct('choir');
  assert.equal(audio.accompaniment.count, 0);
  assert.ok(audio.ctx.oscillators.every((node) => node.disconnected));
  assert.equal(audio.voiceRecord.gain.value, 1);
  assert.equal(audio.accompRecord.gain.value, 0);
  assert.equal(audio.dry.gain.value, 0.4);
  assert.equal(audio.source, null, 'switching back must not reopen the microphone');
  await audio.dispose();
});

test('switching to chords cancels a pending microphone grant and rejects further voice inputs', async (t) => {
  fakeWebAudio(t);
  const permission = deferred();
  let requested = 0;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    mediaDevices: { getUserMedia() { requested++; return permission.promise; } },
  } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', oldNavigator));
  const audio = new ChoirAudio();
  await audio.init();
  const mic = audio.useMic();
  const rejected = assert.rejects(mic, { name: 'AbortError' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(requested, 1);
  audio.setProduct('chord');
  let stopped = 0;
  permission.resolve({ getTracks: () => [{ stop: () => stopped++ }] });
  await rejected;
  assert.equal(stopped, 1);
  assert.equal(audio.source, null);
  await assert.rejects(audio.useMic(), { name: 'AbortError' });
  await assert.rejects(audio.useDemo(), { name: 'AbortError' });
  await assert.rejects(audio.useFile({ arrayBuffer() { throw new Error('file must not be read'); } }), { name: 'AbortError' });
  assert.equal(requested, 1);
  await audio.dispose();
});

test('capture uses the recorded product snapshot to bypass microphone latency for chords', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  t.mock.method(audio, 'roundTripSec', () => 0.1);
  for (const [product, recordProduct, shift] of [
    ['choir', 'chord', 0], ['chord', 'choir', 0.1], ['chord', undefined, 0],
    ['choir', undefined, 0.1],
  ]) {
    audio.setProduct(product);
    const orb = { id: 1, begin: 2, len: 2, recordProduct };
    const rejected = assert.rejects(audio.capture(orb), { name: 'AbortError' });
    const request = audio.recorder.port.messages.at(-1);
    assert.equal(request.from, Math.round((2 + shift) * audio.ctx.sampleRate));
    assert.equal(request.to - request.from, 2 * audio.ctx.sampleRate);
    audio.stop(orb);
    await rejected;
  }
  await audio.dispose();
});

test('panic silences output and chord voices while retaining recorded loops for the app', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  audio.setProduct('chord');
  audio.accompaniment.setChord([48, 52, 55]);
  const buffer = audio.ctx.createBuffer(2, 16000, 8000);
  const orb = { id: 1, begin: 2, len: 2, x: 0.5, y: 0.5, buffer };
  audio.play(orb);
  audio.panic();
  assert.equal(audio.outputMuted, true);
  assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.harmGain.gain.value, 0);
  assert.equal(audio.dry.gain.value, 0);
  assert.equal(audio.accompaniment.count, 0);
  assert.ok(audio.ctx.oscillators.every((node) => node.stopped && node.disconnected));
  assert.equal(orb.buffer, buffer);
  assert.equal(audio.orbNodes.size, 1, 'loop muting/state is owned by the app');
  audio.setOutputMuted(false);
  assert.ok(audio.master.gain.value > 0);
  await audio.dispose();
});

test('dispose closes accompaniment and disconnects both recording taps before the context', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  audio.setProduct('chord');
  audio.accompaniment.setChord([48, 52, 55]);
  const synth = audio.accompaniment;
  const ctx = audio.ctx;
  const taps = [audio.voiceRecord, audio.accompRecord];
  const close = ctx.close.bind(ctx);
  t.mock.method(ctx, 'close', async () => {
    assert.equal(synth.disposed, true);
    assert.equal(synth.output.disconnected, true);
    assert.ok(taps.every((node) => node.disconnected));
    await close();
  });
  await audio.dispose();
  assert.equal(ctx.state, 'closed');
  assert.equal(audio.accompaniment, null);
  assert.equal(audio.voiceRecord, null);
  assert.equal(audio.accompRecord, null);
  assert.ok(ctx.oscillators.every((node) => node.disconnected));
  await audio.dispose();
});

test('session recording requires a complete graph and creates its stream only on demand', async (t) => {
  const load = deferred();
  const contexts = fakeWebAudio(t, () => load.promise);
  const audio = new ChoirAudio();
  assert.throws(() => audio.getRecordingStream(), /먼저 시작/);
  assert.equal(contexts.length, 0, 'reading a recording stream must not initialize audio');
  const init = audio.init();
  assert.throws(() => audio.getRecordingStream(), /먼저 시작/);
  assert.equal(contexts[0].mediaDestinations.length, 0);
  load.resolve();
  await init;
  assert.equal(contexts[0].mediaDestinations.length, 0, 'ordinary playback does not allocate a recording stream');
  const stream = audio.getRecordingStream();
  assert.equal(contexts[0].mediaDestinations.length, 1);
  assert.equal(stream.getAudioTracks().length, 1);
  assert.equal(stream.getTracks()[0].readyState, 'live');
  await audio.dispose();
});

test('session recording reuses one post-master tap including every output bus and mute', async (t) => {
  fakeWebAudio(t);
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let requested = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia() { requested++; throw new Error('recording must not request input permission'); },
  } } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', oldNavigator));
  const audio = new ChoirAudio();
  await audio.init();
  const ctx = audio.ctx;
  const stream = audio.getRecordingStream();
  const tap = ctx.mediaDestinations[0];
  for (let i = 0; i < 5; i++) assert.equal(audio.getRecordingStream(), stream);
  assert.equal(ctx.mediaDestinations.length, 1);
  assert.deepEqual(audio.master.connections, [ctx.destination, tap]);
  for (const bus of [audio.dry, audio.harmGain, audio.reverb, audio.accompaniment.output, audio.orbBus, audio.click]) {
    assert.ok(bus.connections.includes(audio.master), 'each audible bus flows through the master');
    assert.ok(!bus.connections.includes(tap), 'no bus can bypass master mute into the recording');
  }
  assert.ok(!audio.recBus.connections.includes(tap), 'orb recording remains a separate bus');
  audio.setOutputMuted(true);
  assert.equal(audio.master.gain.value, 0);
  assert.equal(audio.getRecordingStream(), stream);
  audio.setOutputMuted(false);
  assert.equal(audio.master.gain.value, 0.75);
  ctx.state = 'suspended';
  assert.equal(audio.getRecordingStream(), stream);
  assert.equal(ctx.state, 'suspended', 'retrieving the stream must not resume audio');
  assert.equal(requested, 0);
  await audio.dispose();
});

test('session recording keeps the same tap across products without owning recorder clones', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  const stream = audio.getRecordingStream();
  const original = stream.getAudioTracks()[0];
  const recorderClone = original.clone();
  recorderClone.stop();
  assert.equal(original.readyState, 'live', 'a recorder stops only its clone');
  for (const product of ['chord', 'choir', 'chord']) {
    audio.setProduct(product);
    assert.equal(audio.getRecordingStream(), stream);
    assert.equal(original.stops, 0);
  }
  await audio.dispose();
  assert.equal(original.stops, 1);
  assert.equal(recorderClone.stops, 1, 'audio disposal must not stop tracks owned by recorders');
});

test('session disposal stops original recording tracks and disconnects before context close resolves', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  const ctx = audio.ctx, master = audio.master;
  const stream = audio.getRecordingStream();
  const original = stream.getTracks()[0], tap = audio.recordDestination;
  const close = deferred();
  t.mock.method(ctx, 'close', async () => {
    assert.equal(original.readyState, 'ended');
    assert.equal(tap.disconnected, true);
    assert.equal(master.disconnected, true);
    await close.promise;
    ctx.state = 'closed';
  });
  const disposal = audio.dispose();
  assert.equal(audio.recordDestination, null);
  assert.equal(audio.recordingContext, null);
  assert.equal(audio.ctx, null);
  assert.equal(audio.ready, false);
  assert.throws(() => audio.getRecordingStream(), /먼저 시작/);
  close.resolve();
  await disposal;
  await audio.dispose();
  assert.equal(original.stops, 1);
});

test('a new session receives a fresh recording stream even while the old context is closing', async (t) => {
  const contexts = fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  const oldStream = audio.getRecordingStream();
  const oldTap = audio.recordDestination;
  const closing = deferred();
  t.mock.method(contexts[0], 'close', async () => { await closing.promise; contexts[0].state = 'closed'; });
  const disposal = audio.dispose();
  await audio.init();
  const newStream = audio.getRecordingStream();
  const newTap = audio.recordDestination;
  assert.notEqual(newStream, oldStream);
  assert.notEqual(newTap, oldTap);
  assert.equal(audio.recordingContext, contexts[1]);
  assert.deepEqual(audio.master.connections, [contexts[1].destination, newTap]);
  closing.resolve();
  await disposal;
  assert.equal(audio.getRecordingStream(), newStream, 'late old close cannot reset the new session tap');
  assert.equal(oldStream.getTracks()[0].stops, 1);
  assert.equal(newStream.getTracks()[0].stops, 0);
  await audio.dispose();
});

test('a failed recording tap connection releases its stream and allows a clean retry', async (t) => {
  fakeWebAudio(t);
  const audio = new ChoirAudio();
  await audio.init();
  const connect = audio.master.connect.bind(audio.master);
  let failed = false;
  t.mock.method(audio.master, 'connect', target => {
    if (!failed) { failed = true; throw new Error('connection failed'); }
    return connect(target);
  });
  assert.throws(() => audio.getRecordingStream(), /connection failed/);
  assert.equal(audio.recordDestination, null);
  assert.equal(audio.recordingContext, null);
  assert.equal(audio.ctx.mediaDestinations[0].disconnected, true);
  assert.equal(audio.ctx.mediaDestinations[0].stream.getTracks()[0].stops, 1);
  const stream = audio.getRecordingStream();
  assert.equal(audio.ctx.mediaDestinations.length, 2);
  assert.equal(stream.getTracks()[0].readyState, 'live');
  assert.equal(audio.master.connections.length, 2);
  audio.ctx.state = 'closed';
  assert.throws(() => audio.getRecordingStream(), /먼저 시작/);
  await audio.dispose();
});

test('recorder worklet drops a canceled future read', async (t) => {
  let Processor;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: () => {} }; } };
  globalThis.sampleRate = 8000;
  globalThis.currentFrame = 0;
  globalThis.registerProcessor = (_name, klass) => { Processor = klass; };
  t.after(() => { for (const key of ['AudioWorkletProcessor', 'sampleRate', 'currentFrame', 'registerProcessor']) delete globalThis[key]; });
  await import('../core/recorder-worklet.js');
  const processor = new Processor();
  processor.port.onmessage({ data: { type: 'read', id: 1, from: 0, to: 8000 } });
  processor.port.onmessage({ data: { type: 'cancel', id: 1 } });
  processor.process([[]]);
  assert.equal(processor.pending.length, 0);
});
