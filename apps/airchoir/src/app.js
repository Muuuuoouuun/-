import { PRESETS, NOTE_NAMES, midiName } from '../core/dsp.js';
import { analyzeHand, GestureTracker } from './gestures.js';
import { HandCamera } from './hands.js';
import { ChoirAudio } from './audio.js';
import { drawStage, coverMapper } from './stage.js';
import { Transport, OrbStation } from './orbs.js';

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

const audio = new ChoirAudio();
const cam = new HandCamera($('video'));
const tracker = new GestureTracker();
let gesture = tracker.state();
let stats = null;
let history = [];
let mode = null; // 'camera' | 'pointer'
let soundRequest = 0;
let startupRequest = 0;
let active = true;
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
    capture: (orb) => audio.capture(orb).then(() => (orb.midi = medianMidi(orb.begin, orb.begin + orb.len))),
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
}

function markSource(kind) {
  $('src-mic').setAttribute('aria-pressed', String(kind === 'mic'));
  $('src-demo').setAttribute('aria-pressed', String(kind === 'demo'));
  $('src-file-label').style.borderColor = kind === 'file' ? 'var(--fg)' : '';
  const label = { mic: '마이크 켜짐', demo: '데모 노래 재생 중', file: '녹음 파일 재생 중' }[kind] || '소리 꺼짐';
  status('st-audio', label, kind ? 'on' : 'off');
}

function setDry(val) {
  $('dry').value = val;
  $('dry-v').textContent = val.toFixed(2);
  audio.setDry(val);
}

// ───────────── 시작 ─────────────

audio.onStats = (s) => {
  stats = s;
  history.push({ t: s.t, midi: s.midi, targets: s.targets });
  const cut = s.t - HISTORY_SEC;
  while (history.length && history[0].t < cut) history.shift();
  pitchLog.push({ t: s.t, midi: s.midi });
  while (pitchLog.length && pitchLog[0].t < s.t - 30) pitchLog.shift();
};

async function startSound(kind, file) {
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
  markSource(kind);
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
    gesture = tracker.update(hands, performance.now());
    audio.setGesture(gesture);
  };
  cam.run();
}

function usePointer(message) {
  mode = 'pointer';
  $('stage').classList.add('pointer');
  $('pointer-help').hidden = false;
  status('st-cam', '마우스 모드', 'on');
  if (message) notice(message);
}

async function start(kind) {
  const request = ++startupRequest;
  $('start').hidden = true;
  notice('');
  const soundKind = kind === 'pointer' ? 'demo' : kind;
  let ok = await startSound(soundKind);
  if (request !== startupRequest) return;
  if (!ok && soundKind === 'mic') ok = await startSound('demo');
  if (request !== startupRequest) return;
  if (!ok) { $('start').hidden = false; return; }
  if (kind === 'pointer') usePointer();
  else await startCamera(request);
}

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
  };
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerdown', (e) => {
    if (mode !== 'pointer') return;
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
  $('src-mic').onclick = () => startSound('mic');
  $('src-demo').onclick = () => startSound('demo');
  $('src-file').onchange = (e) => e.target.files[0] && startSound('file', e.target.files[0]);
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
  $('clear-orbs').onclick = () => station.clear();
  document.querySelectorAll('[data-engine]').forEach((b) => (b.onclick = () => setEngine(b.dataset.engine)));

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (ENGINE_KEYS[k]) setEngine(ENGINE_KEYS[k]);
    else if (mode === 'pointer' && k >= '0' && k <= '5') pointer.fingers = +k;
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
    station.update({ ...gesture, screen }, now);
    const recording = ['countin', 'recording', 'finishing'].includes(station.mode);
    audio.setMetronome(metronomeWanted || recording, transport);
    loops = { station, transport, now, pinchAt: screen?.pinchPoint };
  }
  drawStage(og, W, H, { mapper, gesture, stats, theme, loops });
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
  const on = stats && stats.midi != null;
  const note = $('hud-note');
  note.textContent = on ? midiName(stats.midi) : '—';
  note.className = 'hud-note' + (on ? '' : ' off');

  const chips = $('hud-chips');
  let html;
  if (!gesture.present) html = `<span class="chip idle">${mode ? '손을 보여 주세요' : '시작 전'}</span>`;
  else if (gesture.fist) html = '<span class="chip idle">정지</span>';
  else if (on && stats.targets.length) html = stats.targets.map((m, i) => `<span class="chip v${i}">${midiName(m)}</span>`).join('');
  else html = '<span class="chip idle">노래를 기다리는 중</span>';
  if (chips.innerHTML !== html) chips.innerHTML = html;

  $('hud-preset').textContent = !gesture.present
    ? '—'
    : gesture.fist
      ? '주먹 · 정지'
      : `${gesture.fingers}개 · ${PRESETS[gesture.preset].name}`;

  const g = !gesture.present ? 'none' : gesture.fist ? 'fist' : String(Math.min(4, gesture.fingers));
  document.querySelectorAll('#guide li[data-g]').forEach((li) => li.classList.toggle('now', li.dataset.g === g));

  if (mode === 'camera' && cam.fps) status('st-cam', `손 인식 ${Math.round(cam.fps)}fps`, 'on');
  renderLoopHud();
}

