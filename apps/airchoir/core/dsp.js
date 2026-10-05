// AirChoir Phase 0 — 오디오 처리 코어 (외부 의존성 없음)
// AudioWorklet 안과 Node(테스트) 양쪽에서 그대로 돌아가도록 순수 JS로만 작성한다.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export function midiName(m) {
  const r = Math.round(m);
  return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

// ───────────────────────── 스케일 · 화음 계산 ─────────────────────────

// 손가락 개수(0~5)에 대응하는 화음 구성. steps = 스케일 안에서 몇 칸, semis = 반음 단위.
export const PRESETS = [
  { name: '화음 없음', voices: [] },
  { name: '3도 위', voices: [{ steps: 2 }] },
  { name: '3도 + 5도 위', voices: [{ steps: 2 }, { steps: 4 }] },
  { name: '3·5도 + 베이스', voices: [{ steps: 2 }, { steps: 4 }, { semis: -12 }] },
  { name: '풀 합창', voices: [{ steps: 2 }, { steps: 4 }, { semis: -12 }, { semis: 12, gain: 0.45 }] },
];
export const MAX_VOICES = 4;
const VOICE_PAN = [-0.45, 0.45, 0, 0.2];
// 합창 성부가 들어오는 시차 (ms): 사람마다 숨 쉬고 소리 내는 순간이 조금씩 다르다
const VOICE_LAG_MS = [0, 9, 14, 5];
const DRIFT_CENTS = 6;

// 실수 MIDI 음을 키 안에서 가장 가까운 스케일 음으로 맞춘다.
export function snapToScale(midi, tonic, scale) {
  const len = scale.length;
  const oct = Math.floor((midi - tonic) / 12);
  let best = null;
  for (let o = oct - 1; o <= oct + 1; o++) {
    for (let d = 0; d < len; d++) {
      const cand = tonic + 12 * o + scale[d];
      const dist = Math.abs(cand - midi);
      if (!best || dist < best.dist) best = { midi: cand, index: o * len + d, dist };
    }
  }
  return best;
}

export function fromScaleIndex(index, tonic, scale) {
  const len = scale.length;
  const oct = Math.floor(index / len);
  return tonic + 12 * oct + scale[index - oct * len];
}

export function harmonyTargets(midi, presetIndex, tonic, scaleName) {
  const scale = SCALES[scaleName] || SCALES.major;
  const snap = snapToScale(midi, tonic, scale);
  const preset = PRESETS[presetIndex] || PRESETS[0];
  const targets = preset.voices.map((v) =>
    v.steps != null ? fromScaleIndex(snap.index + v.steps, tonic, scale) : snap.midi + v.semis,
  );
  return { snapped: snap.midi, targets };
}

// ───────────────────────── 음정 검출 (YIN) ─────────────────────────

export class PitchDetector {
  constructor(sampleRate, opts = {}) {
    this.decim = sampleRate >= 32000 ? 2 : 1; // 48kHz → 24kHz로 낮춰 계산량 절감
    this.sr = sampleRate / this.decim;
    this.minHz = opts.minHz ?? 70;
    this.maxHz = opts.maxHz ?? 1100;
    this.threshold = opts.threshold ?? 0.15;
    this.gate = opts.gate ?? 0.006; // 이보다 작은 소리는 무성음으로 본다
    this.tauMin = Math.max(2, Math.floor(this.sr / this.maxHz));
    this.tauMax = Math.ceil(this.sr / this.minHz);
    this.W = Math.max(this.tauMax, Math.round(this.sr * 0.02));
    this.N = this.W + this.tauMax + 2;
    this.hop = Math.max(32, Math.round((this.sr * (opts.hopMs ?? 10)) / 1000));
    this.ring = new Float32Array(this.N);
    this.frame = new Float32Array(this.N);
    this.d = new Float32Array(this.tauMax + 2);
    this.w = 0;
    this.count = 0;
    this.sinceHop = 0;
    this.half = 0;
    this.phase = 0;
    this.hist = [];
    this.freq = 0;
    this.confidence = 0;
    this.voiced = false;
    this.rms = 0;
  }

