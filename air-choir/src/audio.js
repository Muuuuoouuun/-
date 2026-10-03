// 오디오 그래프
//   입력 ─┬─ 내 목소리 볼륨 ───────────────────────────────┐
//         └─ 하모나이저(worklet) ─ 밝기 필터 ─ 합창단 볼륨 ─┼─ 마스터 ─ 스피커
//                                              └─ 리버브 ───┘
// 내 목소리는 워클릿을 거치지 않아 추가 지연이 없다.
import { renderDemo } from '../core/dsp.js';

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
    this.post();
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
    if (!this.ctx) return;
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
}
