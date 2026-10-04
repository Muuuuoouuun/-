import test from 'node:test';
import assert from 'node:assert/strict';
import { StageCapture, recordingSize, coverCrop, capturePresentation } from '../src/stage-capture.js';
import { cloneConfig } from '../core/chords.js';

class DrawingContext {
  constructor() { this.events = []; this.matrix = [1, 0, 0, 1, 0, 0]; this.stack = []; }
  save() { this.stack.push([...this.matrix]); }
  restore() { this.matrix = this.stack.pop(); }
  setTransform(...matrix) { this.matrix = matrix; }
  translate(x, y) { const m = this.matrix; m[4] += m[0] * x + m[2] * y; m[5] += m[1] * x + m[3] * y; }
  scale(x, y) { this.matrix[0] *= x; this.matrix[1] *= x; this.matrix[2] *= y; this.matrix[3] *= y; }
  drawImage(image, ...args) {
    if (image.error) throw image.error;
    this.events.push({ type: 'image', image, args, matrix: [...this.matrix] });
  }
  fillText(value, x, y, width) { this.events.push({ type: 'text', value, x, y, width, color: this.fillStyle, font: this.font, matrix: [...this.matrix] }); }
  measureText(value) { return { width: value.length * 7 }; }
  arc(x, y, radius, ...angles) { this.events.push({ type: 'arc', x, y, radius, angles, matrix: [...this.matrix] }); }
  fill() { this.events.push({ type: 'fill', color: this.fillStyle }); }
  beginPath() {}
  closePath() {}
  rect() {}
  roundRect() {}
  lineTo() {}
  clip() {}
  fillRect() {}
  stroke() {}
}

function setup({ width = 800, height = 450, product = 'choir', input = 'hands', hands = 'one', video = true } = {}) {
  const context = new DrawingContext();
  const canvas = { getContext: () => context, width: 0, height: 0 };
  const hud = [];
  const panels = [];
  const stage = {
    clientWidth: width, clientHeight: height, clientLeft: 1, clientTop: 1,
    getBoundingClientRect: () => ({ left: 100, top: 200, width: stage.clientWidth + 2, height: stage.clientHeight + 2 }),
    querySelectorAll: (selector) => {
      if (selector === '.wheel-panel') return panels;
      assert.ok(selector.startsWith('.hud-card')); return hud;
    },
    ownerDocument: {
      createElement: (tag) => { assert.equal(tag, 'canvas'); return canvas; },
      defaultView: { getComputedStyle: (el) => el.style || {} },
    },
  };
  const source = { hidden: !video, readyState: 4, videoWidth: 1920, videoHeight: 1080, srcObject: { active: true } };
  const overlay = { width: width * 2, height: height * 2, hidden: false };
  const state = { product, input, hands, config: cloneConfig(), current: {}, armed: false, ready: true };
  const geometry = [{ center: { x: 301, y: 426 }, radius: 150 }, { center: { x: 701, y: 426 }, radius: 150 }];
  const capture = new StageCapture({ video: source, overlay, stage,
    getPerformance: () => state, getWheelGeometry: () => geometry });
  return { capture, context, canvas, stage, source, overlay, state, geometry, hud, panels };
}

const texts = (context) => context.events.filter((event) => event.type === 'text').map((event) => event.value);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('recording sizes preserve stage aspect within even-pixel rounding and stay within the budget', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [3200, 900], [390, 700], [801, 451]]) {
    const size = recordingSize(width, height);
    assert.ok(size.width * size.height <= 1280 * 720);
    assert.ok(Math.max(size.width, size.height) <= 1280);
    assert.ok(size.width <= width && size.height <= height);
    assert.equal(size.width % 2, 0);
    assert.equal(size.height % 2, 0);
    assert.ok(Math.abs(size.width / size.height - width / height) < 2 / size.height + 2 * width / height / size.height);
  }
  assert.deepEqual(recordingSize(1920, 1080), { width: 1280, height: 720 });
  assert.throws(() => recordingSize(0, 450), /크기/);
  assert.throws(() => recordingSize(Infinity, 450), /크기/);
});

test('cover crop is centered in the source frame for both wide and tall cameras', () => {
  assert.deepEqual(coverCrop(1920, 1080, 400, 400), { sx: 420, sy: 0, sw: 1080, sh: 1080 });
  assert.deepEqual(coverCrop(720, 1280, 400, 400), { sx: 0, sy: 280, sw: 720, sh: 720 });
});

test('camera alone is mirrored, while the existing high-DPI overlay retains stage coordinates', () => {
  const { capture, context, source, overlay } = setup({ width: 400, height: 400 });
  capture.draw();
  const images = context.events.filter((event) => event.type === 'image');
  assert.equal(images[0].image, source);
  assert.deepEqual(images[0].args, [420, 0, 1080, 1080, 0, 0, 400, 400]);
  assert.ok(images[0].matrix[0] < 0);
  assert.equal(images[1].image, overlay);
  assert.deepEqual(images[1].args, [0, 0, 800, 800, 0, 0, 400, 400]);
  assert.ok(images[1].matrix[0] > 0);
  // Source left in the mirrored frame meets the non-mirrored frame's right edge.
  near(images[0].matrix[4], images[1].matrix[4] + images[1].matrix[0] * 400);
  assert.equal(context.stack.length, 0);
});

