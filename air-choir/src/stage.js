// 카메라 위에 그리는 무대: 손 뼈대, 손가락 개수 링, 합창단 오브, 음량·밝기 게이지, 루프 오브
import { HAND_CONNECTIONS, FINGER_TIPS } from './gestures.js';
import { MUTE_DWELL, orbRadius } from './orbs.js';
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

export function drawStage(g, W, H, { mapper, gesture, stats, theme, loops }) {
  g.clearRect(0, 0, W, H);
  const { colors, fonts } = theme;
  const s = gesture;

  drawMeters(g, W, H, s, colors, fonts);
  if (loops) drawLoops(g, W, H, loops, colors, fonts);
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

  // 합창단 오브: 손 위쪽 반원에 성부마다 하나씩 (루프 오브를 들고 있거나 녹음 중일 때는 숨김)
  if (loops && loops.station.mode !== 'idle') {
    g.textAlign = 'start';
    return;
  }
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

// ───────────── 루프 오브 ─────────────

// 녹음한 음의 높이로 색을 정한다: 낮으면 파랑, 높으면 주황·분홍
export function orbColor(midi, alpha = 1) {
  if (midi == null) return `hsl(250 25% 72% / ${alpha})`;
  const t = Math.max(0, Math.min(1, (midi - 45) / 36));
  return `hsl(${Math.round(225 - t * 215)} 85% 66% / ${alpha})`;
}

function drawLoops(g, W, H, { station, transport, now, pinchAt }, colors, fonts) {
  const beat = transport.position(now);
  const pulse = 1 + 0.07 * Math.pow(1 - beat.frac, 3);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  for (const o of station.orbs) {
    const x = o.x * W;
    const y = o.y * H;
    const playing = o.state === 'placed' && o.ready && !o.muted;
    const r = o.r * H * (playing ? pulse : 1);
    g.save();
    g.globalAlpha = o.muted ? 0.4 : 1;
    if (playing) {
      g.shadowColor = orbColor(o.midi);
      g.shadowBlur = 28;
    }
    const grad = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.08, x, y, r);
    grad.addColorStop(0, orbColor(o.midi, 1));
    grad.addColorStop(0.55, orbColor(o.midi, 0.75));
    grad.addColorStop(1, orbColor(o.midi, 0.12));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // 루프 진행 위치 (12시부터 시계 방향)
    g.lineWidth = 2.5;
    if (o.ready && o.state === 'placed') {
      const p = ((((now - o.begin) % o.len) + o.len) % o.len) / o.len;
      g.strokeStyle = o.muted ? colors.muted : colors.voice;
      g.beginPath();
      g.arc(x, y, r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      g.stroke();
    } else if (!o.ready) {
      g.setLineDash([4, 5]);
      g.strokeStyle = colors.voice;
      g.beginPath();
      g.arc(x, y, r + 6, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    g.fillStyle = colors.ink;
    g.font = `600 13px ${fonts.data}`;
    g.fillText(o.muted ? '음소거' : `${o.bars}마디`, x, y + 1);
    if (o.state === 'held') {
      g.fillStyle = colors.label;
      g.font = `500 14px ${fonts.body}`;
      g.fillText('휙 던지기', x, y - r - 16);
    }
    if (station.drag?.orb === o) {
      g.fillStyle = colors.label;
      g.font = `12px ${fonts.data}`;
      const side = o.x < 0.45 ? '왼쪽' : o.x > 0.55 ? '오른쪽' : '가운데';
      g.fillText(`${side} · 음량 ${Math.round(Math.max(0, Math.min(1, (0.9 - o.y) / 0.8)) * 100)}%`, x, y + r + 18);
    }
  }

  // 편 손을 대고 있는 동안 음소거 진행
  const d = station.dwell;
  if (d && !d.done) {
    const p = Math.min(1, (now - d.since) / MUTE_DWELL);
    g.lineWidth = 4;
    g.strokeStyle = colors.bad;
    g.beginPath();
    g.arc(d.orb.x * W, d.orb.y * H, d.orb.r * H + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
    g.stroke();
  }

  // 터지는 오브
  for (const p of station.pops) {
    const k = (now - p.t) / 0.5;
    g.lineWidth = 3;
    g.strokeStyle = orbColor(p.midi, Math.max(0, 1 - k));
    g.beginPath();
    g.arc(p.x * W, p.y * H, p.r * H * (1 + 1.6 * k), 0, Math.PI * 2);
    g.stroke();
  }

  // 녹음 표시: 핀치한 자리에
  const mode = station.mode;
  if (mode === 'countin' || mode === 'recording' || mode === 'finishing') {
    const at = pinchAt || station.lastPoint;
    const x = at.x * W;
    const y = at.y * H;
    const rec = station.rec;
    if (mode === 'countin') {
      const left = Math.max(1, Math.ceil((rec.begin - now) / transport.beat - 1e-6));
      g.lineWidth = 3;
      g.strokeStyle = colors.voice;
      g.beginPath();
      g.arc(x, y, 30, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = colors.voice;
      g.font = `400 34px ${fonts.display}`;
      g.fillText(String(left), x, y + 2);
      g.font = `500 13px ${fonts.body}`;
      g.fillText('다음 마디부터 녹음', x, y - 46);
    } else {
      const bars = Math.max(1, Math.ceil((now - rec.begin) / transport.bar));
      const r = orbRadius(Math.min(4, bars)) * H * (0.7 + 0.3 * pulse);
      g.fillStyle = 'rgba(255, 112, 112, 0.22)';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = colors.bad;
      g.beginPath();
      g.arc(x, y, 7 + 3 * (pulse - 1) * 14, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = colors.label;
      g.font = `500 13px ${fonts.body}`;
      const label = mode === 'recording' ? `녹음 중 · ${bars}마디째` : '마디 끝까지 마저 부르세요';
      g.fillText(label, x, y - r - 14);
    }
  }
  g.textAlign = 'start';
}
