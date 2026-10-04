import { PRESETS, NOTE_NAMES, midiName } from '../core/dsp.js';
import { analyzeHand, GestureTracker } from './gestures.js';
import { HandCamera } from './hands.js';
import { ChoirAudio } from './audio.js';
import { drawStage, coverMapper } from './stage.js';
import { Transport, OrbStation } from './orbs.js';
import { Performance } from './performance.js';
import { FocusSession } from './focus-session.js';

const $ = (id) => document.getElementById(id);
const css = getComputedStyle(document.documentElement);
const v = (name) => css.getPropertyValue(name).trim();
const theme = {
  colors: {
    ink: v('--ink'),
    voice: v('--voice'),
    voices: [v('--v1'), v('--v2'), v('--v3'), v('--v4')],
    bad: v('--bad'),
    skeleton: v('--skeleton'),
    track: v('--track'),
    label: v('--fg'),
    dark: v('--dark-end'),
    bright: v('--bright-end'),
    line: v('--line'),
    muted: v('--muted'),
  },
  fonts: { display: v('--font-display'), body: v('--font-body'), data: v('--font-data') },
};
const ENGINE_KEYS = { q: 'granular', w: 'psola', e: 'synth' };
const HISTORY_SEC = 6;
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');

let audio = new ChoirAudio();
const cam = new HandCamera($('video'));
let tracker = new GestureTracker();
let gesture = tracker.state();
let stats = null;
let history = [];
let mode = null; // 'camera' | 'pointer'
let soundRequest = 0;
let startupRequest = 0;
let active = true;
let starting = false;
let sessionActive = false;
let manualRecording = false;
let selectedOrbId = null;
let loopSignature = '';
let performer;
let focusSession;
const pointer = { inside: false, down: false, x: 0.5, y: 0.5, fingers: 2 };

// 오브 모드: 마디 그리드 + 오브 상태. 녹음한 구간의 음 높이로 오브 색을 정한다.
const transport = new Transport(90, 0);
const pitchLog = []; // 최근 30초 { t, midi }
function medianMidi(from, to) {
  const ms = pitchLog.filter((p) => p.t >= from && p.t <= to && p.midi != null).map((p) => p.midi).sort((a, b) => a - b);
  return ms.length ? ms[ms.length >> 1] : null;
}
const station = new OrbStation({
  transport,
  audio: {
    capture: (orb) => {
      orb.recordProduct = performer?.state.product || 'choir';
      const chord = performer?.state.current.chord;
      if (orb.recordProduct === 'chord' && chord) orb.chord = { ...chord };
      return audio.capture(orb).then(() => (orb.midi = orb.recordProduct === 'chord'
        ? (orb.chord ? 48 + orb.chord.root : null)
        : medianMidi(orb.begin, orb.begin + orb.len)));
    },
    play: (orb) => audio.play(orb),
    stop: (orb) => audio.stop(orb),
    mix: (orb) => audio.mix(orb),
  },
});
let metronomeWanted = false;
window.airchoir = { station, audio, transport, tracker }; // 디버그·자동 테스트용

// ───────────── 상태 표시 ─────────────

function notice(text, kind = '') {
  const el = $('notice');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = 'notice' + (kind ? ' ' + kind : '');
}

function status(id, text, state) {
  const el = $(id);
  el.textContent = text;
  el.dataset.state = state;
  if (starting) $('start-progress').textContent = text;
}

function markSource(kind, filename) {
  $('src-mic').setAttribute('aria-pressed', String(kind === 'mic'));
  $('src-demo').setAttribute('aria-pressed', String(kind === 'demo'));
  $('src-file-label').style.borderColor = kind === 'file' ? 'var(--fg)' : '';
  const label = { mic: '마이크 켜짐', demo: '데모 노래 재생 중', file: '녹음 파일 재생 중' }[kind] || '소리 꺼짐';
  status('st-audio', label, kind ? 'on' : 'off');
  $('source-name').textContent = kind === 'file' ? filename || '오디오 파일 재생 중' : kind === 'demo' ? '작은 별 · 합성 목소리 데모' : kind === 'mic' ? '실시간 마이크 입력' : '세션을 시작하면 입력을 바꿀 수 있어요.';
}