test('wheel geometry uses viewport-to-content coordinates including stage borders and recording scale', () => {
  const { capture, context, state } = setup({ product: 'chord', hands: 'two' });
  state.current = { root: 0, quality: 'min', chord: { root: 0, quality: 'min' } };
  state.armed = true;
  capture.draw();
  const root = context.events.find((event) => event.type === 'arc' && event.radius === 150);
  assert.equal(root.x, 200); // viewport 301 - stage content origin 101
  assert.equal(root.y, 225); // viewport 426 - stage content origin 201
  const rootLabel = context.events.find((event) => event.type === 'text' && event.value === 'C');
  near(rootLabel.x, 200);
  near(rootLabel.y, 225 - 150 * 36.5 / 48); // index 0 is at twelve o'clock
  assert.ok(texts(context).includes('Cm · 연주 중'));
  assert.ok(texts(context).includes('마이너'));
  assert.equal(texts(context).filter((value) => value === 'OFF').length, 2);
});

test('mode composition matches live visibility for camera and manual control modes', () => {
  for (const [product, input, hands, expectedOverlay, expectedWheels] of [
    ['choir', 'hands', 'one', true, 0], ['choir', 'manual', 'one', true, 1],
    ['chord', 'hands', 'one', false, 1], ['chord', 'manual', 'two', false, 2],
  ]) {
    const { capture, context, overlay } = setup({ product, input, hands });
    capture.draw();
    assert.equal(context.events.some((event) => event.type === 'image' && event.image === overlay), expectedOverlay);
    assert.equal(texts(context).filter((value) => value === 'OFF').length, expectedWheels);
  }
});

test('custom order, flat chord names and partial root zero selection match visible wheel labels', () => {
  const config = cloneConfig();
  config.chords = [{ root: 1, quality: 'maj7' }, { root: 10, quality: '7' }];
  let presentation = capturePresentation({ product: 'chord', hands: 'one', config,
    current: { chord: { root: 1, quality: 'maj7' } }, armed: false });
  assert.deepEqual(presentation.wheels[0].choices, [{ label: 'Dbmaj7', selected: true }, { label: 'Bb7', selected: false }]);
  assert.equal(presentation.selection, 'OFF · Dbmaj7');
  config.roots = [5, 0]; config.qualities = ['dim', 'maj7'];
  presentation = capturePresentation({ product: 'chord', hands: 'two', config, current: { root: 0 } });
  assert.deepEqual(presentation.wheels[0].choices, [{ label: 'F', selected: false }, { label: 'C', selected: true }]);
  assert.match(presentation.selection, /C · 코드 종류 대기/);
  assert.deepEqual(presentation.wheels[1].choices.map((choice) => choice.label), ['디미니시', '메이저 7']);
  assert.equal(capturePresentation({ product: 'choir', current: { choir: 3 }, armed: true }).selection, '합창 3명 · 지휘 중');
});

test('not-ready or hidden video has an explicit fallback, including manual control with live camera', () => {
  const { capture, context, source, state } = setup({ product: 'chord', input: 'manual' });
  source.readyState = 1;
  capture.draw();
  assert.equal(context.events.some((event) => event.type === 'image'), false);
  assert.ok(texts(context).some((value) => value.includes('카메라 영상 준비 중')));
  context.events = []; source.readyState = 4; source.hidden = true;
  capture.draw();
  assert.ok(texts(context).some((value) => value.includes('카메라 꺼짐')));
  context.events = []; source.hidden = false;
  capture.draw();
  assert.ok(context.events.some((event) => event.type === 'image' && event.image === source));
  assert.equal(state.input, 'manual'); // The input mode must not determine camera visibility.
});

test('recording dimensions freeze across aspect changes and only explicit resize changes them', () => {
  const { capture, canvas, stage, context } = setup();
  const original = { width: canvas.width, height: canvas.height };
  stage.clientWidth = 390; stage.clientHeight = 700;
  capture.draw();
  assert.deepEqual({ width: canvas.width, height: canvas.height }, original);
  const frame = context.events.find((event) => event.type === 'image').matrix;
  assert.ok(frame[4] > 0); // Portrait stage is contained, not stretched across the frame.
  assert.deepEqual(capture.resizeForRecording(), { width: 390, height: 700 });
});

test('an unavailable frame degrades explicitly, but real rendering errors propagate for recorder recovery', () => {
  const { capture, context, source } = setup();
  source.error = new DOMException('no current frame', 'InvalidStateError');
  assert.doesNotThrow(() => capture.draw());
  assert.ok(texts(context).some((value) => value.includes('카메라 영상 준비 중')));
  assert.equal(context.stack.length, 0);
  source.error = new DOMException('tainted source', 'SecurityError');
  assert.throws(() => capture.draw(), { name: 'SecurityError' });
  assert.equal(context.stack.length, 0);
});

