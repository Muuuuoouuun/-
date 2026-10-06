import { chordLabel, chordNotes, cloneConfig, loadConfig, saveConfig, validateConfig } from '../core/chords.js';
import { WheelController } from './wheel-controller.js';
import { SENSITIVITY, DEFAULT_SENSITIVITY } from './gestures.js';
import { WheelUI } from './wheel-ui.js';

const emptySelection = () => ({ chord: null, root: null, quality: null, choir: null });
const quietGesture = () => ({ present: false, fist: true, pinch: false, preset: 0, level: 0, brightness: .5 });

// Product, hand count and input ownership are separate from the media session.
// Only wheel lists are persisted; live notes, streams and device choices are not.
export class Performance {
  constructor({ getAudio, isReady, hasCamera, onTransition, onStop, onInterrupt, notify,
    sensitivity = DEFAULT_SENSITIVITY, onSensitivity = null }) {
    this.getAudio = getAudio; this.isReady = isReady; this.onTransition = onTransition;
    this.hasCamera = hasCamera;
    this.onInterrupt = onInterrupt;
    this.onStop = onStop; this.notify = notify;
    let storage;
    try { storage = window.localStorage; } catch { storage = null; }
    this.storage = storage;
    const loaded = loadConfig(storage);
    this.state = { product: 'choir', hands: 'one', input: 'hands', config: loaded.config,
      current: emptySelection(), armed: false, status: '콰이어 · 손가락으로 화음을 지휘하세요.' };
    this.sensitivity = Object.hasOwn(SENSITIVITY, sensitivity) ? sensitivity : DEFAULT_SENSITIVITY;
    this.onSensitivity = onSensitivity;
    this.controller = new WheelController(SENSITIVITY[this.sensitivity].wheel);
    this.blocked = false;
    this.lastCameraFrame = -Infinity;
    this.ui = new WheelUI({ config: this.state.config,
      sensitivity: this.sensitivity,
      sensitivities: Object.entries(SENSITIVITY).map(([id, v]) => ({ id, label: v.label, description: v.description })),
      onSensitivity: value => (this.onSensitivity ? this.onSensitivity(value) : this.setSensitivity(value)),
      onProduct: value => this.change('product', value),
      onHands: value => this.change('hands', value),
      onInput: value => this.change('input', value),
      onSelection: selection => this.select(selection),
      onOff: () => this.stop('OFF · 다시 선택하면 연주합니다.'),
      onStop: () => this.stop('전체 정지 · 다시 선택하거나 손을 내렸다 올리세요.', true),
      onSettingsOpen: () => { this.onInterrupt?.('settings'); this.stop('설정 중 · 연주가 정지됐어요.', true); },
      onApply: config => this.apply(config),
      onPointerLeave: () => { if (this.state.input === 'manual') this.stop('휠을 벗어나 연주를 멈췄어요.'); },
    });
    this.render();
    if (loaded.notice) this.notify(loaded.notice);
  }

  // 휠 판정 감도 (손동작 추적기 쪽은 앱이 맡는다)
  setSensitivity(value) {
    if (!Object.hasOwn(SENSITIVITY, value)) return;
    this.sensitivity = value;
    this.controller.setOptions(SENSITIVITY[value].wheel);
    this.controller.reset();
    this.ui.setSensitivity?.(value);
  }

  get legacy() { return this.state.product === 'choir' && this.state.input === 'hands'; }
  get settingsOpen() { return !!this.ui.settingsOpen; }

  render() {
    this.ui.render({ ...this.state, ready: this.isReady(), cameraAvailable: this.hasCamera() });
    document.getElementById('stage').dataset.product = this.state.product;
    const chord = this.state.product === 'chord';
    // 시작 카드: 제목과 한 줄 설명만 바꾼다 (아이콘·구조는 그대로)
    const setChoice = (id, title, desc) => {
      const el = document.getElementById(id);
      const t = el.querySelector('.choice-title');
      const d = el.querySelector('.choice-desc');
      if (t) { t.textContent = title; if (d) d.textContent = desc; } else el.textContent = title;
    };
    setChoice('start-pointer', chord ? '코드 악기로 시작' : '데모로 바로 시작',
      chord ? '권한 없이 · 휠을 누르거나 숫자 키로 코드를 연주해요' : '권한 없이 · 마우스와 키보드로 화음과 오브를 만들어요');
    document.getElementById('start-mic').hidden = chord;
    setChoice('start-demo', chord ? '카메라로 코드 연주' : '손동작 체험',
      chord ? '카메라 · 휠 위에 손을 올려 코드를 골라요' : '데모 노래 + 카메라 · 손가락 개수로 화음을 지휘해요');
  }

  stop(message = '연주 정지', all = false, options = {}) {
    this.blocked = true;
    this.controller.reset();
    this.state.current = emptySelection();
    this.state.armed = false;
    this.state.status = message;
    const audio = this.getAudio();
    audio.accompaniment?.release({ immediate: true });
    audio.setGesture(quietGesture());
    // Center OFF owns this instrument only. Existing loops keep their transport;
    // global stop separately silences the master and pauses those loops.
    if (all) { audio.setOutputMuted?.(true); this.onStop(options); }
    this.render();
  }

  sessionStarted() {
    this.blocked = false;
    this.controller.reset();
    this.state.current = emptySelection(); this.state.armed = false;
    this.state.status = this.state.product === 'chord' ? '휠에서 코드를 선택하세요.' : '목소리와 손으로 화음을 만드세요.';
    this.getAudio().setProduct(this.state.product);
    this.render();
  }