function setDry(val) {
  $('dry').value = val;
  $('dry-v').textContent = val.toFixed(2);
  audio.setDry(val);
}

// ───────────── 시작 ─────────────

function watchAudio(instance) {
  instance.onStats = (s) => {
    if (instance !== audio) return;
    stats = s;
    history.push({ t: s.t, midi: s.midi, targets: s.targets });
    const cut = s.t - HISTORY_SEC;
    while (history.length && history[0].t < cut) history.shift();
    pitchLog.push({ t: s.t, midi: s.midi });
    while (pitchLog.length && pitchLog[0].t < s.t - 30) pitchLog.shift();
  };
}
watchAudio(audio);

async function startSound(kind, file) {
  if (performer?.state.product === 'chord') return false;
  focusSession?.boundary('mode-change');
  const request = ++soundRequest;
  const controls = ['src-mic', 'src-demo', 'src-file'].map($);
  controls.forEach((control) => (control.disabled = true));
  status('st-audio', '소리 켜는 중', 'busy');
  try {
    if (kind === 'mic') await audio.useMic();
    else if (kind === 'demo') await audio.useDemo();
    else await audio.useFile(file);
  } catch (err) {
    if (request !== soundRequest || err.name === 'AbortError') return false;
    markSource(audio.source?.kind);
    if (kind === 'mic') {
      notice('마이크를 열 수 없어요. 브라우저 주소창의 마이크 권한을 확인해 주세요. 그동안 데모 노래로 들어 볼 수 있어요.', 'error');
    } else if (kind === 'file') {
      notice('이 파일은 열 수 없어요. mp3, m4a, wav 같은 오디오 파일이나 영상 파일을 골라 주세요.', 'error');
    } else {
      notice('오디오를 시작하지 못했어요. 잠시 뒤 다시 시작해 주세요.', 'error');
    }
    return false;
  } finally {
    if (request === soundRequest) controls.forEach((control) => (control.disabled = false));
  }
  if (request !== soundRequest) return false;
  notice('');
  markSource(kind, file?.name);
  setDry(kind === 'mic' ? 0 : 0.85);
  return true;
}

async function startCamera(request) {
  status('st-cam', '카메라 켜는 중', 'busy');
  try {
    await cam.startCamera();
  } catch (err) {
    if (request !== startupRequest || err.name === 'AbortError') return;
    cam.stop();
    usePointer('카메라를 열 수 없어서 마우스 모드로 바꿨어요. 카메라 권한을 허용하면 손으로 조작할 수 있어요.');
    return;
  }
  if (request !== startupRequest) return;
  $('video').hidden = false;
  status('st-cam', '손 인식 모델 불러오는 중', 'busy');
  try {
    await cam.loadModel();
  } catch (err) {
    if (request !== startupRequest || err.name === 'AbortError') return;
    cam.stop();
    $('video').hidden = true;
    usePointer('손 인식 모델을 불러오지 못해서 마우스 모드로 바꿨어요. 인터넷 연결을 확인한 뒤 새로고침해 주세요.');
    return;
  }
  if (request !== startupRequest) return;
  mode = 'camera';
  cam.onResult = (list, aspect) => {
    const hands = list.map((lm) => ({ ...analyzeHand(lm, aspect), landmarks: lm }));
    gesture = tracker.update(hands, performance.now(), { immediateRelease: true });
    const r = $('stage').getBoundingClientRect();
    const video = $('video');
    const mapper = coverMapper(r.width, r.height, video.videoWidth, video.videoHeight);
    performer.cameraHands(hands, p => {
      const [x, y] = mapper.map(p.x, p.y); return { x: x + r.left, y: y + r.top };
    }, performance.now());
    if (performer.legacy) {
      gesture = performer.routeLegacy(gesture);
      audio.setGesture(gesture);
    }
  };
  cam.run();
}

function usePointer(message) {
  mode = 'pointer';
  if (performer?.state.product === 'chord') performer.state.input = 'manual';
  $('stage').classList.add('pointer');
  $('pointer-help').hidden = false;
  status('st-cam', '마우스 모드', 'on');
  if (message) notice(message);
}

