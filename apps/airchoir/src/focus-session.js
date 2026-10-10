import { FocusUI } from './focus-ui.js';
import { StageCapture } from './stage-capture.js';
import { SessionRecorder } from './session-recorder.js';

const REASONS = {
  user: '녹화를 마쳤어요.', 'exit-focus': '작업 화면으로 돌아와 녹화를 마쳤어요.',
  settings: '설정을 열어 녹화를 마쳤어요.', 'mode-change': '연주 모드 변경으로 녹화를 마쳤어요.',
  'session-ended': '세션 종료로 녹화를 마쳤어요.', hidden: '화면이 숨겨져 녹화를 마쳤어요.',
  blur: '창을 벗어나 녹화를 마쳤어요.', 'camera-ended': '카메라 입력이 끝나 녹화를 마쳤어요.',
  'camera-muted': '카메라 입력이 중단되어 녹화를 마쳤어요.',
  'render-error': '영상 합성이 중단됐어요. 남은 녹화를 확인해 주세요.',
  'time-limit': '10분 한도에 도달해 녹화를 마쳤어요.',
  'size-limit': '크기 한도에 도달해 녹화를 마쳤어요.',
  'source-ended': '녹화 입력이 끝나 영상을 마무리했어요.',
};

// Owns the view/recording boundary, never opens devices or stores a file itself.
export class FocusSession {
  constructor({ video, overlay, stage, getAudio, getPerformance, getWheelGeometry, getTheme,
    isReady, isCameraReady, onStop, onPreviewPlay = onStop, onMode, onInput, onStyle, onSettings, notify }) {
    Object.assign(this, { video, getAudio, getPerformance, isReady, isCameraReady, onStop, onSettings, notify });
    this.active = false;
    this.message = '';
    this.viewError = '';
    this.lastDraw = -Infinity;
    this.lastRender = -Infinity;
    this.mutedSince = null;
    this.exiting = false;
    this.capture = new StageCapture({ video, overlay, stage, getPerformance, getWheelGeometry, getTheme });
    this.recorder = new SessionRecorder({ onChange: () => { if (this.ui) this.render(); } });
    this.ui = new FocusUI({
      onEnter: () => this.enter(),
      onExit: () => void this.exit(),
      onSettings: () => { this.boundary('settings'); this.onSettings(); },
      onStop: () => this.onStop(),
      onRecordStart: () => this.startRecording(),
      onRecordStop: () => this.boundary('user'),
      onFullscreen: () => void this.toggleFullscreen(),
      onDownload: () => this.recorder.download(),
      onDiscard: () => { this.ui.pausePreview?.(); this.recorder.discard(); this.message = ''; this.render(); },
      onPreviewPlay,
      onMode: value => { onMode?.(value); this.render(); },
      onInput: value => { onInput?.(value); this.render(); },
      // 화음 성격은 소리만 바꾸므로 녹화를 마무리하지 않는다
      onStyle: (kind, value) => { onStyle?.(kind, value); this.render(); },
    });
    this.events = new AbortController();
    document.addEventListener('fullscreenchange', () => this.render(), { signal: this.events.signal });
    window.addEventListener('beforeunload', (event) => {
      const { status, blob } = this.recorder.state;
      if (['recording', 'stopping'].includes(status) || blob) {
        event.preventDefault(); event.returnValue = '';
      }
    }, { signal: this.events.signal });
    // Capture phase precedes the wheel's keyboard handler; dialogs keep their own Escape.
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.active || document.querySelector('dialog[open]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void this.exit();
    }, { capture: true, signal: this.events.signal });
    this.render();
  }

  cameraLive() {
    const tracks = this.video.srcObject?.getVideoTracks?.() || [];
    return this.isCameraReady() && !this.video.hidden && this.video.readyState >= 2
      && tracks.some(track => track.readyState === 'live');
  }

  enter() {
    if (!this.isReady() || this.exiting) return false;
    if (this.active) return true;
    this.onStop();
    this.viewError = '';
    this.active = true;
    this.ui.enter();
    this.message = this.cameraLive() ? '집중 연주 · 영상 녹화는 버튼을 눌러 시작하세요.' : '카메라 없는 연주 화면입니다. 영상 녹화에는 카메라 세션이 필요해요.';
    this.render();
    return true;
  }

  async exit() {
    if (!this.active || this.exiting) return;
    this.exiting = true;
    this.onStop();
    try { await this.boundary('exit-focus'); }
    finally {
      this.active = false;
      if (document.fullscreenElement) {
        try { await document.exitFullscreen(); } catch { /* app layout still exits */ }
      }
      this.ui.exit();
      this.exiting = false;
      this.render();
    }
  }

  // Synchronously request stop before the caller mutates mode/layout or closes
  // source tracks. MediaRecorder supplies its final chunk asynchronously.
  boundary(reason) {
    this.ui.pausePreview?.();
    if (['recording', 'stopping'].includes(this.recorder.state.status)) {
      this.message = REASONS[reason] || '입력이 변경되어 녹화를 마쳤어요.';
      const result = this.recorder.stop(reason);
      this.render();
      return result;
    }
    return Promise.resolve(this.recorder.state);
  }

  sessionEnded() {
    this.boundary('session-ended');
    this.active = false;
    this.ui.exit();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    // Completed clips belong to this page, not the replaceable audio session.
    this.render();
  }

  startRecording() {
    this.viewError = '';
    if (!this.active || !this.isReady() || !this.cameraLive() || document.hidden
      || document.querySelector('dialog[open]')) {
      this.message = '카메라가 준비된 집중 연주 화면에서 녹화를 시작하세요.';
      this.render(); return false;
    }
    if (this.recorder.state.blob) {
      this.message = '기존 영상을 다운로드한 뒤 버리기를 눌러 새 녹화를 준비하세요.';
      this.render(); return false;
    }
    try {
      this.capture.resizeForRecording();
      if (this.capture.draw() === false) throw new Error('영상을 그릴 수 없어요.');
      const started = this.recorder.start({ canvas: this.capture.canvas,
        audioStream: this.getAudio().getRecordingStream(), label: 'airchoir-performance' });
      this.message = started ? '녹화 중 · 카메라 + 현재 위젯 + 앱 소리' : this.recorder.state.error || '녹화를 시작하지 못했어요.';
      this.lastDraw = performance.now();
      this.render(); return started;
    } catch (error) {
      this.message = `녹화를 시작하지 못했어요. ${error.message}`;
      this.notify(this.message); this.render(); return false;
    }
  }

  tick(now) {
    if (this.recorder.state.status === 'recording') {
      if (!this.cameraLive()) this.boundary('camera-ended');
      else {
        const muted = this.video.srcObject.getVideoTracks().some(track => track.muted);
        this.mutedSince = muted ? this.mutedSince ?? now : null;
        if (this.mutedSince !== null && now - this.mutedSince > 1500) this.boundary('camera-muted');
        else if (now - this.lastDraw >= 1000 / 30) {
          this.lastDraw = now;
          try {
            if (this.capture.draw() === false) this.boundary('render-error');
          } catch { this.boundary('render-error'); }
        }
      }
    } else this.mutedSince = null;
    if (now - this.lastRender > 200) { this.lastRender = now; this.render(); }
  }

  render() {
    const state = this.recorder.state;
    const performanceState = this.getPerformance();
    const capability = this.recorder.capability(this.capture.canvas);
    const live = this.cameraLive();
    const problem = !capability.supported ? capability.reason : !live ? '영상 녹화에는 준비된 카메라가 필요합니다.' : '';
    const recordingMessage = state.status === 'recording' ? '녹화 중 · 카메라 + 현재 위젯 + 앱 소리'
      : state.status === 'stopping' ? '녹화를 마무리하고 있어요. 마지막 영상 조각을 기다립니다.'
        : state.status === 'ready' ? `${REASONS[state.reason] || '녹화를 마쳤어요.'} 영상을 확인하고 다운로드하세요.` : '';
    const result = state.blob ? { url: state.url, filename: state.filename,
      mimeType: state.mime, durationMs: state.elapsedMs, size: state.sizeBytes } : null;
    this.ui.render({ active: this.active, ready: this.isReady(),
      product: performanceState.product, hands: performanceState.hands, input: performanceState.input,
      styles: performanceState.styles,
      cameraAvailable: this.isCameraReady(),
      sourceLabel: performanceState.product === 'chord' ? '소리 · 합성 코드'
        : `소리 · ${{ mic: '마이크', demo: '목소리 데모', file: '오디오 파일' }[performanceState.sourceKind] || '준비 전'}`,
      recording: state.status === 'recording', stopping: state.status === 'stopping',
      elapsedMs: state.elapsedMs, canRecord: this.active && live && capability.supported && !result,
      status: recordingMessage || this.message || problem || '카메라 + 현재 위젯 + 앱 소리를 녹화합니다.',
      modeLabel: performanceState.product === 'chord' ? `코드 악기 · ${performanceState.hands === 'two' ? '두 손' : '한 손'}` : '목소리 합창 · 한 손',
      performanceStatus: performanceState.status,
      recordingError: state.error || this.viewError || (this.active && !result ? problem : '') || '', result,
      fullscreen: !!document.fullscreenElement,
    });
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else throw new Error('전체 화면 기능을 지원하지 않아요.');
    } catch {
      this.viewError = '전체 화면으로 전환할 수 없어요. 현재 집중 화면에서 계속 연주할 수 있습니다.';
      this.render();
    }
  }
}
