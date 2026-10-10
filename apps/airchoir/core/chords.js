// Independent chord/wheel data. No audio devices, DOM, or storage globals are accessed here.

export const STORAGE_KEY = 'airchoir.wheels.v1';

export const ROOTS = Object.freeze(
  ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
    .map((label, id) => Object.freeze({ id, label })),
);

export const QUALITIES = Object.freeze([
  { id: 'maj', label: '메이저', intervals: [0, 4, 7] },
  { id: 'min', label: '마이너', intervals: [0, 3, 7] },
  { id: '7', label: '도미넌트 7', intervals: [0, 4, 7, 10] },
  { id: 'maj7', label: '메이저 7', intervals: [0, 4, 7, 11] },
  { id: 'm7', label: '마이너 7', intervals: [0, 3, 7, 10] },
  { id: 'dim', label: '디미니시', intervals: [0, 3, 6] },
  { id: 'sus4', label: '서스펜디드 4', intervals: [0, 5, 7] },
  // 가요·발라드·CCM에서 자주 쓰는 색깔 코드
  { id: 'add9', label: '애드 9', intervals: [0, 4, 7, 14] },
  { id: 'sus2', label: '서스펜디드 2', intervals: [0, 2, 7] },
  { id: '7sus4', label: '7 서스 4', intervals: [0, 5, 7, 10] },
  { id: '6', label: '식스', intervals: [0, 4, 7, 9] },
  { id: 'maj9', label: '메이저 9', intervals: [0, 4, 7, 11, 14] },
  { id: 'm9', label: '마이너 9', intervals: [0, 3, 7, 10, 14] },
  { id: '9', label: '도미넌트 9', intervals: [0, 4, 7, 10, 14] },
  { id: 'm7b5', label: '하프 디미니시', intervals: [0, 3, 6, 10] },
  { id: 'aug', label: '오그먼트', intervals: [0, 4, 8] },
].map((quality) => Object.freeze({ ...quality, intervals: Object.freeze(quality.intervals) })));

export const CHOIR_OPTIONS = Object.freeze(
  [1, 2, 3, 4].map((id) => Object.freeze({ id, label: `${id}명` })),
);

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  chords: Object.freeze([
    { root: 0, quality: 'maj' }, { root: 2, quality: 'min' },
    { root: 4, quality: 'min' }, { root: 5, quality: 'maj' },
    { root: 7, quality: 'maj' }, { root: 9, quality: 'min' },
    { root: 10, quality: 'maj' },
  ].map(Object.freeze)),
  roots: Object.freeze([0, 2, 4, 5, 7, 9, 10]),
  qualities: Object.freeze(['maj', 'min', '7', 'dim']),
  choir: Object.freeze([1, 2, 3, 4]),
});

const QUALITY_BY_ID = new Map(QUALITIES.map((quality) => [quality.id, quality]));
const SUFFIX = {
  maj: '', min: 'm', '7': '7', maj7: 'maj7', m7: 'm7', dim: 'dim', sus4: 'sus4',
  add9: 'add9', sus2: 'sus2', '7sus4': '7sus4', '6': '6', maj9: 'maj9', m9: 'm9', '9': '9', m7b5: 'm7b5', aug: 'aug',
};
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRoot = (value) => Number.isInteger(value) && value >= 0 && value < ROOTS.length;
const isQuality = (value) => typeof value === 'string' && QUALITY_BY_ID.has(value);
const isChord = (value) => isRecord(value) && isRoot(value.root) && isQuality(value.quality);

function checkedChord(chord) {
  if (!isChord(chord)) throw new TypeError('코드의 근음과 종류를 선택해 주세요.');
  return chord;
}

export function chordKey(chord) {
  const { root, quality } = checkedChord(chord);
  return `${root}:${quality}`;
}

export function chordLabel(chord) {
  const { root, quality } = checkedChord(chord);
  return ROOTS[root].label + SUFFIX[quality];
}

// Scientific pitch notation: C4 = MIDI 60; the default C3 chord starts at MIDI 48.
export function chordNotes(chord, octave = 3) {
  const { root, quality } = checkedChord(chord);
  if (!Number.isInteger(octave) || octave < -1 || octave > 9) {
    throw new RangeError('옥타브는 -1부터 9까지의 정수여야 합니다.');
  }
  const base = (octave + 1) * 12 + root;
  const notes = QUALITY_BY_ID.get(quality).intervals.map((interval) => base + interval);
  if (notes.some((note) => note > 127)) throw new RangeError('코드가 MIDI 음 범위를 벗어납니다.');
  return notes;
}

/** Validate all four wheels and return a fresh, allowlisted config. No input is mutated. */
export function validateConfig(input) {
  const errors = [];
  if (!isRecord(input)) return { ok: false, value: null, errors: ['휠 설정은 객체여야 합니다.'] };
  if (input.version !== 1) errors.push('지원하지 않는 휠 설정 버전입니다.');

  function wheel(key, label, valid, identity = (value) => value) {
    const values = input[key];
    if (!Array.isArray(values) || values.length < 1 || values.length > 12) {
      errors.push(`${label}: 항목을 1개부터 12개까지 선택해 주세요.`);
      return;
    }
    const seen = new Set();
    for (const value of values) {
      if (!valid(value)) {
        errors.push(`${label}: 사용할 수 없는 항목이 있습니다.`);
        continue;
      }
      const id = identity(value);
      if (seen.has(id)) errors.push(`${label}: 같은 항목을 두 번 넣을 수 없습니다.`);
      seen.add(id);
    }
  }

  wheel('chords', '코드 휠', isChord, chordKey);
  wheel('roots', '근음 휠', isRoot);
  wheel('qualities', '코드 종류 휠', isQuality);
  wheel('choir', '합창 인원 휠', (value) => Number.isInteger(value) && value >= 1 && value <= 4);
  if (errors.length) return { ok: false, value: null, errors };
  return {
    ok: true,
    value: {
      version: 1,
      chords: input.chords.map(({ root, quality }) => ({ root, quality })),
      roots: [...input.roots],
      qualities: [...input.qualities],
      choir: [...input.choir],
    },
    errors: [],
  };
}

export function cloneConfig(config = DEFAULT_CONFIG) {
  const result = validateConfig(config);
  if (!result.ok) throw new TypeError(result.errors.join(' '));
  return result.value;
}

/** Read only our settings key. Invalid/unavailable storage is never overwritten. */
export function loadConfig(storage) {
  const fallback = (notice) => ({ config: cloneConfig(), notice });
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return fallback('저장된 휠 설정을 읽을 수 없어 기본 설정으로 시작합니다.');
  }
  if (raw === null) return fallback(null);
  try {
    const result = validateConfig(JSON.parse(raw));
    if (result.ok) return { config: result.value, notice: null };
  } catch {
    // Malformed JSON is treated the same as an unsupported config.
  }
  return fallback('저장된 휠 설정이 올바르지 않아 기본 설정으로 시작합니다. 설정을 다시 저장해 주세요.');
}

/** Persist only validated wheel choices, never arbitrary caller properties. */
export function saveConfig(storage, config) {
  const result = validateConfig(config);
  if (!result.ok) return { ok: false, error: result.errors.join(' ') };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(result.value));
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: '휠 설정을 저장하지 못했습니다. 브라우저 저장 공간과 권한을 확인해 주세요.' };
  }
}
