import { ROOTS, QUALITIES, CHOIR_OPTIONS, DEFAULT_CONFIG, cloneConfig, validateConfig, chordKey, chordLabel } from '../core/chords.js';

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
  constructor({ host = document.getElementById('performance-controls'), stageHost = document.getElementById('performance-wheels'), config = DEFAULT_CONFIG, ...callbacks } = {}) {
    this.host = host;
    this.stageHost = stageHost;
    this.callbacks = callbacks;
    this.config = cloneConfig(config);
    this.state = { product: 'choir', hands: 'one', input: 'hands', ready: false, cameraAvailable: false, armed: false, current: {} };
    this.signature = '';
    this.choices = [];
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
      }
    }, { signal: this.events.signal });
    this.stageHost.addEventListener('pointerleave', () => this.call('onPointerLeave'), { signal: this.events.signal });
    this.render();
  }

  call(name, ...args) { return (this.callbacks[name] || noop)(...args); }

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
    const settings = button('휠 설정', 'wheel-settings', 'quiet');
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
    const fields = node('div', 'performance-fields');
    fields.append(product.wrap, hands.wrap, input.wrap);
    const actions = node('div', 'performance-actions');
    actions.append(settings, stop);
    const info = node('div', 'performance-info');
    info.append(this.handsHint, this.inputHint, this.modeStatus);
    this.host.replaceChildren(fields, actions, info);
    this.product.addEventListener('change', () => this.call('onProduct', this.product.value));
    this.hands.addEventListener('change', () => this.call('onHands', this.hands.value));
    this.input.addEventListener('change', () => this.call('onInput', this.input.value));
  }

  render(next = {}) {
    this.state = { ...this.state, ...next, current: next.current === undefined ? this.state.current : (next.current || {}) };
    if (next.config) this.config = cloneConfig(next.config);
    const { product, hands, input, ready, cameraAvailable, armed, current, status } = this.state;
    this.product.value = product;
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
      : (product === 'choir' ? '손가락 수로 화음을 지휘하세요.' : '휠 안으로 손을 움직여 선택하세요. 중앙은 OFF입니다.');
    const text = status || `${mode} · ${ready ? (armed ? '연주 중' : '선택 대기') : '세션 시작 전'} · ${instruction}`;
    if (this.modeStatus.textContent !== text) this.modeStatus.textContent = text;
    const visible = ready && (product === 'chord' || input === 'manual');
    this.stageHost.hidden = !visible;
    this.stageHost.parentElement?.classList.toggle('wheel-mode', visible);
    if (this.stageHost.parentElement) this.stageHost.parentElement.dataset.product = product;
    this.stageHost.dataset.input = input;
    this.stageHost.dataset.product = product;
    const signature = JSON.stringify([product, hands, this.config]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.buildWheels();
    }
    for (const entry of this.choices) {
      const selected = current[entry.type] != null && keyFor(entry.type, current[entry.type]) === keyFor(entry.type, entry.value);
      entry.button.setAttribute('aria-pressed', String(selected));
      entry.button.disabled = !ready || input !== 'manual';
      entry.path?.classList.toggle('selected', selected);
      entry.path?.classList.toggle('sounding', selected && armed);
    }
    for (const off of this.stageHost.querySelectorAll('.wheel-off')) {
      off.disabled = !ready;
      off.dataset.armed = String(armed);
    }
    this.stageHost.dataset.armed = String(armed);
  }

  buildWheels() {
    const { product, hands } = this.state;
    const specifications = product === 'choir'
      ? [['choir', '합창', 'choir']]
      : hands === 'two' ? [['root', '근음', 'roots'], ['quality', '코드 종류', 'qualities']] : [['chord', '코드', 'chords']];
    this.stageHost.replaceChildren();
    this.choices = [];
    this.stageHost.classList.toggle('two-wheels', specifications.length === 2);
    for (const [type, title, group] of specifications) {
      const panel = node('section', 'wheel-panel');
      panel.setAttribute('aria-label', `${title} 선택`);
      const heading = node('h2', 'wheel-title', title);
      const circle = node('div', 'wheel-circle');
      const values = this.config[group];
      circle.style.setProperty('--wheel-count', values.length);
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
        circle.append(el);
        this.choices.push({ type, value, button: el, path: svg.querySelector(`path[data-index="${i}"]`) });
      });
      const off = button('OFF', null, 'wheel-off');
      off.setAttribute('aria-label', `${title} 휠 소리 끄기`);
      off.append(node('small', '', '소리 끄기'));
      off.addEventListener('click', () => this.call('onOff'));
      circle.append(off);
      panel.append(heading, circle);
      this.stageHost.append(panel);
    }
  }

  buildDialog() {
    this.dialog = node('dialog', 'wheel-dialog');
    this.dialog.id = 'wheel-dialog';
    this.dialog.setAttribute('aria-labelledby', 'wheel-dialog-title');
    this.dialog.setAttribute('aria-describedby', 'wheel-dialog-description');
    const header = node('div', 'wheel-dialog-header');
    const title = node('h2', '', '나의 연주 휠'); title.id = 'wheel-dialog-title';
    const close = button('닫기', 'wheel-close', 'quiet');
    close.setAttribute('aria-label', '휠 설정 닫기');
    close.addEventListener('click', () => this.closeSettings());
    header.append(title, close);
    const description = node('p', 'muted', '자주 쓰는 항목을 추가하고 순서를 바꾸세요. 적용 전까지 연주 휠은 바뀌지 않습니다.');
    description.id = 'wheel-dialog-description';
    const group = field('설정할 목록', 'wheel-config-group', Object.entries(GROUPS));
    this.groupSelect = group.select;
    this.groupSelect.addEventListener('change', () => { this.editError = ''; this.renderEditor(); });
    this.list = node('ol', 'wheel-config-list'); this.list.id = 'wheel-config-list';
    this.list.setAttribute('aria-label', '휠 항목 순서');
    this.addFields = node('div', 'wheel-add-fields');
    this.addButton = button('항목 추가', 'wheel-add');
    this.addButton.addEventListener('click', () => this.addItem());
    this.preview = node('div', 'wheel-preview');
    this.preview.setAttribute('role', 'img');
    this.error = node('p', 'wheel-config-error');
    this.error.id = 'wheel-config-error'; this.error.setAttribute('role', 'alert');
    this.error.setAttribute('aria-live', 'assertive');
    this.error.hidden = true;
    const editor = node('div', 'wheel-editor');
    const items = node('div', 'wheel-editor-items');
    items.append(group.wrap, this.list, this.addFields, this.addButton);
    const previewWrap = node('aside', 'wheel-preview-wrap');
    previewWrap.append(node('h3', '', '적용 후 미리보기'), this.preview, node('p', 'muted', '위에서 시작해 시계 방향으로 배치됩니다. 중앙 OFF는 항상 유지됩니다.'));
    editor.append(items, previewWrap);
    const privacy = node('p', 'wheel-storage-note', '이 기기에 목록과 순서만 저장합니다. 이미지·오디오·카메라 영상은 저장하지 않습니다.');
    const footer = node('div', 'wheel-dialog-footer');
    const defaults = button('기본 목록 복원', 'wheel-defaults', 'quiet');
    defaults.addEventListener('click', () => { this.draft = cloneConfig(DEFAULT_CONFIG); this.editError = ''; this.renderEditor(); });
    const cancel = button('취소', 'wheel-cancel', 'quiet');
    cancel.addEventListener('click', () => this.closeSettings());
    this.apply = button('적용', 'wheel-apply', 'primary');
    this.apply.addEventListener('click', () => this.applySettings());
    const actions = node('div', 'row'); actions.append(cancel, this.apply);
    footer.append(defaults, actions);
    this.dialog.append(header, description, editor, this.error, privacy, footer);
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.closeSettings(); });
    this.dialog.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.append(this.dialog);
  }

  openSettings() {
    if (this.dialog.open) return;
    this.returnFocus = document.activeElement;
    this.call('onSettingsOpen');
    this.draft = cloneConfig(this.config);
    this.editError = '';
    this.groupSelect.value = 'chords';
    this.renderEditor();
    this.dialog.showModal();
    this.groupSelect.focus();
  }

  closeSettings() {
    if (this.saving) return;
    this.dialog.close();
    this.draft = null;
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
  }

  renderEditor(focus = null) {
    const group = this.groupSelect.value;
    const items = this.draft[group];
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
    this.preview.replaceChildren(ring(items.length, items.map((value) => labelFor(group, value))), node('span', 'wheel-preview-off', 'OFF'));
    this.preview.setAttribute('aria-label', `${GROUPS[group]} 미리보기: ${items.map((value) => labelFor(group, value)).join(', ') || '비어 있음'}. 중앙 OFF.`);
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
