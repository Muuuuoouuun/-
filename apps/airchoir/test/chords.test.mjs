import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOTS, QUALITIES, CHOIR_OPTIONS, DEFAULT_CONFIG, STORAGE_KEY,
  cloneConfig, validateConfig, chordKey, chordLabel, chordNotes, loadConfig, saveConfig,
} from '../core/chords.js';

function fakeStorage(raw = null) {
  const calls = [];
  return {
    calls,
    raw,
    getItem(key) { calls.push(['get', key]); return this.raw; },
    setItem(key, value) { calls.push(['set', key]); this.raw = value; },
  };
}

test('code names and MIDI notes cover all chord qualities and flat roots', () => {
  const expected = [
    ['maj', 'C', [48, 52, 55]], ['min', 'Cm', [48, 51, 55]],
    ['7', 'C7', [48, 52, 55, 58]], ['maj7', 'Cmaj7', [48, 52, 55, 59]],
    ['m7', 'Cm7', [48, 51, 55, 58]], ['dim', 'Cdim', [48, 51, 54]],
    ['sus4', 'Csus4', [48, 53, 55]],
  ];
  for (const [quality, label, notes] of expected) {
    const chord = { root: 0, quality };
    assert.equal(chordKey(chord), `0:${quality}`);
    assert.equal(chordLabel(chord), label);
    assert.deepEqual(chordNotes(chord), notes);
  }
  assert.equal(chordLabel({ root: 1, quality: 'min' }), 'Dbm');
  assert.equal(chordLabel({ root: 10, quality: 'maj7' }), 'Bbmaj7');
  assert.deepEqual(chordNotes({ root: 11, quality: '7' }, 4), [71, 75, 78, 81]);
  assert.deepEqual(chordNotes({ root: 0, quality: 'maj' }, -1), [0, 4, 7]);
  assert.deepEqual(chordNotes({ root: 0, quality: 'maj' }, 9), [120, 124, 127]);
});

test('invalid chords and out-of-range octaves never produce ambiguous notes', () => {
  for (const chord of [null, [], 'Cm', {}, { root: '0', quality: 'maj' },
    { root: 12, quality: 'maj' }, { root: -1, quality: 'maj' },
    { root: 0.5, quality: 'maj' }, { root: 0, quality: 'toString' }]) {
    for (const helper of [chordKey, chordLabel, chordNotes]) assert.throws(() => helper(chord), TypeError);
  }
  for (const octave of [NaN, Infinity, -2, 10, 3.5, '3', null]) {
    assert.throws(() => chordNotes({ root: 0, quality: 'maj' }, octave), RangeError);
  }
  assert.throws(() => chordNotes({ root: 11, quality: 'maj7' }, 9), RangeError);
});

test('defaults and catalogs cannot be mutated; draft clones and note arrays are independent', () => {
  assert.deepEqual(ROOTS.map((root) => root.id), Array.from({ length: 12 }, (_, id) => id));
  assert.deepEqual(CHOIR_OPTIONS.map((option) => option.id), [1, 2, 3, 4]);
  assert.equal(validateConfig(DEFAULT_CONFIG).ok, true);
  assert.throws(() => DEFAULT_CONFIG.chords[0].root = 1, TypeError);
  assert.throws(() => ROOTS[0].label = 'oops', TypeError);
  assert.throws(() => QUALITIES[0].intervals.push(12), TypeError);
  const a = cloneConfig();
  const b = cloneConfig(a);
  a.chords[0].root = 1;
  a.roots.pop();
  assert.deepEqual(b, DEFAULT_CONFIG);
  assert.deepEqual(cloneConfig(), DEFAULT_CONFIG);
  const notes = chordNotes(b.chords[0]);
  notes[0] = 99;
  assert.deepEqual(chordNotes(b.chords[0]), [48, 52, 55]);
});

test('validation preserves wheel order and returns only independent known fields', () => {
  const config = {
    version: 1,
    chords: [{ root: 7, quality: '7', audio: 'private' }, { root: 0, quality: 'maj' }],
    roots: [11, 0, 7], qualities: ['sus4', 'min'], choir: [4, 1],
    deviceId: 'private', photo: 'private', audio: 'private',
  };
  const before = structuredClone(config);
  const result = validateConfig(config);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.value, {
    version: 1, chords: [{ root: 7, quality: '7' }, { root: 0, quality: 'maj' }],
    roots: [11, 0, 7], qualities: ['sus4', 'min'], choir: [4, 1],
  });
  result.value.chords[0].root = 5;
  result.value.choir.pop();
  assert.deepEqual(config, before);
});

