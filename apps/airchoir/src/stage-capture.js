import { ROOTS, QUALITIES, CHOIR_OPTIONS, DEFAULT_CONFIG, chordKey, chordLabel } from '../core/chords.js';

const MAX_PIXELS = 1280 * 720;
const TAU = Math.PI * 2;
const BASE_THEME = {
  colors: { label: '#f2f1e9', muted: '#abb2ab', voice: '#f3dfb4', line: '#383e39' },
  fonts: { body: '"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif', data: 'ui-monospace,monospace' },
};
const WHEEL_COLORS = {
  backdrop: '#17231b', sector: '#26372d', line: '#819484', selected: '#566947',
  sounding: '#697b43', 'selected-line': '#ffe4ae', label: '#fff8e5',
  'selected-label': '#192117', 'label-chip': '#f3dfb4', center: '#17231b',
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
  const waiting = state.input === 'hands' ? chordMode ? '핀치 대기' : '손동작 대기' : 'OFF';
  return {
    title: `AirChoir · ${chordMode ? '코드 악기' : '목소리 합창'}`,
    selection: state.ready === false ? '세션 시작 전' : state.armed
      ? `${selected || '선택됨'} · ${chordMode ? '연주 중' : '지휘 중'}`
      : selected ? `${waiting} · ${selected}` : `${waiting} · 선택 대기`,
    input: state.input === 'manual' ? '클릭 · 키보드' : chordMode ? `손동작 · ${state.hands === 'two' ? '양손 핀치' : '핀치'} 유지` : '손동작 · 합창 지휘',
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

function text(g, value, x, y, width, size, color, font, align = 'left', weight = '400') {
  g.fillStyle = color;
  g.font = `${weight} ${size}px ${font}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(value, x, y, Math.max(1, width));
}

// Match overflow-wrap:anywhere without canvas fillText's horizontal compression.
function labelLines(g, value, width) {
  const lines = [];
  let line = '';
  for (const word of value.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (g.measureText(candidate).width <= width) { line = candidate; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const character of word) {
      if (line && g.measureText(line + character).width > width) { lines.push(line); line = ''; }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const pixels = (value, fallback) => Number.parseFloat(value) || fallback;

function wheelLabel(g, value, x, y, width, size, color, family, weight, lineHeight) {
  g.font = `${weight} ${size}px ${family}`;
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = labelLines(g, value, width);
  lines.forEach((line, index) => g.fillText(line, x, y + (index - (lines.length - 1) / 2) * lineHeight));
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

  _style(element) {
    return element ? this.stage.ownerDocument?.defaultView?.getComputedStyle(element) : null;
  }

  _drawWheelHeading(g, wheel, panel, geometry, rect, state, theme, colors) {
    const title = wheel.title + (state.input === 'hands' ? ' · 손동작' : '');
    const selected = wheel.choices.find((choice) => choice.selected);
    const selection = selected ? `${selected.label} · ${state.armed ? '연주 중' : '선택'}` : '선택 대기';
    const heading = panel?.querySelector('.wheel-heading');
    if (!heading) {
      text(g, `${title} · ${selection}`, geometry.center.x - rect.left,
        geometry.center.y - rect.top - geometry.radius / .96 - 13,
        geometry.radius * 2, 12, colors.label, theme.fonts.body, 'center', '600');
      return;
    }
    for (const [element, value, badge] of [
      [heading, '', false], [heading.querySelector('.wheel-title'), title, false],
      [heading.querySelector('.wheel-selection'), selection, true],
    ]) {
      if (!element) continue;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const style = this._style(element);
      const x = box.left - rect.left, y = box.top - rect.top;
      roundedBox(g, x, y, box.width, box.height, pixels(style?.borderRadius, badge ? 20 : 0));
      g.fillStyle = style?.backgroundColor || 'transparent'; g.fill();
      if (badge && pixels(style?.borderTopWidth, 0) > 0) {
        g.strokeStyle = style.borderTopColor; g.lineWidth = pixels(style.borderTopWidth, 1); g.stroke();
      }
      if (value) text(g, value, x + box.width / 2, y + box.height / 2, box.width,
        pixels(style?.fontSize, badge ? 12 : 13), style?.color || colors.label,
        style?.fontFamily || theme.fonts.body, 'center', style?.fontWeight || '600');
    }
  }

  _drawWheel(g, wheel, geometry, rect, state, theme, colors, panel) {
    const x = geometry.center.x - rect.left, y = geometry.center.y - rect.top;
    const radius = geometry.radius;
    const count = wheel.choices.length;
    const dense = count > 8 && ['chord', 'root'].includes(wheel.type);
    const labelRadius = radius * (dense ? 40 : 36.5) / 48;
    const inner = radius * 25 / 48;
    const gap = 0.7 * Math.PI / 180;
    const buttons = panel?.querySelectorAll('.wheel-choice') || [];
    // The opaque circle matches .wheel-circle::before, including the inner gap.
    g.beginPath(); g.arc(x, y, radius, 0, TAU);
    g.fillStyle = colors.backdrop; g.fill();
    wheel.choices.forEach((choice, index) => {
      const middle = index * TAU / count - Math.PI / 2;
      const start = middle - Math.PI / count + gap;
      const end = middle + Math.PI / count - gap;
      g.beginPath();
      g.arc(x, y, radius, start, end);
      g.lineTo(x + Math.cos(end) * inner, y + Math.sin(end) * inner);
      g.arc(x, y, inner, end, start, true);
      g.closePath();
      g.fillStyle = choice.selected ? state.armed ? colors.sounding : colors.selected : colors.sector;
      g.strokeStyle = choice.selected ? colors['selected-line'] : colors.line;
      g.lineWidth = radius / 48 * (choice.selected ? 0.85 : 0.35);
      g.fill(); g.stroke();
      const lx = x + Math.cos(middle) * labelRadius, ly = y + Math.sin(middle) * labelRadius;
      const quality = wheel.type === 'quality';
      const style = this._style(buttons[index]);
      const box = buttons[index]?.getBoundingClientRect();
      const size = pixels(style?.fontSize, dense ? 14 : quality
        ? Math.max(14, Math.min(17, radius / .48 * .032)) : Math.max(16, Math.min(24, radius / .48 * .044)));
      const width = box?.width || (quality ? 78 : dense ? 44 : 60);
      const height = box?.height || 44;
      if (choice.selected) {
        roundedBox(g, lx - width / 2, ly - height / 2, width, height, pixels(style?.borderRadius, 8));
        g.fillStyle = colors['label-chip']; g.fill();
        g.strokeStyle = colors['selected-line']; g.lineWidth = 1; g.stroke();
      }
      const horizontalInset = pixels(style?.paddingLeft, dense ? 3 : 8) + pixels(style?.paddingRight, dense ? 3 : 8) + 2;
      wheelLabel(g, choice.label, lx, ly, Math.max(1, width - horizontalInset), size,
        choice.selected ? colors['selected-label'] : colors.label,
        style?.fontFamily || (quality ? theme.fonts.body : theme.fonts.data),
        style?.fontWeight || '700', pixels(style?.lineHeight, size * 1.15));
    });
    const holdInput = state.product === 'chord' && state.input === 'hands';
    const off = panel?.querySelector(holdInput ? '.wheel-center-hint' : '.wheel-off');
    const offStyle = this._style(off), smallStyle = this._style(off?.querySelector('small'));
    const offSize = pixels(offStyle?.fontSize, Math.max(18, Math.min(23, radius / .48 * .044)));
    const smallSize = pixels(smallStyle?.fontSize, 12);
    const offLine = pixels(offStyle?.lineHeight, offSize * 1.15);
    const smallLine = pixels(smallStyle?.lineHeight, smallSize * 1.5);
    const gapSize = pixels(offStyle?.gap, 4);
    g.beginPath();
    g.arc(x, y, radius * 19.5 / 48, 0, TAU);
    g.fillStyle = colors.center; g.fill();
    g.strokeStyle = state.armed ? colors['selected-line'] : colors.line;
    g.lineWidth = 1; g.stroke();
    text(g, holdInput ? '핀치' : 'OFF', x, y - (smallLine + gapSize) / 2, radius * .7, offSize,
      offStyle?.color || theme.colors.label, offStyle?.fontFamily || (holdInput ? theme.fonts.body : theme.fonts.data), 'center', offStyle?.fontWeight || '600');
    text(g, holdInput ? '놓으면 쉼' : '소리 끄기', x, y + (offLine + gapSize) / 2, radius * .7, smallSize,
      smallStyle?.color || '#c5d0c3', smallStyle?.fontFamily || theme.fonts.body, 'center');
    this._drawWheelHeading(g, wheel, panel, geometry, rect, state, theme, colors);
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
        const style = this._style(this.stage);
        const colors = Object.fromEntries(Object.entries(WHEEL_COLORS).map(([name, fallback]) =>
          [name, style?.getPropertyValue?.(`--wheel-${name}`).trim() || fallback]));
        const panels = this.stage.querySelectorAll?.('.wheel-panel') || [];
        presentation.wheels.forEach((wheel, index) => {
          const shape = geometry[index];
          if (shape && Number.isFinite(shape.center?.x) && Number.isFinite(shape.center?.y) && Number.isFinite(shape.radius) && shape.radius > 0) {
            this._drawWheel(g, wheel, shape, rect, state, theme, colors, panels[index]);
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
