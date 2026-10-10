// 코드 악기 보이싱: 같은 코드라도 어떤 음을 어느 높이에 얼마나 넓게 놓을지가 '성격'을 만든다.
// 장치·DOM·저장소에 닿지 않는 순수 계산이라 테스트와 화면이 같은 결과를 쓴다.
import { QUALITIES } from './chords.js';

export const VOICING_STYLES = Object.freeze([
  { id: 'close', label: '기본 (밀집)', short: '기본', desc: '근음 위에 3화음·7화음을 촘촘히. 가장 또렷한 기본 소리.' },
  { id: 'ballad', label: '가요 발라드', short: '발라드', desc: '낮은 근음 위로 add9을 펼쳐 맑고 따뜻하게. 발라드 피아노 느낌.' },
  { id: 'citypop', label: '시티팝·R&B', short: '텐션', desc: '7·9·11·13 텐션을 얹어 세련되게. 근음은 아래, 위는 루트리스.' },
  { id: 'open', label: '오픈 (웅장)', short: '오픈', desc: '근음·5도를 아래에 넓게, 3도는 위로. 오케스트라·워십 패드 느낌.' },
  { id: 'power', label: '파워 코드', short: '파워', desc: '3도 없이 근음·5도·옥타브. 락 기타처럼 비고 단단하게.' },
  { id: 'quartal', label: '4도 쌓기', short: '4도', desc: '4도로 쌓아 몽환적이고 모던하게. 네오소울·OST 느낌.' },
].map(Object.freeze));

export const DEFAULT_VOICING = 'close';
export const MAX_CHORD_NOTES = 6;
const STYLE_IDS = new Set(VOICING_STYLES.map((style) => style.id));
export const isVoicingStyle = (id) => STYLE_IDS.has(id);
const INTERVALS = new Map(QUALITIES.map((quality) => [quality.id, quality.intervals]));

/** 코드 종류의 화성 기능: 3도·5도·7도·9도가 무엇인지와 계열(장·단·속·서스…). */
export function analyzeQuality(quality) {
  const intervals = INTERVALS.get(quality);
  if (!intervals) throw new TypeError('코드의 근음과 종류를 선택해 주세요.');
  const pcs = new Set(intervals.map((i) => i % 12));
  const third = pcs.has(4) ? 4 : pcs.has(3) ? 3 : null;
  const fifth = pcs.has(8) ? 8 : pcs.has(6) && third === 3 ? 6 : 7;
  const seventh = pcs.has(10) ? 10 : pcs.has(11) ? 11 : null;
  const sixth = pcs.has(9) && fifth !== 6 ? 9 : null;
  const ninth = intervals.some((i) => i > 12 && i % 12 === 2);
  const sus = third == null ? (pcs.has(5) ? 5 : pcs.has(2) ? 2 : null) : null;
  let family;
  if (third == null) family = 'sus';
  else if (fifth === 8) family = 'aug';
  else if (third === 3 && fifth === 6) family = seventh === 10 ? 'halfdim' : 'dim';
  else if (third === 3) family = 'min';
  else if (seventh === 10) family = 'dom';
  else family = 'maj';
  return { intervals, third, fifth, seventh, sixth, ninth, sus, family };
}