const ORB_STATUS = {
  countin: '다음 마디부터 녹음해요',
  recording: '● 녹음 중 · 놓으면 마디 끝에서 완성',
  finishing: '마디 끝까지 마저 부르세요',
  holding: '휙 던지면 그 자리에서 반복돼요',
  drag: '옮기는 중 · 놓으면 내려놓기',
};

function renderLoopHud() {
  if (!audio.ready) return;
  const pos = transport.position(audio.ctx.currentTime);
  document.querySelectorAll('#hud-beat i').forEach((el, i) => el.classList.toggle('on', i === pos.beat));
  $('hud-bpm').textContent = `${transport.bpm}`;
  const text = station.message?.text || ORB_STATUS[station.mode] || '';
  const card = $('hud-orb');
  card.hidden = !text;
  $('hud-orb-text').textContent = text;
  card.classList.toggle('rec', station.mode === 'recording' || station.mode === 'finishing');
  $('orb-count').textContent = `${station.count} / ${station.maxOrbs}`;
  const busy = station.count > 0 || station.mode !== 'idle';
  $('bpm').disabled = busy;
  $('bpm-lock').hidden = !busy;
  $('clear-orbs').disabled = !busy;
  const g = station.mode === 'idle' ? null : station.mode === 'drag' ? 'drag' : station.mode === 'holding' ? 'throw' : 'pinch';
  document.querySelectorAll('#orb-guide li[data-o]').forEach((li) => li.classList.toggle('now', li.dataset.o === g));
}

let lastHud = 0;
let frameId;
function frame(now) {
  if (!active) return;
  if (mode === 'pointer') {
    gesture = tracker.update(pointerHand(), now);
    audio.setGesture(gesture);
  }
  drawOverlay();
  if (now - lastHud > 70) {
    lastHud = now;
    renderHud();
    drawTrace();
  }
  frameId = requestAnimationFrame(frame);
}

window.addEventListener('pagehide', () => {
  active = false;
  startupRequest++;
  soundRequest++;
  cancelAnimationFrame(frameId);
  station.clear();
  cam.stop();
  void audio.dispose().catch(() => {});
  mode = null;
  pointer.down = pointer.inside = false;
  stats = null;
  history = [];
  pitchLog.length = 0;
});
window.addEventListener('pageshow', () => {
  if (active) return;
  active = true;
  $('start').hidden = false;
  $('video').hidden = true;
  $('stage').classList.remove('pointer');
  $('pointer-help').hidden = true;
  ['src-mic', 'src-demo', 'src-file'].map($).forEach((control) => (control.disabled = false));
  markSource(null);
  status('st-cam', '카메라 꺼짐', 'off');
  frameId = requestAnimationFrame(frame);
});

bindControls();
bindPointer();
frameId = requestAnimationFrame(frame);
