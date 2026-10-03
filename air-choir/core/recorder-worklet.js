// 오디오 스레드에서 녹음 버스를 계속 담아 두고, 요청이 오면 구간을 잘라 보낸다.
import { RingRecorder } from './recorder.js';

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = new RingRecorder(sampleRate, { channels: 2, seconds: 40 });
    this.pending = [];
    this.port.onmessage = (e) => {
      if (e.data?.type === 'read') this.pending.push(e.data);
    };
  }

  process(inputs) {
    const inp = inputs[0];
    const len = 128;
    this.rec.write(inp && inp.length ? inp : [new Float32Array(len)], currentFrame);
    if (this.pending.length) {
      this.pending = this.pending.filter((req) => {
        if (req.to > this.rec.frame) return true; // 아직 녹음 중
        const data = this.rec.read(req.from, req.to);
        this.port.postMessage({ type: 'data', id: req.id, channels: data }, data ? data.map((d) => d.buffer) : []);
        return false;
      });
    }
    return true;
  }
}

registerProcessor('airchoir-recorder', RecorderProcessor);
