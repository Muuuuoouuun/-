/* band2sheet 악보 스튜디오 — 화면 동작 */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const MAJOR_KEYS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_KEYS = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"];
const PC = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

const state = {
  info: null,
  file: null,
  quality: "standard",
  jobId: null,
  job: null,
  result: null,
  tab: "full_score",
  zoom: 1.0,
  osmd: null,
  pollTimer: null,
  audios: {},
  mute: new Set(),
  solo: new Set(),
  lastMeasure: -1,
};

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) { /* 본문 없음 */ }
    throw new Error(msg);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : res.text();
}

function show(view) {
  for (const v of ["new", "source", "progress", "result", "remix"]) $(`#view-${v}`).classList.toggle("hidden", v !== view);
  if (view !== "source") { $("#s-video").pause(); $("#s-audio").pause(); }
  if (view !== "remix") { $("#x-video").pause(); $("#x-audio").pause(); }
}

function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function keyName(short) {
  return short.endsWith("m") ? `${short.slice(0, -1)} minor` : `${short} major`;
}

function midiName(m) {
  return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
}

// ------------------------------------------------------------------ 시작 화면
async function loadInfo() {
  state.info = await api("/api/info");
  $("#device-chip").textContent = state.info.device === "cpu" ? "CPU 모드" : `가속: ${state.info.device.toUpperCase()}`;
  $("#ext-hint").textContent = state.info.extensions.join(", ");
  $("#file").accept = state.info.extensions.join(",");
  const box = $("#instruments");
  box.innerHTML = "";
  for (const ins of state.info.instruments) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" value="${ins.name}"> ${ins.label_ko}`;
    box.appendChild(l);
  }
  const tk = $("#target-key");
  for (const k of [...MAJOR_KEYS, ...MINOR_KEYS]) {
    tk.add(new Option(keyName(k), k));
    $("#rm-key").add(new Option(keyName(k), k));
  }
  const eng = Object.fromEntries(state.info.engines.map((e) => [e.key, e]));
  const whisper = (eng.whisper && eng.whisper.installed) || (eng.whisperx && eng.whisperx.installed);
  $("#lyrics-hint").textContent = whisper ? "Whisper 로 가사를 인식합니다." :
    "가사 인식 엔진이 설치되지 않았습니다: pip install faster-whisper";
  $("#pdf").disabled = !state.info.pdf;
  if (!state.info.pdf) $("#pdf").parentElement.title = "MuseScore 또는 pip install verovio cairosvg pypdf 필요";
  const sep = eng.audio_separator && eng.audio_separator.installed;
  for (const id of ["#split-vocals", "#split-drums"]) {
    $(id).disabled = !sep;
    if (!sep) $(id).parentElement.title = "audio-separator 설치 필요: pip install audio-separator";
  }
  const t = $("#engines-table");
  t.innerHTML = state.info.engines.map((e) => `<tr><td class="${e.installed ? "ok" : "no"}">${e.installed ? "✓ 설치됨" : "· 없음"}</td>
    <td><b>${e.key}</b><br><span class="muted small">${e.note}</span></td><td>${e.role}${e.installed ? "" : `<br><code class="small">pip install ${e.pip}</code>`}</td></tr>`).join("") +
    `<tr><td class="${state.info.musescore ? "ok" : "no"}">${state.info.musescore ? "✓ 설치됨" : "· 없음"}</td><td><b>MuseScore</b></td><td>PDF 악보 만들기</td></tr>`;
}

function urlValue() {
  return $("#url").value.trim();
}

function updateStartButton() {
  const url = urlValue();
  $("#btn-start").disabled = !(url || state.file);
  const what = $("#keep-video").checked ? "영상" : "음성";
  $("#btn-start").textContent = url && $("#fetch-only").checked ? `${what} 받기 시작` :
    url ? `${what} 받아서 악보 만들기` : "악보 만들기 시작";
  $("#max-height").disabled = !$("#keep-video").checked;
  $("#title").placeholder = url ? "영상 제목 사용" : state.file ? state.file.name.replace(/\.[^.]+$/, "") : "파일 이름 사용";
  $("#drop").classList.toggle("dim", !!url);
}