async function start(kind) {
  if (starting || sessionActive) return;
  const request = ++startupRequest;
  starting = true;
  $('start-intro').hidden = true;
  $('start-busy').hidden = false;
  $('session-end').disabled = false;
  $('start-cancel').focus();
  notice('');
  const soundKind = kind === 'pointer' ? 'demo' : kind;
  let ok;
  if (performer.state.product === 'chord') {
    performer.state.input = kind === 'pointer' ? 'manual' : 'hands';
    try {
      audio.setProduct('chord');
      await audio.init();
      ok = true;
      status('st-audio', '코드 악기 준비', 'on');
    } catch { notice('코드 악기를 시작하지 못했어요. 다시 시도해 주세요.', 'error'); ok = false; }
  } else ok = await startSound(soundKind);
  if (request !== startupRequest) return;
  if (!ok && soundKind === 'mic') ok = await startSound('demo');
  if (request !== startupRequest) return;
  if (!ok) {
    starting = false;
    $('start-intro').hidden = false;
    $('start-busy').hidden = true;
    $('session-end').disabled = true;
    $('start-pointer').focus();
    return;
  }
  if (kind === 'pointer') usePointer();
  else await startCamera(request);
  if (request !== startupRequest) return;
  starting = false;
  sessionActive = true;
  $('start').hidden = true;
  audio.setOutputMuted(false);
  performer.sessionStarted();
  updateProductControls();
  renderLoopHud();
  if (mode === 'camera') focusSession.enter();
  else $('record-toggle').focus();
}

// Session end and page exit share the same cleanup; a fresh engine lets a canceled
// permission/worklet request finish without blocking a new session.
function stopSession({ focus = true } = {}) {
  focusSession?.sessionEnded();
  performer?.stop('세션 종료 · 다시 시작할 수 있어요.', true);
  startupRequest++;
  soundRequest++;
  starting = sessionActive = manualRecording = false;
  station.clear();
  station.prev = { pinch: false, fist: false };
  station.lastNow = null;
  station.nextId = 1;
  station.lastPoint = { x: 0.5, y: 0.58 };
  cam.stop();
  const oldAudio = audio;
  oldAudio.onStats = null;
  void oldAudio.dispose().catch(() => {});
  audio = new ChoirAudio();
  audio.setParams({ ...oldAudio.params });
  audio.setProduct(performer?.state.product || 'choir');
  watchAudio(audio);
  tracker = new GestureTracker();
  gesture = tracker.state();
  window.airchoir.audio = audio;
  window.airchoir.tracker = tracker;
  mode = null;
  pointer.down = pointer.inside = false;
  stats = null;
  history = [];
  pitchLog.length = 0;
  selectedOrbId = null;
  metronomeWanted = false;
  $('metronome').checked = false;
  $('start').hidden = false;
  $('start-intro').hidden = false;
  $('start-busy').hidden = true;
  $('video').hidden = true;
  $('stage').classList.remove('pointer');
  $('pointer-help').hidden = true;
  $('session-end').disabled = true;
  ['src-mic', 'src-demo', 'src-file'].map($).forEach((control) => (control.disabled = true));
  markSource(null);
  status('st-cam', '시작 전', 'off');
  notice('');
  renderLoopHud();
  performer?.render();
  focusSession?.render();
  if (focus) $('start-pointer').focus();
}

function recordAction() {
  if (!sessionActive || !audio.ready) return;
  const now = audio.ctx.currentTime;
  if (station.mode === 'idle') {
    manualRecording = station.beginRecording(now);
  } else if (station.mode === 'countin' || station.mode === 'recording') {
    manualRecording = false;
    station.finishRecording(now);
  } else if (station.mode === 'holding') {
    station.placeHeld();
  }
  renderLoopHud();
}

function cancelRecording() {
  manualRecording = false;
  station.cancelRecording();
  renderLoopHud();
  $('record-toggle').focus();
}

station.on('orb', (orb) => { manualRecording = false; selectedOrbId = orb.id; });
station.on('grab', (orb) => { selectedOrbId = orb.id; });

// ───────────── 마우스 모드 ─────────────