  // 검출 결과가 실제 소리보다 얼마나 늦는지 (ms): 분석 창 절반 + 홉 + 중간값 필터
  get trackingLatencyMs() {
    return ((this.N / 2 + this.hop * 1.5) / this.sr) * 1000;
  }

  process(input) {
    for (let i = 0; i < input.length; i++) this.push(input[i]);
  }

  push(x) {
    if (this.decim === 2) {
      if (this.phase === 0) {
        this.half = x;
        this.phase = 1;
        return;
      }
      x = 0.5 * (this.half + x);
      this.phase = 0;
    }
    this.ring[this.w] = x;
    this.w = (this.w + 1) % this.N;
    this.count++;
    if (++this.sinceHop >= this.hop && this.count >= this.N) {
      this.sinceHop = 0;
      this.analyze();
    }
  }

  analyze() {
    const { N, W, tauMax, frame: f, d } = this;
    for (let i = 0; i < N; i++) f[i] = this.ring[(this.w + i) % N];

    let e = 0;
    for (let i = N - W; i < N; i++) e += f[i] * f[i];
    this.rms = Math.sqrt(e / W);

    // 누적 평균 정규화 차이 함수
    d[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const df = f[j] - f[j + tau];
        s += df * df;
      }
      run += s;
      d[tau] = run > 0 ? (s * tau) / run : 1;
    }