test('each wheel rejects missing, empty, oversized, duplicate and invalid choices', () => {
  const invalidByWheel = {
    chords: [undefined, null, {}, [], Array(13).fill({ root: 0, quality: 'maj' }),
      [{ root: 0, quality: 'maj' }, { root: 0, quality: 'maj' }],
      [{ root: 0, quality: 'major' }], [{ root: 12, quality: 'maj' }], ['C']],
    roots: [undefined, null, {}, [], Array(13).fill(0), [0, 0], [-1], [12], [0.5], ['0'], [NaN]],
    qualities: [undefined, null, {}, [], Array(13).fill('maj'), ['min', 'min'], ['major'], [7]],
    choir: [undefined, null, {}, [], Array(13).fill(1), [1, 1], [0], [5], [1.5], ['1']],
  };
  for (const [wheel, cases] of Object.entries(invalidByWheel)) {
    for (const values of cases) {
      const config = cloneConfig();
      config[wheel] = values;
      const result = validateConfig(config);
      assert.equal(result.ok, false, `${wheel} ${JSON.stringify(values)}`);
      assert.equal(result.value, null);
      assert.ok(result.errors.length > 0);
    }
  }
  const max = cloneConfig();
  max.roots = ROOTS.map((root) => root.id);
  max.chords = ROOTS.map((root) => ({ root: root.id, quality: 'maj' }));
  assert.equal(validateConfig(max).ok, true);
  const min = { version: 1, chords: [{ root: 0, quality: 'maj' }], roots: [0], qualities: ['maj'], choir: [1] };
  assert.equal(validateConfig(min).ok, true);
});

test('unsupported versions and non-object configs return errors rather than partial settings', () => {
  for (const config of [undefined, null, [], 1, 'config', {},
    { ...cloneConfig(), version: 2 }, { ...cloneConfig(), version: '1' }]) {
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
    assert.ok(result.errors.length > 0);
  }
});

test('missing saved settings return fresh defaults without a warning or any write', () => {
  const storage = fakeStorage();
  const result = loadConfig(storage);
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.equal(result.notice, null);
  result.config.chords[0].root = 1;
  assert.deepEqual(loadConfig(storage).config, DEFAULT_CONFIG);
  assert.deepEqual(storage.calls, [['get', STORAGE_KEY], ['get', STORAGE_KEY]]);
});

test('corrupted JSON, versions and choices fall back without overwriting persisted evidence', () => {
  for (const raw of ['{', '', 'null', '[]', '42', JSON.stringify({ ...cloneConfig(), version: 9 }),
    JSON.stringify({ ...cloneConfig(), roots: [] }), JSON.stringify({ ...cloneConfig(), choir: [5] })]) {
    const storage = fakeStorage(raw);
    const result = loadConfig(storage);
    assert.deepEqual(result.config, DEFAULT_CONFIG);
    assert.ok(result.notice);
    assert.equal(storage.raw, raw);
    assert.deepEqual(storage.calls, [['get', STORAGE_KEY]]);
  }
});

test('saving and loading persist only wheel selections, preserving caller objects', () => {
  const storage = fakeStorage();
  const config = cloneConfig();
  config.chords[0].root = 11;
  config.audio = 'never store';
  config.chords[0].deviceId = 'never store';
  const before = structuredClone(config);
  assert.deepEqual(saveConfig(storage, config), { ok: true, error: null });
  assert.deepEqual(config, before);
  const clean = validateConfig(config).value;
  assert.deepEqual(JSON.parse(storage.raw), clean);
  assert.deepEqual(loadConfig(storage), { config: clean, notice: null });
  assert.deepEqual(storage.calls, [['set', STORAGE_KEY], ['get', STORAGE_KEY]]);
  // Old data can also contain unrelated fields; reading it must not carry them into app state.
  storage.raw = JSON.stringify(config);
  assert.deepEqual(loadConfig(storage).config, clean);
  assert.equal(storage.raw, JSON.stringify(config));
});

test('invalid save leaves previous settings intact; inaccessible/quota storage returns useful failures', () => {
  const storage = fakeStorage(JSON.stringify(cloneConfig()));
  const previous = storage.raw;
  const invalid = { ...cloneConfig(), chords: [] };
  assert.equal(saveConfig(storage, invalid).ok, false);
  assert.equal(storage.raw, previous);
  assert.deepEqual(storage.calls, []);
  for (const blocked of [undefined, null, {}, {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  }]) {
    const loaded = loadConfig(blocked);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
    assert.ok(loaded.notice);
    const saved = saveConfig(blocked, cloneConfig());
    assert.equal(saved.ok, false);
    assert.ok(saved.error);
  }
});
