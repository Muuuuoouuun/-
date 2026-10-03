// 실행: node --test air-choir/phase0/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PitchDetector,
  Harmonizer,
  InputRing,
  GranularVoice,
  PsolaAnalyzer,
  PsolaVoice,
  SynthVoice,
  harmonyTargets,
  snapToScale,
  SCALES,
  hzToMidi,
  midiToHz,
  renderDemo,
  ENGINES,
} from '../dsp.js';

const SR = 48000;

function vowel(hz, seconds, sr = SR) {
  const v = new SynthVoice(sr);
  v.freq = v.target = hz;
  const out = new Float32Array(Math.round(seconds * sr));
  v.processBlock(out, out.length, null);
  return out;
}

function saw(hz, seconds, sr = SR) {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) out[i] = 0.4 * (((i * hz) / sr) % 1) - 0.2;
  return out;
}

// 신호 뒷부분에서 음정을 여러 번 재서 중간값을 돌려준다
function measureHz(signal, sr = SR) {
  const det = new PitchDetector(sr);
  const found = [];
  const block = 128;
  for (let i = 0; i + block <= signal.length; i += block) {
    det.process(signal.subarray(i, i + block));
    if (i > signal.length * 0.4 && det.voiced) found.push(det.freq);
  }
  if (!found.length) return 0;
  found.sort((a, b) => a - b);
  return found[found.length >> 1];
}

const cents = (a, b) => 1200 * Math.log2(a / b);

test('스케일 맞추기와 다이아토닉 화음', () => {
  const C = SCALES.major;
  assert.equal(snapToScale(63.4, 0, C).midi, 64);
  assert.equal(snapToScale(61, 0, C).midi === 60 || snapToScale(61, 0, C).midi === 62, true);
  assert.deepEqual(harmonyTargets(64, 2, 0, 'major').targets, [67, 71]); // E4 → G4, B4
  assert.deepEqual(harmonyTargets(71, 1, 0, 'major').targets, [74]); // B4 → D5
  assert.deepEqual(harmonyTargets(72, 2, 9, 'minor').targets, [76, 79]); // A단조 C5 → E5, G5
  assert.deepEqual(harmonyTargets(60, 3, 0, 'major').targets, [64, 67, 48]);
  assert.deepEqual(harmonyTargets(60, 0, 0, 'major').targets, []);
});

test('음정 검출 정확도 (±10 cent)', () => {
  for (const hz of [82, 110, 196, 261.6, 440, 880]) {
    for (const [name, sig] of [
      ['saw', saw(hz, 0.6)],
      ['vowel', vowel(hz, 0.6)],
    ]) {
      const got = measureHz(sig);
      assert.ok(got > 0, `${name} ${hz}Hz 검출 실패`);
      assert.ok(Math.abs(cents(got, hz)) < 10, `${name} ${hz}Hz → ${got.toFixed(2)}Hz`);
    }
  }
});

test('조용하면 무성음으로 판단', () => {
  const det = new PitchDetector(SR);
  const quiet = vowel(220, 0.5).map((x) => x * 0.005);
  det.process(quiet);
  assert.equal(det.voiced, false);
});

function runVoice(make, input, ratio) {
  const ring = new InputRing();
  const det = new PitchDetector(SR);
  const an = new PsolaAnalyzer(ring, SR);
  const voice = make(ring, an);
  voice.target = ratio;
  const out = new Float32Array(input.length);
  const block = 128;
  const tmp = new Float32Array(block);
  for (let i = 0; i + block <= input.length; i += block) {
    const chunk = input.subarray(i, i + block);
    for (let k = 0; k < block; k++) ring.push(chunk[k]);
    det.process(chunk);
    an.setPitch(det.freq, det.voiced);
    an.update();
    voice.processBlock(tmp, block);
    out.set(tmp, i);
  }
  return out;
}

for (const [name, make] of [
  ['그레인', (ring) => new GranularVoice(ring, SR, 40)],
  ['PSOLA', (ring, an) => new PsolaVoice(an, Math.round(an.maxT * 1.5))],
]) {
  test(`${name} 엔진: 출력 음정이 목표대로 바뀜`, () => {
    for (const [hz, ratio] of [
      [220, Math.pow(2, 4 / 12)], // 장3도 위
      [196, Math.pow(2, 7 / 12)], // 완전5도 위
      [262, 0.5], // 옥타브 아래
    ]) {
      const out = runVoice(make, vowel(hz, 1.2), ratio);
      const got = measureHz(out);
      const want = hz * ratio;
      assert.ok(got > 0, `${name} ${hz}Hz×${ratio.toFixed(3)} 무음`);
      assert.ok(Math.abs(cents(got, want)) < 20, `${name} ${hz}Hz×${ratio.toFixed(3)} → ${got.toFixed(1)}Hz (목표 ${want.toFixed(1)})`);
    }
  });
}

test('하모나이저: 엔진 3종 모두 E4를 부르면 G4 화음을 만든다', () => {
  const input = vowel(midiToHz(64), 1.5);
  for (const engine of ENGINES) {
    const h = new Harmonizer(SR);
    h.setParams({ engine, preset: 1, tonic: 0, scale: 'major', dryGain: 0, harmGain: 1, lock: true });
    const L = new Float32Array(input.length);
    const R = new Float32Array(input.length);
    for (let i = 0; i + 128 <= input.length; i += 128) {
      h.process(input.subarray(i, i + 128), L.subarray(i, i + 128), R.subarray(i, i + 128));
    }
    const got = hzToMidi(measureHz(L));
    assert.ok(Math.abs(got - 67) < 0.2, `${engine}: ${got.toFixed(2)} (목표 67)`);
    assert.ok(L.every(Number.isFinite), `${engine}: NaN 발생`);
  }
});

test('하모나이저: 데모 멜로디 처리 중 값이 튀지 않음 + 처리 속도', () => {
  const demo = renderDemo(SR);
  for (const engine of ENGINES) {
    const h = new Harmonizer(SR);
    h.setParams({ engine, preset: 4 });
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    let peak = 0;
    const notes = new Set();
    const t0 = performance.now();
    for (let i = 0; i + 128 <= demo.length; i += 128) {
      h.process(demo.subarray(i, i + 128), L, R);
      for (let k = 0; k < 128; k++) peak = Math.max(peak, Math.abs(L[k]), Math.abs(R[k]));
      const s = h.stats();
      if (s.voiced) notes.add(Math.round(s.midi));
    }
    const ms = performance.now() - t0;
    const audioMs = (demo.length / SR) * 1000;
    console.log(`  ${engine.padEnd(8)} 처리 시간 ${(ms / audioMs * 100).toFixed(1)}% (실시간 대비), 최대 진폭 ${peak.toFixed(2)}`);
    assert.ok(Number.isFinite(peak) && peak < 2.5, `${engine} 최대 진폭 ${peak}`);
    for (const n of [60, 62, 64, 65, 67, 69]) assert.ok(notes.has(n), `${engine}: ${n} 검출 안 됨`);
  }
});
