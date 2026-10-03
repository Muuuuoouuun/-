import { renderDemo, PRESETS, NOTE_NAMES, SCALES, midiName } from './dsp.js';

const $ = (id) => document.getElementById(id);
const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(name).trim();
const VOICE_COLORS = ['--v1', '--v2', '--v3', '--v4'].map(color);
const ENGINE_KEYS = { q: 'granular', w: 'psola', e: 'synth' };
const HISTORY_SEC = 6;

const params = {
  engine: 'psola',
  preset: 2,
  tonic: 0,
  scale: 'major',
  lock: true,
  dryGain: 0.9,
  harmGain: 0.8,
  windowMs: 40,
};

let ctx = null;
let node = null;
let recDest = null;
let source = null; // { kind, node, stream?, track? }
let latest = null;
let history = [];
let recorder = null;
let recChunks = [];
let lastBlob = null;
let centerMidi = 64;

// ───────────── 오디오 준비 ─────────────

async function ensureAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') await ctx.resume();
    return;
  }
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
  node = new AudioWorkletNode(ctx, 'airchoir', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  node.connect(ctx.destination);
  recDest = ctx.createMediaStreamDestination();
  node.connect(recDest);
  node.port.onmessage = (e) => {
    if (e.data?.type !== 'stats') return;
    latest = e.data;
    history.push({ t: e.data.t, midi: e.data.midi, targets: e.data.targets });
    const cut = e.data.t - HISTORY_SEC;
    while (history.length && history[0].t < cut) history.shift();
  };
  sendParams();
  $('rec').disabled = false;
}

function sendParams() {
  node?.port.postMessage({ type: 'params', params: { ...params } });
}

function stopSource() {
  if (!source) return;
  try {
    source.node.disconnect();
    source.node.stop?.();
  } catch {}
  source.stream?.getTracks().forEach((t) => t.stop());
  source = null;
  markSource(null);
}

function markSource(kind) {
  $('src-demo').setAttribute('aria-pressed', String(kind === 'demo'));
  $('src-mic').setAttribute('aria-pressed', String(kind === 'mic'));
  $('src-file-label').style.borderColor = kind === 'file' ? 'var(--fg)' : '';
}

function setDry(v) {
  params.dryGain = v;
  $('dry').value = v;
  $('dry-v').textContent = v.toFixed(2);
}

function playBuffer(data, kind) {
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(node);
  src.start();
  source = { kind, node: src };
  markSource(kind);
}

function notice(text, kind = '') {
  const el = $('notice');
  el.textContent = text;
  el.className = 'notice' + (kind ? ' ' + kind : '');
}

async function useDemo() {
  await ensureAudio();
  stopSource();
  setDry(0.9);
  sendParams();
  playBuffer(renderDemo(ctx.sampleRate), 'demo');
  notice('데모 멜로디(작은 별, C장조)가 반복 재생 중이에요. 손가락 개수와 엔진을 바꿔 가며 들어 보세요.');
}

async function useMic() {
  await ensureAudio();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    notice(
      '마이크를 열 수 없어요. 브라우저의 마이크 권한을 확인해 주세요. Claude 앱 안에서 열린 페이지라면 마이크가 막혀 있으니, 휴대폰으로 녹음한 파일을 "녹음 파일 열기"로 올리거나 README의 방법으로 내 컴퓨터에서 실행해 주세요.',
      'error',
    );
    return;
  }
  stopSource();
  const src = ctx.createMediaStreamSource(stream);
  src.connect(node);
  source = { kind: 'mic', node: src, stream, track: stream.getAudioTracks()[0] };
  markSource('mic');
  setDry(0);
  sendParams();
  notice('마이크가 켜졌어요. 반드시 이어폰을 끼고 "아~" 하고 길게 불러 보세요. 내 목소리는 기본으로 꺼 두었어요(늦게 들리는 내 목소리가 방해되면 안 되니까요).');
}

async function useFile(file) {
  await ensureAudio();
  let data;
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    data = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < ch.length; i++) data[i] += ch[i] / decoded.numberOfChannels;
    }
  } catch {
    notice('이 파일은 열 수 없어요. mp3, m4a, wav, webm 같은 오디오 파일이나 영상 파일을 골라 주세요.', 'error');
    return;
  }
  stopSource();
  setDry(0.9);
  sendParams();
  playBuffer(data, 'file');
  notice(`"${file.name}"을 반복 재생 중이에요. 키를 노래의 키에 맞추면 화음이 정확해져요.`);
}

// ───────────── 녹음 ─────────────

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  }
  return '';
}