function setFile(f) {
  state.file = f;
  $("#file-name").textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)} MB)` : "";
  if (f) $("#url").value = "";  // 파일을 고르면 링크 대신 파일 사용
  updateStartButton();
}

function initNewView() {
  const drop = $("#drop");
  $("#file").addEventListener("change", (e) => setFile(e.target.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
  });
  $$("#quality button").forEach((b) => b.addEventListener("click", () => {
    $$("#quality button").forEach((x) => x.classList.toggle("on", x === b));
    state.quality = b.dataset.v;
  }));
  $("#url").addEventListener("input", updateStartButton);
  $("#url").addEventListener("keydown", (e) => { if (e.key === "Enter" && urlValue()) startJob(); });
  $("#fetch-only").addEventListener("change", updateStartButton);
  $("#keep-video").addEventListener("change", updateStartButton);
  $("#btn-start").addEventListener("click", startJob);
}

async function startJob() {
  $("#start-error").textContent = "";
  const options = {
    title: $("#title").value.trim(),
    quality: state.quality,
    split_vocals: $("#split-vocals").checked,
    split_drums: $("#split-drums").checked,
    stems: $$("#instruments input:checked").map((x) => x.value),
    time_signature: $("#time-sig").value,
    bpm: $("#bpm").value || null,
    target_key: $("#target-key").value || null,
    start: $("#start").value || null,
    duration: $("#duration").value || null,
    lyrics: $("#lyrics").checked,
    cleanup: $("#cleanup").checked,
    pdf: $("#pdf").checked,
    language: $("#language").value,
  };
  const url = urlValue();
  $("#btn-start").disabled = true;
  $("#btn-start").textContent = url ? "시작하는 중…" : "올리는 중…";
  try {
    let job;
    if (url) {
      Object.assign(options, {
        fetch_only: $("#fetch-only").checked,
        keep_video: $("#keep-video").checked,
        max_height: Number($("#max-height").value),
        audio_format: $("#audio-format").value,
      });
      job = await api("/api/jobs/url", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, options }),
      });
      $("#url").value = "";
    } else {
      const fd = new FormData();
      fd.append("file", state.file);
      fd.append("options", JSON.stringify(options));
      job = await api("/api/jobs", { method: "POST", body: fd });
      setFile(null);
      $("#file").value = "";
    }
    await loadJobs();
    openJob(job.id);
  } catch (e) {
    $("#start-error").textContent = e.message;
  } finally {
    updateStartButton();
  }
}

// ------------------------------------------------------------------ 내 영상 후보정
function setMode(mode) {
  $$("#mode-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("#mode-score").classList.toggle("hidden", mode !== "score");
  $("#mode-remix").classList.toggle("hidden", mode !== "remix");
}

function setRemixFile(f) {
  state.rmFile = f;
  $("#rm-file-name").textContent = f ? `${f.name} (${(f.size / 1048576).toFixed(1)} MB)` : "";
  $("#rm-start").disabled = !f;
}

function updateHarmonyRow() {
  const style = state.rmStyle;
  const voices = style === "harmony" || $("#rm-with-harmony").checked;
  $("#rm-harmony-row").classList.toggle("hidden", !voices);
}

function setRemixStyle(style) {
  state.rmStyle = style;
  $$("#rm-style button").forEach((b) => b.classList.toggle("on", b.dataset.v === style));
  // 반주 스타일에서 내 목소리 화음을 더할지 (아카펠라는 기본으로 넣음)
  $("#rm-with-harmony-row").classList.toggle("hidden", style === "harmony");
  $("#rm-with-harmony").checked = style === "acappella";
  updateHarmonyRow();
  // 화음만 넣을 때는 원래 반주를 살리고, 오케스트라를 입힐 때는 원래 반주를 빼고 바꾸는 게 기본
  $("#rm-keep-backing").checked = style === "harmony";
  $("#rm-keep-label").textContent = style === "harmony" ? "원래 반주 유지" : "원래 반주도 남기기 (끄면 새 반주로 바꿈)";
}

function initRemix() {
  state.rmStyle = "harmony";
  $$("#mode-tabs button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  const drop = $("#rm-drop");
  $("#rm-file").addEventListener("change", (e) => setRemixFile(e.target.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    if (e.dataTransfer.files.length) setRemixFile(e.dataTransfer.files[0]);
  });
  $$("#rm-style button").forEach((b) => b.addEventListener("click", () => setRemixStyle(b.dataset.v)));
  $("#rm-with-harmony").addEventListener("change", updateHarmonyRow);
  setRemixStyle("harmony");
  $("#rm-autotune").addEventListener("change", () => {
    $("#rm-strength").disabled = $("#rm-hard").disabled = !$("#rm-autotune").checked;
  });
  $("#rm-strength").addEventListener("input", () => { $("#rm-strength-v").textContent = `${$("#rm-strength").value}%`; });
  $("#rm-start").addEventListener("click", startRemix);
  $$("#x-compare button").forEach((b) => b.addEventListener("click", () => compareRemix(b.dataset.v)));
  $("#x-delete").addEventListener("click", async () => {
    if (!confirm("후보정 결과를 지울까요? (원본 파일은 내 컴퓨터에 그대로 있어요)")) return;
    await api(`/api/jobs/${state.job.id}`, { method: "DELETE" });
    state.jobId = null;
    await loadJobs();
    show("new");
  });
}

async function startRemix() {
  $("#rm-error").textContent = "";
  const options = {
    style: state.rmStyle,
    harmony: $("#rm-harmony").value,
    with_harmony: state.rmStyle === "harmony" ? null : $("#rm-with-harmony").checked,
    keep_backing: $("#rm-keep-backing").checked,
    autotune: $("#rm-autotune").checked,
    autotune_strength: Number($("#rm-strength").value) / 100,
    hard_tune: $("#rm-autotune").checked && $("#rm-hard").checked,
    key: $("#rm-key").value || null,
    bpm: $("#rm-bpm").value || null,
  };
  const fd = new FormData();
  fd.append("file", state.rmFile);
  fd.append("options", JSON.stringify(options));
  $("#rm-start").disabled = true;
  $("#rm-start").textContent = "올리는 중…";
  try {
    const job = await api("/api/remix", { method: "POST", body: fd });
    setRemixFile(null);
    $("#rm-file").value = "";
    await loadJobs();
    openJob(job.id);
  } catch (e) {
    $("#rm-error").textContent = e.message;
  } finally {
    $("#rm-start").textContent = "후보정 시작";
    $("#rm-start").disabled = !state.rmFile;
  }
}

function remixUrl(path) {
  return `/api/jobs/${state.job.id}/remix/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function compareRemix(which) {
  const r = state.job.result;
  $$("#x-compare button").forEach((b) => b.classList.toggle("on", b.dataset.v === which));
  const player = r.video ? $("#x-video") : $("#x-audio");
  const t = player.currentTime || 0;
  const playing = !player.paused;
  player.src = remixUrl(which === "original" ? "original" : (r.video || r.audio));
  player.addEventListener("loadedmetadata", () => {  // 같은 위치에서 이어서 비교
    player.currentTime = t;
    if (playing) player.play();
  }, { once: true });
}

