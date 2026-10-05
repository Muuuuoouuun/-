import test from 'node:test';
import assert from 'node:assert/strict';
import { Accompaniment } from '../src/accompaniment.js';

class Param {
  constructor() { this.value = 1; this.events = []; }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
  setValueAtTime(value, time) { this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.events.push(['ramp', value, time]); }
  setTargetAtTime(value, time, constant) { this.events.push(['target', value, time, constant]); }
}

class Node {
  constructor() { this.gain = new Param(); this.connections = []; this.disconnected = false; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections = []; this.disconnected = true; }
}

class Oscillator extends Node {
  constructor(ctx) { super(); this.ctx = ctx; this.frequency = new Param(); this.stops = []; }
  start(time) {
    if (this.ctx.failStart) throw new Error('oscillator start failed');
    this.started = time;
  }
  stop(time) { this.stops.push(time); this.stopTime = time; }
  end() { this.ended = true; this.onended?.(); }
}

class Context {
  constructor() {
    this.currentTime = 2;
    this.state = 'running';
    this.oscillators = [];
    this.gains = [];
    this.listeners = new Set();
  }
  createGain() { const node = new Node(); this.gains.push(node); return node; }
  createOscillator() { const node = new Oscillator(this); this.oscillators.push(node); return node; }
  addEventListener(type, fn) { assert.equal(type, 'statechange'); this.listeners.add(fn); }
  removeEventListener(type, fn) { assert.equal(type, 'statechange'); this.listeners.delete(fn); }
  changeState(state) { this.state = state; for (const fn of this.listeners) fn(); }
  advance(seconds) {
    this.currentTime += seconds;
    for (const node of this.oscillators) if (!node.ended && node.stopTime <= this.currentTime) node.end();
  }
  close() { throw new Error('instrument must not close its owner context'); }
  resume() { throw new Error('instrument must not resume its owner context'); }
}

const openSources = (ctx) => ctx.oscillators.filter((node) => !node.disconnected);

test('output is explicit, supports an independent recording connection and avoids duplicate routes', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  assert.deepEqual(synth.output.connections, []);
  const monitor = new Node();
  const recording = new Node();
  const routed = new Accompaniment(ctx, { destination: monitor, recordDestination: recording });
  assert.deepEqual(routed.output.connections, [monitor, recording]);
  const same = new Accompaniment(ctx, { destination: monitor, recordDestination: monitor });
  assert.deepEqual(same.output.connections, [monitor]);
  synth.dispose(); routed.dispose(); same.dispose();
});

test('a triad creates microphone-independent tones with normalized envelope levels', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  assert.equal(synth.setChord([69, 73, 76]), true);
  assert.deepEqual(synth.activeVoices, [69, 73, 76]);
  assert.equal(synth.count, 3);
  assert.equal(synth.output.gain.value, 0.22);
  assert.equal(ctx.oscillators[0].frequency.events[0][1], 440);
  for (const node of ctx.oscillators) {
    assert.equal(node.type, 'triangle');
    assert.equal(node.started, ctx.currentTime);
    const envelope = node.connections[0];
    assert.deepEqual(envelope.connections, [synth.output]);
    assert.equal(envelope.gain.events.at(-1)[1], 1 / 3);
    assert.ok(envelope.gain.events.at(-1)[2] > node.started);
  }
  synth.dispose();
});

test('same chord in a different order does not retrigger, and common tones survive changes', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  const original = [...ctx.oscillators];
  synth.setChord([67, 60, 64]);
  synth.setChord([60, 64, 67, 67]);
  assert.equal(ctx.oscillators.length, 3);
  synth.setChord([60, 64, 67, 70]);
  assert.equal(synth.count, 4);
  assert.equal(ctx.oscillators.length, 4);
  for (const node of original) {
    assert.deepEqual(node.stops, []);
    assert.equal(node.connections[0].gain.events.at(-1)[1], 1 / 4);
  }
  synth.dispose();
});

test('rapid chord changes keep both held notes and release tails bounded', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  for (let i = 0; i < 100; i++) {
    const root = 36 + i % 24;
    synth.setChord([root, root + 4, root + 7, root + 10]);
    assert.ok(openSources(ctx).length <= 8);
    assert.equal(synth.count, 4);
  }
  synth.release();
  ctx.advance(0.2);
  assert.equal(openSources(ctx).length, 0);
  synth.dispose();
});

test('release during attack ramps from its actual level and onended disconnects every node', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  const envelopes = ctx.oscillators.map((node) => node.connections[0]);
  ctx.advance(0.01);
  synth.release();
  assert.equal(synth.count, 0);
  for (const envelope of envelopes) {
    const anchor = envelope.gain.events.at(-2);
    assert.equal(anchor[0], 'set');
    assert.ok(anchor[1] > 0 && anchor[1] < 1 / 3);
    assert.equal(envelope.gain.events.at(-1)[1], 0);
  }
  const stopTimes = ctx.oscillators.map((node) => node.stopTime);
  synth.release();
  assert.deepEqual(ctx.oscillators.map((node) => node.stopTime), stopTimes);
  ctx.advance(0.2);
  assert.ok(ctx.oscillators.every((node) => node.disconnected && node.onended === null));
  assert.ok(envelopes.every((node) => node.disconnected));
  synth.dispose();
});