function toggleRecord() {
  if (!recDest) return;
  if (recorder?.state === 'recording') {
    recorder.stop();
    return;
  }
  const mime = pickMime();
  recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  const label = `${params.engine} · 손가락 ${params.preset}`;
  const started = performance.now();
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => {
    lastBlob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
    const a = $('playback');
    if (a.src) URL.revokeObjectURL(a.src);
    a.src = URL.createObjectURL(lastBlob);
    a.hidden = false;
    $('save').hidden = false;
    $('rec').classList.remove('rec-on');
    $('rec').firstChild.textContent = '● 녹음 시작 ';
    const sec = ((performance.now() - started) / 1000).toFixed(1);
    $('rec-info').textContent = `${label} · ${sec}초 · ${(lastBlob.size / 1024).toFixed(0)}KB`;
  };
  recorder.start();
  $('rec').classList.add('rec-on');
  $('rec').firstChild.textContent = '■ 녹음 끝내기 ';
  $('rec-info').textContent = `${label} 녹음 중…`;
}

async function saveRecording() {
  if (!lastBlob) return;
  const ext = lastBlob.type.includes('mp4') ? 'mp4' : 'webm';
  const filename = `airchoir-${params.engine}-${Date.now()}.${ext}`;
  let downloads = null;
  try {
    downloads = await window.claude?.use?.('downloads');
  } catch {}
  if (downloads) {
    try {
      await downloads.save({ filename, data: lastBlob });
      $('rec-info').textContent = '파일로 저장했어요.';
    } catch (err) {
      if (err?.code !== 'declined') $('rec-info').textContent = '여기서는 파일을 저장할 수 없어요. 위 플레이어로 들어 보세요.';
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastBlob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ───────────── 컨트롤 ─────────────

function setEngine(engine) {
  params.engine = engine;
  document.querySelectorAll('[data-engine]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.engine === engine)));
  sendParams();
}

function setPreset(i) {
  params.preset = i;
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.preset === i)));
  $('preset-name').textContent = PRESETS[i].name;
  sendParams();
}

function bindControls() {
  $('src-demo').onclick = useDemo;
  $('src-mic').onclick = useMic;
  $('src-file').onchange = (e) => e.target.files[0] && useFile(e.target.files[0]);
  $('stop').onclick = () => {
    stopSource();
    notice('정지했어요. 위에서 입력을 다시 고르세요.');
  };
  document.querySelectorAll('[data-engine]').forEach((b) => (b.onclick = () => setEngine(b.dataset.engine)));
  document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => setPreset(+b.dataset.preset)));

  const key = $('key');
  NOTE_NAMES.forEach((n, i) => key.add(new Option(`${n} 키`, i)));
  key.onchange = () => {
    params.tonic = +key.value;
    sendParams();
  };
  $('scale').onchange = (e) => {
    params.scale = e.target.value;
    sendParams();
  };
  $('lock').onchange = (e) => {
    params.lock = e.target.checked;
    sendParams();
  };
  $('dry').oninput = (e) => {
    setDry(+e.target.value);
    sendParams();
  };
  $('harm').oninput = (e) => {
    params.harmGain = +e.target.value;
    $('harm-v').textContent = params.harmGain.toFixed(2);
    sendParams();
  };
  $('win').oninput = (e) => {
    params.windowMs = +e.target.value;
    $('win-v').textContent = `${params.windowMs}ms`;
    sendParams();
  };
  $('rec').onclick = toggleRecord;
  $('save').onclick = saveRecording;

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k >= '0' && k <= '4') setPreset(+k);
    else if (ENGINE_KEYS[k]) setEngine(ENGINE_KEYS[k]);
    else if (k === 'r') toggleRecord();
  });
}

// ───────────── 화면 갱신 ─────────────

function latencyParts() {
  if (!ctx) return null;
  const mic = source?.kind === 'mic';
  const input = mic ? source.track?.getSettings?.().latency : 0;
  return [
    { name: '입력 장치 (마이크)', ms: input == null ? null : input * 1000, color: color('--v4'), hint: '브라우저가 알려 주지 않음', label: mic ? null : '없음 (파일 재생)' },
    { name: '화음 엔진', ms: latest?.engineLatencyMs ?? 0, color: color('--v1') },
    { name: '브라우저 처리 단위', ms: (ctx.baseLatency || 0) * 1000, color: color('--v3') },
    { name: '출력 장치', ms: ctx.outputLatency ? ctx.outputLatency * 1000 : null, color: color('--v2'), hint: '브라우저가 알려 주지 않음' },
  ];
}

