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
  harmonyPreset,
  HARMONY_STYLES,
  PRESETS,
  snapToScale,
  SCALES,
  hzToMidi,
  midiToHz,
  renderDemo,
  ENGINES,
} from '../core/dsp.js';

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

const pcOf = (m) => ((m % 12) + 12) % 12;
const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);

test('화음 성격: 모든 성격이 손가락 1~4개에 성부를 하나씩 더하고, 정석 3도는 예전 구성 그대로', () => {
  assert.ok(HARMONY_STYLES.length >= 7);
  assert.equal(new Set(HARMONY_STYLES.map((s) => s.id)).size, HARMONY_STYLES.length);
  for (const style of HARMONY_STYLES) {
    assert.ok(style.label && style.short && style.desc, style.id);
    assert.equal(style.presets.length, 5, style.id);
    style.presets.forEach((preset, n) => {
      assert.equal(preset.voices.length, n, `${style.id} ${n}개`);
      assert.ok(preset.name);
    });
    // 모든 음에서 성부가 멜로디 근처에 (드론의 낮은 으뜸음만 두 옥타브 남짓 아래까지)
    for (let m = 55; m <= 79; m++) {
      const { snapped, targets } = harmonyTargets(m, 4, 0, 'major', style.id, {});
      assert.equal(targets.length, 4);
      for (const t of targets) assert.ok(Number.isInteger(t) && Math.abs(t - snapped) <= 26, `${style.id} ${m} → ${t}`);
    }
  }
  assert.equal(PRESETS, HARMONY_STYLES[0].presets);
  for (let m = 50; m < 80; m++) {
    for (let p = 0; p <= 4; p++) {
      assert.deepEqual(harmonyTargets(m, p, 0, 'major', 'classic').targets, harmonyTargets(m, p, 0, 'major').targets);
    }
  }
  assert.equal(harmonyPreset('없는 성격', 2), PRESETS[2], '모르는 성격은 정석 3도');
});

test('화음 성격: 발라드는 멜로디가 늘 맨 위, 가스펠은 2도가 부딪히는 7·6화음', () => {
  for (let m = 60; m <= 72; m++) {
    if (!C_MAJOR.has(pcOf(m))) continue;
    const ballad = harmonyTargets(m, 2, 0, 'major', 'ballad').targets;
    assert.ok(ballad.every((t) => t < m), `발라드 ${m}: ${ballad}`);
    assert.deepEqual(ballad.map((t) => m - t).map((d) => d >= 3 && d <= 9), [true, true]); // 3도·6도 아래
    const gospel = harmonyTargets(m, 3, 0, 'major', 'gospel').targets;
    assert.ok([1, 2].includes(m - gospel[0]), `가스펠 ${m}: 바로 아래 2도 ${gospel}`);
    // 네 음이 3도 간격으로 쌓이는 화음(6·7화음)이 된다: 맨 아래부터 3도·3도·2도
    const stack = [m, ...gospel].sort((a, b) => a - b);
    assert.ok(stack[1] - stack[0] >= 3 && stack[2] - stack[1] >= 3 && stack[3] - stack[2] <= 2, `가스펠 ${stack}`);
  }
  // E4 위의 발라드: C4·G3 아래 → C장조 화음 (포부르동)
  assert.deepEqual(harmonyTargets(64, 2, 0, 'major', 'ballad').targets, [60, 55]);
  // 아이돌 훅: 옥타브 아래 더블 + 3도 위
  assert.deepEqual(harmonyTargets(64, 2, 0, 'major', 'kpop').targets, [52, 67]);
});

test('화음 성격: 파워는 3도 없이 완전음정만, 키 밖으로 나가지 않는다', () => {
  for (const [tonic, scale] of [[0, 'major'], [9, 'minor'], [7, 'major']]) {
    const inKey = new Set(SCALES[scale].map((d) => (tonic + d) % 12));
    for (let m = 55; m <= 79; m++) {
      if (!inKey.has(pcOf(m))) continue;
      for (const t of harmonyTargets(m, 4, tonic, scale, 'power').targets) {
        assert.ok([0, 5, 7].includes(pcOf(t - m)), `파워 ${tonic}/${scale} ${m} → ${t}`);
        assert.ok(inKey.has(pcOf(t)), `키 밖 ${m} → ${t}`);
      }
    }
  }
  assert.deepEqual(harmonyTargets(67, 2, 0, 'major', 'power').targets, [60, 55]); // G4: C4(5도 아래), G3
  assert.deepEqual(harmonyTargets(65, 1, 0, 'major', 'power').targets, [60]); // F4: 시♭ 대신 도 (4도 아래)
});

test('화음 성격: 4도 쌓기는 스케일 4도로 쌓고, 앞 성부 위에 또 4도를 얹는다', () => {
  const [up, down, upup] = harmonyTargets(62, 3, 0, 'major', 'quartal').targets; // D4
  assert.deepEqual([up, down, upup], [67, 57, 72]); // G4, A3, C5
  for (let m = 60; m <= 72; m++) {
    if (!C_MAJOR.has(pcOf(m))) continue;
    for (const t of harmonyTargets(m, 4, 0, 'major', 'quartal').targets) assert.ok(C_MAJOR.has(pcOf(t)), `${m} → ${t}`);
  }
});

