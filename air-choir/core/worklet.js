// AudioWorklet: 오디오 스레드에서 하모나이저를 돌리고, 상태를 메인 스레드로 보낸다.
import { Harmonizer } from './dsp.js';

class AirChoirProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.h = new Harmonizer(sampleRate);
    this.blocks = 0;
    this.silence = new Float32Array(128);
    this.port.onmessage = (e) => {
      if (e.data?.type === 'params') this.h.setParams(e.data.params);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const len = out[0].length;
    const inp = inputs[0];
    let x = inp && inp.length ? inp[0] : null;
    if (!x) {
      if (this.silence.length !== len) this.silence = new Float32Array(len);
      x = this.silence;
    }
    this.h.process(x, out[0], out[1] || out[0]);
    if (++this.blocks % 6 === 0) this.port.postMessage({ type: 'stats', t: currentTime, ...this.h.stats() });
    return true;
  }
}

registerProcessor('airchoir', AirChoirProcessor);