function pointerHand() {
  if (!pointer.inside) return [];
  const f = pointer.fingers;
  const palm = { x: 1 - pointer.x, y: pointer.y }; // 카메라 원본 좌표로 (화면은 거울)
  return [{
    fingers: f,
    fist: f === 0,
    extended: [f === 5, f >= 1, f >= 2, f >= 3, f >= 4],
    palm,
    size: 0.09,
    // 마우스 버튼을 누르고 있으면 핀치
    pinch: pointer.down,
    pinchShape: true,
    pinchDist: pointer.down ? 0.1 : 1,
    pinchPoint: palm,
  }];
}

function bindPointer() {
  const stage = $('stage');
  const move = (e) => {
    const r = stage.getBoundingClientRect();
    pointer.x = (e.clientX - r.left) / r.width;
    pointer.y = (e.clientY - r.top) / r.height;
    pointer.inside = true;
    performer?.rearmLegacy();
  };
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerdown', (e) => {
    if (mode !== 'pointer' || !performer.legacy || performer.settingsOpen) return;
    move(e);
    pointer.down = true;
    stage.setPointerCapture?.(e.pointerId);
  });
  const up = () => (pointer.down = false);
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('pointerleave', () => {
    if (!pointer.down) pointer.inside = false;
  });
}

// ───────────── 컨트롤 ─────────────

function setEngine(engine) {
  audio.setParams({ engine });
  document.querySelectorAll('[data-engine]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.engine === engine)));
}

function bindControls() {
  $('start-mic').onclick = () => start('mic');
  $('start-demo').onclick = () => start('demo');
  $('start-pointer').onclick = () => start('pointer');
  $('start-cancel').onclick = () => stopSession();
  $('session-end').onclick = () => stopSession();
  $('record-toggle').onclick = recordAction;
  $('record-cancel').onclick = cancelRecording;
  $('src-mic').onclick = () => startSound('mic');
  $('src-demo').onclick = () => startSound('demo');
  $('src-file').onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) startSound('file', file);
  };
  $('dry').oninput = (e) => setDry(+e.target.value);

  const key = $('key');
  NOTE_NAMES.forEach((n, i) => key.add(new Option(`${n} 키`, i)));
  key.onchange = () => audio.setParams({ tonic: +key.value });
  $('scale').onchange = (e) => audio.setParams({ scale: e.target.value });
  $('lock').onchange = (e) => audio.setParams({ lock: e.target.checked });

  const bpm = $('bpm');
  [70, 80, 90, 100, 110, 120, 130].forEach((b) => bpm.add(new Option(`${b} BPM`, b, b === 90, b === 90)));
  bpm.onchange = () => transport.set(+bpm.value);
  $('metronome').onchange = (e) => (metronomeWanted = e.target.checked);
  $('clear-orbs').onclick = () => { manualRecording = false; station.clear(); selectedOrbId = null; renderLoopHud(); $('record-toggle').focus(); };
  $('loop-list').onclick = (e) => {
    const button = e.target.closest('[data-orb-id]');
    if (!button) return;
    selectedOrbId = +button.dataset.orbId;
    renderLoopHud();
  };
  $('orb-mute').onclick = () => {
    const orb = station.orbs.find((o) => o.id === selectedOrbId);
    if (orb) { orb.muted = !orb.muted; if (!orb.muted) { audio.setOutputMuted(false); audio.play(orb); } audio.mix(orb); renderLoopHud(); }
  };
  $('orb-delete').onclick = () => {
    const orb = station.orbs.find((o) => o.id === selectedOrbId);
    if (orb) station.pop(orb, audio.ctx.currentTime);
    selectedOrbId = station.orbs[0]?.id ?? null;
    renderLoopHud();
    ($('loop-list').querySelector('[aria-pressed="true"]') || $('record-toggle')).focus();
  };
  $('orb-place').onclick = () => {
    station.placeHeld();
    renderLoopHud();
    ($('loop-list').querySelector('[aria-pressed="true"]') || $('record-toggle')).focus();
  };
  document.querySelectorAll('[data-engine]').forEach((b) => (b.onclick = () => setEngine(b.dataset.engine)));

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || performer.settingsOpen) return;
    if (e.target.closest?.('input, select, textarea, video, audio, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (starting) { e.preventDefault(); stopSession(); }
      else {
        e.preventDefault();
        const wasRecording = ['countin', 'recording', 'finishing'].includes(station.mode);
        performer.stop('전체 정지 · 기존 오브는 보관했어요.', true);
        if (wasRecording) $('record-toggle').focus();
      }
    } else if (k === ' ' && !e.target.closest?.('button, a, summary')) {
      e.preventDefault();
      // The loop transport is hidden in focus; media previews own their native keys.
      if (!focusSession?.active) recordAction();
    }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && e.target.closest?.('#stage, #loop-list')) {
      const orb = station.orbs.find((o) => o.id === selectedOrbId && o.state === 'placed');
      if (!orb) return;
      e.preventDefault();
      orb.x += e.key === 'ArrowRight' ? 0.025 : e.key === 'ArrowLeft' ? -0.025 : 0;
      orb.y += e.key === 'ArrowDown' ? 0.025 : e.key === 'ArrowUp' ? -0.025 : 0;
      station.keepInside(orb);
      audio.mix(orb);
    }
    else if (ENGINE_KEYS[k] && performer.state.product === 'choir') setEngine(ENGINE_KEYS[k]);
    else if (mode === 'pointer' && performer.legacy && k >= '0' && k <= '5') { pointer.fingers = +k; performer.rearmLegacy(); }
  });
}