    let tau = -1;
    for (let t = this.tauMin; t < tauMax; t++) {
      if (d[t] < this.threshold) {
        while (t + 1 < tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    let voiced = tau > 0;
    if (!voiced) {
      tau = this.tauMin;
      for (let t = this.tauMin; t < tauMax; t++) if (d[t] < d[tau]) tau = t;
    }

    let bt = tau;
    if (tau > 1 && tau < tauMax) {
      const a = d[tau - 1];
      const b = d[tau];
      const c = d[tau + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) bt = tau + (0.5 * (a - c)) / den;
    }

    this.confidence = Math.max(0, Math.min(1, 1 - d[tau]));
    voiced = voiced && this.rms > this.gate;
    if (voiced) {
      this.hist.push(this.sr / bt);
      if (this.hist.length > 3) this.hist.shift();
      const sorted = [...this.hist].sort((p, q) => p - q);
      this.freq = sorted[sorted.length >> 1];
    } else {
      this.hist.length = 0;
    }
    this.voiced = voiced;
  }
}

// ───────────────────────── 공용 입력 버퍼 ─────────────────────────

export class InputRing {
  constructor(size = 1 << 15) {
    this.buf = new Float32Array(size);
    this.mask = size - 1;
    this.n = 0; // 지금까지 쓴 샘플 수 (절대 인덱스)
  }
  push(x) {
    this.buf[this.n & this.mask] = x;
    this.n++;
  }
  at(i) {
    return this.buf[i & this.mask];
  }
  interp(pos) {
    const i = Math.floor(pos);
    const fr = pos - i;
    return this.at(i) * (1 - fr) + this.at(i + 1) * fr;
  }
}

// ───────────────────────── 엔진 A: 그레인(지연선) 피치시프트 ─────────────────────────
// Tone.js PitchShift와 같은 원리: 길이가 변하는 지연선 두 개를 교차 페이드.

export class GranularVoice {
  constructor(ring, sampleRate, windowMs = 40, delay = 0) {
    this.ring = ring;
    this.sr = sampleRate;
    this.delay = delay; // 추가 지연(샘플): 합창 성부마다 조금씩 늦게 들어오게
    this.p = 0;
    this.ratio = 1;
    this.target = 1;
    this.smooth = 1 - Math.exp(-1 / (0.008 * sampleRate));
    this.setWindow(windowMs);
  }
  setWindow(ms) {
    this.W = Math.max(64, Math.round((ms * this.sr) / 1000));
  }
  get latencyMs() {
    return ((this.W / 2 + this.delay) / this.sr) * 1000;
  }
  processBlock(out, len) {
    const ring = this.ring;
    const n0 = ring.n - len - this.delay;
    const W = this.W;
    for (let i = 0; i < len; i++) {
      this.ratio += (this.target - this.ratio) * this.smooth;
      this.p += (1 - this.ratio) / W;
      this.p -= Math.floor(this.p);
      let p2 = this.p + 0.5;
      if (p2 >= 1) p2 -= 1;
      const now = n0 + i;
      const g1 = Math.sin(Math.PI * this.p);
      const g2 = Math.sin(Math.PI * p2);
      out[i] = g1 * g1 * ring.interp(now - this.p * W) + g2 * g2 * ring.interp(now - p2 * W);
    }
  }
}

// ───────────────────────── 엔진 B: PSOLA ─────────────────────────
// 목소리의 한 주기 단위(피치 마크)로 잘라 간격을 바꿔 다시 붙인다. 모음의 음색(포먼트)이 덜 변한다.

export class PsolaAnalyzer {
  constructor(ring, sampleRate, minHz = 70) {
    this.ring = ring;
    this.sr = sampleRate;
    this.maxT = Math.ceil(sampleRate / minHz);
    this.T = Math.round(sampleRate / 200);
    this.voiced = false;
    this.marks = []; // { pos, T }
    this.lastMark = 0;
  }
  setPitch(freq, voiced) {
    if (voiced && freq > 0) this.T = Math.max(16, Math.min(this.maxT, Math.round(this.sr / freq)));
    this.voiced = voiced;
  }
  update() {
    const ring = this.ring;
    const n = ring.n;
    if (n - this.lastMark > this.maxT * 4) this.lastMark = n - this.maxT * 2; // 끊겼다 다시 시작한 경우
    while (this.lastMark + this.T + (this.T >> 1) < n) {
      let c = this.lastMark + this.T;
      if (this.voiced) {
        // 예상 위치 주변 ±T/4에서 파형의 최고점에 마크를 맞춘다
        const r = this.T >> 2;
        let best = c;
        let bv = -Infinity;
        for (let i = c - r; i <= c + r; i++) {
          const v = ring.at(i);
          if (v > bv) {
            bv = v;
            best = i;
          }
        }
        c = Math.max(this.lastMark + (this.T >> 1), best);
      }
      this.marks.push({ pos: c, T: this.T });
      this.lastMark = c;
    }
    const oldest = n - this.maxT * 6;
    let drop = 0;
    while (drop < this.marks.length && this.marks[drop].pos < oldest) drop++;
    if (drop) this.marks.splice(0, drop);
  }
  // 위치 s에 가장 가까운 마크 중, 앞뒤 한 주기 분량이 이미 버퍼에 들어온 것
  nearest(s) {
    const n = this.ring.n;
    let best = null;
    let bd = Infinity;
    for (let k = this.marks.length - 1; k >= 0; k--) {
      const m = this.marks[k];
      if (m.pos + m.T > n) continue;
      const dist = Math.abs(m.pos - s);
      if (dist < bd) {
        bd = dist;
        best = m;
      } else if (m.pos < s) break;
    }
    return best;
  }
}

export class PsolaVoice {
  constructor(analyzer, latency) {
    this.an = analyzer;
    this.ring = analyzer.ring;
    this.L = latency;
    this.acc = new Float32Array(1 << 15);
    this.mask = this.acc.length - 1;
    this.nextSynth = 0;
    this.target = 1;
  }
  get latencyMs() {
    return (this.L / this.an.sr) * 1000;
  }
  reset() {
    this.acc.fill(0);
    this.nextSynth = 0;
  }
  processBlock(out, len) {
    const ring = this.ring;
    const n = ring.n;
    const tEnd = n - this.L;
    const tStart = tEnd - len;
    const ratio = this.target;
    if (this.nextSynth < tStart - this.an.maxT || this.nextSynth > tEnd + 4 * this.an.maxT) {
      this.nextSynth = tStart;
    }
    for (;;) {
      const mark = this.an.nearest(this.nextSynth);
      const T = mark ? mark.T : this.an.T;
      if (this.nextSynth - T >= tEnd) break;
      if (mark) {
        const g = Math.min(2, 1 / ratio);
        const s = this.nextSynth;
        for (let k = -T; k < T; k++) {
          const w = 0.5 - 0.5 * Math.cos((Math.PI * (k + T)) / T);
          this.acc[(s + k) & this.mask] += g * w * ring.at(mark.pos + k);
        }
      }
      this.nextSynth += Math.max(1, Math.round(T / ratio));
    }
    for (let i = 0; i < len; i++) {
      const idx = (tStart + i) & this.mask;
      out[i] = this.acc[idx];
      this.acc[idx] = 0;
    }
  }
}

// ───────────────────────── 엔진 C: 합성 보이스 ("아~") ─────────────────────────

const VOWEL_A = [
  [730, 110, 1.0],
  [1090, 130, 0.45],
  [2440, 180, 0.2],
];
// 합창용 '아~': 조금 더 둥근 모음 + 가수 포먼트(2.8kHz 근처, 합창이 반주를 뚫고 들리는 대역)
const VOWEL_CHOIR = [
  [650, 120, 1.0],
  [1050, 140, 0.5],
  [2650, 220, 0.16],
  [2950, 260, 0.12],
];
const ENSEMBLE_CENTS = [0, 7, -6, 3];

// 작은 결정적 난수 (워클릿·테스트에서 같은 결과)
function lcg(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export class SynthVoice {
  // opts.choir: 합창 성부용 음색 (기본은 깨끗한 독창 — 테스트 신호로도 쓴다)
  //   ensemble: 한 성부를 함께 부르는 사람 수 - 1, breath: 숨소리 양, seed
  constructor(sampleRate, opts = {}) {
    this.sr = sampleRate;
    this.choir = Boolean(opts.choir);
    this.singers = 1 + (this.choir ? Math.max(0, Math.min(3, opts.ensemble ?? 1)) : 0);
    this.breath = this.choir ? opts.breath ?? 0.05 : 0;
    this.rand = lcg(opts.seed ?? 1);
    this.freq = 220;
    this.target = 220;
    this.theta = new Float64Array(this.singers);
    this.vib = new Float64Array(this.singers);
    this.vibRate = new Float64Array(this.singers);
    this.drift = new Float64Array(this.singers);
    this.driftTo = new Float64Array(this.singers);
    for (let k = 0; k < this.singers; k++) {
      this.theta[k] = this.rand() * Math.PI * 2;
      this.vib[k] = this.rand() * Math.PI * 2;
      this.vibRate[k] = (2 * Math.PI * (5.0 + 0.7 * this.rand())) / sampleRate;
    }
    this.driftCount = 0;
    this.driftSmooth = 1 - Math.exp(-1 / (0.25 * sampleRate));
    this.amps = new Float32Array(64);
    this.nh = 0;
    this.ampFreq = 0;
    this.glide = 1 - Math.exp(-1 / (0.025 * sampleRate));
    // 숨소리: 2차 공명 필터 (1.6kHz 근처, 넓게)
    const fc = 1600;
    const r = Math.exp((-Math.PI * 1400) / sampleRate);
    this.bpA1 = 2 * r * Math.cos((2 * Math.PI * fc) / sampleRate);
    this.bpA2 = -r * r;
    this.bpG = 1 - r;
    this.bp1 = 0;
    this.bp2 = 0;
  }
  computeAmps(f) {
    const nh = Math.max(1, Math.min(63, Math.floor(5000 / f)));
    const vowel = this.choir ? VOWEL_CHOIR : VOWEL_A;
    let pow = 0;
    for (let h = 1; h <= nh; h++) {
      const fh = h * f;
      // 성대음(배음마다 1/h로 약해짐) × 모음 포먼트 강조
      let boost = 0.25;
      for (let i = 0; i < vowel.length; i++) {
        let [F, bw, g] = vowel[i];
        // 높은 소리(소프라노)는 첫 포먼트를 기본음 위로 올려 부른다 — 얇아지지 않게
        if (this.choir && i === 0 && F < f * 1.1) F = f * 1.1;
        boost += 2 * g * Math.exp(-0.5 * ((fh - F) / bw) ** 2);
      }
      const a = boost / h;
      this.amps[h] = a;
      pow += a * a;
    }
    const norm = 0.35 / Math.sqrt(pow / 2) / Math.sqrt(this.singers);
    for (let h = 1; h <= nh; h++) this.amps[h] *= norm;
    this.nh = nh;
    this.ampFreq = f;
  }
  // env: 샘플별 음량(입력 목소리 크기를 따라감). null이면 1.
  processBlock(out, len, env) {
    const S = this.singers;
    for (let i = 0; i < len; i++) {
      this.freq += (this.target - this.freq) * this.glide;
      if (Math.abs(this.freq - this.ampFreq) > this.ampFreq * 0.004) this.computeAmps(this.freq);
      if (S > 1 && ++this.driftCount >= 4096) {
        // 함께 부르는 사람마다 음정이 천천히 조금씩 다르게 흔들림 (±4 cent)
        this.driftCount = 0;
        for (let k = 0; k < S; k++) this.driftTo[k] = (this.rand() * 2 - 1) * 4;
      }
      let sum = 0;
      for (let k = 0; k < S; k++) {
        if (S > 1) this.drift[k] += (this.driftTo[k] - this.drift[k]) * this.driftSmooth;
        this.vib[k] += this.vibRate[k];
        if (this.vib[k] > 2 * Math.PI) this.vib[k] -= 2 * Math.PI;
        const cents = ENSEMBLE_CENTS[k] + this.drift[k];
        const f = this.freq * (1 + 0.004 * Math.sin(this.vib[k])) * (cents ? Math.pow(2, cents / 1200) : 1);
        let th = this.theta[k] + (2 * Math.PI * f) / this.sr;
        if (th > 2 * Math.PI) th -= 2 * Math.PI;
        this.theta[k] = th;
        // sin(hθ)를 점화식으로 계산: s(h+1) = 2cosθ·s(h) − s(h−1)
        const c2 = 2 * Math.cos(th);
        let prev = 0;
        let cur = Math.sin(th);
        for (let h = 1; h <= this.nh; h++) {
          sum += this.amps[h] * cur;
          const nx = c2 * cur - prev;
          prev = cur;
          cur = nx;
        }
      }
      if (this.breath) {
        // 숨소리: 성대가 열리는 순간마다 조금씩 (주기에 맞춰 출렁이는 잡음)
        const n = (this.rand() * 2 - 1) * (0.55 + 0.45 * Math.cos(this.theta[0]));
        const y = this.bpG * n + this.bpA1 * this.bp1 + this.bpA2 * this.bp2;
        this.bp2 = this.bp1;
        this.bp1 = y;
        sum += this.breath * 2.2 * y;
      }
      out[i] = sum * (env ? env[i] : 1);
    }
  }
}

// ───────────────────────── 하모나이저 (전체 조립) ─────────────────────────

export const ENGINES = ['granular', 'psola', 'synth'];

export class Harmonizer {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.ring = new InputRing();
    this.det = new PitchDetector(sampleRate);
    this.analyzer = new PsolaAnalyzer(this.ring, sampleRate, this.det.minHz);
    const L = Math.round(this.analyzer.maxT * 1.5);
    this.params = {
      engine: 'psola',
      preset: 2,
      tonic: 0,
      scale: 'major',
      lock: true,
      dryGain: 1,
      harmGain: 0.8,
      windowMs: 40,
      humanize: 1, // 0 = 기계처럼 딱 맞게, 1 = 사람 합창처럼 성부마다 음정·타이밍이 조금씩 다름
    };
    this.gran = [];
    this.psola = [];
    this.synth = [];
    for (let i = 0; i < MAX_VOICES; i++) {
      const lag = Math.round(VOICE_LAG_MS[i] * sampleRate / 1000);
      this.gran.push(new GranularVoice(this.ring, sampleRate, this.params.windowMs, lag));
      this.psola.push(new PsolaVoice(this.analyzer, L + lag));
      this.synth.push(new SynthVoice(sampleRate, { choir: true, ensemble: 1, breath: 0.05, seed: i + 1 }));
    }
    // 성부별 사람다움: 천천히 움직이는 음정 흔들림(cent)과 고역 다듬기
    this.rand = lcg(7);
    this.ratio = new Float32Array(MAX_VOICES).fill(1);
    this.drift = new Float32Array(MAX_VOICES);
    this.driftTo = new Float32Array(MAX_VOICES);
    this.driftClock = 0;
    this.driftSmooth = 1 - Math.exp(-128 / (0.3 * sampleRate)); // 블록마다
    this.lp = new Float32Array(MAX_VOICES);
    this.lpCoef = 1 - Math.exp((-2 * Math.PI * 7000) / sampleRate);
    this.norm = 1;
    this.voiceGain = new Float32Array(MAX_VOICES);
    this.voiceTarget = new Float32Array(MAX_VOICES);
    this.wasActive = new Array(MAX_VOICES).fill(false);
    this.vbuf = [];
    this.envBuf = new Float32Array(128);
    this.gate = 0;
    this.follow = 0;
    this.targets = [];
    this.snapped = null;
    this.detMidi = null;
    this.attack = 1 - Math.exp(-1 / (0.006 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.08 * sampleRate));
    this.voiceSmooth = 1 - Math.exp(-1 / (0.02 * sampleRate));
    this.followCoef = 1 - Math.exp(-1 / (0.012 * sampleRate));
  }

  setParams(p) {
    const prev = { ...this.params };
    Object.assign(this.params, p);
    if (this.params.windowMs !== prev.windowMs) this.gran.forEach((g) => g.setWindow(this.params.windowMs));
    if (this.params.engine !== prev.engine) this.psola.forEach((v) => v.reset());
  }

  engineLatencyMs() {
    const e = this.params.engine;
    if (e === 'granular') return this.gran[0].latencyMs;
    if (e === 'psola') return this.psola[0].latencyMs;
    return 0;
  }

  ensureBuffers(len) {
    if (this.vbuf.length && this.vbuf[0].length >= len) return;
    this.vbuf = Array.from({ length: MAX_VOICES }, () => new Float32Array(len));
    this.envBuf = new Float32Array(len);
    this.synthEnv = new Float32Array(len);
  }

  updateTargets() {
    const { det, params } = this;
    if (!det.voiced) return;
    const midi = hzToMidi(det.freq);
    const h = harmonyTargets(midi, params.preset, params.tonic, params.scale);
    this.detMidi = midi;
    this.snapped = h.snapped;
    this.targets = h.targets;
    const ref = params.lock ? midi : h.snapped;
    for (let i = 0; i < MAX_VOICES; i++) {
      if (i >= h.targets.length) continue;
      const ratio = Math.pow(2, (h.targets[i] - ref) / 12);
      this.ratio[i] = ratio;
      this.synth[i].target = params.lock ? midiToHz(h.targets[i]) : det.freq * ratio;
    }
  }

  // input: 모노 입력, outL/outR: 덮어쓴다
  process(input, outL, outR) {
    const len = input.length;
    this.ensureBuffers(len);
    for (let i = 0; i < len; i++) this.ring.push(input[i]);
    this.det.process(input);
    this.updateTargets();
    this.analyzer.setPitch(this.det.freq, this.det.voiced);
    this.analyzer.update();

    const { params } = this;
    const preset = PRESETS[params.preset] || PRESETS[0];
    let power = 0;
    for (let v = 0; v < MAX_VOICES; v++) {
      this.voiceTarget[v] = v < preset.voices.length ? preset.voices[v].gain ?? 1 : 0;
      power += this.voiceTarget[v] * this.voiceTarget[v];
    }
    // 성부가 많아져도 합창단 전체 크기는 비슷하게 (같은 목소리를 옮긴 소리라 거의 그대로 더해진다)
    const normTarget = 1 / Math.sqrt(Math.max(1, power));

    // 성부마다 음정이 천천히 다르게 흔들림 (약 0.4초마다 새 목표, 부드럽게 따라감)
    const human = Math.max(0, params.humanize ?? 1);
    this.driftClock += len;
    if (this.driftClock >= this.sr * 0.4) {
      this.driftClock = 0;
      for (let v = 0; v < MAX_VOICES; v++) this.driftTo[v] = (this.rand() * 2 - 1) * DRIFT_CENTS * human;
    }
    for (let v = 0; v < MAX_VOICES; v++) {
      this.drift[v] += (this.driftTo[v] - this.drift[v]) * this.driftSmooth * (len / 128);
      const r = this.ratio[v] * Math.pow(2, this.drift[v] / 1200);
      this.gran[v].target = r;
      this.psola[v].target = r;
    }

    // 유성음일 때만 화음이 들리게 하는 게이트 + 입력 음량 추적
    const gateTarget = this.det.voiced ? 1 : 0;
    const env = this.envBuf;
    const synthEnv = this.synthEnv;
    for (let i = 0; i < len; i++) {
      this.gate += (gateTarget - this.gate) * (gateTarget > this.gate ? this.attack : this.release);
      this.follow += (Math.abs(input[i]) - this.follow) * this.followCoef;
      env[i] = this.gate;
      synthEnv[i] = Math.min(1, this.follow * 3.2) * this.gate;
    }

    for (let v = 0; v < MAX_VOICES; v++) {
      const active = this.voiceGain[v] > 1e-4 || this.voiceTarget[v] > 0;
      const buf = this.vbuf[v];
      if (!active) {
        buf.fill(0, 0, len);
        if (this.wasActive[v]) this.psola[v].reset(); // 다시 켜질 때 예전 조각이 섞이지 않게
        this.wasActive[v] = false;
        continue;
      }
      this.wasActive[v] = true;
      if (params.engine === 'granular') this.gran[v].processBlock(buf, len);
      else if (params.engine === 'psola') this.psola[v].processBlock(buf, len);
      else this.synth[v].processBlock(buf, len, synthEnv);
    }

    const dry = params.dryGain;
    const hg = params.harmGain;
    const useGate = params.engine !== 'synth'; // 합성 보이스는 이미 env를 곱했다
    // 음높이를 옮긴 목소리의 거친 고역(조각 이음 소리)을 살짝 다듬는다
    const smooth = useGate && human > 0;
    const a = this.lpCoef;
    for (let i = 0; i < len; i++) {
      let l = dry * input[i];
      let r = l;
      this.norm += (normTarget - this.norm) * this.voiceSmooth;
      for (let v = 0; v < MAX_VOICES; v++) {
        this.voiceGain[v] += (this.voiceTarget[v] - this.voiceGain[v]) * this.voiceSmooth;
        const g = this.voiceGain[v];
        if (g < 1e-4) continue;
        let x = this.vbuf[v][i];
        if (smooth) x = this.lp[v] += (x - this.lp[v]) * a;
        const s = x * g * hg * this.norm * (useGate ? env[i] : 1);
        const pan = VOICE_PAN[v];
        l += s * (1 - pan) * 0.7;
        r += s * (1 + pan) * 0.7;
      }
      outL[i] = l;
      if (outR !== outL) outR[i] = r;
    }
  }

  stats() {
    const d = this.det;
    return {
      voiced: d.voiced,
      freq: d.voiced ? d.freq : 0,
      midi: d.voiced ? hzToMidi(d.freq) : null,
      confidence: d.confidence,
      rms: d.rms,
      snapped: this.snapped,
      targets: d.voiced ? this.targets.slice() : [],
      engineLatencyMs: this.engineLatencyMs(),
      trackingLatencyMs: d.trackingLatencyMs,
    };
  }
}

// ───────────────────────── 데모 음원 (마이크 없이 테스트) ─────────────────────────
// "작은 별" 앞 소절을 합성 목소리로 렌더링한다.

export function renderDemo(sampleRate, { bpm = 96, transpose = 0 } = {}) {
  const melody = [60, 60, 67, 67, 69, 69, 67, null, 65, 65, 64, 64, 62, 62, 60, null];
  const beat = (60 / bpm) * sampleRate;
  const total = Math.round(beat * melody.length);
  const out = new Float32Array(total);
  const voice = new SynthVoice(sampleRate);
  const one = new Float32Array(1);
  let seed = 1;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  let amp = 0;
  for (let i = 0; i < total; i++) {
    const k = Math.floor(i / beat);
    const pos = (i - k * beat) / beat;
    let note = melody[k];
    // 음표 끝 15%는 쉬어서 음이 바뀌는 순간을 만든다 (빈 박자는 이전 음을 길게)
    let on = pos < 0.85;
    if (note == null) {
      note = melody[k - 1];
      on = pos < 0.6;
    }
    if (note != null) voice.target = midiToHz(note + transpose);
    if (i === 0) voice.freq = voice.target;
    amp += ((on ? 1 : 0) - amp) * (on ? 0.004 : 0.0015);
    voice.processBlock(one, 1, null);
    out[i] = 0.5 * amp * one[0] + 0.004 * noise();
  }
  return out;
}
