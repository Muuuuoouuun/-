import test from 'node:test';
import assert from 'node:assert/strict';
import { QUALITIES, chordNotes } from '../core/chords.js';
import { VOICING_STYLES, DEFAULT_VOICING, MAX_CHORD_NOTES, Voicer, analyzeQuality, voiceChord } from '../core/voicing.js';
import {
  DEFAULT_STYLES, STYLE_STORAGE_KEY, loadStyles, saveStyles, validateStyles, nextStyle, styleInfo,
} from '../core/styles.js';

const pc = (m) => ((m % 12) + 12) % 12;
const rel = (notes, root) => new Set(notes.map((n) => pc(n - root)));

test('코드 종류의 화성 기능을 음정에서 읽는다', () => {
  assert.deepEqual(
    Object.fromEntries(QUALITIES.map((q) => [q.id, analyzeQuality(q.id).family])),
    {
      maj: 'maj', min: 'min', '7': 'dom', maj7: 'maj', m7: 'min', dim: 'dim', sus4: 'sus',
      add9: 'maj', sus2: 'sus', '7sus4': 'sus', '6': 'maj', maj9: 'maj', m9: 'min', '9': 'dom', m7b5: 'halfdim', aug: 'aug',
    },
  );
  assert.equal(analyzeQuality('add9').ninth, true);
  assert.equal(analyzeQuality('6').sixth, 9);
  assert.equal(analyzeQuality('sus2').sus, 2);
  assert.throws(() => analyzeQuality('toString'), TypeError);
});

test('모든 보이싱·코드 종류·근음이 3~6음, 패드가 웅웅거리지 않는 음역에 놓인다', () => {
  for (const style of VOICING_STYLES) {
    for (const q of QUALITIES) {
      for (let root = 0; root < 12; root++) {
        const { notes, bass } = voiceChord({ root, quality: q.id }, style.id);
        assert.ok(notes.length >= 3 && notes.length <= MAX_CHORD_NOTES, `${style.id} ${root}${q.id}: ${notes}`);
        assert.deepEqual(notes, [...notes].sort((a, b) => a - b));
        assert.equal(new Set(notes).size, notes.length);
        assert.ok(notes[0] >= 28 && notes.at(-1) <= 96, `${style.id} ${root}${q.id}: ${notes}`);
        if (bass.length) {
          assert.equal(pc(bass[0]), root, `${style.id} 베이스는 근음`);
          assert.ok(bass[0] >= 33 && bass[0] <= 45, `${style.id} 베이스 ${bass[0]}`);
        }
      }
    }
  }
});

test('기본(밀집) 첫 코드는 예전과 같은 근음 위치 · 성격마다 고유한 색깔', () => {
  for (const q of QUALITIES) {
    for (const root of [0, 5, 11]) assert.deepEqual(voiceChord({ root, quality: q.id }, 'close').notes, chordNotes({ root, quality: q.id }));
  }
  const C = { root: 0, quality: 'maj' };
  // 발라드: 낮은 C 위로 add9(D)
  const ballad = voiceChord(C, 'ballad');
  assert.equal(ballad.bass[0], 36);
  assert.ok(rel(ballad.upper, 0).has(2) && rel(ballad.upper, 0).has(4));
  // 시티팝: 메이저도 maj9 (B·D)
  assert.deepEqual([...rel(voiceChord(C, 'citypop').upper, 0)].sort((a, b) => a - b), [2, 4, 7, 11]);
  // 시티팝 G7 → 13 (3·b7·9·13), 루트리스
  const g13 = voiceChord({ root: 7, quality: '7' }, 'citypop');
  assert.deepEqual([...rel(g13.upper, 7)].sort((a, b) => a - b), [2, 4, 9, 10]);
  // 오픈: C2 G2 위에 E3 C4 G4
  assert.deepEqual(voiceChord(C, 'open').notes, [36, 43, 52, 60, 67]);
  // 파워: 3도 없음
  for (const quality of ['maj', 'min', '7']) {
    const notes = voiceChord({ root: 0, quality }, 'power').notes;
    assert.ok(!rel(notes, 0).has(3) && !rel(notes, 0).has(4), `${quality}: ${notes}`);
  }
  // 트로트: 장3화음은 6화음(A), 딸림화음은 b9(Ab)을 얹은 7화음
  assert.ok(rel(voiceChord(C, 'trot').upper, 0).has(9));
  const e7 = voiceChord({ root: 4, quality: '7' }, 'trot');
  assert.deepEqual([...rel(e7.upper, 4)].sort((a, b) => a - b), [1, 4, 7, 10]); // G# B D F
  assert.equal(e7.bass[0] % 12, 4);
  // CCM: 왼손 근음·5도, 오른손 5·1·2·3 (add2)
  const ccm = voiceChord(C, 'ccm');
  assert.deepEqual(ccm.bass, [36, 43]);
  assert.deepEqual([...rel(ccm.upper, 0)].sort((a, b) => a - b), [0, 2, 4, 7]);
  // 4도 쌓기: Dm → 소 왓(So What) 모양, 위 네 음이 4도·4도·4도·3도
  const dm = voiceChord({ root: 2, quality: 'min' }, 'quartal').upper;
  assert.deepEqual(dm.slice(1).map((n, i) => n - dm[i]), [5, 5, 4]);
});