test('HUD text is read only from stage widgets, with no DOM HUD required for other modes', () => {
  const { capture, context, hud } = setup();
  hud.push({ id: 'hud-note', textContent: ' C4 ', hidden: false,
    style: { color: '#123456', fontSize: '30px', fontFamily: 'monospace' },
    getBoundingClientRect: () => ({ left: 121, top: 239, width: 52, height: 30 }) });
  capture.draw();
  const note = context.events.find((event) => event.type === 'text' && event.value === 'C4');
  assert.equal(note.x, 20);
  assert.equal(note.y, 53);
  assert.equal(note.color, '#123456');
});

test('session-not-ready hides wheels and disposal touches neither video nor the live overlay', () => {
  const { capture, context, source, overlay, state, canvas } = setup({ product: 'chord' });
  state.ready = false;
  capture.draw();
  assert.ok(texts(context).includes('세션 시작 전'));
  assert.equal(texts(context).filter((value) => value === 'OFF').length, 0);
  capture.dispose(); capture.dispose();
  assert.equal(capture.draw(), false);
  assert.equal(canvas.width, 0);
  assert.equal(source.srcObject.active, true);
  assert.equal(overlay.width, 1600);
  assert.throws(() => capture.resizeForRecording(), /종료/);
});

test('wheel paint follows inherited CSS tokens and opaque backing while retaining selected state', () => {
  const { capture, context, stage, state } = setup({ product: 'chord', input: 'hands' });
  const tokens = { '--wheel-backdrop': '#010101', '--wheel-sector': '#020202', '--wheel-label': '#fafafa',
    '--wheel-sounding': '#030303', '--wheel-selected-label': '#040404', '--wheel-label-chip': '#eeeeee' };
  stage.style = { getPropertyValue: (key) => tokens[key] || '' };
  state.current = { chord: state.config.chords[0] }; state.armed = true;
  capture.draw();
  assert.equal(context.events.find((event) => event.type === 'fill').color, '#010101');
  for (const color of ['#020202', '#030303', '#eeeeee']) {
    assert.ok(context.events.some((event) => event.type === 'fill' && event.color === color));
  }
  assert.ok(context.events.some((event) => event.type === 'text' && event.value === 'C' && event.color === '#040404'));
  assert.ok(context.events.some((event) => event.type === 'text' && event.value === 'G' && event.color === '#fafafa'));
  tokens['--wheel-selected-label'] = '#050505'; context.events = [];
  capture.draw();
  assert.ok(context.events.some((event) => event.type === 'text' && event.value === 'C' && event.color === '#050505'));
});

test('responsive label typography wraps at its DOM content width without squeezing text', () => {
  const { capture, context, state, panels } = setup({ product: 'chord', input: 'manual' });
  state.config.chords = [{ root: 1, quality: 'maj7' }];
  const choice = { style: { fontSize: '19px', fontWeight: '700', fontFamily: 'test-font', lineHeight: '22px',
    paddingLeft: '3px', paddingRight: '3px' }, getBoundingClientRect: () => ({ width: 44, height: 54 }) };
  panels.push({ querySelectorAll: () => [choice], querySelector: () => null });
  capture.draw();
  const labels = context.events.filter((event) => event.type === 'text' && event.font === '700 19px test-font');
  assert.deepEqual(labels.map((event) => event.value), ['Dbmaj', '7']);
  assert.ok(labels.every((event) => event.width === undefined));
  assert.equal(labels[1].y - labels[0].y, 22);
});

test('wheel title and selection badge follow stage DOM positions in compact layouts', () => {
  const { capture, context, state, panels } = setup({ product: 'chord', hands: 'one', input: 'hands' });
  state.current = { chord: state.config.chords[0] }; state.armed = true;
  const element = (left, width, style = {}) => ({ style,
    getBoundingClientRect: () => ({ left, top: 251, width, height: 24 }) });
  const title = element(231, 100, { fontSize: '12px', fontWeight: '600', color: '#fafafa' });
  const badge = element(341, 110, { fontSize: '11px', fontWeight: '700', color: '#192117', backgroundColor: '#f3dfb4' });
  const heading = element(221, 240, { backgroundColor: '#17231b' });
  heading.querySelector = (selector) => selector === '.wheel-title' ? title : badge;
  panels.push({ querySelectorAll: () => [], querySelector: (selector) => selector === '.wheel-heading' ? heading : null });
  capture.draw();
  const selected = context.events.find((event) => event.type === 'text' && event.value === 'C · 연주 중');
  assert.equal(selected.x, 295); assert.equal(selected.y, 62);
  assert.equal(selected.color, '#192117'); assert.match(selected.font, /^700 11px/);
  assert.ok(texts(context).includes('코드 · 손동작'));
});
