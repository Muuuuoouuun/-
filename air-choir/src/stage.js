// 카메라 위에 그리는 무대: 손 뼈대, 손가락 개수 링, 합창단 오브, 음량·밝기 게이지
import { HAND_CONNECTIONS, FINGER_TIPS } from './gestures.js';
import { midiName } from '../core/dsp.js';

// object-fit: cover로 보이는 영상 위의 좌표 (화면은 거울처럼 좌우 반전)
export function coverMapper(W, H, vw, vh) {
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;
  return { map: (x, y) => [W - (ox + x * dw), oy + y * dh], unit: Math.max(dw, dh) };
}

const glow = new Float32Array(4);

export function drawStage(g, W, H, { mapper, gesture, stats, theme }) {
  g.clearRect(0, 0, W, H);
  const { colors, fonts } = theme;
  const s = gesture;

  drawMeters(g, W, H, s, colors, fonts);
  if (!s.present || !s.hand) return;

  const hand = s.hand;
  const [px, py] = mapper.map(hand.palm.x, hand.palm.y);
  const palmPx = Math.max(28, hand.size * mapper.unit);

  // 손 뼈대
  if (hand.landmarks) {
    const pts = hand.landmarks.map((p) => mapper.map(p.x ?? p[0], p.y ?? p[1]));
    g.lineWidth = 2;
    g.strokeStyle = colors.skeleton;
    g.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      g.moveTo(...pts[a]);
      g.lineTo(...pts[b]);
    }
    g.stroke();
    // 편 손가락 끝은 성부 색으로 (검지=성부1 … 새끼=성부4, 엄지는 흰색)
    FINGER_TIPS.forEach((tip, f) => {
      const on = hand.extended?.[f];
      g.beginPath();
      g.arc(...pts[tip], on ? 7 : 4, 0, Math.PI * 2);
      g.fillStyle = on ? (f === 0 ? colors.voice : colors.voices[f - 1]) : colors.skeleton;
      g.fill();
    });
  }

  // 손바닥 링 + 손가락 개수
  const short = Math.min(W, H);
  const ringR = Math.min(palmPx * 0.75, short * 0.13);
  g.lineWidth = 3;
  g.strokeStyle = s.fist ? colors.bad : colors.voice;
  g.beginPath();
  g.arc(px, py, ringR, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = s.fist ? colors.bad : colors.voice;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${Math.round(Math.max(26, ringR * 0.9))}px ${fonts.display}`;
  g.fillText(s.fist ? '정지' : String(s.fingers), px, py + 2);

  // 합창단 오브: 손 위쪽 반원에 성부마다 하나씩
  const targets = s.fist ? [] : stats?.targets || [];
  const voiced = !!stats?.voiced && !s.fist;
  const n = Math.max(targets.length, s.fist ? 0 : s.preset);
  const radius = Math.min(palmPx * 2.1 + 24, short * 0.32);
  for (let v = 0; v < 4; v++) {
    glow[v] += ((v < n && voiced ? 1 : 0) - glow[v]) * 0.2;
    if (v >= n) continue;
    const ang = n === 1 ? -Math.PI / 2 : -Math.PI * (0.85 - (0.7 * v) / (n - 1));
    // 화면 밖으로 나가지 않게 (오른쪽은 음량 게이지 자리를 비운다)
    const ox = Math.max(30, Math.min(W - 70, px + Math.cos(ang) * radius));
    const oy = Math.max(30, Math.min(H - 60, py + Math.sin(ang) * radius));
    const r = 15 + 9 * glow[v] * (0.4 + s.level);
    g.save();
    g.shadowColor = colors.voices[v];
    g.shadowBlur = 24 * glow[v];
    g.globalAlpha = 0.35 + 0.65 * glow[v];
    g.fillStyle = colors.voices[v];
    g.beginPath();
    g.arc(ox, oy, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
    if (targets[v] != null) {
      g.fillStyle = colors.ink;
      g.font = `600 13px ${fonts.data}`;
      g.fillText(midiName(targets[v]), ox, oy + 1);
    }
  }
  g.textAlign = 'start';
}

function drawMeters(g, W, H, s, colors, fonts) {
  const on = s.present && !s.fist;
  // 오른쪽: 합창단 음량 (손 높이)
  const x = W - 30;
  const top = H * 0.14;
  const bottom = H * 0.8;
  g.fillStyle = colors.track;
  roundRect(g, x - 5, top, 10, bottom - top, 5);
  g.fill();
  const lv = on ? s.level : 0;
  const yLevel = bottom - (bottom - top) * lv;
  g.fillStyle = colors.voices[0];
  roundRect(g, x - 5, yLevel, 10, bottom - yLevel, 5);
  g.fill();
  g.fillStyle = colors.label;
  g.font = `12px ${fonts.body}`;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillText('합창단 음량', x + 8, top - 16);
  g.font = `500 13px ${fonts.data}`;
  g.fillText(on ? `${Math.round(lv * 100)}%` : s.fist ? '정지' : '—', x - 12, yLevel);

  // 아래: 밝기 (손 좌우)
  const bw = Math.min(360, W * 0.5);
  const bx = (W - bw) / 2;
  const by = H - 34;
  const grad = g.createLinearGradient(bx, 0, bx + bw, 0);
  grad.addColorStop(0, colors.dark);
  grad.addColorStop(1, colors.bright);
  g.fillStyle = grad;
  roundRect(g, bx, by, bw, 8, 4);
  g.fill();
  if (s.present) {
    const mx = bx + bw * s.brightness;
    g.fillStyle = colors.voice;
    g.beginPath();
    g.arc(mx, by + 4, 8, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = colors.label;
  g.font = `12px ${fonts.body}`;
  g.textAlign = 'right';
  g.fillText('어둡게 · 울림', bx - 10, by + 4);
  g.textAlign = 'left';
  g.fillText('밝게 · 선명', bx + bw + 10, by + 4);
  g.textAlign = 'start';
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
  else g.rect(x, y, w, h);
}