test('화음 성격: 드론은 멜로디가 움직여도 으뜸음·딸림음 자리를 지키고, 너무 멀어지면 옥타브를 옮긴다', () => {
  const memo = {};
  const line = [64, 65, 67, 65, 64, 62, 60].map((m) => harmonyTargets(m, 2, 0, 'major', 'drone', memo).targets);
  assert.ok(line.every(([tonic, fifth]) => tonic === 60 && fifth === 55), JSON.stringify(line)); // C4, G3 그대로
  const high = harmonyTargets(81, 3, 0, 'major', 'drone', memo).targets; // A5: 한 옥타브 반 위로 가면
  assert.deepEqual(high, [72, 67, 60]);
  assert.ok(high.every((t) => t <= 81));
  // 기억이 없으면 매번 멜로디 아래 3반음 이상에서 새로 고른다
  assert.deepEqual(harmonyTargets(62, 1, 0, 'major', 'drone').targets, [48]);
  // 단조: 으뜸음 A, 딸림음 E
  assert.deepEqual(harmonyTargets(72, 2, 9, 'minor', 'drone').targets.map(pcOf), [9, 4]);
});

test('하모나이저: 화음 성격을 바꾸면 같은 손가락 수라도 다른 음을 낸다', () => {
  const h = new Harmonizer(SR);
  const input = vowel(midiToHz(64), 0.6);
  const run = (style) => {
    h.setParams({ engine: 'psola', preset: 2, tonic: 0, scale: 'major', style, dryGain: 0 });
    for (let i = 0; i + 128 <= input.length; i += 128) {
      const L = new Float32Array(128);
      h.process(input.subarray(i, i + 128), L, L);
    }
    return h.stats().targets;
  };
  assert.deepEqual(run('classic'), [67, 71]);
  assert.deepEqual(run('ballad'), [60, 55]);
  assert.deepEqual(run('power'), [57, 52]);
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

test('녹음 링 버퍼: 절대 프레임으로 구간 꺼내기, 지난 구간은 null', async () => {
  const { RingRecorder } = await import('../core/recorder.js');
  const r = new RingRecorder(1000, { channels: 2, seconds: 1 }); // 1024 프레임
  let f = 0;
  for (let b = 0; b < 20; b++) {
    const block = new Float32Array(128).map((_, i) => f + i);
    r.write([block], f); // 모노 → 두 채널에 복사
    f += 128;
  }
  const got = r.read(2000, 2010);
  assert.deepEqual([...got[0]], [...Array(10)].map((_, i) => 2000 + i));
  assert.deepEqual([...got[1]], [...got[0]]);
  assert.equal(r.read(100, 200), null); // 이미 덮어씀
  assert.equal(r.read(2500, 2600), null); // 아직 안 들어옴
});

function runHarmonizer(input, params) {
  const h = new Harmonizer(SR);
  h.setParams(params);
  const L = new Float32Array(input.length);
  const R = new Float32Array(input.length);
  for (let i = 0; i + 128 <= input.length; i += 128) {
    h.process(input.subarray(i, i + 128), L.subarray(i, i + 128), R.subarray(i, i + 128));
  }
  return { L, R };
}
const rms = (x, from = 0.4) => {
  let s = 0;
  const a = Math.floor(x.length * from);
  for (let i = a; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length - a));
};

test('합창단: 성부가 많아져도 전체 크기는 비슷하고, 성부마다 음정은 목표 근처에서만 흔들린다', () => {
  const input = vowel(midiToHz(64), 2.5);
  for (const engine of ['psola', 'granular']) {
    const one = runHarmonizer(input, { engine, preset: 1, dryGain: 0, harmGain: 1 });
    const full = runHarmonizer(input, { engine, preset: 4, dryGain: 0, harmGain: 1 });
    const ratio = (rms(full.L) + rms(full.R)) / (rms(one.L) + rms(one.R));
    assert.ok(ratio > 0.7 && ratio < 1.6, `${engine}: 4성부/1성부 크기 비 ${ratio.toFixed(2)}`);
    // 한 성부(3도 위 = G4)는 흔들려도 목표에서 크게 벗어나지 않음
    const det = new PitchDetector(SR);
    const found = [];
    for (let i = 0; i + 128 <= one.L.length; i += 128) {
      det.process(one.L.subarray(i, i + 128));
      if (i > SR * 0.5 && det.voiced) found.push(cents(det.freq, midiToHz(67)));
    }
    assert.ok(found.length > 100);
    const worst = Math.max(...found.map(Math.abs));
    assert.ok(worst < 18, `${engine}: 최대 ${worst.toFixed(1)} cent`);
  }
});

test('합창단: humanize 를 끄면 기계처럼 딱 맞고, 켜면 성부가 조금씩 다르게 움직인다', () => {
  const input = vowel(midiToHz(64), 1.5);
  const tight = runHarmonizer(input, { engine: 'psola', preset: 2, dryGain: 0, humanize: 0 });
  const human = runHarmonizer(input, { engine: 'psola', preset: 2, dryGain: 0, humanize: 1 });
  let diff = 0;
  for (let i = SR; i < input.length; i++) diff += Math.abs(tight.L[i] - human.L[i]);
  assert.ok(diff / (input.length - SR) > 1e-3, '사람다움이 소리에 반영되어야 함');
  assert.ok(human.L.every(Number.isFinite) && human.R.every(Number.isFinite));
});

test('합창용 합성 보이스: 두 사람이 함께 불러도 음정은 정확하고, 성부마다 소리가 다르다', () => {
  const sing = (seed) => {
    const v = new SynthVoice(SR, { choir: true, ensemble: 1, breath: 0.05, seed });
    v.freq = v.target = 220;
    const out = new Float32Array(SR);
    v.processBlock(out, out.length, null);
    return out;
  };
  const a = sing(1);
  const b = sing(2);
  assert.ok(Math.abs(cents(measureHz(a), 220)) < 10, `${measureHz(a).toFixed(1)} Hz`);
  assert.ok(a.every(Number.isFinite));
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  assert.ok(d / a.length > 0.01, '씨앗이 다르면 다른 사람처럼');
  const peak = a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  assert.ok(peak < 1.2, `최대 ${peak}`);
});
