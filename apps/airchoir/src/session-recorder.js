// Local canvas + mixed-audio recording. The caller owns the camera and audio source.
// Only this class's canvas capture tracks and cloned audio tracks are ever stopped.
const MIME_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_DURATION_MS = 10 * 60 * 1000;
const initialState = () => ({ status: 'idle', elapsedMs: 0, sizeBytes: 0, mime: '', extension: '',
  reason: null, error: null, url: null, blob: null, filename: '' });
const bounded = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.min(value, fallback) : fallback;
const extensionFor = mime => mime.toLowerCase().split(';')[0].trim() === 'video/mp4' ? 'mp4' : 'webm';
const fileLabel = label => String(label || 'airchoir-recording').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  .replace(/\.(webm|mp4)$/i, '').trim().slice(0, 80) || 'airchoir-recording';

export class SessionRecorder {
  constructor({ onChange = () => {}, deps = {}, maxBytes = MAX_BYTES, maxDurationMs = MAX_DURATION_MS,
    stopTimeoutMs = 5000, stallTimeoutMs = 15000 } = {}) {
    this.onChange = onChange;
    this.deps = {
      MediaRecorder: globalThis.MediaRecorder, MediaStream: globalThis.MediaStream,
      Blob: globalThis.Blob, URL: globalThis.URL, document: globalThis.document,
      now: () => performance.now(),
      // Browser timers require Window as their receiver, not this dependency object.
      setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), ...deps,
    };
    this.maxBytes = bounded(maxBytes, MAX_BYTES);
    this.maxDurationMs = bounded(maxDurationMs, MAX_DURATION_MS);
    this.stopTimeoutMs = bounded(stopTimeoutMs, 5000);
    this.stallTimeoutMs = bounded(stallTimeoutMs, 15000);
    this._state = initialState();
    this._run = null;
    this._disposed = false;
  }

  get state() { return { ...this._state }; }

  capability(canvas = null) {
    const { MediaRecorder, MediaStream, URL } = this.deps;
    if (typeof MediaRecorder !== 'function' || typeof MediaStream !== 'function'
      || typeof MediaRecorder.isTypeSupported !== 'function' || typeof URL?.createObjectURL !== 'function') {
      return { supported: false, mime: '', reason: '이 브라우저는 로컬 영상 녹화를 지원하지 않습니다.' };
    }
    if (canvas && typeof canvas.captureStream !== 'function') {
      return { supported: false, mime: '', reason: '이 브라우저에서는 캔버스 영상을 녹화할 수 없습니다.' };
    }
    for (const mime of MIME_TYPES) {
      try {
        if (MediaRecorder.isTypeSupported(mime)) return { supported: true, mime, reason: null };
      } catch { /* Probe the remaining formats if a browser rejects one codec string. */ }
    }
    return { supported: false, mime: '', reason: '지원되는 영상 녹화 형식(WebM/MP4)이 없습니다.' };
  }

  _emit() { this.onChange(this.state); }

  start({ canvas, audioStream, label } = {}) {
    if (this._disposed || this._run || this._state.blob) return false;
    const capability = this.capability(canvas);
    this._state = initialState();
    if (!capability.supported || !canvas || typeof audioStream?.getAudioTracks !== 'function') {
      this._state.status = 'error';
      this._state.reason = 'start-error';
      this._state.error = capability.reason || '녹화할 캔버스와 오디오 스트림이 필요합니다.';
      this._emit();
      return false;
    }
    const run = {
      recorder: null, owned: new Set(), listeners: [], chunks: [], bytes: 0,
      started: this.deps.now(), lastChunk: this.deps.now(), elapsedMs: 0,
      label: fileLabel(label), requestedMime: capability.mime, chunkMime: '', reason: null,
      error: null, capped: false, finalized: false, interval: null, timeout: null,
    };
    run.promise = new Promise(resolve => { run.resolve = resolve; });
    this._run = run;
    try {
      const sourceAudio = audioStream.getAudioTracks();
      if (!sourceAudio.length || sourceAudio.some(track => track.readyState === 'ended')) {
        throw new Error('녹음할 오디오 트랙이 없습니다. 소리를 먼저 시작해 주세요.');
      }
      const captured = canvas.captureStream(30);
      for (const track of captured.getTracks()) run.owned.add(track);
      const video = captured.getVideoTracks();
      if (!video.length || video.some(track => track.readyState === 'ended')) throw new Error('녹화할 영상 트랙이 없습니다.');
      const audio = sourceAudio.map(track => {
        const clone = track.clone();
        if (clone === track) throw new Error('공유 오디오 트랙을 안전하게 복제하지 못했습니다.');
        run.owned.add(clone);
        return clone;
      });
      const stream = new this.deps.MediaStream([...video, ...audio]);
      const recorder = (run.recorder = new this.deps.MediaRecorder(stream, { mimeType: capability.mime }));
      recorder.ondataavailable = event => this._chunk(run, event.data);
      recorder.onerror = event => {
        if (run.finalized) return;
        run.error = event.error?.message || '영상 녹화 중 오류가 발생했습니다.';
        void this.stop('recorder-error');
      };
      recorder.onstop = () => this._finish(run);
      for (const track of new Set([...run.owned, ...sourceAudio])) {
        const ended = () => { if (!run.finalized) void this.stop('source-ended'); };
        track.addEventListener?.('ended', ended);
        run.listeners.push([track, ended]);
      }
      this._state = { ...initialState(), status: 'recording', mime: recorder.mimeType || capability.mime };
      run.interval = this.deps.setInterval(() => this._tick(run), 250);
      recorder.start(1000);
      if (!run.finalized) this._emit();
      return this._state.status === 'recording';
    } catch (error) {
      run.reason = 'start-error';
      run.error = error?.message || '녹화를 시작하지 못했습니다.';
      this._finish(run);
      return false;
    }
  }

  _chunk(run, data) {
    if (run.finalized || this._run !== run || run.capped) return;
    if (!(data instanceof this.deps.Blob)) {
      run.error = '녹화 데이터 조각을 읽지 못했습니다.';
      void this.stop('chunk-error');
      return;
    }
    if (!data.size) return;
    if (run.bytes + data.size > this.maxBytes) {
      run.capped = true; // Keep a contiguous prefix; never accumulate beyond the cap.
      run.reason = 'size-limit';
      run.error = '녹화 크기 한도에 도달했습니다. 한도를 넘기기 전에 받은 부분만 보관합니다.';
      void this.stop('size-limit');
      return;
    }
    run.chunks.push(data);
    run.bytes += data.size;
    run.lastChunk = this.deps.now();
    if (!run.chunkMime && data.type) run.chunkMime = data.type;
    this._state.sizeBytes = run.bytes;
    if (run.bytes >= this.maxBytes) void this.stop('size-limit');
    else this._emit();
  }

  _tick(run) {
    if (run.finalized || this._run !== run || this._state.status !== 'recording') return;
    run.elapsedMs = Math.max(0, this.deps.now() - run.started);
    this._state.elapsedMs = run.elapsedMs;
    if (run.elapsedMs >= this.maxDurationMs) void this.stop('time-limit');
    else if (this.deps.now() - run.lastChunk >= this.stallTimeoutMs) {
      run.error = '녹화 데이터가 더 이상 들어오지 않아 녹화를 종료했습니다.';
      void this.stop('stall');
    } else this._emit();
  }

  stop(reason = 'user') {
    const run = this._run;
    if (!run) return Promise.resolve(this.state);
    if (this._state.status === 'stopping') return run.promise;
    run.reason = reason;
    run.elapsedMs = Math.max(0, this.deps.now() - run.started);
    this.deps.clearInterval(run.interval);
    run.interval = null;
    this._state = { ...this._state, status: 'stopping', elapsedMs: run.elapsedMs, reason, error: run.error };
    // Install the promise and watchdog before stop(): test/browser implementations may finish synchronously.
    run.timeout = this.deps.setTimeout(() => {
      run.reason = 'stop-timeout';
      run.error ||= '녹화 종료 응답이 지연되어 지금까지 받은 부분만 보관합니다.';
      this._finish(run);
    }, this.stopTimeoutMs);
    this._emit();
    try {
      if (run.recorder?.state !== 'inactive') run.recorder?.stop();
    } catch (error) {
      run.error ||= error?.message || '녹화를 종료하지 못했습니다.';
      // Some engines can still deliver a final data event after stop() throws.
    }
    return run.promise;
  }

  _finish(run) {
    if (run.finalized) return;
    run.finalized = true;
    this.deps.clearInterval(run.interval);
    this.deps.clearTimeout(run.timeout);
    if (run.recorder && run.recorder.state !== 'inactive') {
      try { run.recorder.stop(); } catch {}
    }
    for (const [track, ended] of run.listeners) track.removeEventListener?.('ended', ended);
    for (const track of run.owned) { try { track.stop(); } catch {} }
    if (run.recorder) {
      run.recorder.ondataavailable = run.recorder.onerror = run.recorder.onstop = null;
    }
    const mime = run.recorder?.mimeType || run.chunkMime || run.requestedMime;
    const blob = run.bytes ? new this.deps.Blob(run.chunks, { type: mime }) : null;
    run.chunks.length = 0;
    let url = null;
    if (blob) {
      try { url = this.deps.URL.createObjectURL(blob); }
      catch { run.error ||= '녹화 파일 링크를 만들지 못했습니다. 다운로드를 다시 눌러 주세요.'; }
    }
    this._state = {
      status: blob ? 'ready' : 'error', elapsedMs: run.elapsedMs || Math.max(0, this.deps.now() - run.started),
      sizeBytes: blob?.size || 0, mime: blob?.type || mime, extension: extensionFor(blob?.type || mime),
      reason: run.reason || 'recorder-stopped', error: run.error || (blob ? null : '녹화된 데이터가 없습니다.'),
      blob, url, filename: `${run.label}.${extensionFor(blob?.type || mime)}`,
    };
    if (this._run === run) this._run = null;
    run.resolve(this.state);
    this._emit();
  }

  discard() {
    if (this._run) return false;
    if (this._state.url) this.deps.URL.revokeObjectURL(this._state.url);
    this._state = initialState();
    this._emit();
    return true;
  }

  download() {
    if (!this._state.blob || this._run) return false;
    try {
      if (!this._state.url) this._state.url = this.deps.URL.createObjectURL(this._state.blob);
      const link = this.deps.document.createElement('a');
      link.href = this._state.url;
      link.download = this._state.filename;
      this.deps.document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      return true;
    } catch {
      this._state.error = '다운로드를 시작하지 못했습니다. 브라우저의 다운로드 허용 설정을 확인해 주세요.';
      this._emit();
      return false;
    }
  }

  async dispose({ preserve = false } = {}) {
    this._disposed = true;
    await this.stop('dispose');
    if (!preserve) this.discard();
    return this.state;
  }
}
