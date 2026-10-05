import { ROOTS, QUALITIES, CHOIR_OPTIONS, DEFAULT_CONFIG, chordKey, chordLabel } from '../core/chords.js';

const MAX_PIXELS = 1280 * 720;
const TAU = Math.PI * 2;
const BASE_THEME = {
  colors: { label: '#f2f1e9', muted: '#abb2ab', voice: '#f3dfb4', line: '#383e39' },
  fonts: { body: '"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif', data: 'ui-monospace,monospace' },
};

export function recordingSize(width, height) {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    throw new Error('녹화할 무대의 크기를 확인할 수 없어요.');
  }
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)), 1280 / Math.max(width, height));
  const even = (value) => Math.max(2, Math.floor(value * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

// Source crop for CSS object-fit:cover. Mirroring happens only when drawing video.
export function coverCrop(videoWidth, videoHeight, width, height) {
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const sw = width / scale, sh = height / scale;
  return { sx: (videoWidth - sw) / 2, sy: (videoHeight - sh) / 2, sw, sh };
}

const labelFor = (group, value) => {
  if (group === 'chords') return chordLabel(value);
  const choices = { roots: ROOTS, qualities: QUALITIES, choir: CHOIR_OPTIONS }[group];
  return choices.find((choice) => choice.id === value)?.label || String(value);
};

// The same lists, order, labels, selection and sounding state as WheelUI.
export function capturePresentation(state = {}) {
  const chordMode = state.product === 'chord';
  const current = state.current || {};
  const config = state.config || DEFAULT_CONFIG;
  const specifications = !chordMode
    ? [['choir', '합창', 'choir']]
    : state.hands === 'two' ? [['root', '근음', 'roots'], ['quality', '코드 종류', 'qualities']]
      : [['chord', '코드', 'chords']];
  const wheels = specifications.map(([type, title, group]) => ({
    type, title,
    choices: (config[group] || DEFAULT_CONFIG[group]).map((value) => ({
      label: labelFor(group, value),
      selected: current[type] != null && (type === 'chord'
        ? chordKey(value) === chordKey(current[type]) : value === current[type]),
    })),
  }));
  let selected = '';
  if (chordMode) {
    if (current.chord) selected = chordLabel(current.chord);
    else if (current.root != null && current.quality != null) selected = chordLabel(current);
    else if (current.root != null) selected = `${labelFor('roots', current.root)} · 코드 종류 대기`;
    else if (current.quality != null) selected = `${labelFor('qualities', current.quality)} · 근음 대기`;
  } else if (current.choir != null) selected = `합창 ${labelFor('choir', current.choir)}`;
  return {
    title: `AirChoir · ${chordMode ? '코드 악기' : '목소리 합창'}`,
    selection: state.ready === false ? '세션 시작 전' : state.armed
      ? `${selected || '선택됨'} · ${chordMode ? '연주 중' : '지휘 중'}`
      : selected ? `OFF · ${selected}` : 'OFF · 선택 대기',
    input: state.input === 'manual' ? '클릭 · 키보드' : chordMode ? '손동작 · 휠 선택' : '손동작 · 합창 지휘',
    showOverlay: !chordMode,
    showWheels: state.ready !== false && (chordMode || state.input === 'manual'),
    wheels,
  };
}

function stageRect(stage) {
  const rect = stage.getBoundingClientRect();
  return {
    left: rect.left + (stage.clientLeft || 0), top: rect.top + (stage.clientTop || 0),
    width: stage.clientWidth || rect.width, height: stage.clientHeight || rect.height,
  };
}

function roundedBox(g, x, y, width, height, radius) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, width, height, radius);
  else g.rect(x, y, width, height);
}

