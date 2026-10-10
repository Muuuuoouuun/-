import { ROOTS, QUALITIES, CHOIR_OPTIONS, DEFAULT_CONFIG, cloneConfig, validateConfig, chordKey, chordLabel } from '../core/chords.js';
import { DEFAULT_STYLES, STYLE_LISTS, styleInfo } from '../core/styles.js';
import { harmonyPreset } from '../core/dsp.js';
import { keyFor as wheelKeyCode, keyLabel } from './wheel-keys.js';

const GROUPS = { chords: '한 손 코드', roots: '두 손 · 근음', qualities: '두 손 · 코드 종류', choir: '합창 프리셋' };
const OPTIONS = { roots: ROOTS, qualities: QUALITIES, choir: CHOIR_OPTIONS };
const NS = 'http://www.w3.org/2000/svg';
const noop = () => {};
const labelFor = (group, value) => group === 'chords' ? chordLabel(value) : OPTIONS[group]?.find((item) => item.id === value)?.label || String(value);
const keyFor = (type, value) => type === 'chord' ? chordKey(value) : String(value);
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
};
function option(value, label) {
  const el = node('option', '', label);
  el.value = value;
  return el;
}
function button(text, id, className = '') {
  const el = node('button', className, text);
  el.type = 'button';
  if (id) el.id = id;
  return el;
}
function field(label, id, values) {
  const wrap = node('label', 'performance-field');
  wrap.append(node('span', '', label));
  const select = node('select');
  select.id = id;
  for (const [value, text] of values) select.append(option(value, text));
  wrap.append(select);
  return { wrap, select };
}
function point(radius, degrees) {
  const angle = degrees * Math.PI / 180;
  return [50 + radius * Math.sin(angle), 50 - radius * Math.cos(angle)];
}
function ring(count, labels = null) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('wheel-ring');
  for (let i = 0; i < count; i++) {
    const middle = i * 360 / count;
    // A single full circle needs two arcs; keeping a small sector gap also makes its boundary visible.
    const start = middle - 180 / count + .7;
    const end = middle + 180 / count - .7;
    const [a, b, c, d] = [point(48, start), point(48, end), point(25, end), point(25, start)];
    const large = end - start > 180 ? 1 : 0;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M ${a.join(' ')} A 48 48 0 ${large} 1 ${b.join(' ')} L ${c.join(' ')} A 25 25 0 ${large} 0 ${d.join(' ')} Z`);
    path.dataset.index = i;
    svg.append(path);
    if (labels) {
      const p = point(36.5, middle);
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', p[0]); text.setAttribute('y', p[1]);
      text.setAttribute('text-anchor', 'middle'); text.setAttribute('dominant-baseline', 'middle');
      text.textContent = labels[i];
      svg.append(text);
    }
  }
  return svg;
}

/** UI only: audio ownership, latching and persistence belong to the app callbacks. */
export class WheelUI {
  constructor({ host = document.getElementById('performance-controls'), stageHost = document.getElementById('performance-wheels'), config = DEFAULT_CONFIG,
    styles = DEFAULT_STYLES, sensitivity = 'normal', sensitivities = [], ...callbacks } = {}) {
    this.host = host;
    this.sensitivity = sensitivity;
    this.sensitivities = sensitivities;
    this.stageHost = stageHost;
    this.callbacks = callbacks;
    this.config = cloneConfig(config);
    this.state = { product: 'choir', hands: 'one', input: 'hands', ready: false, cameraAvailable: false, armed: false, current: {}, styles: { ...styles } };
    this.signature = '';
    this.choices = [];
    this.panels = [];
    this.saving = false;
    this.events = new AbortController();
    this.buildControls();
    this.buildDialog();
    // The underlying stage also handles recording/drag gestures. Wheel controls own their input.
    for (const event of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick', 'keydown', 'keyup']) {
      this.stageHost.addEventListener(event, (e) => e.stopPropagation(), { signal: this.events.signal });
    }
    this.stageHost.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.call('onStop');
      } else if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) {
        // 누르고 있는 키·조합 키는 휠이 쓰지 않는다
      } else if (e.code === 'KeyH') {
        // 휠 버튼에 초점이 있어도 H(다음)·Shift+H(이전)로 화음 성격을 넘긴다 (페이지 단축키는 여기까지 오지 않음)
        e.preventDefault();
        this.call('onCycleStyle', e.shiftKey ? -1 : 1);
      } else if (!e.shiftKey && this.call('onKey', e.code)) {
        e.preventDefault();
      }
    }, { signal: this.events.signal });
    this.stageHost.addEventListener('pointerleave', () => this.call('onPointerLeave'), { signal: this.events.signal });
    this.render();
  }

  call(name, ...args) { return (this.callbacks[name] || noop)(...args); }

  /**
   * 카메라 코드 연주: 손바닥이 휠 위 어디를 가리키는지 커서로 보여 준다 (핀치 중이면 채운 원).
   * points: 화면(client) 좌표. 빈 배열이면 숨긴다.
   */
  showHands(points) {
    this.handCursors ??= [];
    const box = this.stageHost.hidden ? null : this.stageHost.getBoundingClientRect();
    points.slice(0, 2).forEach((p, i) => {
      let el = this.handCursors[i];
      if (!el) {
        el = node('span', 'wheel-hand-cursor');
        el.setAttribute('aria-hidden', 'true');
        this.stageHost.append(el);
        this.handCursors[i] = el;
      }
      if (!box || !el.isConnected) this.stageHost.append(el);
      el.hidden = !box;
      if (box) el.style.transform = `translate(${p.x - box.left}px, ${p.y - box.top}px)`;
      el.dataset.pinch = String(p.pinch);
    });
    for (let i = points.length; i < this.handCursors.length; i++) this.handCursors[i].hidden = true;
  }

  /** 화음 성격이 바뀌면 무대 가운데 위에 잠깐 이름과 설명을 띄운다 (집중 화면에서도 보이게). */
  flashStyle(info) {
    const stage = this.stageHost.parentElement;
    if (!stage) return;
    if (!this.flash) {
      this.flash = node('div', 'style-flash');
      this.flash.setAttribute('role', 'status');
      this.flash.setAttribute('aria-live', 'polite');
      this.flash.hidden = true;
      stage.append(this.flash);
    }
    this.flash.replaceChildren(node('strong', '', info.label), node('span', '', info.desc));
    this.flash.hidden = false;
    this.flash.classList.remove('show');
    void this.flash.offsetWidth; // 같은 이름을 연달아 눌러도 다시 나타나게
    this.flash.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => { this.flash.hidden = true; this.flash.classList.remove('show'); }, 1800);
  }

  get settingsOpen() { return this.dialog.open; }

  getWheelGeometry() {
    if (this.stageHost.hidden) return [];
    return [...this.stageHost.querySelectorAll('.wheel-circle')].map((circle) => {
      const rect = circle.getBoundingClientRect();
      return { center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, radius: Math.min(rect.width, rect.height) * .48 };
    });
  }

  buildControls() {
    const product = field('악기', 'performance-product', [['choir', '목소리 합창'], ['chord', '코드 악기']]);
    const hands = field('선택 방식', 'performance-hands', [['one', '한 손 · 한 휠'], ['two', '두 손 · 두 휠']]);
    const input = field('조작', 'performance-input', [['hands', '손동작'], ['manual', '클릭 · 키보드']]);
    this.product = product.select;
    this.hands = hands.select;
    this.input = input.select;
    this.handsHint = node('span', 'performance-hint', '합창은 한 손으로 지휘합니다.');
    this.handsHint.id = 'performance-hands-hint';
    this.hands.setAttribute('aria-describedby', this.handsHint.id);
    this.inputHint = node('span', 'performance-hint', '손동작은 세션 종료 후 ‘카메라로 코드 연주’로 시작하세요.');
    this.inputHint.id = 'performance-input-hint';
    this.input.setAttribute('aria-describedby', this.inputHint.id);
    const settings = button('설정', 'wheel-settings', 'quiet');
    settings.setAttribute('aria-label', '연주 설정: 휠 항목과 손동작 감도');
    settings.setAttribute('aria-haspopup', 'dialog');
    settings.setAttribute('aria-controls', 'wheel-dialog');
    settings.addEventListener('click', () => this.openSettings());
    const stop = button('모든 소리 정지', 'all-stop', 'all-stop');
    stop.setAttribute('aria-label', '모든 소리 정지');
    stop.addEventListener('click', () => this.call('onStop'));
    this.modeStatus = node('p', 'performance-mode-status');
    this.modeStatus.id = 'performance-mode-status';
    this.modeStatus.setAttribute('role', 'status');
    this.modeStatus.setAttribute('aria-live', 'polite');
    // 화음 성격: 합창이면 쌓는 방식, 코드 악기면 보이싱. 목록은 악기가 바뀔 때 다시 채운다.
    const style = field('화음 성격', 'performance-style', []);
    style.wrap.classList.add('performance-style');
    this.style = style.select;
    this.styleKind = null;
    this.styleHint = node('span', 'performance-style-hint');
    this.styleHint.id = 'performance-style-hint';
    this.style.setAttribute('aria-describedby', this.styleHint.id);
    this.style.setAttribute('aria-keyshortcuts', 'H');
    this.smoothWrap = node('label', 'check performance-smooth');
    this.smooth = node('input');
    this.smooth.type = 'checkbox';
    this.smooth.id = 'performance-smooth';
    this.smoothWrap.append(this.smooth, document.createTextNode('부드럽게 잇기'));
    this.smoothWrap.title = '앞 코드와 겹치는 음은 그대로 두고 가장 가깝게 움직여요 (성부 진행).';
    this.swipeWrap = node('label', 'check performance-smooth');
    this.swipe = node('input');
    this.swipe.type = 'checkbox';
    this.swipe.id = 'performance-swipe';
    this.swipeWrap.append(this.swipe, document.createTextNode('손 휙으로 넘기기'));
    this.swipeWrap.title = '카메라 앞에서 편 손을 옆으로 휙: 오른쪽은 다음, 왼쪽은 이전 화음 성격.';
    const fields = node('div', 'performance-fields');
    fields.append(product.wrap, hands.wrap, input.wrap, style.wrap, this.smoothWrap, this.swipeWrap);
    const actions = node('div', 'performance-actions');
    actions.append(settings, stop);
    const info = node('div', 'performance-info');
    info.append(this.handsHint, this.inputHint, this.styleHint, this.modeStatus);
    this.host.replaceChildren(fields, actions, info);
    this.product.addEventListener('change', () => this.call('onProduct', this.product.value));
    this.hands.addEventListener('change', () => this.call('onHands', this.hands.value));
    this.input.addEventListener('change', () => this.call('onInput', this.input.value));
    this.style.addEventListener('change', () => this.call('onStyle', this.styleKind, this.style.value));
    this.smooth.addEventListener('change', () => this.call('onStyle', 'smooth', this.smooth.checked));
    this.swipe.addEventListener('change', () => this.call('onStyle', 'swipe', this.swipe.checked));
  }

  renderStyle(product, styles) {
    const kind = product === 'choir' ? 'choir' : 'voicing';
    if (this.styleKind !== kind) {
      this.styleKind = kind;
      this.style.replaceChildren(...STYLE_LISTS[kind].map((item) => option(item.id, item.label)));
      this.style.setAttribute('aria-label', kind === 'choir' ? '화음 성격: 목소리를 쌓는 방식' : '화음 성격: 코드 보이싱');
    }
    const info = styleInfo(kind, styles[kind]);
    this.style.value = info.id;
    const hint = `${info.label} · ${info.desc}`;
    if (this.styleHint.textContent !== hint) this.styleHint.textContent = hint;
    this.smoothWrap.hidden = kind !== 'voicing';
    this.smooth.checked = styles.smooth !== false;
    this.swipeWrap.hidden = this.state.input !== 'hands';
    this.swipe.checked = styles.swipe !== false;
  }

  render(next = {}) {
    this.state = { ...this.state, ...next, current: next.current === undefined ? this.state.current : (next.current || {}) };
    if (next.config) this.config = cloneConfig(next.config);
    const { product, hands, input, ready, cameraAvailable, armed, current, status } = this.state;
    this.product.value = product;
    this.renderStyle(product, this.state.styles || DEFAULT_STYLES);
    this.hands.value = product === 'choir' ? 'one' : hands;
    this.hands.querySelector('option[value="two"]').disabled = product === 'choir';
    this.input.value = input;
    const needsCameraSession = product === 'chord' && ready && !cameraAvailable;
    this.input.querySelector('option[value="hands"]').disabled = needsCameraSession;
    this.inputHint.hidden = !needsCameraSession;
    this.handsHint.hidden = product !== 'choir';
    const mode = product === 'choir' ? '목소리 합창' : '코드 악기';
    const instruction = input === 'manual'
      ? (product === 'chord' && hands === 'two' ? '근음과 코드 종류를 하나씩 클릭하세요. 중앙 OFF로 멈춥니다.' : '항목을 클릭하거나 키보드로 선택하세요. 중앙 OFF로 멈춥니다.')
      : (product === 'choir' ? '손가락 수로 화음을 지휘하세요.' : `${hands === 'two' ? '양손 핀치' : '핀치'}를 유지하며 휠에서 선택하세요. 놓으면 소리가 멈춥니다.`);
    const text = status || `${mode} · ${ready ? (armed ? '연주 중' : '선택 대기') : '세션 시작 전'} · ${instruction}`;
    if (this.modeStatus.textContent !== text) this.modeStatus.textContent = text;
    const visible = ready && (product === 'chord' || input === 'manual');
    this.stageHost.hidden = !visible;
    this.stageHost.parentElement?.classList.toggle('wheel-mode', visible);
    if (this.stageHost.parentElement) this.stageHost.parentElement.dataset.product = product;
    this.stageHost.dataset.input = input;
    this.stageHost.dataset.product = product;
    const signature = JSON.stringify([product, hands, input, this.config]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.buildWheels();
      this.handCursors = []; // 휠을 다시 만들면 커서도 새로
    }
    if (!(product === 'chord' && input === 'hands' && visible)) this.handCursors?.forEach((el) => { el.hidden = true; });
    this.renderChoirNames(this.state.styles || DEFAULT_STYLES);
    for (const entry of this.choices) {
      const selected = current[entry.type] != null && keyFor(entry.type, current[entry.type]) === keyFor(entry.type, entry.value);
      entry.button.setAttribute('aria-pressed', String(selected));
      entry.button.disabled = !ready || input !== 'manual';
      entry.path?.classList.toggle('selected', selected);
      entry.path?.classList.toggle('sounding', selected && armed);
    }
    for (const center of this.stageHost.querySelectorAll('.wheel-off, .wheel-center-hint')) {
      if (center.tagName === 'BUTTON') center.disabled = !ready;
      center.dataset.armed = String(armed);
    }
    for (const panel of this.panels) {
      const value = current[panel.type];
      const selected = value != null;
      const text = selected ? `${labelFor(panel.group, value)} · ${armed ? '연주 중' : '선택'}` : '선택 대기';
      if (panel.selection.textContent !== text) panel.selection.textContent = text;
      panel.selection.dataset.selected = String(selected);
      panel.selection.dataset.armed = String(selected && armed);
    }
    this.stageHost.dataset.armed = String(armed);
  }

  // 합창 휠: '2명' 아래에 지금 화음 성격에서 무엇을 쌓는지 (예: 3도 + 6도 아래)
  renderChoirNames(styles) {
    for (const entry of this.choices) {
      if (entry.type !== 'choir' || !entry.sub) continue;
      const name = harmonyPreset(styles.choir, entry.value).name;
      if (entry.sub.textContent !== name) {
        entry.sub.textContent = name;
        entry.button.setAttribute('aria-label', `합창 ${labelFor('choir', entry.value)} · ${name}`);
      }
    }
  }

  buildWheels() {
    const { product, hands, input } = this.state;
    const holdInput = product === 'chord' && input === 'hands';
    const specifications = product === 'choir'
      ? [['choir', '합창', 'choir']]
      : hands === 'two' ? [['root', '근음', 'roots'], ['quality', '코드 종류', 'qualities']] : [['chord', '코드', 'chords']];
    this.stageHost.replaceChildren();
    this.choices = [];
    this.panels = [];
    this.stageHost.classList.toggle('two-wheels', specifications.length === 2);
    for (const [wheelIndex, [type, title, group]] of specifications.entries()) {
      const panel = node('section', 'wheel-panel');
      panel.setAttribute('aria-label', `${title} 선택`);
      const heading = node('h2', 'wheel-title', title);
      const header = node('div', 'wheel-heading');
      const selection = node('span', 'wheel-selection', '선택 대기');
      header.append(heading, selection);
      this.panels.push({ type, group, selection });
      const circle = node('div', 'wheel-circle');
      const values = this.config[group];
      circle.style.setProperty('--wheel-count', values.length);
      circle.dataset.manyQualities = String(type === 'quality' && values.length > 4);
      const dense = values.length > 8 && (type === 'chord' || type === 'root');
      circle.dataset.dense = String(dense);
      const svg = ring(values.length);
      circle.append(svg);
      values.forEach((value, i) => {
        const label = labelFor(group, value);
        const el = button(label, null, 'wheel-choice');
        el.dataset.wheelType = type;
        el.dataset.value = keyFor(type, value);
        el.setAttribute('aria-label', `${title} ${label}`);
        el.setAttribute('aria-pressed', 'false');
        const p = point(dense ? 40 : 36.5, i * 360 / values.length);
        el.style.left = `${p[0]}%`; el.style.top = `${p[1]}%`;
        el.addEventListener('click', () => this.call('onSelection', { type, value }));
        let sub = null;
        if (type === 'choir') {
          sub = node('small', 'wheel-choice-sub');
          el.append(sub);
        }
        // 클릭·키보드 조작: 이 항목을 누르는 키 (숫자 줄 / 두 손의 코드 종류는 아래 줄)
        const code = input === 'manual' ? wheelKeyCode(wheelIndex, i) : null;
        if (code) {
          el.append(node('kbd', 'wheel-key', keyLabel(code)));
          el.setAttribute('aria-keyshortcuts', keyLabel(code));
        }
        circle.append(el);
        this.choices.push({ type, value, button: el, sub, path: svg.querySelector(`path[data-index="${i}"]`) });
      });
      const center = holdInput ? node('div', 'wheel-center-hint', '핀치') : button('OFF', null, 'wheel-off');
      center.append(node('small', '', holdInput ? '놓으면 쉼' : '소리 끄기'));
      if (!holdInput) {
        center.setAttribute('aria-label', `${title} 휠 소리 끄기`);
        center.addEventListener('click', () => this.call('onOff'));
      }
      circle.append(center);
      panel.append(header, circle);
      this.stageHost.append(panel);
    }
  }

  buildDialog() {
    this.dialog = node('dialog', 'wheel-dialog');
    this.dialog.id = 'wheel-dialog';
    this.dialog.setAttribute('aria-labelledby', 'wheel-dialog-title');
    this.dialog.setAttribute('aria-describedby', 'wheel-dialog-description');
    const header = node('div', 'wheel-dialog-header');
    const title = node('h2', '', '연주 설정'); title.id = 'wheel-dialog-title';
    const close = button('닫기', 'wheel-close', 'quiet');
    close.setAttribute('aria-label', '설정 닫기');
    close.addEventListener('click', () => this.closeSettings());
    header.append(title, close);

    // 탭: 연주 휠 · 손동작 감도 (둘 다 '적용'을 눌러야 바뀌고 '취소'로 되돌린다)
    const tabs = node('div', 'wheel-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '설정 종류');
    this.tabButtons = {};
    this.panels = {};
    for (const [id, label] of [['wheel', '연주 휠'], ['gesture', '손동작 감도']]) {
      const tab = button(label, `wheel-tab-${id}`, 'wheel-tab');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', `wheel-panel-${id}`);
      tab.addEventListener('click', () => this.showTab(id, true));
      tab.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        this.showTab(id === 'wheel' ? 'gesture' : 'wheel', true);
      });
      this.tabButtons[id] = tab;
      tabs.append(tab);
    }

    // 연주 휠
    const wheelPanel = node('section', 'settings-panel');
    wheelPanel.id = 'wheel-panel-wheel';
    const description = node('p', 'muted', '자주 쓰는 항목을 추가하고 순서를 바꾸세요. 적용 전까지 연주 휠은 바뀌지 않습니다.');
    description.id = 'wheel-dialog-description';
    const group = field('설정할 목록', 'wheel-config-group', Object.entries(GROUPS));
    this.groupSelect = group.select;
    this.groupSelect.addEventListener('change', () => { this.editError = ''; this.renderEditor(); });
    this.groupCount = node('span', 'wheel-group-count');
    const groupHeader = node('div', 'wheel-editor-heading');
    groupHeader.append(group.wrap, this.groupCount);
    this.list = node('ol', 'wheel-config-list'); this.list.id = 'wheel-config-list';
    this.list.setAttribute('aria-label', '휠 항목 순서');
    this.addFields = node('div', 'wheel-add-fields');
    this.addButton = button('항목 추가', 'wheel-add');
    this.addButton.addEventListener('click', () => this.addItem());
    this.preview = node('div', 'wheel-preview');
    this.preview.setAttribute('role', 'img');
    const editor = node('div', 'wheel-editor');
    const items = node('div', 'wheel-editor-items');
    items.append(this.list, this.addFields, this.addButton);
    const previewWrap = node('aside', 'wheel-preview-wrap');
    previewWrap.append(node('h3', '', '적용 후 미리보기'), this.preview, node('p', 'muted', '위에서 시작해 시계 방향으로 배치됩니다. 클릭·키보드는 중앙 OFF, 코드 손동작은 핀치를 놓아 멈춥니다.'));
    editor.append(items, previewWrap);
    const privacy = node('p', 'wheel-storage-note', '이 기기에 목록·순서·감도만 저장합니다. 이미지·오디오·카메라 영상은 저장하지 않습니다.');
    wheelPanel.append(description, groupHeader, editor, privacy);

    // 손동작 감도
    const gesturePanel = node('section', 'settings-panel');
    gesturePanel.id = 'wheel-panel-gesture';
    const intro = node('p', 'muted', '손가락 개수·핀치·휠 선택을 얼마나 빨리, 얼마나 단단히 판정할지 고르세요. 카메라 영상은 이 기기 안에서만 씁니다.');
    const group2 = node('div', 'sense-options');
    group2.setAttribute('role', 'radiogroup');
    group2.setAttribute('aria-label', '손동작 감도');
    const meters = { stable: [1, 3], normal: [2, 3], quick: [3, 2] };
    this.senseInputs = [];
    for (const item of this.sensitivities) {
      const card = node('label', 'sense-card');
      const input = node('input');
      input.type = 'radio';
      input.name = 'gesture-sensitivity';
      input.value = item.id;
      input.id = `sense-${item.id}`;
      input.addEventListener('change', () => { if (input.checked) this.draftSensitivity = item.id; });
      const copy = node('span', 'sense-copy');
      copy.append(node('strong', 'sense-title', item.label + (item.id === 'normal' ? ' (권장)' : '')), node('span', 'sense-desc', item.description || ''));
      const [speed, steady] = meters[item.id] || [2, 2];
      const meter = node('span', 'sense-meters');
      meter.setAttribute('aria-hidden', 'true');
      for (const [name, value] of [['반응', speed], ['흔들림 방지', steady]]) {
        const row = node('span', 'sense-meter');
        row.append(node('small', '', name));
        const bar = node('span', 'sense-bar');
        for (let i = 0; i < 3; i++) bar.append(node('i', i < value ? 'on' : ''));
        row.append(bar);
        meter.append(row);
      }
      card.append(input, copy, meter);
      group2.append(card);
      this.senseInputs.push(input);
    }
    const tip = node('p', 'wheel-storage-note', '팁: 손을 카메라에서 50cm~1m 거리에, 밝은 곳에서 손바닥이 보이게 들면 어느 감도에서나 판정이 정확해져요.');
    gesturePanel.append(intro, group2, tip);
    for (const [id, panel] of [['wheel', wheelPanel], ['gesture', gesturePanel]]) {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `wheel-tab-${id}`);
      this.panels[id] = panel;
    }

    const body = node('div', 'wheel-dialog-body');
    body.append(wheelPanel, gesturePanel);
    this.body = body;
    this.error = node('p', 'wheel-config-error');
    this.error.id = 'wheel-config-error'; this.error.setAttribute('role', 'alert');
    this.error.setAttribute('aria-live', 'assertive');
    this.error.hidden = true;
    const footer = node('div', 'wheel-dialog-footer');
    const defaults = button('기본 목록 복원', 'wheel-defaults', 'quiet');
    defaults.addEventListener('click', () => { this.draft = cloneConfig(DEFAULT_CONFIG); this.editError = ''; this.renderEditor(); });
    this.defaultsButton = defaults;
    const cancel = button('취소', 'wheel-cancel', 'quiet');
    cancel.addEventListener('click', () => this.closeSettings());
    this.apply = button('적용', 'wheel-apply', 'primary');
    this.apply.addEventListener('click', () => this.applySettings());
    const actions = node('div', 'row'); actions.append(cancel, this.apply);
    footer.append(defaults, actions);
    this.dialog.append(header, tabs, body, this.error, footer);
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.closeSettings(); });
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.append(this.dialog);
    this.showTab('wheel');
  }

  showTab(id, focus = false) {
    if (!this.panels?.[id]) return;
    this.tab = id;
    for (const [key, panel] of Object.entries(this.panels)) {
      const on = key === id;
      panel.hidden = !on;
      this.tabButtons[key].setAttribute('aria-selected', String(on));
      this.tabButtons[key].tabIndex = on ? 0 : -1;
    }
    this.defaultsButton && (this.defaultsButton.hidden = id !== 'wheel');
    this.body && (this.body.scrollTop = 0);
    if (focus) this.tabButtons[id].focus();
  }

  setSensitivity(value) {
    this.sensitivity = value;
    if (!this.dialog.open) this.draftSensitivity = value;
  }

  openSettings(tab = 'wheel') {
    if (this.dialog.open) return;
    this.returnFocus = document.activeElement;
    this.call('onSettingsOpen');
    this.draft = cloneConfig(this.config);
    this.draftSensitivity = this.sensitivity;
    for (const input of this.senseInputs) input.checked = input.value === this.sensitivity;
    this.editError = '';
    this.groupSelect.value = 'chords';
    this.renderEditor();
    this.showTab(tab === 'gesture' ? 'gesture' : 'wheel');
    this.dialog.showModal();
    if (this.tab === 'gesture') this.senseInputs.find((i) => i.checked)?.focus();
    else this.groupSelect.focus();
  }

  closeSettings() {
    if (this.saving) return;
    this.dialog.close();
    this.draft = null;
    this.draftSensitivity = this.sensitivity;
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
  }

  renderEditor(focus = null) {
    const group = this.groupSelect.value;
    const items = this.draft[group];
    const maximum = group === 'choir' ? CHOIR_OPTIONS.length : group === 'qualities' ? Math.min(12, QUALITIES.length) : 12;
    this.groupCount.textContent = `${items.length} / ${maximum}개`;
    this.list.replaceChildren();
    items.forEach((value, index) => {
      const row = node('li', 'wheel-config-row'); row.dataset.index = index;
      const label = labelFor(group, value);
      row.append(node('span', 'wheel-item-number', String(index + 1)), node('strong', 'wheel-item-label', label));
      for (const [action, symbol, description] of [['up', '↑', '위로'], ['down', '↓', '아래로'], ['remove', '삭제', '삭제']]) {
        const control = button(symbol, null, 'quiet');
        control.dataset.action = action;
        control.setAttribute('aria-label', `${label} ${description}`);
        control.disabled = action === 'up' && index === 0 || action === 'down' && index === items.length - 1;
        control.addEventListener('click', () => {
          this.editError = '';
          if (action === 'remove') items.splice(index, 1);
          else {
            const nextIndex = index + (action === 'up' ? -1 : 1);
            [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
          }
          const nextIndex = action === 'remove' ? Math.min(index, items.length - 1) : index + (action === 'up' ? -1 : 1);
          this.renderEditor({ index: nextIndex, action });
        });
        row.append(control);
      }
      this.list.append(row);
    });
    if (!items.length) this.list.append(node('li', 'wheel-empty-list', '항목을 하나 이상 추가해 주세요.'));
    this.addFields.replaceChildren();
    const fields = group === 'chords' ? [['root', '근음', ROOTS], ['quality', '코드 종류', QUALITIES]]
      : [[group === 'roots' ? 'root' : group === 'qualities' ? 'quality' : 'choir', '추가할 항목', OPTIONS[group]]];
    for (const [id, label, options] of fields) {
      const add = field(label, `wheel-add-${id}`, options.map((item) => [item.id, item.label]));
      this.addFields.append(add.wrap);
    }
    const holdPreview = this.state.input === 'hands' && group !== 'choir';
    this.preview.replaceChildren(ring(items.length, items.map((value) => labelFor(group, value))), node('span', 'wheel-preview-off', holdPreview ? '핀치' : 'OFF'));
    this.preview.setAttribute('aria-label', `${GROUPS[group]} 미리보기: ${items.map((value) => labelFor(group, value)).join(', ') || '비어 있음'}. ${holdPreview ? '핀치를 놓으면 쉼.' : '클릭·키보드에서 중앙 OFF.'}`);
    this.updateValidation();
    if (focus) {
      const target = this.list.querySelector(`[data-index="${focus.index}"] [data-action="${focus.action}"]:not(:disabled)`)
        || this.list.querySelector(`[data-index="${focus.index}"] [data-action="remove"]`) || this.addButton;
      target.focus();
    }
  }

  updateValidation() {
    const result = validateConfig(this.draft);
    const errors = this.editError ? [this.editError] : result.errors;
    this.error.textContent = errors.join(' ');
    this.error.hidden = !errors.length;
    this.apply.disabled = !result.ok || this.saving;
    return result;
  }

  addItem() {
    const group = this.groupSelect.value;
    const read = (name) => this.addFields.querySelector(`#wheel-add-${name}`).value;
    const value = group === 'chords' ? { root: Number(read('root')), quality: read('quality') }
      : group === 'roots' ? Number(read('root')) : group === 'qualities' ? read('quality') : Number(read('choir'));
    const key = group === 'chords' ? chordKey(value) : value;
    if (this.draft[group].some((item) => (group === 'chords' ? chordKey(item) : item) === key)) {
      this.editError = `${labelFor(group, value)} 항목이 이미 있습니다. 다른 항목을 선택해 주세요.`;
      this.updateValidation();
      return;
    }
    this.draft[group].push(value);
    this.editError = '';
    this.renderEditor({ index: this.draft[group].length - 1, action: 'remove' });
  }

  async applySettings() {
    if (this.saving) return;
    this.editError = '';
    const result = this.updateValidation();
    if (!result.ok) return;
    this.saving = true;
    this.apply.disabled = true;
    this.apply.textContent = '적용 중…';
    try {
      await this.call('onApply', cloneConfig(result.value));
      this.config = cloneConfig(result.value);
      if (this.draftSensitivity && this.draftSensitivity !== this.sensitivity) {
        await this.call('onSensitivity', this.draftSensitivity);
        this.sensitivity = this.draftSensitivity;
      }
      this.saving = false;
      this.closeSettings();
      this.render({ config: this.config });
    } catch (error) {
      this.editError = error?.message || '설정을 적용하지 못했어요. 다시 시도해 주세요.';
      this.saving = false;
      this.updateValidation();
    } finally {
      this.apply.textContent = '적용';
    }
  }

  destroy() {
    this.events.abort();
    this.dialog.remove();
    this.host.replaceChildren();
    this.stageHost.replaceChildren();
    this.stageHost.hidden = true;
    this.stageHost.parentElement?.classList.remove('wheel-mode');
  }
}
