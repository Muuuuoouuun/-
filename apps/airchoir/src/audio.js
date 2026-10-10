// 오디오 그래프
//   입력 ─┬─ 내 목소리 볼륨 ───────────────────────────────┐
//         ├─ 하모나이저(worklet) ─ 밝기 필터 ─ 합창단 볼륨 ─┼─ 마스터 ─ 스피커
//         │                                    └─ 리버브 ───┤
//         │                                                 │
//         └──────────── 녹음 버스 ← (합창단 볼륨, 리버브)   오브들 ─┤
//                         └→ 녹음기(worklet, 최근 40초)       메트로놈 ─┘
// 내 목소리는 워클릿을 거치지 않아 추가 지연이 없다.
// 녹음 버스에는 선택한 제품의 소리만 들어간다: 목소리+화음 또는 독립 코드 신스.
// 목소리 녹음은 모니터 볼륨과 무관하며, 오브와 메트로놈은 두 녹음 경로에서 모두 빠진다.
// 영상 녹화용 MediaStream은 마스터 뒤에서 별도로 분기해 실제 출력과 음소거를 그대로 담는다.
import { renderDemo } from '../core/dsp.js';
import { Accompaniment } from './accompaniment.js';
import { orbMix } from './orbs.js';

const canceled = () => new DOMException('Canceled', 'AbortError');

// 홀 잔향: 고역이 먼저 사라지는 꼬리(시간에 따라 어두워짐) + 좌우가 다른 초기 반사.
// 예전처럼 밝은 잡음이 끝까지 '쉬익' 하고 남지 않는다.
export function impulseData(sampleRate, seconds = 2.6, seed = 11) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const len = Math.round(sampleRate * seconds);
  const pre = Math.round(sampleRate * 0.018);
  const rt60 = seconds * 0.8;
  const channels = [];
  for (let c = 0; c < 2; c++) {
    const d = new Float32Array(len);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sampleRate;
      // 1차 저역통과의 차단 주파수가 9kHz -> 1.2kHz 로 내려감
      const fc = 1200 + 7800 * Math.exp(-t / (rt60 * 0.25));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
      lp += (rnd() - lp) * a;
      const onset = Math.min(1, t / 0.025);
      d[i] = lp * Math.exp((-6.9 * t) / rt60) * onset * onset * (1.6 + 2.4 * (1 - a));
    }
    for (let k = 0; k < 7; k++) { // 초기 반사 (8~80ms)
      const tt = 0.008 + 0.072 * ((rnd() + 1) / 2);
      const i = pre + Math.round(tt * sampleRate);
      if (i < len) d[i] += 0.5 * rnd() * Math.exp(-tt * 14);
    }
    channels.push(d);
  }
  let e = 0;
  for (const d of channels) for (let i = 0; i < len; i++) e += d[i] * d[i];
  const g = 1 / Math.sqrt(e / 2 || 1);
  for (const d of channels) for (let i = 0; i < len; i++) d[i] *= g;
  return channels;
}

function makeImpulse(ctx, seconds = 2.6) {
  const data = impulseData(ctx.sampleRate, seconds);
  const buf = ctx.createBuffer(2, data[0].length, ctx.sampleRate);
  data.forEach((d, c) => buf.copyToChannel(d, c));
  return buf;
}

export class ChoirAudio {
  constructor() {
    this.ctx = null;
    this.ready = false; // init이 끝까지 끝났는지 (ctx는 중간에 먼저 생긴다)
    this.source = null;
    this.sourceRequest = 0;
    this.reqs = new Map();
    this.orbNodes = new Map();
    this.onStats = null;
    this.product = 'choir';
    this.accompaniment = null;
    this.recordDestination = null;
    this.recordingContext = null;
    this.outputMuted = false;
    this.dryLevel = 0;
    this.params = { engine: 'psola', preset: 0, style: 'classic', tonic: 0, scale: 'major', lock: true, dryGain: 0, harmGain: 1, windowMs: 40, humanize: 1 };
    this.control = { gain: 0, cutoff: 0, reverb: 0 };
  }