// ───────────── 그리기 ─────────────

const overlay = $('overlay');
const og = overlay.getContext('2d');
const traceCanvas = $('trace');
const tg = traceCanvas.getContext('2d');

function fitCanvas(canvas, g) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [w, h];
}

// 손 위치를 무대 화면 기준 0~1 좌표로 (카메라 영상이 잘려 보이는 만큼 보정)
function toStage(mapper, W, H, p) {
  const [x, y] = mapper.map(p.x, p.y);
  return { x: x / W, y: y / H };
}

function displayGesture() {
  if (performer.legacy) return gesture;
  const state = performer.state;
  return { present: state.product === 'choir' && state.armed, fist: !state.armed,
    preset: state.current.choir ?? 0, fingers: 0, level: .65, brightness: .6,
    hand: null, pinch: false };
}

function drawOverlay() {
  const [W, H] = fitCanvas(overlay, og);
  const video = $('video');
  const mapper = mode === 'camera' && video.videoWidth ? coverMapper(W, H, video.videoWidth, video.videoHeight) : coverMapper(W, H, W, H);
  let loops = null;
  if (audio.ready) {
    const now = audio.ctx.currentTime;
    const hand = gesture.present ? gesture.hand : null;
    const screen = hand
      ? { palm: toStage(mapper, W, H, hand.palm), pinchPoint: toStage(mapper, W, H, hand.pinchPoint || hand.palm) }
      : null;
    station.aspect = W / H;
    // 오브가 HUD 아래, 음량 게이지 왼쪽, 밝기 바 위에 머물도록
    const hud = document.querySelector('.hud');
    station.bounds = {
      x0: 0.03,
      x1: 1 - 62 / W,
      y0: Math.min(0.45, (hud.offsetTop + hud.offsetHeight + 10) / H),
      y1: 1 - 52 / H,
    };
    const manual = manualRecording && ['countin', 'recording'].includes(station.mode);
    const routed = performer.legacy && !performer.blocked && !performer.settingsOpen ? { ...gesture, screen } : { present: false, pinch: false, fist: false, screen: null };
    station.update(manual ? { ...routed, present: true, pinch: true, fist: false, screen } : routed, now);
    const recording = ['countin', 'recording', 'finishing'].includes(station.mode);
    audio.setMetronome(metronomeWanted || recording, transport);
    loops = { station, transport, now, pinchAt: screen?.pinchPoint, selectedId: selectedOrbId, reducedMotion: motionPreference.matches };
  }
  drawStage(og, W, H, { mapper, gesture: displayGesture(), stats, theme, loops });
}