test('부드럽게 잇기: 공통음은 그 자리에, 나머지는 가장 가까이 움직인다', () => {
  const v = new Voicer({ style: 'close' });
  const c = v.voice({ root: 0, quality: 'maj' });
  const f = v.voice({ root: 5, quality: 'maj' });
  const g = v.voice({ root: 7, quality: '7' });
  assert.deepEqual(c, [48, 52, 55]);
  assert.deepEqual(f, [48, 53, 57]); // C는 그대로, E→F, G→A
  assert.ok(f.includes(48));
  assert.ok(g.every((n) => n >= 45 && n <= 60), `${g}`);
  // 끄면 매번 근음 위치
  const plain = new Voicer({ style: 'close', smooth: false });
  plain.voice({ root: 0, quality: 'maj' });
  assert.deepEqual(plain.voice({ root: 5, quality: 'maj' }), chordNotes({ root: 5, quality: 'maj' }));
  // 오래 진행해도 오른손이 한쪽으로 흘러가지 않는다
  const walk = new Voicer({ style: 'ballad' });
  const prog = [[0, 'maj'], [9, 'min'], [5, 'maj'], [7, '7'], [4, 'm7'], [9, 'm7'], [2, 'm7'], [7, '7sus4']];
  for (let round = 0; round < 6; round++) {
    for (const [root, quality] of prog) {
      const notes = walk.voice({ root, quality });
      const upper = walk.previous.upper;
      assert.ok(upper[0] >= 52 && upper.at(-1) <= 84, `${round} ${root}${quality}: ${notes}`);
    }
  }
});

test('보이서: 성격을 바꾸거나 다시 시작하면 기본 높이에서 새로 쌓는다', () => {
  const v = new Voicer();
  assert.equal(v.style, DEFAULT_VOICING);
  v.voice({ root: 0, quality: 'maj' });
  v.voice({ root: 5, quality: 'maj' });
  v.reset();
  assert.deepEqual(v.voice({ root: 5, quality: 'maj' }), [53, 57, 60]);
  assert.equal(v.setStyle('없는 성격'), false);
  assert.equal(v.setStyle('power'), true);
  assert.equal(v.previous, null);
  assert.deepEqual(v.voice({ root: 0, quality: 'maj' }), [36, 43, 48, 55]);
  assert.equal(new Voicer({ style: 'nope' }).style, DEFAULT_VOICING);
});

function fakeStorage(raw = null, { failRead = false, failWrite = false } = {}) {
  return {
    raw,
    getItem(key) { if (failRead) throw new Error('blocked'); return key === STYLE_STORAGE_KEY ? this.raw : null; },
    setItem(key, value) { if (failWrite) throw new Error('full'); if (key === STYLE_STORAGE_KEY) this.raw = value; },
  };
}

test('화음 성격 저장: 알맞은 값만 저장하고, 깨진 값·막힌 저장소는 기본값으로', () => {
  assert.deepEqual(validateStyles(null), DEFAULT_STYLES);
  assert.deepEqual(validateStyles({ choir: 'ballad', voicing: 'citypop', smooth: false, extra: 1 }),
    { choir: 'ballad', voicing: 'citypop', smooth: false, swipe: true });
  assert.deepEqual(validateStyles({ choir: 'x', voicing: 'ballad', smooth: 'yes', swipe: 'no' }),
    { choir: DEFAULT_STYLES.choir, voicing: 'ballad', smooth: true, swipe: true });
  assert.equal(validateStyles({ swipe: false }).swipe, false, '손으로 넘기기는 끌 수 있다');
  const storage = fakeStorage();
  assert.deepEqual(loadStyles(storage).styles, DEFAULT_STYLES);
  assert.equal(saveStyles(storage, { choir: 'drone', voicing: 'open', smooth: false, secret: 'x' }).ok, true);
  assert.deepEqual(JSON.parse(storage.raw), { choir: 'drone', voicing: 'open', smooth: false, swipe: true });
  assert.deepEqual(loadStyles(storage).styles, { choir: 'drone', voicing: 'open', smooth: false, swipe: true });
  // 손으로 넘기기가 생기기 전에 저장한 값도 그대로 읽는다
  assert.deepEqual(loadStyles(fakeStorage('{"choir":"trot","voicing":"ccm","smooth":true}')).styles,
    { choir: 'trot', voicing: 'ccm', smooth: true, swipe: true });
  assert.deepEqual(loadStyles(fakeStorage('{나쁜 json')).styles, DEFAULT_STYLES);
  assert.deepEqual(loadStyles(fakeStorage(null, { failRead: true })).styles, DEFAULT_STYLES);
  assert.equal(saveStyles(fakeStorage(null, { failWrite: true }), DEFAULT_STYLES).ok, false);
  assert.equal(nextStyle('choir', 'classic'), 'ballad');
  assert.equal(nextStyle('voicing', VOICING_STYLES.at(-1).id), VOICING_STYLES[0].id);
  assert.equal(styleInfo('voicing', 'nope').id, VOICING_STYLES[0].id);
});
