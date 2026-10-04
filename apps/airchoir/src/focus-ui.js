// Presentation only. The caller owns camera/audio, recording, blobs and fullscreen.
const element = (tag, className = '', text = '') => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};
const button = (id, text, className = '', label = text) => {
  const el = element('button', className, text);
  el.id = id; el.type = 'button'; el.setAttribute('aria-label', label);
  return el;
};
const timeText = (milliseconds) => {
  const total = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
};
const sizeText = (bytes) => {
  const size = Math.max(0, Number(bytes) || 0);
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(size ? 1 : 0, Math.round(size / 1024))} KB`;
};
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

export class FocusUI {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.state = { ready: false, recording: false, stopping: false, canRecord: true, elapsedMs: 0, status: '', recordingError: '', result: null };
    this._active = false;
    this.resultURL = null;
    this.listeners = new AbortController();
    this.toolbar = document.getElementById('focus-toolbar');
    this.enterButton = document.getElementById('focus-enter');
    this.indicator = document.getElementById('focus-recording-indicator');
    this.resultPanel = document.getElementById('focus-recording-result');
    this.buildToolbar();
    this.buildIndicator();
    this.buildResult();
    this.enterButton.addEventListener('click', () => this.call('onEnter'), { signal: this.listeners.signal });
    this.resize = new ResizeObserver(() => this.measureToolbar());
    this.resize.observe(this.toolbar);
    this.render();
  }

  call(name, ...args) { return this.callbacks[name]?.(...args); }
  get active() { return this._active; }
  get isActive() { return this._active; }

  buildToolbar() {
    const identity = element('div', 'focus-identity');
    this.title = element('strong', '', '집중 연주');
    this.source = element('span', 'focus-source');
    this.source.id = 'focus-source';
    this.liveMarker = element('span', 'focus-live-marker', '녹화 중');
    this.liveMarker.hidden = true;
    this.time = element('time', 'focus-time', '00:00');
    this.time.id = 'focus-time'; this.time.setAttribute('aria-label', '영상 녹화 경과 시간');
    this.time.setAttribute('role', 'timer'); this.time.setAttribute('aria-live', 'off');
    identity.append(this.title, this.source);
    const topline = element('div', 'focus-topline');
    const recordControls = element('div', 'focus-record-controls');
    const modes = element('div', 'focus-modes');
    const modeSwitch = element('div', 'focus-mode-switch');
    modeSwitch.setAttribute('role', 'group');
    modeSwitch.setAttribute('aria-label', '연주 모드');
    this.modeButtons = new Map();
    for (const [value, label] of [['chord-one', '한 손 코드'], ['chord-two', '두 손 코드'], ['choir', '목소리 합창']]) {
      const choice = button(`focus-mode-${value}`, label, 'quiet');
      choice.setAttribute('aria-pressed', 'false');
      choice.addEventListener('click', () => this.call('onMode', value));
      this.modeButtons.set(value, choice);
      modeSwitch.append(choice);
    }
    modes.append(modeSwitch);
    this.status = element('p', 'focus-status');
    this.status.id = 'focus-status'; this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.performanceStatus = element('p', 'focus-performance-status');
    this.performanceStatus.id = 'focus-performance-status';
    this.performanceStatus.setAttribute('role', 'status');
    this.performanceStatus.hidden = true;
    const actions = element('div', 'focus-main-actions');
    const inputField = element('label', 'focus-input-field');
    const inputLabel = element('span', '', '조작');
    this.input = element('select'); this.input.id = 'focus-input';
    this.input.setAttribute('aria-label', '집중 연주 조작 방식');
    for (const [value, label] of [['hands', '손동작'], ['manual', '클릭 · 키보드']]) {
      const option = element('option', '', label); option.value = value;
      this.input.append(option);
    }
    this.input.addEventListener('change', () => this.call('onInput', this.input.value));
    inputField.append(inputLabel, this.input);
    const settings = button('focus-settings', '설정', 'quiet', '휠 설정');
    settings.setAttribute('aria-haspopup', 'dialog'); settings.setAttribute('aria-controls', 'wheel-dialog');
    settings.addEventListener('click', () => this.call('onSettings'));
    const stop = button('focus-all-stop', '모두 정지', 'all-stop', '모든 소리 정지');
    stop.addEventListener('click', () => this.call('onStop'));
    const exit = button('focus-exit', '작업 화면', 'quiet', '작업 화면으로 돌아가기');
    exit.setAttribute('aria-keyshortcuts', 'Escape');
    exit.addEventListener('click', () => this.call('onExit'));
    this.record = button('focus-record', '녹화 시작', 'focus-record-button', '영상 녹화 시작');
    this.record.setAttribute('aria-describedby', 'focus-record-scope focus-record-hint');
    this.record.addEventListener('click', () => this.call(this.state.recording ? 'onRecordStop' : 'onRecordStart'));
    this.fullscreen = button('focus-fullscreen', '전체 화면', 'quiet', '전체 화면 전환');
    this.fullscreen.addEventListener('click', () => this.call('onFullscreen'));
    actions.append(inputField, settings, stop, exit, this.fullscreen);
    recordControls.append(this.liveMarker, this.time, this.record);
    topline.append(identity, recordControls);
    const feedback = element('div', 'focus-feedback');
    feedback.append(this.performanceStatus, this.status);
    this.scope = element('p', 'focus-capture-note', '카메라·위젯 + 앱 소리(루프·클릭 포함) · 이 기기에만 녹화');
    const scope = this.scope;
    scope.id = 'focus-record-scope';
    this.recordHint = element('p', 'focus-record-hint'); this.recordHint.id = 'focus-record-hint';
    this.recordHint.hidden = true;
    this.toolbar.append(topline, modes, actions, feedback, scope, this.recordHint);
  }

  buildIndicator() {
    const copy = element('div', 'focus-workspace-record-copy');
    this.workspaceLabel = element('strong', '', '영상 녹화 중');
    this.workspaceTime = element('time', 'focus-time', '00:00');
    this.workspaceTime.id = 'focus-workspace-time';
    this.workspaceTime.setAttribute('aria-label', '영상 녹화 경과 시간');
    this.workspaceTime.setAttribute('aria-live', 'off');
    this.workspaceStatus = element('p'); this.workspaceStatus.setAttribute('role', 'status');
    copy.append(this.workspaceLabel, this.workspaceTime, this.workspaceStatus);
    this.workspaceStop = button('focus-workspace-record-stop', '녹화 정지', 'focus-record-button', '영상 녹화 정지');
    this.workspaceStop.addEventListener('click', () => this.call('onRecordStop'));
    this.workspaceResult = button('focus-workspace-result-open', '영상 확인', 'primary');
    this.workspaceResult.hidden = true;
    this.workspaceResult.addEventListener('click', () => {
      this.resultPanel.open = true;
      this.resultPanel.scrollIntoView({ block: 'start' });
      this.resultPanel.querySelector('summary').focus({ preventScroll: true });
    });
    this.error = element('p', 'focus-record-error'); this.error.id = 'focus-record-error';
    this.error.setAttribute('role', 'alert'); this.error.hidden = true;
    this.indicator.append(copy, this.workspaceStop, this.workspaceResult, this.error);
  }

  buildResult() {
    const summary = element('summary', 'focus-result-summary');
    summary.append(element('strong', '', '녹화 완료'), element('span', '', '미리보기 · 다운로드'));
    const body = element('div', 'focus-result-body');
    this.video = element('video', 'focus-result-video'); this.video.id = 'focus-result-video';
    this.video.controls = true; this.video.playsInline = true; this.video.preload = 'metadata';
    this.video.setAttribute('aria-label', '녹화 영상 미리보기');
    // Playback is explicit. Stop the live performance before the preview emits sound.
    this.video.addEventListener('play', () => this.call('onPreviewPlay'));
    this.filename = element('p', 'focus-result-name'); this.filename.id = 'focus-result-name';
    const meta = element('dl', 'focus-result-meta');
    const fields = [['format', '형식'], ['duration', '길이'], ['size', '크기']];
    this.meta = {};
    for (const [key, label] of fields) {
      const group = element('div');
      const value = element('dd'); value.id = `focus-result-${key}`;
      group.append(element('dt', '', label), value); meta.append(group); this.meta[key] = value;
    }
    const actions = element('div', 'focus-result-actions');
    const download = button('focus-result-download', '영상 다운로드', 'primary');
    download.addEventListener('click', () => this.call('onDownload'));
    const discard = button('focus-result-discard', '영상 버리기', 'quiet');
    discard.addEventListener('click', () => this.call('onDiscard'));
    actions.append(download, discard);
    const note = element('p', 'focus-result-note', '새로고침·닫기 전 다운로드하세요. 저장 후 영상을 버리면 새로 녹화할 수 있습니다. 저장하지 않고 버린 영상은 복구할 수 없습니다.');
    body.append(this.video, this.filename, meta, actions, note);
    this.resultPanel.append(summary, body);
    this.resultPanel.setAttribute('aria-label', '녹화 영상 파일');
  }

  enter() {
    if (this._active) return;
    this.previousFocus = document.activeElement;
    this.previousScroll = { x: window.scrollX, y: window.scrollY };
    this._active = true;
    document.body.classList.add('is-performance-focus');
    this.toolbar.hidden = false;
    this.measureToolbar();
    window.scrollTo(0, 0);
    document.getElementById('focus-exit').focus({ preventScroll: true });
  }

  exit() {
    if (!this._active) return;
    this._active = false;
    document.body.classList.remove('is-performance-focus');
    this.toolbar.hidden = true;
    const target = this.previousFocus?.isConnected && !this.previousFocus.closest?.('[hidden]') ? this.previousFocus : this.enterButton;
    if (!target.disabled) target.focus({ preventScroll: true });
    window.scrollTo(this.previousScroll?.x || 0, this.previousScroll?.y || 0);
  }

  measureToolbar() {
    if (this._active) document.body.style.setProperty('--focus-toolbar-height', `${Math.ceil(this.toolbar.getBoundingClientRect().height)}px`);
  }

  pausePreview() { this.video.pause(); }

  render(next = {}) {
    this.state = { ...this.state, ...next };
    if (next.active !== undefined && Boolean(next.active) !== this._active) next.active ? this.enter() : this.exit();
    const { ready, recording, elapsedMs, canRecord, result, recordingError, status } = this.state;
    const stopping = this.state.stopping || this.state.statusPhase === 'stopping';
    const selectedMode = this.state.product === 'choir' ? 'choir' : `chord-${this.state.hands || 'one'}`;
    for (const [value, choice] of this.modeButtons) {
      choice.setAttribute('aria-pressed', String(value === selectedMode));
      choice.disabled = !ready || stopping;
    }
    const input = this.state.input || 'hands';
    if (this.input.value !== input) this.input.value = input;
    this.input.disabled = !ready || stopping;
    this.input.querySelector('option[value="hands"]').disabled = this.state.product === 'chord' && !this.state.cameraAvailable;
    setText(this.scope, recording ? '모드·조작·설정을 바꾸면 녹화를 마무리합니다.' : '카메라·위젯 + 앱 소리(루프·클릭 포함) · 이 기기에만 녹화');
    setText(this.fullscreen, this.state.fullscreen ? '화면 복귀' : '전체 화면');
    this.fullscreen.setAttribute('aria-label', this.state.fullscreen ? '전체 화면 종료' : '전체 화면 전환');
    this.fullscreen.setAttribute('aria-pressed', String(Boolean(this.state.fullscreen)));
    setText(this.title, this.state.modeLabel || '집중 연주');
    setText(this.source, this.state.sourceLabel || '소리 준비 전');
    this.performanceStatus.hidden = !this.state.performanceStatus;
    setText(this.performanceStatus, this.state.performanceStatus ? `연주 · ${this.state.performanceStatus}` : '');
    this.enterButton.disabled = !ready;
    this.liveMarker.hidden = !recording && !stopping;
    setText(this.liveMarker, stopping ? '마무리 중' : '녹화 중');
    this.toolbar.dataset.recording = String(recording);
    this.toolbar.dataset.stopping = String(stopping);
    this.record.dataset.recording = String(recording);
    setText(this.time, timeText(elapsedMs));
    setText(this.workspaceTime, timeText(elapsedMs));
    const message = recordingError || status || (stopping ? '영상을 마무리하고 있어요.' : recording ? '영상 녹화 중 · 카메라와 앱 소리를 담고 있어요.' : result ? '녹화 영상을 확인하고 저장하세요.' : ready ? '연주 준비됨 · 영상은 녹화 버튼을 눌러야 저장됩니다.' : '세션을 시작한 뒤 집중 연주를 열 수 있어요.');
    setText(this.status, message);
    this.status.classList.toggle('error', Boolean(recordingError));
    setText(this.workspaceStatus, message);
    setText(this.record, stopping ? '마무리 중…' : recording ? '녹화 정지' : '녹화 시작');
    this.record.setAttribute('aria-label', stopping ? '영상 녹화 마무리 중' : recording ? '영상 녹화 정지' : '영상 녹화 시작');
    this.record.disabled = stopping || (!recording && (!ready || !canRecord || Boolean(result)));
    const hint = result ? '기존 영상을 저장하고 버린 뒤 새로 녹화할 수 있어요.' : !canRecord ? '지금은 영상을 녹화할 수 없어요. 상태 안내를 확인하세요.' : '';
    this.recordHint.hidden = !hint; setText(this.recordHint, hint);
    this.indicator.hidden = !recording && !stopping && !recordingError && !result;
    this.indicator.dataset.recording = String(recording);
    setText(this.workspaceLabel, stopping ? '영상 마무리 중' : recording ? '영상 녹화 중' : result ? '녹화 영상 준비됨' : '녹화 안내');
    this.workspaceResult.hidden = !result;
    this.workspaceStop.hidden = !recording && !stopping;
    this.workspaceStop.disabled = stopping;
    setText(this.workspaceStop, stopping ? '마무리 중…' : '녹화 정지');
    this.error.hidden = !recordingError; setText(this.error, recordingError || '');
    this.renderResult(result);
    this.measureToolbar();
  }

  renderResult(result) {
    const url = typeof result?.url === 'string' && result.url.startsWith('blob:') ? result.url : null;
    const hadFocus = this.resultPanel.contains(document.activeElement);
    this.resultPanel.hidden = !result;
    if (!result) {
      if (this.resultURL) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
      this.resultURL = null;
      if (hadFocus) {
        const target = this._active ? this.record : this.state.ready ? this.enterButton : document.getElementById('start-pointer');
        if (target && !target.disabled) target.focus({ preventScroll: true });
      }
      return;
    }
    if (url !== this.resultURL) {
      this.video.pause();
      if (url) this.video.src = url;
      else this.video.removeAttribute('src');
      this.resultURL = url;
      this.resultPanel.open = true;
    }
    this.video.hidden = !url;
    setText(this.filename, result.filename || '녹화 영상');
    const mime = (result.mimeType || '알 수 없는 형식').split(';')[0];
    const format = mime === 'video/webm' ? 'WebM' : mime === 'video/mp4' ? 'MP4' : mime;
    setText(this.meta.format, format);
    setText(this.meta.duration, timeText(result.durationMs));
    setText(this.meta.size, sizeText(result.size));
  }

  destroy() {
    this.exit();
    this.resize.disconnect(); this.listeners.abort();
    this.video.pause(); this.video.removeAttribute('src'); this.video.load();
    this.toolbar.replaceChildren(); this.toolbar.hidden = true;
    this.indicator.replaceChildren(); this.indicator.hidden = true;
    this.resultPanel.replaceChildren(); this.resultPanel.hidden = true;
    document.body.style.removeProperty('--focus-toolbar-height');
  }
}