let center = 64;
function drawTrace() {
  const [w, h] = fitCanvas(traceCanvas, tg);
  tg.clearRect(0, 0, w, h);
  const voiced = history.filter((p) => p.midi != null).map((p) => p.midi);
  if (voiced.length) {
    const sorted = [...voiced].sort((a, b) => a - b);
    center += (sorted[sorted.length >> 1] - center) * 0.05;
  }
  const span = 30;
  const lo = center - span * 0.45;
  const y = (m) => h - ((m - lo) / span) * h;
  const tonic = audio.params.tonic;
  tg.lineWidth = 1;
  for (let m = Math.ceil(lo); m <= lo + span; m++) {
    const pc = (((m - tonic) % 12) + 12) % 12;
    if (pc !== 0) continue;
    tg.strokeStyle = theme.colors.line;
    tg.beginPath();
    tg.moveTo(0, Math.round(y(m)) + 0.5);
    tg.lineTo(w, Math.round(y(m)) + 0.5);
    tg.stroke();
    tg.fillStyle = theme.colors.muted;
    tg.font = `11px ${theme.fonts.data}`;
    tg.fillText(midiName(m), 4, y(m) - 4);
  }
  if (!history.length) return;
  const tEnd = history[history.length - 1].t;
  const x = (t) => ((t - (tEnd - HISTORY_SEC)) / HISTORY_SEC) * w;
  const line = (get, color, width) => {
    tg.strokeStyle = color;
    tg.lineWidth = width;
    tg.beginPath();
    let pen = false;
    for (const p of history) {
      const m = get(p);
      if (m == null) {
        pen = false;
        continue;
      }
      pen ? tg.lineTo(x(p.t), y(m)) : tg.moveTo(x(p.t), y(m));
      pen = true;
    }
    tg.stroke();
  };
  for (let i = 3; i >= 0; i--) line((p) => (p.midi != null ? p.targets[i] : null), theme.colors.voices[i], 1.6);
  line((p) => p.midi, theme.colors.voice, 2.4);
}

function renderHud() {
  const shown = displayGesture();
  const on = stats && stats.midi != null;
  const note = $('hud-note');
  note.textContent = on ? midiName(stats.midi) : '—';
  note.className = 'hud-note' + (on ? '' : ' off');

  const chips = $('hud-chips');
  let html;
  if (!shown.present) html = `<span class="chip idle">${performer.state.input === 'manual' ? '휠에서 화음을 선택하세요' : mode === 'pointer' ? '무대 위에서 움직여 보세요' : mode ? '손을 보여 주세요' : '시작 전'}</span>`;
  else if (shown.fist) html = '<span class="chip idle">정지</span>';
  else if (on && stats.targets.length) html = stats.targets.map((m, i) => `<span class="chip v${i}">${midiName(m)}</span>`).join('');
  else html = '<span class="chip idle">노래를 기다리는 중</span>';
  if (chips.innerHTML !== html) chips.innerHTML = html;

  $('hud-preset').textContent = !shown.present
    ? '—'
    : shown.fist
      ? '주먹 · 정지'
      : `${performer.state.input === 'manual' ? '프리셋' : `${shown.fingers}개`} · ${PRESETS[shown.preset].name}`;

  const g = !gesture.present ? 'none' : gesture.fist ? 'fist' : String(Math.min(4, gesture.fingers));
  document.querySelectorAll('#guide li[data-g]').forEach((li) => li.classList.toggle('now', li.dataset.g === g));

  if (mode === 'camera' && cam.fps) status('st-cam', `손 인식 ${Math.round(cam.fps)}fps`, 'on');
  renderLoopHud();
}

