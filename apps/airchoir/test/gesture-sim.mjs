// 잡음 섞인 실제 손 랜드마크 재생 (test/gesture-sensitivity.test.mjs 와 감도 조정용)
import { readFileSync } from 'node:fs';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/hands.json', import.meta.url)));

export function rng(seed) {
  let s = seed >>> 0 || 1;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const g = () => { const a = u() || 1e-9, b = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); };
  return { u, g };
}

function curl(landmarks, fingerIndexes, amount = 1) {
  const p = landmarks.map((q) => [...q]);
  const joints = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  for (const f of fingerIndexes) {
    const [mcp, pip, dip, tip] = joints[f];
    const toWrist = p[0].map((v, k) => v - p[mcp][k]);
    const back = p[pip].map((v, k) => v - p[mcp][k]);
    const dipC = p[pip].map((v, k) => v - back[k] * 0.6);
    const tipC = p[mcp].map((v, k) => v + toWrist[k] * 0.15);
    p[dip] = p[dip].map((v, k) => v + (dipC[k] - v) * amount);
    p[tip] = p[tip].map((v, k) => v + (tipC[k] - v) * amount);
  }
  return p;
}
const F = fixtures.open_two_hands;
export const ASPECT = F.width / F.height;
const OPEN = F.hands[1].landmarks;
export const POSES = {
  5: OPEN, 3: curl(OPEN, [3]), 2: curl(OPEN, [2, 3]), 1: curl(OPEN, [1, 2, 3]), 0: curl(OPEN, [0, 1, 2, 3]),
};
export const partial = (amount) => curl(OPEN, [3], amount); // 새끼손가락을 반쯤 접은 애매한 손

const palmCenter = (lm) => [0, 5, 9, 13, 17].reduce((a, i) => [a[0] + lm[i][0] / 5, a[1] + lm[i][1] / 5], [0, 0]);
export function place(lm, x, y) {
  const [cx, cy] = palmCenter(lm);
  return lm.map((p) => [p[0] - cx + x, p[1] - cy + y, p[2]]);
}

// MediaPipe 다운 잡음: 점마다 σ, 손 전체 흔들림, 가끔 크게 튐, 가끔 손 놓침
export const NOISE = { point: 0.004, global: 0.002, outlier: 0.03, outlierSigma: 0.015, drop: 0.02 };
export function noisy(lm, r, n = NOISE) {
  if (r.u() < n.drop) return null;
  const big = r.u() < n.outlier;
  const gx = r.g() * n.global, gy = r.g() * n.global;
  const s = big ? n.outlierSigma : n.point;
  return lm.map((p) => [p[0] + gx + r.g() * s, p[1] + gy + r.g() * s, p[2] + r.g() * s]);
}
