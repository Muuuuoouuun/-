// 오디오 그래프
//   입력 ─┬─ 내 목소리 볼륨 ───────────────────────────────┐
//         ├─ 하모나이저(worklet) ─ 밝기 필터 ─ 합창단 볼륨 ─┼─ 마스터 ─ 스피커
//         │                                    └─ 리버브 ───┤
//         │                                                 │
//         └──────────── 녹음 버스 ← (합창단 볼륨, 리버브)   오브들 ─┤
//                         └→ 녹음기(worklet, 최근 40초)       메트로놈 ─┘
// 내 목소리는 워클릿을 거치지 않아 추가 지연이 없다.
// 녹음 버스에는 목소리(모니터 볼륨과 무관)와 화음만 들어가고, 오브와 메트로놈은 빠진다.
import { renderDemo } from '../core/dsp.js';
import { orbMix } from './orbs.js';

function makeImpulse(ctx, seconds = 2.6, decay = 3.2) {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const pre = Math.round(ctx.sampleRate * 0.018);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = pre; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - (i - pre) / (len - pre), decay);
  }
  return buf;
}

export class ChoirAudio {
  constructor() {
    this.ctx = null;
    this.ready = false; // init이 끝까지 끝났는지 (ctx는 중간에 먼저 생긴다)
    this.source = null;
    this.onStats = null;
    this.params = { engine: 'psola', preset: 0, tonic: 0, scale: 'major', lock: true, dryGain: 0, harmGain: 1, windowMs: 40 };
    this.control = { gain: 0, cutoff: 0, reverb: 0 };
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    await ctx.audioWorklet.addModule(new URL('../core/worklet.js', import.meta.url));
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
    this.master.gain.value = 0.9;

    this.node.connect(this.filter).connect(this.harmGain).connect(this.master);
    this.harmGain.connect(this.reverbSend).connect(this.reverb).connect(this.master);
    this.dry.connect(this.master);
    this.master.connect(ctx.destination);

    // 오브용: 녹음 버스 → 녹음기, 오브 버스, 메트로놈
    await ctx.audioWorklet.addModule(new URL('../core/recorder-worklet.js', import.meta.url));
    this.recBus = ctx.createGain();
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
    this.harmGain.connect(this.recBus);
    this.reverb.connect(this.recBus);
    this.reqs = new Map();
    this.reqId = 1;
    this.recorder.port.onmessage = (e) => {
      if (e.data?.type !== 'data') return;
      const r = this.reqs.get(e.data.id);
      this.reqs.delete(e.data.id);
      r?.(e.data.channels);
    };
    this.orbBus = ctx.createGain();
    this.orbBus.connect(this.master);
    this.orbNodes = new Map();
    this.click = ctx.createGain();
    this.click.gain.value = 0.35;
    this.click.connect(this.master);
    this.metronome = { on: false, next: 0, timer: null };
    this.post();
    this.ready = true;
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
    this.dry?.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  // 손동작 상태 → 화음 구성, 합창단 볼륨, 밝기
  setGesture(s) {
    if (!this.ready) return;
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
    node.connect(this.recBus);
    this.source = { node, kind, ...extra };
  }

  async useMic() {
    await this.init();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.stopSource();
    this.connectSource(this.ctx.createMediaStreamSource(stream), 'mic', { stream });
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
    await this.init();
    this.playData(renderDemo(this.ctx.sampleRate), 'demo');
  }

  async useFile(file) {
    await this.init();
    const decoded = await this.ctx.decodeAudioData(await file.arrayBuffer());
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
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const shift = this.roundTripSec();
    const from = Math.round((orb.begin + shift) * sr);
    const to = from + Math.round(orb.len * sr);
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const timer = setTimeout(() => {
        this.reqs.delete(id);
        reject(new Error('timeout'));
      }, (orb.len + shift) * 1000 + 3000);
      this.reqs.set(id, (channels) => {
        clearTimeout(timer);
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
      });
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
    const n = this.orbNodes.get(orb.id);
    if (!n) return;
    const now = this.ctx.currentTime;
    n.gain.gain.setTargetAtTime(0, now, 0.03);
    n.src.stop(now + 0.25);
    this.orbNodes.delete(orb.id);
  }

  // ───────────── 메트로놈 ─────────────

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
        osc.start(t);
        osc.stop(t + 0.06);
        this.metronome.next += T.beat;
      }
    };
    tick();
    this.metronome.timer = setInterval(tick, 25);
  }
}