function renderLoopHud() {
  const now = audio.ctx?.currentTime ?? 0;
  const pos = transport.position(now);
  document.querySelectorAll('#hud-beat i').forEach((el, i) => el.classList.toggle('on', i === pos.beat));
  $('hud-bpm').textContent = `${transport.bpm}`;
  const mode = station.mode;
  const stateText = {
    countin: `카운트인 · ${Math.max(1, Math.ceil(((station.rec?.begin ?? now) - now) / transport.beat))}박 뒤 녹음`,
    recording: `녹음 중 · ${Math.max(1, Math.ceil((now - (station.rec?.begin ?? now)) / transport.bar))}마디째`,
    finishing: '현재 마디를 마무리하는 중',
    holding: '새 오브가 준비됐어요', drag: '선택한 오브를 옮기는 중',
  };
  const text = station.message?.text || stateText[mode] || (sessionActive ? station.count ? `${station.count}개 오브 · ${station.orbs.filter((o) => !o.muted && o.state === 'placed').length}개 재생 중` : '첫 루프를 녹음해 보세요' : '시작할 준비가 됐어요');
  const card = $('hud-orb');
  $('hud-orb-text').textContent = text;
  card.classList.toggle('rec', mode === 'recording' || mode === 'finishing');
  const detail = {
    countin: '다음 마디에 시작 · Esc로 취소',
    recording: '마치기를 누르면 마디 끝에서 완성',
    finishing: '계속 불러 주세요 · Esc로 취소',
    holding: '던지거나 내려놓기로 반복 재생',
    drag: '좌우는 패닝 · 높이는 음량',
  };
  $('record-detail').textContent = !sessionActive ? '악기를 고르고 세션을 시작하세요.' : detail[mode] || 'Space로 녹음 · 최대 4마디';
  $('record-toggle').dataset.state = mode;
  $('record-label').textContent = {countin:'대기 취소',recording:'녹음 마치기',finishing:'마디 마무리 중',holding:'오브 내려놓기',drag:'오브 이동 중'}[mode] || '녹음 시작';
  $('record-toggle').disabled = !sessionActive || !audio.ready || ['finishing','drag'].includes(mode) || (mode === 'idle' && station.count >= station.maxOrbs);
  $('record-cancel').hidden = !['recording', 'finishing'].includes(mode);
  $('stage-empty').hidden = performer?.state.product === 'chord' || performer?.state.input === 'manual' || !sessionActive || station.count > 0 || mode !== 'idle' || gesture.present;
  $('orb-count').textContent = `${station.count} / ${station.maxOrbs}`;
  const busy = station.count > 0 || station.mode !== 'idle';
  $('bpm').disabled = busy;
  $('bpm-lock').hidden = !busy;
  $('clear-orbs').disabled = !busy;
  $('metronome').disabled = !sessionActive;
  const g = station.mode === 'idle' ? null : station.mode === 'drag' ? 'drag' : station.mode === 'holding' ? 'throw' : 'pinch';
  document.querySelectorAll('#orb-guide li[data-o]').forEach((li) => li.classList.toggle('now', li.dataset.o === g));
  renderLoops();
}

function renderLoops() {
  if (!station.orbs.some((o) => o.id === selectedOrbId)) selectedOrbId = station.orbs[0]?.id ?? null;
  const signature = station.orbs.map((o) => `${o.id}:${o.state}:${o.ready}:${o.muted}:${o.bars}`).join('|');
  if (signature !== loopSignature) {
    const focused = document.activeElement?.dataset.orbId;
    const list = $('loop-list');
    list.replaceChildren(...station.orbs.map((orb) => {
      const button = document.createElement('button');
      button.className = 'loop-card'; button.dataset.orbId = orb.id; button.dataset.muted = orb.muted;
      button.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
      const state = !orb.ready ? '녹음 가져오는 중' : orb.muted ? '음소거' : orb.state === 'held' ? '손에 들고 있음' : orb.state === 'flying' ? '날아가는 중' : '반복 재생';
      button.innerHTML = `<span class="orb-icon" aria-hidden="true"></span><span><strong>오브 ${orb.id} · ${orb.bars}마디</strong><small>${state}</small></span>`;
      return button;
    }));
    if (focused) list.querySelector(`[data-orb-id="${focused}"]`)?.focus({ preventScroll: true });
    loopSignature = signature;
  }
  $('loop-empty').hidden = station.count > 0;
  $('loop-actions').hidden = station.count === 0;
  for (const button of $('loop-list').children) button.setAttribute('aria-pressed', String(+button.dataset.orbId === selectedOrbId));
  const selected = station.orbs.find((o) => o.id === selectedOrbId);
  if (!selected) return;
  $('selected-orb-name').textContent = `오브 ${selected.id} 선택됨 · 방향키로 이동`;
  $('orb-mute').textContent = selected.muted ? '음소거 해제' : '음소거';
  $('orb-mute').setAttribute('aria-pressed', String(selected.muted));
  $('orb-place').hidden = station.held !== selected;
}