function showRemix() {
  const job = state.job;
  const r = job.result;
  show("remix");
  $("#player").classList.add("hidden");
  $("#x-title").textContent = job.title;
  $("#x-meta").innerHTML = "";
  for (const m of [r.style_label, r.autotune ? "오토튠" : null, `키 ${r.key_short}`].filter(Boolean)) {
    const span = document.createElement("span");
    span.textContent = m;
    $("#x-meta").appendChild(span);
  }
  $("#x-notes").innerHTML = "";
  for (const n of r.notes) {
    const li = document.createElement("li");
    li.textContent = n;
    $("#x-notes").appendChild(li);
  }
  $("#x-video").classList.toggle("hidden", !r.video);
  $("#x-audio").classList.toggle("hidden", !!r.video);
  $("#x-dl").href = remixUrl(r.video || r.audio);
  $("#x-dl").textContent = r.video ? "⬇ 후보정 영상 받기" : "⬇ 후보정 음원 받기";
  if (state.remixJob !== job.id) {
    state.remixJob = job.id;
    compareRemix("remix");
  }
  $("#x-files").innerHTML = "";
  for (const f of [...r.files, "original"]) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = remixUrl(f);
    a.textContent = f === "original" ? "원본 파일" : f === r.video ? "🎬 후보정 영상" :
      f === r.audio ? "🎵 후보정 음원 (WAV)" : f.endsWith(".mid") ? `🎼 반주 편곡 (MIDI · ${f})` :
      { "stems/lead_tuned.wav": "오토튠 보컬", "stems/harmony_up.wav": "위 화음",
        "stems/harmony_down.wav": "아래 화음" }[f] || (f.startsWith("stems/") ? `반주 트랙 (${f.slice(6)})` : f);
    a.download = "";
    li.appendChild(a);
    $("#x-files").appendChild(li);
  }
}

// ------------------------------------------------------------------ 받은 영상·음성
function showSource() {
  const job = state.job;
  const src = job.source || {};
  show("source");
  $("#player").classList.add("hidden");
  $("#s-title").textContent = job.title;
  const meta = [];
  if (src.uploader) meta.push(src.uploader);
  if (src.duration) meta.push(`길이 ${fmtTime(src.duration)}`);
  if (src.height) meta.push(`${src.height}p`);
  $("#s-meta").innerHTML = "";
  for (const m of meta) {
    const span = document.createElement("span");
    span.textContent = m;
    $("#s-meta").appendChild(span);
  }
  if (src.url) {
    const a = document.createElement("a");
    a.href = src.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "원본 링크 ↗";
    a.className = "small";
    $("#s-meta").appendChild(a);
  }
  const base = `/api/jobs/${job.id}/source`;
  if (state.sourceJob !== job.id) {  // 같은 작업이면 재생 위치 유지
    state.sourceJob = job.id;
    $("#s-video").src = src.video ? `${base}/video` : "";
    $("#s-audio").src = src.audio ? `${base}/audio` : "";
    $("#s-start").value = job.options.start || "";
    $("#s-duration").value = job.options.duration || "";
  }
  $("#s-video").classList.toggle("hidden", !src.video);
  $("#s-video-dl").classList.toggle("hidden", !src.video);
  $("#s-audio-dl").classList.toggle("hidden", !src.audio);
  $("#s-video-dl").href = `${base}/video`;
  $("#s-audio-dl").href = `${base}/audio`;
  $("#s-error").textContent = "";
}