  change(field, value) {
    const choices = { product: ['choir', 'chord'], hands: ['one', 'two'], input: ['manual', 'hands'] };
    if (!choices[field]?.includes(value)) return;
    if (field === 'hands' && value === 'two' && this.state.product === 'choir') return;
    if (field === 'input' && value === 'hands' && this.state.product === 'chord' && this.isReady() && !this.hasCamera()) {
      this.notify('손동작은 세션 종료 후 ‘카메라로 코드 연주’로 시작하세요.');
      this.render(); return;
    }
    if (this.state[field] === value) return;
    this.onInterrupt?.('mode-change');
    this.stop('모드가 바뀌었어요. 다시 선택해 연주하세요.', true);
    this.state[field] = value;
    if (field === 'product') {
      if (value === 'choir') this.state.hands = 'one';
      else this.state.input = 'manual';
    }
    if (field === 'input') this.blocked = false; // explicit ownership change
    this.render();
    this.onTransition(this.state.product, field);
  }

  apply(input) {
    const result = validateConfig(input);
    if (!result.ok) { this.notify(result.errors.join(' ')); return false; }
    this.onInterrupt?.('settings');
    this.stop('설정 적용 완료 · 다시 선택해 연주하세요.', true);
    this.state.config = cloneConfig(result.value);
    const saved = saveConfig(this.storage, this.state.config);
    this.render();
    this.notify(saved.ok ? '원형 항목과 순서만 이 브라우저에 저장했어요. 카메라·음성·사진은 저장하지 않아요.' : `이번 세션에는 적용했지만 기기에 저장하지 못했어요. ${saved.error || ''}`);
    return true;
  }

  resume() {
    if (!this.isReady() || this.settingsOpen || document.hidden) return false;
    this.blocked = false;
    this.getAudio().setOutputMuted(false);
    return true;
  }

  select({ type, value }) {
    if (this.state.input !== 'manual' || !this.resume()) return;
    const { config, product, hands, current } = this.state;
    if (product === 'choir' && type === 'choir' && config.choir.includes(value)) {
      current.choir = value; this.state.armed = true;
      this.getAudio().setGesture({ present: true, fist: false, pinch: false, preset: value, level: .65, brightness: .6 });
      this.state.status = '콰이어 화음 선택 · 입력 목소리에 화음을 더합니다.';
    } else if (product === 'chord') {
      if (hands === 'one' && type === 'chord' && config.chords.some(c => c.root === value?.root && c.quality === value?.quality)) current.chord = { ...value };
      else if (hands === 'two' && type === 'root' && config.roots.includes(value)) current.root = value;
      else if (hands === 'two' && type === 'quality' && config.qualities.includes(value)) current.quality = value;
      else return;
      if (hands === 'two') current.chord = current.root !== null && current.quality !== null ? { root: current.root, quality: current.quality } : null;
      this.playCurrentChord();
    }
    this.render();
  }

  playCurrentChord() {
    const chord = this.state.current.chord;
    if (!chord) { this.state.status = '근음과 코드 종류를 모두 선택하세요.'; return; }
    const audio = this.getAudio();
    this.state.armed = !!audio.accompaniment?.setChord(chordNotes(chord));
    this.state.status = this.state.armed ? `${chordLabel(chord)} 연주 중 · OFF로 정지` : '연주를 시작할 수 없어요. 세션을 다시 시작해 주세요.';
  }

  rearmLegacy() { if (this.legacy && !this.settingsOpen) this.resume(); }

  routeLegacy(gesture) {
    if (!this.legacy || this.blocked || this.settingsOpen || document.hidden) return quietGesture();
    const mapped = { ...gesture };
    if (gesture.present && !gesture.fist) {
      const index = Math.min(Math.max(gesture.preset - 1, 0), this.state.config.choir.length - 1);
      mapped.preset = this.state.config.choir[index];
      this.getAudio().setOutputMuted(false);
      this.state.current.choir = mapped.preset;
      this.state.armed = true;
    } else { this.state.armed = false; this.state.current.choir = null; }
    return mapped;
  }

  cameraHands(hands, mapPoint, now) {
    this.lastCameraFrame = now;
    if (document.hidden || !document.hasFocus()) return;
    if (!hands.length) this.blocked = false;
    if (this.state.product !== 'chord' || this.state.input !== 'hands' || !this.isReady() || this.settingsOpen) return;
    const geometry = this.ui.getWheelGeometry();
    if (!geometry.length) return;
    this.controller.configure({ hands: this.state.hands,
      counts: this.state.hands === 'one' ? [this.state.config.chords.length] : [this.state.config.roots.length, this.state.config.qualities.length],
      centers: geometry.map(g => g.center), radius: Math.min(...geometry.map(g => g.radius)),
    });
    const points = hands.map(h => ({ ...h, palm: mapPoint(h.palm) }));
    const result = this.controller.update(points, now);
    if (this.blocked) return;
    if (!result.active) {
      this.getAudio().accompaniment?.release(); this.state.armed = false;
      this.state.current = emptySelection();
      this.state.status = result.reason === 'ambiguous' ? '손을 내렸다 다시 올려 역할을 맞추세요.' : '휠의 항목 위에서 손을 잠시 유지하세요.';
      return;
    }
    const [a, b] = result.indices;
    const config = this.state.config;
    this.state.current = this.state.hands === 'one' ? { ...emptySelection(), chord: { ...config.chords[a] } } :
      { ...emptySelection(), root: config.roots[a], quality: config.qualities[b], chord: { root: config.roots[a], quality: config.qualities[b] } };
    this.getAudio().setOutputMuted(false);
    this.playCurrentChord();
  }

  tick(now, cameraMode) {
    if (cameraMode && this.state.input === 'hands' && now - this.lastCameraFrame > 300 && this.state.armed) this.stop('손 입력이 끊겨 연주를 멈췄어요.');
    if (this.state.product === 'chord' && this.state.input === 'hands') this.controller.tick(now);
  }
}