let lastHud = 0;
let frameId;
function frame(now) {
  if (!active) return;
  if (mode === 'pointer' && performer.legacy) {
    gesture = tracker.update(pointerHand(), now);
    gesture = performer.routeLegacy(gesture);
    audio.setGesture(gesture);
  }
  // Video callbacks use performance.now(); use the same clock here rather than
  // the earlier rAF frame timestamp, which can precede a video observation.
  performer.tick(performance.now(), mode === 'camera');
  drawOverlay();
  focusSession.tick(performance.now());
  if (now - lastHud > 70) {
    lastHud = now;
    renderHud();
    drawTrace();
    performer.render();
  }
  frameId = requestAnimationFrame(frame);
}

window.addEventListener('pagehide', () => {
  active = false;
  cancelAnimationFrame(frameId);
  stopSession({ focus: false });
});
window.addEventListener('pageshow', () => {
  if (active) return;
  active = true;
  frameId = requestAnimationFrame(frame);
});

function pausePerformance({ preservePreview = false } = {}) {
  if (!preservePreview) focusSession?.ui.pausePreview();
  manualRecording = false;
  station.cancelRecording();
  station.prev = { pinch: false, fist: false };
  pointer.down = pointer.inside = false;
  for (const orb of station.orbs) { orb.muted = true; audio.stop(orb); }
  metronomeWanted = false;
  $('metronome').checked = false;
  audio.setMetronome(false, transport);
  renderLoopHud();
}

function updateProductControls() {
  const chord = performer.state.product === 'chord';
  for (const id of ['src-mic', 'src-demo', 'src-file', 'dry', 'key', 'scale', 'lock']) $(id).disabled = chord || !sessionActive;
  document.querySelectorAll('[data-engine]').forEach(b => (b.disabled = chord));
  $('source-name').textContent = chord ? '코드 악기 · 마이크 입력 없이 합성' : $('source-name').textContent;
}

performer = new Performance({
  getAudio: () => audio,
  isReady: () => sessionActive && audio.ready,
  hasCamera: () => mode === 'camera' && cam.running
    && !!cam.stream?.getVideoTracks().some(track => track.readyState === 'live' && !track.muted),
  notify: text => notice(text),
  onStop: pausePerformance,
  onInterrupt: reason => focusSession?.boundary(reason),
  onTransition: async (product, field) => {
    if (starting) { stopSession({ focus: false }); return; }
    if (field !== 'product') return;
    soundRequest++;
    audio.setProduct(product);
    if (sessionActive && product === 'choir' && !audio.source) await startSound('demo');
    if (sessionActive && product === 'chord') status('st-audio', '코드 악기 준비', 'on');
    updateProductControls();
  },
});
window.airchoir.performance = performer.state;
window.airchoir.performanceController = performer;
focusSession = new FocusSession({
  video: $('video'), overlay, stage: $('stage'), getAudio: () => audio,
  getPerformance: () => ({ ...performer.state, ready: sessionActive && audio.ready, sourceKind: audio.source?.kind }),
  getWheelGeometry: () => performer.ui.getWheelGeometry(),
  getTheme: () => theme,
  isReady: () => sessionActive && audio.ready,
  isCameraReady: () => mode === 'camera' && cam.running,
  onStop: () => performer.stop('전체 정지 · 다시 선택하거나 손을 내렸다 올리세요.', true),
  onPreviewPlay: () => performer.stop('영상 미리보기 중 · 다시 선택하면 연주합니다.', true, { preservePreview: true }),
  onMode: value => {
    if (value === 'choir') performer.change('product', 'choir');
    else if (value === 'chord-one' || value === 'chord-two') {
      performer.change('product', 'chord');
      performer.change('hands', value === 'chord-two' ? 'two' : 'one');
    }
  },
  onInput: value => performer.change('input', value),
  onSettings: () => performer.ui.openSettings(), notify: text => notice(text),
});
window.airchoir.focus = focusSession;
window.addEventListener('blur', () => {
  focusSession.boundary('blur');
  performer.stop('창을 벗어나 전체 정지했어요.', true);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    focusSession.boundary('hidden');
    performer.stop('화면이 숨겨져 전체 정지했어요.', true);
  }
});
bindControls();
bindPointer();
renderLoopHud();
frameId = requestAnimationFrame(frame);