test('replaying a released chord survives late onended callbacks from its old voices', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  synth.release();
  synth.setChord([60, 64, 67]);
  assert.equal(ctx.oscillators.length, 6);
  ctx.advance(0.2);
  assert.deepEqual(synth.activeVoices, [60, 64, 67]);
  assert.equal(openSources(ctx).length, 3);
  assert.ok(ctx.oscillators.slice(0, 3).every((node) => node.disconnected));
  assert.ok(ctx.oscillators.slice(3).every((node) => !node.disconnected));
  synth.dispose();
});

test('invalid chords release the previous sound instead of leaving a stale chord held', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  for (const invalid of [null, [], [60, 64], [60, 64, NaN], [60, 64, 67.5], [-1, 60, 64], [60, 64, 128], [60, 60, 64], [60, 64, 67, 70, 74]]) {
    synth.setChord([60, 64, 67]);
    assert.equal(synth.setChord(invalid), false);
    assert.equal(synth.count, 0);
    ctx.advance(0.2);
    assert.equal(openSources(ctx).length, 0);
  }
  synth.dispose();
});

test('immediate release disconnects held notes and already scheduled release tails', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  synth.setChord([61, 65, 68]);
  assert.equal(openSources(ctx).length, 6);
  synth.release({ immediate: true });
  assert.equal(synth.count, 0);
  assert.equal(openSources(ctx).length, 0);
  assert.ok(ctx.oscillators.every((node) => node.stopTime === ctx.currentTime));
  synth.dispose();
});

test('suspension clears notes without awaiting frozen audio time, and resume cannot revive them', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  ctx.changeState('suspended');
  assert.equal(synth.count, 0);
  assert.equal(openSources(ctx).length, 0);
  assert.equal(synth.setChord([60, 64, 67]), false);
  ctx.changeState('running');
  assert.equal(synth.count, 0);
  assert.equal(ctx.oscillators.length, 3);
  assert.equal(synth.setChord([60, 64, 67]), true);
  ctx.changeState('closed');
  assert.equal(synth.count, 0);
  assert.equal(openSources(ctx).length, 0);
  synth.dispose();
});

test('gain changes stay finite and bounded without allocating new tones', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  for (const [input, expected] of [[0.4, 0.4], [-5, 0], [12, 1], [NaN, 0]]) {
    synth.setGain(input);
    assert.equal(synth.output.gain.events.at(-1)[1], expected);
  }
  assert.equal(ctx.oscillators.length, 3);
  synth.dispose();
});

test('failed oscillator startup cleans a partial chord and allows an explicit retry', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  ctx.failStart = true;
  assert.throws(() => synth.setChord([61, 65, 68]), /start failed/);
  assert.equal(synth.count, 0);
  assert.equal(openSources(ctx).length, 0);
  ctx.failStart = false;
  assert.equal(synth.setChord([61, 65, 68]), true);
  synth.dispose();
});

test('dispose is immediate and idempotent even while suspended; it never closes its owner context', () => {
  const ctx = new Context();
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  ctx.state = 'suspended'; // Deliberately no statechange callback before dispose.
  synth.dispose();
  synth.dispose();
  assert.equal(synth.count, 0);
  assert.equal(openSources(ctx).length, 0);
  assert.equal(ctx.listeners.size, 0);
  assert.equal(synth.output.disconnected, true);
  assert.equal(ctx.state, 'suspended');
  assert.equal(synth.setChord([60, 64, 67]), false);
  synth.setGain(0.5);
  assert.equal(ctx.oscillators.length, 3);
});

test('when the browser supports custom waves, every note shares one warm pad wave with a small per-note detune', () => {
  const ctx = new Context();
  const waves = [];
  ctx.createPeriodicWave = (real, imag) => {
    const wave = { real, imag };
    waves.push(wave);
    return wave;
  };
  const make = ctx.createOscillator.bind(ctx);
  ctx.createOscillator = () => {
    const node = make();
    node.detune = new Param();
    node.setPeriodicWave = (wave) => { node.wave = wave; };
    return node;
  };
  const synth = new Accompaniment(ctx);
  synth.setChord([60, 64, 67]);
  synth.setChord([62, 65, 69]);
  assert.equal(waves.length, 1, 'the wave is built once and shared');
  const [{ real, imag }] = waves;
  assert.equal(real.length, imag.length);
  assert.equal(imag[0], 0);
  assert.ok(imag[1] > imag[2] && imag[2] > 0, 'fundamental-led spectrum with even harmonics (not a triangle)');
  for (const node of ctx.oscillators) {
    assert.equal(node.wave, waves[0]);
    assert.equal(node.type, undefined);
    const cents = node.detune.events.at(-1)[1];
    assert.ok(Math.abs(cents) <= 4);
  }
  assert.ok(new Set(ctx.oscillators.slice(0, 3).map((n) => n.detune.events.at(-1)[1])).size > 1, 'chord tones are not all detuned alike');
  synth.release({ immediate: true });
  assert.equal(openSources(ctx).length, 0, 'lifecycle is unchanged');
  synth.dispose();
});