// 근음(옥타브 3, C3 = 48) 기준 반음 간격. bass = 왼손(아래), upper = 오른손(위).
//   invert: 오른손을 자리바꿈해 앞 코드와 가깝게 이을 수 있는지 (펼친 모양을 지켜야 하는 성격은 false)
//   tied: 베이스와 오른손이 한 덩어리로 옥타브만 옮기는지 (오픈·파워)
//   center: 오른손 평균 높이 목표 (MIDI), bassCenter: 맨 아래 음 목표, minUpper: 오른손 맨 아래 한계
//   (E3 아래에서 3도·4도를 쌓으면 소리가 뭉개진다 — 낮은 음정 한계)
const SHAPES = {
  close(q) {
    return { bass: [], upper: [...q.intervals], invert: true, center: 55 };
  },
  ballad(q) {
    const upper = {
      maj: q.seventh ? [4, 7, 11, 14] : q.sixth ? [4, 7, 9, 14] : [4, 7, 12, 14],
      min: q.seventh ? [3, 7, 10, 14] : [3, 7, 12, 14],
      dom: [4, 7, 10, 14],
      sus: q.sus === 2 ? [2, 7, 12] : q.seventh ? [5, 7, 10, 14] : [5, 7, 12, 14],
      halfdim: [3, 6, 10, 12],
      dim: [3, 6, 12],
      aug: [4, 8, 12],
    }[q.family];
    return { bass: [-12], upper, invert: true, center: 65, bassCenter: 40, minUpper: 52 };
  },
  citypop(q) {
    const upper = {
      maj: q.sixth && !q.seventh ? [4, 9, 14, 19] : [4, 7, 11, 14],
      min: [3, 7, 10, 14],
      dom: [4, 10, 14, 21],
      sus: q.sus === 2 ? [2, 7, 11] : [5, 10, 14, 19],
      halfdim: [3, 6, 10, 14],
      dim: [3, 6, 9, 14],
      aug: [4, 8, 10, 14],
    }[q.family];
    return { bass: [-12], upper, invert: true, center: 64, bassCenter: 40, minUpper: 52 };
  },
  open(q) {
    const third = q.third ?? q.sus;
    const upper = [third, q.seventh ?? q.sixth ?? 12, q.fifth + 12];
    if (q.ninth || (q.sus === 2)) upper.push(14);
    return { bass: [-12, q.fifth - 12], upper: [...new Set(upper)], tied: true, center: 60, bassCenter: 40 };
  },
  power(q) {
    return { bass: [-12, q.fifth - 12], upper: [0, q.fifth], tied: true, center: 52, bassCenter: 40 };
  },
  quartal(q) {
    const upper = {
      maj: q.seventh ? [11, 16, 21, 26] : [4, 9, 14, 19],
      min: [5, 10, 15, 19],
      dom: [10, 16, 21, 26],
      sus: q.sus === 2 ? [2, 7, 12, 17] : [7, 12, 17, 22],
      halfdim: [3, 10, 18],
      dim: [3, 6, 9],
      aug: [4, 8, 14],
    }[q.family];
    return { bass: [-12], upper, invert: false, center: 64, bassCenter: 40, minUpper: 52 };
  },
};

const LOW = 28;
const HIGH = 96;
// 베이스 근음은 A1~A2 한 옥타브 안에서만: 진행이 이어져도 아래로 계속 내려가 웅웅거리지 않게.
// (근음이 A일 때만 두 자리가 있어 앞 베이스와 가까운 쪽을 고른다)
const inBassRange = (note, shape) => note >= shape.bassCenter - 7 && note <= shape.bassCenter + 5;
const mean = (notes) => notes.reduce((sum, n) => sum + n, 0) / notes.length;

// 두 화음 사이의 움직임: 각 음이 가장 가까운 앞 음까지 움직인 거리(양쪽). 공통음은 0.
function movement(next, prev) {
  if (!prev?.length) return 0;
  let cost = 0;
  for (const n of next) cost += Math.min(...prev.map((p) => Math.abs(n - p)));
  for (const p of prev) cost += Math.min(...next.map((n) => Math.abs(n - p)));
  return cost;
}

// 자리바꿈: 맨 아래 음을 한 옥타브 위로 올리는 것을 되풀이 (모양을 지키며 높이만 바뀐다)
function rotations(upper) {
  const out = [];
  let cur = [...upper].sort((a, b) => a - b);
  for (let i = 0; i < cur.length; i++) {
    out.push(cur);
    cur = [...cur.slice(1), cur[0] + 12].sort((a, b) => a - b);
  }
  return out;
}

function best(candidates, cost) {
  let pick = null;
  let score = Infinity;
  for (const candidate of candidates) {
    const s = cost(candidate);
    if (s < score - 1e-9) { pick = candidate; score = s; }
  }
  return pick;
}

