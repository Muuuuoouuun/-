// 화음 성격 선택(합창 쌓기 · 코드 보이싱 · 부드럽게 잇기 · 손으로 넘기기)만 이 브라우저에 저장한다.
import { HARMONY_STYLES, DEFAULT_HARMONY_STYLE } from './dsp.js';
import { VOICING_STYLES, DEFAULT_VOICING } from './voicing.js';

export const STYLE_STORAGE_KEY = 'airchoir.harmony.v1';
export const STYLE_LISTS = Object.freeze({ choir: HARMONY_STYLES, voicing: VOICING_STYLES });
// swipe: 카메라 앞에서 편 손을 옆으로 휙 움직여 화음 성격 넘기기
export const DEFAULT_STYLES = Object.freeze({ choir: DEFAULT_HARMONY_STYLE, voicing: DEFAULT_VOICING, smooth: true, swipe: true });

const has = (kind, id) => STYLE_LISTS[kind].some((style) => style.id === id);
export const styleInfo = (kind, id) => STYLE_LISTS[kind].find((style) => style.id === id) || STYLE_LISTS[kind][0];

/** 알 수 없는 값은 기본값으로 바꾼 새 객체. 입력은 바꾸지 않는다. */
export function validateStyles(input) {
  const value = input !== null && typeof input === 'object' ? input : {};
  return {
    choir: has('choir', value.choir) ? value.choir : DEFAULT_STYLES.choir,
    voicing: has('voicing', value.voicing) ? value.voicing : DEFAULT_STYLES.voicing,
    smooth: typeof value.smooth === 'boolean' ? value.smooth : DEFAULT_STYLES.smooth,
    swipe: typeof value.swipe === 'boolean' ? value.swipe : DEFAULT_STYLES.swipe,
  };
}

/** 다음 성격 (마지막 다음은 처음). step = -1 이면 이전 성격. */
export function nextStyle(kind, id, step = 1) {
  const list = STYLE_LISTS[kind];
  const index = Math.max(0, list.findIndex((style) => style.id === id));
  return list[(((index + step) % list.length) + list.length) % list.length].id;
}

export function loadStyles(storage) {
  let raw;
  try {
    raw = storage?.getItem(STYLE_STORAGE_KEY) ?? null;
  } catch {
    return { styles: { ...DEFAULT_STYLES }, notice: null };
  }
  if (raw === null) return { styles: { ...DEFAULT_STYLES }, notice: null };
  try {
    return { styles: validateStyles(JSON.parse(raw)), notice: null };
  } catch {
    return { styles: { ...DEFAULT_STYLES }, notice: null };
  }
}

export function saveStyles(storage, styles) {
  try {
    storage.setItem(STYLE_STORAGE_KEY, JSON.stringify(validateStyles(styles)));
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: '화음 성격을 기기에 저장하지 못했어요. 이번 세션에만 적용합니다.' };
  }
}