function text(g, value, x, y, width, size, color, font, align = 'left') {
  g.fillStyle = color;
  g.font = `${size}px ${font}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(value, x, y, Math.max(1, width));
}

/**
 * Detached recording-only canvas; no streams, animation loops or media ownership.
 * getPerformance returns Performance.state plus `ready`; wheel geometry is in
 * viewport CSS pixels, as returned by WheelUI.getWheelGeometry(). Call draw after
 * the live overlay is rendered. resizeForRecording is the only size-changing API;
 * later layout changes are contained inside that frozen frame rather than stretched.
 * draw returns the canvas (false after dispose). Rendering errors propagate, except
 * a video InvalidStateError during frame readiness changes, which draws a fallback.
 */
export class StageCapture {
  constructor({ video, overlay, stage, getPerformance = () => ({}), getWheelGeometry = () => [], getTheme = () => ({}) }) {
    this.video = video;
    this.overlay = overlay;
    this.stage = stage;
    this.getPerformance = getPerformance;
    this.getWheelGeometry = getWheelGeometry;
    this.getTheme = getTheme;
    this.canvas = (stage.ownerDocument || document).createElement('canvas');
    this.context = this.canvas.getContext('2d', { alpha: false });
    if (!this.context) throw new Error('녹화용 캔버스를 만들 수 없어요.');
    this.disposed = false;
    this.resizeForRecording();
  }

  resizeForRecording() {
    if (this.disposed) throw new Error('녹화용 캔버스가 종료됐어요.');
    const rect = stageRect(this.stage);
    const size = recordingSize(rect.width, rect.height);
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    return size;
  }

  _drawVideo(g, width, height) {
    const video = this.video;
    if (!video || video.hidden) return '카메라 꺼짐';
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.srcObject?.active === false) {
      return '카메라 영상 준비 중';
    }
    const crop = coverCrop(video.videoWidth, video.videoHeight, width, height);
    g.save();
    try {
      g.translate(width, 0);
      g.scale(-1, 1);
      g.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
    } catch (error) {
      if (error.name === 'InvalidStateError') return '카메라 영상 준비 중';
      throw error;
    } finally {
      g.restore();
    }
    return '카메라 켜짐';
  }

  _drawHud(g, rect, theme) {
    // Only read widgets inside the stage. No sidebar, dialogs or page screenshot.
    const selectors = '.hud-card > small, #hud-note, #hud-preset, #hud-chips .chip';
    for (const el of this.stage.querySelectorAll?.(selectors) || []) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || el.hidden) continue;
      const style = this.stage.ownerDocument?.defaultView?.getComputedStyle(el);
      if (style?.visibility === 'hidden' || style?.display === 'none') continue;
      const x = box.left - rect.left, y = box.top - rect.top;
      const chip = el.classList?.contains('chip') && !el.classList?.contains('idle');
      const color = style?.color || (el.id === 'hud-note' ? theme.colors.voice : theme.colors.muted);
      const size = Number.parseFloat(style?.fontSize) || (el.id === 'hud-note' ? 30 : 12);
      if (chip) {
        roundedBox(g, x, y, box.width, box.height, 5);
        g.strokeStyle = color; g.lineWidth = 1; g.stroke();
      }
      text(g, el.textContent.trim(), chip ? x + box.width / 2 : x, y + box.height / 2,
        box.width - (chip ? 8 : 0), size, color, style?.fontFamily || theme.fonts.data, chip ? 'center' : 'left');
    }
  }

  _drawWheel(g, wheel, geometry, rect, state, theme) {
    const x = geometry.center.x - rect.left, y = geometry.center.y - rect.top;
    const radius = geometry.radius;
    const count = wheel.choices.length;
    const dense = count > 8 && ['chord', 'root'].includes(wheel.type);
    const labelRadius = radius * (dense ? 40 : 36.5) / 48;
    const inner = radius * 25 / 48;
    const gap = 0.7 * Math.PI / 180;
    wheel.choices.forEach((choice, index) => {
      const middle = index * TAU / count - Math.PI / 2;
      const start = middle - Math.PI / count + gap;
      const end = middle + Math.PI / count - gap;
      g.beginPath();
      g.arc(x, y, radius, start, end);
      g.lineTo(x + Math.cos(end) * inner, y + Math.sin(end) * inner);
      g.arc(x, y, inner, end, start, true);
      g.closePath();
      g.fillStyle = choice.selected ? state.armed ? '#4c5138' : '#3e4636' : '#252d27';
      g.strokeStyle = choice.selected ? theme.colors.voice : '#465249';
      g.lineWidth = radius / 48 * (choice.selected ? 0.6 : 0.35);
      g.fill(); g.stroke();
      const lx = x + Math.cos(middle) * labelRadius, ly = y + Math.sin(middle) * labelRadius;
      const quality = wheel.type === 'quality';
      const width = quality ? 78 : dense ? 52 : 60;
      if (choice.selected) {
        roundedBox(g, lx - width / 2, ly - 22, width, 44, 7);
        g.fillStyle = '#424731'; g.fill();
        g.strokeStyle = theme.colors.voice; g.lineWidth = 1; g.stroke();
      }
      text(g, choice.label, lx, ly, width - 8, quality || dense ? 12 : 15,
        choice.selected ? theme.colors.voice : state.input === 'hands' ? theme.colors.muted : theme.colors.label,
        quality ? theme.fonts.body : theme.fonts.data, 'center');
    });
    g.beginPath();
    g.arc(x, y, radius * 19.5 / 48, 0, TAU);
    g.fillStyle = '#171d19'; g.fill();
    g.strokeStyle = state.armed ? theme.colors.voice : '#536257';
    g.lineWidth = 1; g.stroke();
    text(g, 'OFF', x, y - 8, radius * .7, 20, theme.colors.label, theme.fonts.data, 'center');
    text(g, '소리 끄기', x, y + 13, radius * .7, 11, theme.colors.muted, theme.fonts.body, 'center');
    text(g, wheel.title + (state.input === 'hands' ? ' · 손동작' : ''), x, y - radius / .96 - 13,
      radius * 2, 12, theme.colors.muted, theme.fonts.body, 'center');
  }

  draw() {
    if (this.disposed) return false;
    const g = this.context;
    const W = this.canvas.width, H = this.canvas.height;
    const rect = stageRect(this.stage);
    if (!(rect.width > 0 && rect.height > 0)) throw new Error('녹화할 무대가 보이지 않아요.');
    const state = this.getPerformance() || {};
    const presentation = capturePresentation(state);
    const supplied = this.getTheme() || {};
    const theme = { colors: { ...BASE_THEME.colors, ...supplied.colors }, fonts: { ...BASE_THEME.fonts, ...supplied.fonts } };
    const compact = W < 620;
    const header = compact ? 48 : 34, footer = 28;
    const scale = Math.min(W / rect.width, Math.max(1, H - header - footer) / rect.height);
    const x = (W - rect.width * scale) / 2;
    const y = header + (H - header - footer - rect.height * scale) / 2;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#111512'; g.fillRect(0, 0, W, H);
    g.save();
    let camera;
    try {
      g.translate(x, y); g.scale(scale, scale);
      g.beginPath(); g.rect(0, 0, rect.width, rect.height); g.clip();
      g.fillStyle = '#191d1a'; g.fillRect(0, 0, rect.width, rect.height);
      camera = this._drawVideo(g, rect.width, rect.height);
      if (presentation.showOverlay) {
        if (this.overlay && !this.overlay.hidden && this.overlay.width > 0 && this.overlay.height > 0) {
          g.drawImage(this.overlay, 0, 0, this.overlay.width, this.overlay.height, 0, 0, rect.width, rect.height);
        }
        this._drawHud(g, rect, theme);
      }
      if (presentation.showWheels) {
        const geometry = this.getWheelGeometry() || [];
        presentation.wheels.forEach((wheel, index) => {
          const shape = geometry[index];
          if (shape && Number.isFinite(shape.center?.x) && Number.isFinite(shape.center?.y) && Number.isFinite(shape.radius) && shape.radius > 0) {
            this._drawWheel(g, wheel, shape, rect, state, theme);
          }
        });
      }
    } finally {
      g.restore();
    }
    text(g, presentation.title, 12, compact ? 14 : 17, compact ? W - 24 : W * .5 - 20,
      compact ? 13 : 15, theme.colors.label, theme.fonts.body);
    text(g, presentation.selection, compact ? 12 : W - 12, compact ? 34 : 17,
      compact ? W - 24 : W * .5 - 20, 13, state.armed ? theme.colors.voice : theme.colors.muted,
      theme.fonts.body, compact ? 'left' : 'right');
    text(g, `${camera} · ${presentation.input}`, 12, H - 14, W - 24, 12, theme.colors.muted, theme.fonts.body);
    return this.canvas;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.width = this.canvas.height = 0;
  }
}