/**
 * 코드 하나를 성격대로 쌓은 MIDI 음 (오름차순, 3~6개).
 * previous: 앞 코드의 { bass, upper } — 주면 오른손은 공통음을 지키고 가장 가깝게 움직이는 자리바꿈을,
 * 베이스는 가장 가까운 옥타브를 고른다(성부 진행). 없으면 성격의 기본 높이에 놓는다.
 */
export function voiceChord(chord, style = DEFAULT_VOICING, previous = null) {
  const q = analyzeQuality(chord?.quality);
  if (!Number.isInteger(chord.root) || chord.root < 0 || chord.root > 11) throw new TypeError('코드의 근음과 종류를 선택해 주세요.');
  const shape = (SHAPES[style] || SHAPES[DEFAULT_VOICING])(q);
  const root = 48 + chord.root;
  const prev = previous && previous.style === style ? previous : null;

  if (shape.tied) {
    const all = [...shape.bass, ...shape.upper].map((i) => root + i).sort((a, b) => a - b);
    const shifts = [-24, -12, 0, 12].map((k) => all.map((n) => n + k)).filter((v) => inBassRange(v[0], shape));
    const pick = best(shifts, (v) => (prev ? movement(v, [...prev.bass, ...prev.upper]) : 0) + Math.abs(v[0] - shape.bassCenter));
    const nb = shape.bass.length;
    return finish(pick.slice(0, nb), pick.slice(nb), style);
  }

  // 왼손: 근음을 앞 베이스와 가까운 옥타브에 (기본 E2 근처)
  let bass = [];
  if (shape.bass.length) {
    const options = [-24, -12, 0, 12].map((k) => shape.bass.map((i) => root + i + k)).filter((v) => inBassRange(v[0], shape));
    bass = best(options, (v) => (prev?.bass.length ? Math.abs(v[0] - prev.bass[0]) : 0) + 0.3 * Math.abs(v[0] - shape.bassCenter));
  }

  // 오른손: 자리바꿈·옥타브 후보 중 앞 코드와 가장 매끄럽게 이어지는 것
  if (style === 'close' && !prev) return finish([], [...q.intervals].map((i) => root + i), style); // 기존 소리 그대로
  const shapes = shape.invert ? rotations(shape.upper) : [[...shape.upper].sort((a, b) => a - b)];
  const floor = bass.length ? bass.at(-1) + 3 : LOW;
  const candidates = [];
  for (const s of shapes) {
    for (const k of [-24, -12, 0, 12, 24]) {
      const v = s.map((i) => root + i + k);
      if (v[0] >= floor && v[0] >= (shape.minUpper ?? 40) && v.at(-1) <= HIGH - 4) candidates.push(v);
    }
  }
  const upper = best(candidates, (v) => (prev ? movement(v, prev.upper) + 0.25 * Math.abs(mean(v) - shape.center)
    : Math.abs(mean(v) - shape.center)));
  return finish(bass, upper, style);
}

function finish(bass, upper, style) {
  const notes = [...new Set([...bass, ...upper])].sort((a, b) => a - b).slice(0, MAX_CHORD_NOTES);
  return { notes, bass: [...bass], upper: [...upper], style };
}

/** 앞 코드를 기억해 성부 진행을 이어 가는 보이서. smooth=false 면 매번 기본 높이. */
export class Voicer {
  constructor({ style = DEFAULT_VOICING, smooth = true } = {}) {
    this.style = isVoicingStyle(style) ? style : DEFAULT_VOICING;
    this.smooth = smooth !== false;
    this.previous = null;
  }

  setStyle(style) {
    if (!isVoicingStyle(style) || style === this.style) return false;
    this.style = style;
    this.previous = null;
    return true;
  }

  setSmooth(smooth) {
    this.smooth = !!smooth;
    if (!this.smooth) this.previous = null;
  }

  /** 새로 시작: 전체 정지·모드 변경 뒤에는 기본 높이에서 다시 시작한다. */
  reset() { this.previous = null; }

  voice(chord) {
    const result = voiceChord(chord, this.style, this.smooth ? this.previous : null);
    this.previous = result;
    return result.notes;
  }
}