async function startAnalysis(options, errorEl) {
  errorEl.textContent = "";
  try {
    await api(`/api/jobs/${state.job.id}/analyze`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ options }),
    });
    await loadJobs();
    refreshJob();
  } catch (e) {
    errorEl.textContent = e.message;
  }
}

function sourcePlayer() {
  return state.job && state.job.source && state.job.source.video ? $("#s-video") : $("#s-audio");
}

function initSourceView() {
  $("#s-mark-start").addEventListener("click", () => {
    $("#s-start").value = sourcePlayer().currentTime.toFixed(1);
  });
  $("#s-mark-end").addEventListener("click", () => {
    const start = Number($("#s-start").value) || 0;
    const len = sourcePlayer().currentTime - start;
    if (len > 0) $("#s-duration").value = len.toFixed(1);
  });
  $("#s-analyze").addEventListener("click", () => startAnalysis({
    start: Number($("#s-start").value) || null,
    duration: Number($("#s-duration").value) || null,
  }, $("#s-error")));
  $("#p-retry").addEventListener("click", () => startAnalysis({}, $("#p-error")));
  $("#s-delete").addEventListener("click", async () => {
    if (!confirm("받은 파일을 지울까요?")) return;
    await api(`/api/jobs/${state.job.id}`, { method: "DELETE" });
    state.jobId = null;
    state.sourceJob = null;
    await loadJobs();
    show("new");
  });
}

// ------------------------------------------------------------------ 작업 목록
async function loadJobs() {
  const jobs = await api("/api/jobs");
  const ul = $("#job-list");
  ul.innerHTML = "";
  $("#job-empty").classList.toggle("hidden", jobs.length > 0);
  for (const j of jobs) {
    const li = document.createElement("li");
    li.classList.toggle("active", j.id === state.jobId);
    const st = j.status === "done" && j.kind === "remix" ? `후보정 완료 · ${j.key || ""}` :
      j.status === "done" ? `완료 · ${j.key || ""}` : j.status === "error" ? "오류" :
      j.status === "ready" ? "영상·음성 준비됨 · 악보 만들기 전" :
      j.status === "queued" ? "대기 중" : `${Math.round(j.progress * 100)}% · ${j.stage}`;
    li.innerHTML = `<span class="t"></span><span class="s ${j.status}">${st}</span>`;
    li.querySelector(".t").textContent = j.title;
    li.addEventListener("click", () => openJob(j.id));
    ul.appendChild(li);
  }
  return jobs;
}

async function openJob(id) {
  stopAudio();
  clearTimeout(state.pollTimer);
  state.jobId = id;
  state.tab = "full_score";
  await loadJobs();
  await refreshJob();
}

async function refreshJob() {
  const job = await api(`/api/jobs/${state.jobId}`);
  state.job = job;
  if (job.status === "done" && job.kind === "remix") {
    showRemix();
    loadJobs();
    return;
  }
  if (job.status === "done") {
    await showResult();
    loadJobs();
    return;
  }
  if (job.status === "ready") {
    showSource();
    loadJobs();
    return;
  }
  show("progress");
  $("#player").classList.add("hidden");
  $("#p-title").textContent = job.title;
  $("#p-bar").style.width = `${Math.round(job.progress * 100)}%`;
  $("#p-stage").textContent = job.status === "queued" ? "다른 작업이 끝나기를 기다리는 중…" : job.stage;
  $("#p-log").textContent = job.log.join("\n");
  $("#p-log").scrollTop = 1e9;
  $("#p-error").textContent = job.error || "";
  $("#p-retry").classList.toggle("hidden", job.status !== "error");
  if (job.status === "running" || job.status === "queued") {
    state.pollTimer = setTimeout(() => { refreshJob(); loadJobs(); }, 1200);
  } else {
    loadJobs();
  }
}

// ------------------------------------------------------------------ 결과 화면
async function showResult() {
  const job = state.job;
  state.result = job.result;
  show("result");
  $("#player").classList.remove("hidden");
  $("#r-title").textContent = job.title;
  buildMixer();
  renderActivity();
  renderFiles();
  const keep = state.viewJob === job.id && state.view;
  await loadView({ semitones: keep ? state.view.semitones : (job.result.semitones || 0) });
  switchView(state.pane || "chart");
}

