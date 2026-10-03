/* 코드 그림: 기타 운지표(코드 다이어그램)와 건반 그림 — 외부 라이브러리 없이 SVG 로 그린다 */
"use strict";

const ChordGfx = (() => {
  const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const INTERVALS = {
    "": [0, 4, 7], m: [0, 3, 7], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
    sus4: [0, 5, 7], sus2: [0, 2, 7], dim: [0, 3, 6], "6": [0, 4, 7, 9], m6: [0, 3, 7, 9],
    "9": [0, 4, 7, 10, 2], add9: [0, 4, 7, 2], aug: [0, 4, 8], "7sus4": [0, 5, 7, 10],
    m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], m9: [0, 3, 7, 10, 2], maj9: [0, 4, 7, 11, 2],
  };
  // 개방현 코드 (6번줄 -> 1번줄, -1 = 치지 않음)
  const OPEN = {
    C: [-1, 3, 2, 0, 1, 0], A: [-1, 0, 2, 2, 2, 0], G: [3, 2, 0, 0, 0, 3], E: [0, 2, 2, 1, 0, 0],
    D: [-1, -1, 0, 2, 3, 2], Am: [-1, 0, 2, 2, 1, 0], Em: [0, 2, 2, 0, 0, 0], Dm: [-1, -1, 0, 2, 3, 1],
    C7: [-1, 3, 2, 3, 1, 0], A7: [-1, 0, 2, 0, 2, 0], G7: [3, 2, 0, 0, 0, 1], E7: [0, 2, 0, 1, 0, 0],
    D7: [-1, -1, 0, 2, 1, 2], B7: [-1, 2, 1, 2, 0, 2], Cmaj7: [-1, 3, 2, 0, 0, 0],
    Amaj7: [-1, 0, 2, 1, 2, 0], Dmaj7: [-1, -1, 0, 2, 2, 2], Gmaj7: [3, 2, 0, 0, 0, 2],
    Fmaj7: [-1, -1, 3, 2, 1, 0], Am7: [-1, 0, 2, 0, 1, 0], Em7: [0, 2, 0, 0, 0, 0],
    Dm7: [-1, -1, 0, 2, 1, 1], Asus4: [-1, 0, 2, 2, 3, 0], Dsus4: [-1, -1, 0, 2, 3, 3],
    Esus4: [0, 2, 2, 2, 0, 0], Asus2: [-1, 0, 2, 2, 0, 0], Dsus2: [-1, -1, 0, 2, 3, 0],
    Cadd9: [-1, 3, 2, 0, 3, 0], Gsus4: [3, 3, 0, 0, 1, 3], A6: [-1, 0, 2, 2, 2, 2],
  };
  // 옮겨 잡는(바레) 모양: 근음 줄 기준 상대 프렛
  const E_SHAPES = {
    "": [0, 2, 2, 1, 0, 0], m: [0, 2, 2, 0, 0, 0], "7": [0, 2, 0, 1, 0, 0], maj7: [0, -1, 1, 1, 0, -1],
    m7: [0, 2, 0, 0, 0, 0], sus4: [0, 2, 2, 2, 0, 0], "7sus4": [0, 2, 0, 2, 0, 0], "6": [0, -1, 2, 1, 2, -1],
    m6: [0, -1, 1, 2, 0, -1], "9": [0, -1, 0, 1, 0, 2], dim7: [0, -1, 1, 2, 1, -1], aug: [0, -1, 2, 1, 1, -1],
  };
  const A_SHAPES = {
    "": [-1, 0, 2, 2, 2, 0], m: [-1, 0, 2, 2, 1, 0], "7": [-1, 0, 2, 0, 2, 0], maj7: [-1, 0, 2, 1, 2, 0],
    m7: [-1, 0, 2, 0, 1, 0], sus4: [-1, 0, 2, 2, 3, 0], sus2: [-1, 0, 2, 2, 0, 0], dim: [-1, 0, 1, 2, 1, -1],
    m7b5: [-1, 0, 1, 0, 1, -1], add9: [-1, 0, 2, 4, 2, 0], "6": [-1, 0, 2, 2, 2, 2], m6: [-1, 0, 2, -1, 1, 2],
    "9": [-1, 0, -1, 0, 0, 0], m9: [-1, 0, -2, 0, 0, 0], maj9: [-1, 0, -1, 1, 0, -1], "7sus4": [-1, 0, 2, 0, 3, 0],
    aug: [-1, 0, 3, 2, 2, -1], dim7: [-1, 0, 1, -1, 1, -1],
  };

  function name(root, quality) {
    return NAMES[((root % 12) + 12) % 12] + (quality || "");
  }

  function tones(root, quality) {
    return (INTERVALS[quality] || INTERVALS[""]).map((i) => (root + i) % 12);
  }

  /** 기타 운지: [6번줄..1번줄] 프렛 배열 (-1 = 치지 않음) */
  function guitar(root, quality) {
    const key = name(root, quality);
    if (OPEN[key]) return OPEN[key];
    const cands = [];
    const eRoot = ((root - 4) % 12 + 12) % 12; // 6번줄(E) 기준 근음 프렛
    const aRoot = ((root - 9) % 12 + 12) % 12; // 5번줄(A) 기준
    for (const [shapes, base] of [[E_SHAPES, eRoot], [A_SHAPES, aRoot]]) {
      const shape = shapes[quality];
      if (!shape) continue;
      for (const b of [base, base + 12]) {
        if (b < 1 || b > 12) continue;
        const frets = shape.map((x) => (x === -1 ? -1 : b + x)); // -1 = 치지 않는 줄
        if (frets.some((f) => f !== -1 && f < 0)) continue;
        cands.push(frets);
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => Math.max(...a) - Math.max(...b));
    return cands[0];
  }

  /** 기타 운지표 SVG */
  function guitarSVG(frets, opts = {}) {
    const w = opts.width || 110, h = opts.height || 130;
    if (!frets) return `<svg width="${w}" height="${h}"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-size="12" fill="currentColor">운지 없음</text></svg>`;
    const played = frets.filter((f) => f > 0);
    const minF = played.length ? Math.min(...played) : 1;
    const maxF = played.length ? Math.max(...played) : 1;
    const start = maxF <= 4 ? 1 : minF;
    const x0 = 18, y0 = 22, sw = (w - 30) / 5, fh = (h - 34) / 5;
    let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="gdiag">`;
    // 너트 / 프렛선
    s += `<line x1="${x0}" y1="${y0}" x2="${x0 + 5 * sw}" y2="${y0}" stroke="currentColor" stroke-width="${start === 1 ? 4 : 1}"/>`;
    for (let i = 1; i <= 5; i++) s += `<line x1="${x0}" y1="${y0 + i * fh}" x2="${x0 + 5 * sw}" y2="${y0 + i * fh}" stroke="currentColor" stroke-width="1" opacity=".6"/>`;
    for (let i = 0; i < 6; i++) s += `<line x1="${x0 + i * sw}" y1="${y0}" x2="${x0 + i * sw}" y2="${y0 + 5 * fh}" stroke="currentColor" stroke-width="1"/>`;
    if (start > 1) s += `<text x="${x0 - 5}" y="${y0 + fh * 0.7}" text-anchor="end" font-size="11" fill="currentColor">${start}</text>`;
    // 바레: 같은 최저 프렛이 여러 줄에 있고 그 사이 줄이 모두 그 이상이면
    const low = played.length ? minF : 0;
    const lowIdx = frets.map((f, i) => (f === low ? i : -1)).filter((i) => i >= 0);
    if (low > 0 && lowIdx.length >= 3 && start > 1) {
      const a = Math.min(...lowIdx), b = Math.max(...lowIdx);
      const y = y0 + (low - start + 0.5) * fh;
      s += `<rect x="${x0 + a * sw - 5}" y="${y - 5}" width="${(b - a) * sw + 10}" height="10" rx="5" fill="currentColor"/>`;
    }
    frets.forEach((f, i) => {
      const x = x0 + i * sw;
      if (f < 0) s += `<text x="${x}" y="${y0 - 6}" text-anchor="middle" font-size="11" fill="currentColor">×</text>`;
      else if (f === 0) s += `<circle cx="${x}" cy="${y0 - 10}" r="4" fill="none" stroke="currentColor"/>`;
      else s += `<circle cx="${x}" cy="${y0 + (f - start + 0.5) * fh}" r="${Math.min(sw, fh) * 0.32}" fill="currentColor"/>`;
    });
    return s + "</svg>";
  }

  /** 건반 그림 SVG (2옥타브, 코드 구성음 표시, 베이스 음은 다른 색) */
  function pianoSVG(chordTones, bassPc, opts = {}) {
    const w = opts.width || 240, h = opts.height || 80;
    const whites = [0, 2, 4, 5, 7, 9, 11];
    const blacks = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
    const ww = w / 14;
    const set = new Set(chordTones);
    let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="pdiag">`;
    for (let o = 0; o < 2; o++) {
      whites.forEach((pc, i) => {
        const on = o === 0 ? pc === bassPc : set.has(pc);
        const cls = on ? (o === 0 ? "kb-bass" : "kb-on") : "kb-w";
        s += `<rect x="${(o * 7 + i) * ww}" y="0" width="${ww - 1}" height="${h}" class="${cls}" rx="2"/>`;
      });
    }
    for (let o = 0; o < 2; o++) {
      for (const [pc, after] of Object.entries(blacks)) {
        const p = Number(pc);
        const on = o === 0 ? p === bassPc : set.has(p);
        const cls = on ? (o === 0 ? "kb-bass" : "kb-on") : "kb-b";
        s += `<rect x="${(o * 7 + after + 0.65) * ww}" y="0" width="${ww * 0.7}" height="${h * 0.6}" class="${cls}" rx="2"/>`;
      }
    }
    return s + "</svg>";
  }

  return { name, tones, guitar, guitarSVG, pianoSVG, NAMES, INTERVALS };
})();
