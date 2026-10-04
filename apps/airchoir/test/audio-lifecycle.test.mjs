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
      this.gain = this.frequency = this.Q = this.pan = {
        value: 0, setTargetAtTime() {}, setValueAtTime() {}, exponentialRampToValueAtTime() {},
      };
      this.port = { messages: [], postMessage(m) { this.messages.push(m); }, close() {} };
    }
    connect(node) { return node; }
    disconnect() { this.disconnected = true; }
    start() {}
    stop() { this.stopped = true; }
  }
  class Context {
    constructor() {
      contexts.push(this);
      this.state = 'running'; this.currentTime = 5; this.sampleRate = 8000;
      this.destination = new Node();
      this.audioWorklet = { addModule: load };
    }
    createGain() { return new Node(); }
    createBiquadFilter() { return new Node(); }
    createConvolver() { return new Node(); }
    createStereoPanner() { return new Node(); }
    createBufferSource() { return new Node(); }
    createMediaStreamSource() { return new Node(); }
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