async function loadView(params) {
  const q = new URLSearchParams();
  if (params.target_key) q.set("key", params.target_key);
  else q.set("semitones", String(params.semitones || 0));
  $("#t-info").textContent = "불러오는 중…";
  try {
    const v = await api(`/api/jobs/${state.job.id}/view?${q}`);
    state.view = v;
    state.viewJob = state.job.id;
    renderHeader();
    renderStructure();
    Views.setData(v, state.job.id);
    updateStale();
    if (state.pane === "score" && scoreStale()) refreshScore();
  } catch (e) {
    $("#t-info").textContent = e.message;
  }
}

function renderHeader() {
  const v = state.view;
  const eng = (state.result && state.result.engines) || {};
  const meta = [
    `키 ${v.key}`,
    ...v.key_changes.map((k) => `${k.number}마디부터 ${k.key_short} (전조)`),
    `템포 ${Math.round(v.tempo)} BPM`, `${v.time_signature}`,
    ...(v.pickup ? ["못갖춘마디로 시작"] : []),
    ...(v.capo ? [`기타 카포 ${v.capo.fret}`] : []),
    ...(eng.separation ? [eng.separation] : []),
  ];
  $("#r-meta").innerHTML = meta.map(() => `<span></span>`).join("");
  $$("#r-meta span").forEach((el, i) => {
    el.textContent = meta[i];
    if (meta[i].includes("전조")) el.classList.add("keychip");
  });
  const minor = v.original_key_short.endsWith("m");
  const sel = $("#t-key");
  sel.innerHTML = "";
  for (const k of minor ? MINOR_KEYS : MAJOR_KEYS) sel.add(new Option(keyName(k) + (k === v.original_key_short ? " (원래)" : ""), k));
  const cur = (minor ? MINOR_KEYS : MAJOR_KEYS).find((k) => PC[k.replace(/m$/, "")] === PC[v.key_short.replace(/m$/, "")]);
  sel.value = cur || v.key_short;
  $("#t-info").textContent = v.semitones ? `원래 ${v.original_key} → ${v.key} (${v.semitones > 0 ? "+" : ""}${v.semitones} 반음)` : `원래 키 ${v.original_key}`;
}

function scoreStale() {
  const r = state.result, v = state.view;
  return !r || !v || r.semitones !== v.semitones || !!r.stale;
}

function updateStale() {
  const stale = scoreStale();
  $("#score-stale").classList.toggle("hidden", !stale);
  $("#files-stale").classList.toggle("hidden", !stale);
}

function markStale() {
  if (state.result) state.result.stale = true;
  updateStale();
}