function renderLatency() {
  const parts = latencyParts();
  if (!parts) return;
  const known = parts.filter((p) => p.ms != null);
  const total = known.reduce((s, p) => s + p.ms, 0);
  const scale = Math.max(150, total * 1.15);
  const bar = $('lat-bar');
  bar.innerHTML = known.map((p) => `<span style="width:${(p.ms / scale) * 100}%;background:${p.color}"></span>`).join('') +
    `<i class="target" style="left:${(100 / scale) * 100}%"></i>`;
  $('lat-list').innerHTML = parts
    .map((p) => `<span class="sw" style="background:${p.color}"></span><span>${p.name}</span><span class="v">${p.label || (p.ms == null ? p.hint || '모름' : p.ms.toFixed(1) + ' ms')}</span>`)
    .join('');
  const unknown = parts.length - known.length;
  $('lat-total').textContent = `${total.toFixed(0)} ms${unknown ? '+' : ''}`;
  const pill = $('lat-pill');
  const [cls, text] = total <= 100 ? ['good', '목표 이내'] : total <= 150 ? ['warn', '조금 늦음'] : ['bad', '너무 늦음'];
  pill.className = `pill ${cls}`;
  pill.textContent = unknown ? `${text} (일부 항목 모름)` : text;
  if (latest) $('track').textContent = `${latest.trackingLatencyMs.toFixed(0)} ms`;
}

function renderReadout() {
  const s = latest;
  const on = s && s.midi != null;
  $('note').textContent = on ? midiName(s.midi) : '—';
  $('note').className = 'note-big' + (on ? '' : ' off');
  if (on) {
    const cents = Math.round((s.midi - Math.round(s.midi)) * 100);
    $('hz').textContent = `${s.freq.toFixed(1)} Hz · ${cents >= 0 ? '+' : ''}${cents} cent`;
  } else {
    $('hz').textContent = source ? '소리가 작거나 음이 없어요' : '음 대기 중';
  }
  $('conf').style.width = `${Math.round((s?.confidence || 0) * 100)}%`;
  const chips = $('chips');
  chips.innerHTML = on && s.targets.length
    ? s.targets.map((m, i) => `<span class="chip v${i}">${midiName(m)}</span>`).join('')
    : `<span class="chip idle">${params.preset === 0 ? '화음 꺼짐' : '없음'}</span>`;
}

const canvas = $('trace');
const g = canvas.getContext('2d');

function drawTrace() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const voiced = history.filter((p) => p.midi != null).map((p) => p.midi);
  if (voiced.length) {
    const sorted = [...voiced].sort((a, b) => a - b);
    centerMidi += (sorted[sorted.length >> 1] - centerMidi) * 0.05;
  }
  const span = 30;
  const lo = centerMidi - span * 0.45;
  const y = (m) => h - ((m - lo) / span) * h;

  // 키의 스케일 음마다 가로줄
  const scale = SCALES[params.scale];
  g.font = `11px ${css.getPropertyValue('--font-data')}`;
  g.textBaseline = 'middle';
  let lastLabel = Infinity;
  for (let m = Math.floor(lo); m <= lo + span; m++) {
    const pc = (((m - params.tonic) % 12) + 12) % 12;
    if (!scale.includes(pc)) continue;
    const yy = Math.round(y(m)) + 0.5;
    g.strokeStyle = pc === 0 ? color('--muted') : color('--line');
    g.globalAlpha = pc === 0 ? 0.55 : 0.5;
    g.beginPath();
    g.moveTo(40, yy);
    g.lineTo(w, yy);
    g.stroke();
    g.globalAlpha = 1;
    if (lastLabel - yy >= 13 || pc === 0) {
      g.fillStyle = color('--muted');
      g.fillText(midiName(m), 8, yy);
      lastLabel = yy;
    }
  }

  if (!history.length) {
    g.fillStyle = color('--muted');
    g.font = `14px ${css.getPropertyValue('--font-body')}`;
    g.fillText('입력을 고르면 최근 6초 동안의 음정이 여기에 그려져요', 52, h / 2);
    return;
  }
  const tEnd = history[history.length - 1].t;
  const x = (t) => 40 + ((t - (tEnd - HISTORY_SEC)) / HISTORY_SEC) * (w - 48);

  const line = (get, stroke, width) => {
    g.strokeStyle = stroke;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    for (const p of history) {
      const m = get(p);
      if (m == null) {
        pen = false;
        continue;
      }
      if (pen) g.lineTo(x(p.t), y(m));
      else g.moveTo(x(p.t), y(m));
      pen = true;
    }
    g.stroke();
  };
  for (let v = 3; v >= 0; v--) line((p) => (p.midi != null ? p.targets[v] : null), VOICE_COLORS[v], 2);
  line((p) => p.midi, color('--voice'), 3);
}

let lastText = 0;
function frame(now) {
  drawTrace();
  if (now - lastText > 80) {
    lastText = now;
    renderReadout();
    renderLatency();
  }
  requestAnimationFrame(frame);
}

bindControls();
setPreset(params.preset);
requestAnimationFrame(frame);