  async init() {
    if (this.initializing) return this.initializing;
    if (this.ready) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.initializing = this.initGraph();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async initGraph() {
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    try {
      await ctx.audioWorklet.addModule(new URL('../core/worklet.js', import.meta.url));
      if (this.ctx !== ctx) throw canceled();
      this.node = new AudioWorkletNode(ctx, 'airchoir', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      this.node.port.onmessage = (e) => e.data?.type === 'stats' && this.onStats?.(e.data);

      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.Q.value = 0.6;
      this.harmGain = ctx.createGain();
      this.harmGain.gain.value = 0;
      this.reverbSend = ctx.createGain();
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeImpulse(ctx);
      this.dry = ctx.createGain();
      this.dry.gain.value = 0;
      this.master = ctx.createGain();
      this.master.gain.value = this.outputMuted ? 0 : 0.75;
      // 성부·오브·코드가 한꺼번에 커져도 스피커에서 찌그러지지 않게 (빠른 리미터)
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 3;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;

      this.node.connect(this.filter).connect(this.harmGain).connect(this.master);
      this.harmGain.connect(this.reverbSend).connect(this.reverb).connect(this.master);
      this.dry.connect(this.master);
      this.master.connect(this.limiter).connect(ctx.destination);

      // 오브용: 녹음 버스 → 녹음기, 오브 버스, 메트로놈
      await ctx.audioWorklet.addModule(new URL('../core/recorder-worklet.js', import.meta.url));
      if (this.ctx !== ctx) throw canceled();
      this.recBus = ctx.createGain();
      this.voiceRecord = ctx.createGain();
      this.accompRecord = ctx.createGain();
      this.voiceRecord.connect(this.recBus);
      this.accompRecord.connect(this.recBus);
      this.accompaniment = new Accompaniment(ctx, {
        destination: this.master, recordDestination: this.accompRecord,
      });
      this.recorder = new AudioWorkletNode(ctx, 'airchoir-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      const sink = ctx.createGain();
      sink.gain.value = 0; // 녹음기가 계속 돌도록 그래프에 연결만 해 둔다
      this.recBus.connect(this.recorder).connect(sink).connect(ctx.destination);
      this.harmGain.connect(this.voiceRecord);
      this.reverb.connect(this.voiceRecord);
      this.reqs = new Map();
      this.reqId = 1;
      this.recorder.port.onmessage = (e) => {
        if (e.data?.type !== 'data') return;
        const r = this.reqs.get(e.data.id);
        r?.accept(e.data.channels);
      };
      this.recorder.onprocessorerror = () => {
        for (const r of [...this.reqs.values()]) r.fail(new Error('recorder failed'));
      };
      this.orbBus = ctx.createGain();
      this.orbBus.connect(this.master);
      this.orbNodes = new Map();
      this.click = ctx.createGain();
      this.click.gain.value = 0.35;
      this.click.connect(this.master);
      this.metronome = { on: false, next: 0, timer: null };
      this.setProduct(this.product);
      this.post();
      this.ready = true;
    } catch (err) {
      if (this.ctx === ctx) await this.dispose();
      throw err;
    }
  }

  post() {
    this.node?.port.postMessage({ type: 'params', params: { ...this.params } });
  }

  setParams(p) {
    let changed = false;
    for (const k in p) {
      if (this.params[k] !== p[k]) {
        this.params[k] = p[k];
        changed = true;
      }
    }
    if (changed) this.post();
  }

  setDry(v) {
    this.dryLevel = v;
    this.dry?.gain.setTargetAtTime(this.product === 'choir' ? v : 0, this.ctx.currentTime, 0.03);
  }

  setProduct(product) {
    if (product !== 'choir' && product !== 'chord') throw new TypeError('Unknown audio product');
    if (product !== this.product) this.sourceRequest++;
    this.product = product;
    if (product === 'chord') {
      this.stopSource();
      if (this.harmGain) {
        this.harmGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.harmGain.gain.setValueAtTime(0, this.ctx.currentTime);
      }
      this.control.gain = 0;
    } else {
      this.accompaniment?.release({ immediate: true });
    }
    this.setDry(this.dryLevel);
    if (this.voiceRecord) {
      const now = this.ctx.currentTime;
      this.voiceRecord.gain.setValueAtTime(product === 'choir' ? 1 : 0, now);
      this.accompRecord.gain.setValueAtTime(product === 'chord' ? 1 : 0, now);
    }
  }

  setOutputMuted(muted) {
    this.outputMuted = Boolean(muted);
    if (!this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    if (this.outputMuted) this.master.gain.setValueAtTime(0, now);
    else this.master.gain.setTargetAtTime(0.75, now, 0.015);
  }

  // Session video captures the same post-mix signal as the speaker, including
  // voice/chords, loops, metronome and master mute. This never requests a device
  // or resumes/creates a context. The audio session owns these original tracks;
  // a recorder must clone them and stop only its own clones.
  getRecordingStream() {
    const ctx = this.ctx;
    if (!this.ready || !ctx || ctx.state === 'closed' || !this.master || !this.limiter) {
      throw new Error('오디오 세션을 먼저 시작해 주세요.');
    }
    if (this.recordDestination && this.recordingContext === ctx) return this.recordDestination.stream;
    const destination = ctx.createMediaStreamDestination();
    try {
      this.limiter.connect(destination); // 스피커와 같은 소리 (음소거·리미터 포함)
    } catch (error) {
      destination.stream.getTracks().forEach((track) => track.stop());
      destination.disconnect();
      throw error;
    }
    this.recordDestination = destination;
    this.recordingContext = ctx;
    return destination.stream;
  }

  panic() {
    this.accompaniment?.release({ immediate: true });
    for (const node of [this.harmGain, this.dry]) {
      if (!node) continue;
      node.gain.cancelScheduledValues(this.ctx.currentTime);
      node.gain.setValueAtTime(0, this.ctx.currentTime);
    }
    this.control.gain = 0;
    this.setOutputMuted(true);
  }

  // 손동작 상태 → 화음 구성, 합창단 볼륨, 밝기
  setGesture(s) {
    if (!this.ready || this.product !== 'choir') return;
    const now = this.ctx.currentTime;
    const silent = !s.present || s.fist;
    const gain = silent ? 0 : 0.12 + 1.0 * s.level;
    if (Math.abs(gain - this.control.gain) > 0.005) {
      this.harmGain.gain.setTargetAtTime(gain, now, s.fist ? 0.012 : 0.05);
      this.control.gain = gain;
    }
    const cutoff = 650 * Math.pow(2, s.brightness * 4.3); // 650Hz ~ 13kHz
    if (Math.abs(cutoff - this.control.cutoff) > this.control.cutoff * 0.02) {
      this.filter.frequency.setTargetAtTime(cutoff, now, 0.05);
      this.control.cutoff = cutoff;
    }
    const reverb = 0.6 - 0.45 * s.brightness; // 어두울수록 성당처럼 울림
    if (Math.abs(reverb - this.control.reverb) > 0.01) {
      this.reverbSend.gain.setTargetAtTime(reverb, now, 0.08);
      this.control.reverb = reverb;
    }
    if (!silent) this.setParams({ preset: s.preset });
  }

  stopSource() {
    if (!this.source) return;
    try {
      this.source.node.disconnect();
      this.source.node.stop?.();
    } catch {}
    this.source.stream?.getTracks().forEach((t) => t.stop());
    this.source = null;
  }

  connectSource(node, kind, extra = {}) {
    node.connect(this.node);
    node.connect(this.dry);
    node.connect(this.voiceRecord);
    this.source = { node, kind, ...extra };
  }

  async useMic() {
    if (this.product !== 'choir') throw canceled();
    const request = ++this.sourceRequest;
    await this.init();
    if (request !== this.sourceRequest) throw canceled();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (request !== this.sourceRequest) {
      stream.getTracks().forEach((t) => t.stop());
      throw canceled();
    }
    this.stopSource();
    try {
      this.connectSource(this.ctx.createMediaStreamSource(stream), 'mic', { stream });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
  }

  playData(data, kind) {
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.copyToChannel(data, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this.stopSource();
    this.connectSource(src, kind);
    src.start();
  }

  async useDemo() {
    if (this.product !== 'choir') throw canceled();
    const request = ++this.sourceRequest;
    await this.init();
    if (request !== this.sourceRequest) throw canceled();
    this.playData(renderDemo(this.ctx.sampleRate), 'demo');
  }

  async useFile(file) {
    if (this.product !== 'choir') throw canceled();
    const request = ++this.sourceRequest;
    await this.init();
    if (request !== this.sourceRequest) throw canceled();
    const decoded = await this.ctx.decodeAudioData(await file.arrayBuffer());
    if (request !== this.sourceRequest) throw canceled();
    const data = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < ch.length; i++) data[i] += ch[i] / decoded.numberOfChannels;
    }
    this.playData(data, 'file');
  }

  // ───────────── 오브 ─────────────

  // 마이크로 부를 때는 메트로놈을 듣고(출력 지연) 부른 소리가 들어오기까지(입력 지연) 늦어진다.
  // 그만큼 뒤에서 잘라 와야 박자가 맞는다.
  roundTripSec() {
    if (this.source?.kind !== 'mic') return 0;
    const input = this.source.stream?.getAudioTracks()[0]?.getSettings?.().latency ?? 0.01;
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + input;
  }

  // orb.begin ~ begin+len 구간을 버퍼로 가져와 orb.buffer에 넣는다
  capture(orb) {
    if (!this.ready) return Promise.reject(new Error('audio not ready'));
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const shift = (orb.recordProduct ?? this.product) === 'chord' ? 0 : this.roundTripSec();
    const from = Math.round((orb.begin + shift) * sr);
    const to = from + Math.round(orb.len * sr);
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const finish = () => {
        clearTimeout(timer);
        this.reqs.delete(id);
      };
      const fail = (err) => {
        finish();
        this.recorder?.port.postMessage({ type: 'cancel', id });
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(new Error('timeout'));
      }, (orb.len + shift) * 1000 + 3000);
      this.reqs.set(id, { orb, fail, accept: (channels) => {
        finish();
        if (!channels) return reject(new Error('expired'));
        const buf = ctx.createBuffer(2, channels[0].length, sr);
        channels.forEach((ch, c) => buf.copyToChannel(ch, c));
        // 루프 이음매에서 딸깍 소리가 나지 않게 양 끝 5ms를 살짝 줄인다
        const fade = Math.round(sr * 0.005);
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < fade; i++) {
            const g = i / fade;
            d[i] *= g;
            d[d.length - 1 - i] *= g;
          }
        }
        orb.buffer = buf;
        resolve(buf);
      } });
      this.recorder.port.postMessage({ type: 'read', id, from, to });
    });
  }

  // 녹음한 순간의 박자 위치를 이어서 재생한다 (오브끼리 박이 맞음)
  play(orb) {
    if (!orb.buffer || this.orbNodes.has(orb.id)) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = orb.buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    src.connect(gain).connect(pan).connect(this.orbBus);
    const when = ctx.currentTime + 0.03;
    const offset = (((when - orb.begin) % orb.len) + orb.len) % orb.len;
    src.start(when, offset);
    this.orbNodes.set(orb.id, { src, gain, pan });
    this.mix(orb);
  }

  mix(orb) {
    const n = this.orbNodes.get(orb.id);
    if (!n) return;
    const { pan, gain } = orbMix(orb);
    const now = this.ctx.currentTime;
    n.gain.gain.setTargetAtTime(gain, now, 0.04);
    n.pan.pan.setTargetAtTime(pan, now, 0.04);
  }

  stop(orb) {
    for (const r of [...this.reqs.values()]) if (r.orb === orb) r.fail(canceled());
    const n = this.orbNodes.get(orb.id);
    if (!n) return;
    const now = this.ctx.currentTime;
    n.gain.gain.setTargetAtTime(0, now, 0.03);
    n.src.onended = () => {
      n.src.disconnect();
      n.gain.disconnect();
      n.pan.disconnect();
    };
    n.src.stop(now + 0.25);
    this.orbNodes.delete(orb.id);
  }

  // ───────────── 메트로놈 ─────────────

  async dispose() {
    this.sourceRequest++;
    this.ready = false;
    clearInterval(this.metronome?.timer);
    this.metronome = null;
    this.stopSource();
    for (const r of [...this.reqs.values()]) r.fail(canceled());
    for (const n of this.orbNodes.values()) {
      try { n.src.stop(); } catch {}
      n.src.disconnect(); n.gain.disconnect(); n.pan.disconnect();
    }
    this.orbNodes.clear();
    this.accompaniment?.dispose();
    this.accompaniment = null;
    // Do this synchronously, before close() awaits, so a canceled session cannot
    // leave a live recording source attached while a replacement session starts.
    this.recordDestination?.stream.getTracks().forEach((track) => track.stop());
    this.recordingContext = null;
    for (const key of ['node', 'filter', 'harmGain', 'reverbSend', 'reverb', 'dry', 'master', 'limiter', 'recordDestination', 'recBus', 'voiceRecord', 'accompRecord', 'recorder', 'orbBus', 'click']) {
      const node = this[key];
      if (node?.port) { node.port.onmessage = null; node.port.close(); }
      node?.disconnect();
      this[key] = null;
    }
    const ctx = this.ctx;
    this.ctx = null;
    this.control = { gain: 0, cutoff: 0, reverb: 0 };
    if (ctx && ctx.state !== 'closed') await ctx.close();
  }

  setMetronome(on, transport) {
    if (!this.ready) return;
    this.transport = transport;
    if (on === this.metronome.on) return;
    this.metronome.on = on;
    clearInterval(this.metronome.timer);
    if (!on) return;
    this.metronome.next = transport.nextBar(this.ctx.currentTime) - transport.bar;
    while (this.metronome.next < this.ctx.currentTime) this.metronome.next += transport.beat;
    const tick = () => {
      const T = this.transport;
      while (this.metronome.next < this.ctx.currentTime + 0.12) {
        const t = this.metronome.next;
        const down = T.position(t + 1e-6).beat === 0;
        const osc = this.ctx.createOscillator();
        const env = this.ctx.createGain();
        osc.frequency.value = down ? 1568 : 1046;
        env.gain.setValueAtTime(0.0001, t);
        env.gain.exponentialRampToValueAtTime(down ? 0.9 : 0.5, t + 0.002);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        osc.connect(env).connect(this.click);
        osc.onended = () => { osc.disconnect(); env.disconnect(); };
        osc.start(t);
        osc.stop(t + 0.06);
        this.metronome.next += T.beat;
      }
    };
    tick();
    this.metronome.timer = setInterval(tick, 25);
  }
}