async function refreshScore() {
  if (state.refreshing) return;
  state.refreshing = true;
  $("#sheet-loading").classList.remove("hidden");
  $("#sheet-loading").textContent = "오선 악보·파일 만드는 중…";
  try {
    state.result = await api(`/api/jobs/${state.job.id}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ semitones: state.view.semitones }),
    });
    renderFiles();
    updateStale();
    renderActivity();
    if (state.pane === "score") renderScorePane();
    loadJobs();
  } catch (e) {
    toast(e.message);
  } finally {
    state.refreshing = false;
    $("#sheet-loading").textContent = "악보 그리는 중…";
    $("#sheet-loading").classList.add("hidden");
  }
}

function switchView(name) {
  state.pane = name;
  $$("#viewtabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  for (const p of ["chart", "live", "roll", "score"]) $(`#v-${p}`).classList.toggle("hidden", p !== name);
  if (name === "score") {
    if (scoreStale()) refreshScore();
    else renderScorePane();
  }
  Views.shown(name);
}

function renderScorePane() {
  const r = state.result;
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  const items = [{ id: "full_score", label: "총보" }];
  if (r.files.includes("lead_sheet.musicxml")) items.push({ id: "lead_sheet", label: "리드시트" });
  for (const p of r.parts) {
    let badge = "";
    if (p.tab) badge = "TAB";
    else if (p.pedals) badge = "페달";
    else if (p.name === "drums" && p.pieces) badge = `${p.pieces.length}조각`;
    items.push({ id: p.name, label: p.label_ko, badge });
  }
  if (!items.find((i) => i.id === state.tab)) state.tab = "full_score";
  for (const it of items) {
    const b = document.createElement("button");
    b.innerHTML = `<span></span>${it.badge ? ` <span class="badge">${it.badge}</span>` : ""}`;
    b.firstChild.textContent = it.label;
    b.classList.toggle("on", it.id === state.tab);
    b.addEventListener("click", () => { state.tab = it.id; renderScorePane(); });
    tabs.appendChild(b);
  }
  showPartInfo();
  loadSheet();
}

function renderFiles() {
  const r = state.result;
  const job = state.job;
  $("#r-zip").href = `/api/jobs/${job.id}/zip/${r.sheet_dir}`;
  $("#files").innerHTML = "";
  for (const [kind, label] of [["video", "원본 영상"], ["audio", "추출한 음성"]]) {
    const name = job.source && job.source[kind];
    if (!name) continue;
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `/api/jobs/${job.id}/source/${kind}`;
    a.textContent = `${label} (${name.split(".").pop()})`;
    a.download = "";
    li.appendChild(a);
    $("#files").appendChild(li);
  }
  for (const f of r.files) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `/api/jobs/${job.id}/files/${r.sheet_dir}/${f}`;
    a.textContent = f;
    a.download = f.split("/").pop();
    li.appendChild(a);
    $("#files").appendChild(li);
  }
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function showPartInfo() {
  const r = state.result;
  const p = r.parts.find((x) => x.name === state.tab);
  let text = "";
  if (state.tab === "full_score") text = "모든 악기를 모은 총보입니다. 기타·베이스 TAB 은 악기 탭에서 볼 수 있어요.";
  else if (state.tab === "lead_sheet") text = "보컬 멜로디 + 코드 (+ 가사) — 예배팀·밴드 연습용";
  else if (p) {
    const bits = [`채보 엔진: ${p.engine || "-"}`, `음표 ${p.notes}개`];
    if (p.range) bits.push(`음역 ${midiName(p.range[0])}–${midiName(p.range[1])}`);
    if (p.pieces) bits.push(`구성: ${p.pieces.join(", ")}`);
    if (p.tab) bits.push("오선보 + TAB (운지 자동 배정)");
    if (p.pedals) bits.push(`서스테인 페달 ${p.pedals}곳`);
    text = bits.join(" · ");
  }
  $("#part-info").textContent = text;
}

async function loadSheet() {
  const r = state.result;
  const file = `${state.tab}.musicxml`;
  $("#sheet-loading").classList.remove("hidden");
  try {
    const xml = await api(`/api/jobs/${state.job.id}/files/${r.sheet_dir}/${file}`);
    if (!state.osmd) {
      state.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay("sheet", {
        autoResize: false, backend: "svg", drawTitle: true, drawComposer: false,
        drawingParameters: "default", followCursor: true,
      });
    }
    await state.osmd.load(xml);
    state.osmd.zoom = state.zoom;
    state.osmd.render();
    state.lastMeasure = -1;
  } catch (e) {
    $("#sheet").textContent = `악보를 불러오지 못했습니다: ${e.message}`;
    state.osmd = null;
  } finally {
    $("#sheet-loading").classList.add("hidden");
  }
}

async function transpose(body) {
  if (Views.hasUnsaved() && !confirm("악기별 보기에서 저장하지 않은 수정이 있어요. 버릴까요?")) return;
  await loadView(body);
  loadJobs();
}

function initResultView() {
  $("#t-key").addEventListener("change", (e) => transpose({ target_key: e.target.value }));
  $("#t-up").addEventListener("click", () => transpose({ semitones: (state.view.semitones || 0) + 1 }));
  $("#t-down").addEventListener("click", () => transpose({ semitones: (state.view.semitones || 0) - 1 }));
  $("#t-reset").addEventListener("click", () => transpose({ semitones: 0 }));
  $("#z-in").addEventListener("click", () => setZoom(state.zoom + 0.1));
  $("#z-out").addEventListener("click", () => setZoom(state.zoom - 0.1));
  $$("#viewtabs button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  $("#score-refresh").addEventListener("click", refreshScore);
  $("#files-refresh").addEventListener("click", refreshScore);
  $("#r-delete").addEventListener("click", async () => {
    if (!confirm("이 작업과 만든 악보를 모두 지울까요?")) return;
    await api(`/api/jobs/${state.job.id}`, { method: "DELETE" });
    stopAudio();
    state.jobId = null;
    $("#player").classList.add("hidden");
    await loadJobs();
    show("new");
  });
  $("#m-play").addEventListener("click", togglePlay);
  $("#m-seek").addEventListener("input", (e) => {
    const a = masterAudio();
    if (a && isFinite(a.duration)) seekAll((e.target.value / 1000) * a.duration);
  });
  Views.init({
    api,
    toast,
    markStale,
    seek: (t, play) => { seekAll(t); const m = masterAudio(); if (play && m && m.paused) togglePlay(); },
    time: () => { const m = masterAudio(); return m ? m.currentTime : 0; },
    playing: () => { const m = masterAudio(); return !!m && !m.paused; },
    reload: () => loadView({ semitones: state.view ? state.view.semitones : 0 }).then(markStale),
  });
}

// 창 크기가 바뀌면 오선 악보가 보일 때만 다시 그린다 (숨겨진 상태에서 그리면 폭이 0)
window.addEventListener("resize", () => {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    if (state.osmd && state.pane === "score" && !$("#v-score").classList.contains("hidden")) state.osmd.render();
  }, 250);
});

function setZoom(z) {
  state.zoom = Math.min(2, Math.max(0.4, Math.round(z * 10) / 10));
  $("#z-val").textContent = `${Math.round(state.zoom * 100)}%`;
  if (state.osmd) { state.osmd.zoom = state.zoom; state.osmd.render(); }
}

function renderStructure() {
  const secs = state.view.sections || [];
  $("#structure").classList.toggle("hidden", secs.length < 2);
  const box = $("#sections");
  box.innerHTML = "";
  for (const sec of secs) {
    const b = document.createElement("button");
    b.className = `sec-${sec.kind}`;
    b.style.flex = `${sec.end_index - sec.start_index} 1 0`;
    b.title = `${sec.name_ko} — ${sec.start_number}~${sec.end_number}마디`;
    b.innerHTML = `<span></span><small></small>`;
    b.firstChild.textContent = sec.name_ko;
    b.lastChild.textContent = `${sec.start_number}마디`;
    b.dataset.index = sec.start_index;
    b.addEventListener("click", () => playFrom(sec.start_index));
    box.appendChild(b);
  }
}

function playFrom(measureIndex) {
  const ms = state.view.measures || [];
  const t = Math.max(0, ms[Math.min(measureIndex, ms.length - 1)] || 0);
  seekAll(t);
  const master = masterAudio();
  if (master && master.paused) togglePlay();
}

function highlightSection(measureIndex) {
  for (const b of $$("#sections button")) {
    const next = b.nextElementSibling ? Number(b.nextElementSibling.dataset.index) : 1e9;
    b.classList.toggle("now", measureIndex >= Number(b.dataset.index) && measureIndex < next);
  }
}

function renderActivity() {
  const r = state.result;
  const sep = r.separation || {};
  const names = Object.keys(sep);
  $("#sep-card").classList.toggle("hidden", !names.length);
  const box = $("#activity");
  box.innerHTML = "";
  const dur = Math.max(r.duration || 0, ...names.flatMap((n) => (sep[n].intervals || []).map((iv) => iv[1]))) || 1;
  const order = ["vocals", "backing_vocals", "guitar", "piano", "other", "bass", "drums"];
  names.sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  for (const n of names) {
    const info = sep[n];
    const label = document.createElement("span");
    label.textContent = STEM_LABELS[n] || n;
    const track = document.createElement("div");
    track.className = "track";
    for (const [a, b] of info.intervals || []) {
      const bar = document.createElement("span");
      bar.style.left = `${(a / dur) * 100}%`;
      bar.style.width = `${Math.max(0.3, ((b - a) / dur) * 100)}%`;
      bar.title = `${fmtTime(a)} ~ ${fmtTime(b)}`;
      track.appendChild(bar);
    }
    for (const k of r.key_changes || []) {
      const ms = r.measures || [];
      const idx = k.bar - (r.pickup ? 0 : 1);
      if (ms[idx] !== undefined) {
        const mark = document.createElement("i");
        mark.style.left = `${(ms[idx] / dur) * 100}%`;
        mark.title = `전조: ${k.key_short}`;
        track.appendChild(mark);
      }
    }
    const stat = document.createElement("span");
    stat.className = "stat";
    const bits = [`연주 ${Math.round((info.active_ratio || 0) * 100)}%`];
    if (info.removed_notes) bits.push(`정리 ${info.removed_notes}음`);
    stat.textContent = bits.join(" · ");
    stat.title = info.bleed_db != null ? `블리딩(새어 들어온 소리) 약 ${info.bleed_db} dB` : "";
    box.append(label, track, stat);
  }
}

// ------------------------------------------------------------------ 믹서
const STEM_LABELS = { mix: "원곡(전체)", vocals: "보컬(메인)", backing_vocals: "코러스", drums: "드럼", bass: "베이스", guitar: "기타", piano: "피아노", other: "건반·신스 등" };

function stopAudio() {
  state.mixerJob = null;
  for (const a of Object.values(state.audios)) { a.pause(); a.src = ""; }
  state.audios = {};
  state.mute.clear();
  state.solo.clear();
  $("#m-play").textContent = "▶ 재생";
}

function masterAudio() {
  return Object.values(state.audios)[0];
}

function buildMixer() {
  const stems = state.result.stems || [];
  const box = $("#mixer");
  if (state.mixerJob === state.job.id && Object.keys(state.audios).length) return;  // 조옮김 후에도 재생 유지
  stopAudio();
  state.mixerJob = state.job.id;
  box.innerHTML = "";
  if (!stems.length) { box.innerHTML = '<p class="muted small">미리듣기 음원이 없습니다.</p>'; return; }
  const order = stems.filter((s) => s !== "mix").concat(stems.includes("mix") ? ["mix"] : []);
  for (const name of order) {
    const a = new Audio(`/api/jobs/${state.job.id}/audio/${name}`);
    a.preload = "auto";
    state.audios[name] = a;
    const row = document.createElement("div");
    row.className = "mix-row";
    row.innerHTML = `<span></span><button class="m" title="음소거">M</button><button class="s" title="이 악기만">S</button><input type="range" min="0" max="100" value="${name === "mix" ? 0 : 90}">`;
    row.firstChild.textContent = STEM_LABELS[name] || name;
    row.querySelector(".m").addEventListener("click", (e) => { toggleSet(state.mute, name); e.target.classList.toggle("on-m", state.mute.has(name)); applyMix(); });
    row.querySelector(".s").addEventListener("click", (e) => { toggleSet(state.solo, name); e.target.classList.toggle("on-s", state.solo.has(name)); applyMix(); });
    row.querySelector("input").addEventListener("input", applyMix);
    row.dataset.name = name;
    box.appendChild(row);
  }
  const master = masterAudio();
  master.addEventListener("timeupdate", onTime);
  master.addEventListener("ended", () => { $("#m-play").textContent = "▶ 재생"; });
  applyMix();
}

function toggleSet(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }

function applyMix() {
  for (const row of $$("#mixer .mix-row")) {
    const name = row.dataset.name;
    const a = state.audios[name];
    if (!a) continue;
    const vol = row.querySelector("input").value / 100;
    const audible = state.solo.size ? state.solo.has(name) : !state.mute.has(name);
    a.volume = audible ? vol : 0;
  }
}

function togglePlay() {
  const all = Object.values(state.audios);
  if (!all.length) return;
  const master = all[0];
  if (master.paused) {
    const t = master.currentTime;
    for (const a of all) { a.currentTime = t; a.play().catch(() => {}); }
    $("#m-play").textContent = "⏸ 일시정지";
  } else {
    for (const a of all) a.pause();
    $("#m-play").textContent = "▶ 재생";
  }
}

function seekAll(t) {
  for (const a of Object.values(state.audios)) a.currentTime = t;
  const m = masterAudio();
  if (!m || m.paused) setTimeout(onTime, 30);
}

function onTime() {
  const all = Object.values(state.audios);
  const master = all[0];
  const t = master.currentTime;
  if (isFinite(master.duration)) $("#m-seek").value = Math.round((t / master.duration) * 1000);
  $("#m-time").textContent = `${fmtTime(t)} / ${fmtTime(master.duration)}`;
  // 여러 스템이 어긋나지 않게 맞추기
  for (const a of all.slice(1)) {
    if (!master.paused && Math.abs(a.currentTime - t) > 0.08) a.currentTime = t;
  }
  if ($("#m-follow").checked && state.pane === "score") followMeasure(t);
  highlightSection(measureAt(t));
  Views.tick(t);
  const c = Views.chordAt(t);
  $("#player-chord").textContent = c ? (Views.ctx.numbers ? c.number : c.name) : "";
}

function measureAt(t) {
  const ms = (state.view && state.view.measures) || [];
  let lo = 0, hi = ms.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function followMeasure(t) {
  const osmd = state.osmd;
  if (!osmd || !osmd.cursor) return;
  const m = measureAt(t);
  if (m === state.lastMeasure) return;
  const cursor = osmd.cursor;
  const idx = () => (cursor.Iterator || cursor.iterator).CurrentMeasureIndex;
  if (m < state.lastMeasure || state.lastMeasure < 0) cursor.reset();
  cursor.show();
  let guard = 0;
  while (idx() < m && !(cursor.Iterator || cursor.iterator).EndReached && guard++ < 5000) cursor.next();
  state.lastMeasure = m;
}

// ------------------------------------------------------------------ 시작
window.addEventListener("DOMContentLoaded", async () => {
  initNewView();
  initSourceView();
  initRemix();
  initResultView();
  $("#btn-new").addEventListener("click", () => {
    stopAudio();
    clearTimeout(state.pollTimer);
    state.jobId = null;
    loadJobs();
    show("new");
  });
  $("#btn-engines").addEventListener("click", () => $("#engines-dialog").showModal());
  try {
    await loadInfo();
  } catch (e) {
    $("#start-error").textContent = `서버에 연결하지 못했습니다: ${e.message}`;
  }
  const jobs = await loadJobs().catch(() => []);
  const params = new URLSearchParams(location.search);
  if (params.get("job")) openJob(params.get("job"));
  else if (jobs.length && jobs[0].status !== "done") openJob(jobs[0].id);
  else show("new");
});
