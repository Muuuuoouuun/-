// 최근 몇십 초를 계속 담아 두는 링 버퍼. 프레임 번호(오디오 컨텍스트의 절대 샘플 위치)로 구간을 꺼낸다.
export class RingRecorder {
  constructor(sampleRate, { channels = 2, seconds = 40 } = {}) {
    let size = 1;
    while (size < sampleRate * seconds) size <<= 1;
    this.size = size;
    this.mask = size - 1;
    this.channels = channels;
    this.bufs = Array.from({ length: channels }, () => new Float32Array(size));
    this.frame = 0; // 다음에 쓸 절대 프레임
  }

  // input: 채널 배열 (모노면 모든 채널에 복사)
  write(input, startFrame) {
    const len = input[0]?.length || 0;
    for (let c = 0; c < this.channels; c++) {
      const src = input[c] || input[0];
      const dst = this.bufs[c];
      for (let i = 0; i < len; i++) dst[(startFrame + i) & this.mask] = src ? src[i] : 0;
    }
    this.frame = startFrame + len;
  }

  has(from, to) {
    return to <= this.frame && from >= this.frame - this.size && to > from;
  }

  read(from, to) {
    if (!this.has(from, to)) return null;
    return this.bufs.map((b) => {
      const out = new Float32Array(to - from);
      for (let i = 0; i < out.length; i++) out[i] = b[(from + i) & this.mask];
      return out;
    });
  }
}
