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
  jobEpoch: 0,
  jobRequest: 0,
  viewRequest: 0,
  scoreRequest: 0,
  sheetRequest: 0,
  refreshing: null,
  renderQueues: new Map(),
  sheetLoading: null,
  jobsRequest: 0,
  analysisJobs: new Set(),
  deletingJobs: new Set(),
  startingJob: false,
  job: null,
  result: null,
  tab: "full_score",
  zoom: 1.0,
  osmd: null,
  pollTimer: null,
  audios: {},
  gains: {},
  ctx: null,
  playKey: 0,
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
  for (const v of ["new", "source", "progress", "choose", "result"]) $(`#view-${v}`).classList.toggle("hidden", v !== view);
  if (view !== "source") { $("#s-video").pause(); $("#s-audio").pause(); }
  if (view !== "choose" && state.chooseAudio) state.chooseAudio.pause();
}

function jobContext() {
  return { id: state.jobId, epoch: state.jobEpoch };
}

function isCurrentJob(context) {
  return context.id === state.jobId && context.epoch === state.jobEpoch;
}

function canLeaveJob() {
  return !Views.hasUnsaved() || confirm("저장하지 않은 악보 수정이 있어요. 수정을 버리고 계속할까요?");
}

async function newJob() {
  if (!canLeaveJob()) return false;
  selectJob(null);
  await loadJobs();
  return true;
}

function selectJob(id) {
  Views.discardUnsaved();
  stopAudio();
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.jobEpoch++;
  state.jobId = id;
  state.job = null;
  state.result = null;
  state.tab = "full_score";
  state.osmd = null;
  $("#sheet").replaceChildren();
  state.refreshing = null;
  state.sheetLoading = null;
  $("#sheet-loading").classList.add("hidden");
  updateScoreButtons();
  updateAnalysisButtons();
  updateDeleteButtons();
  $("#player").classList.add("hidden");
  show(id ? "progress" : "new");
  if (id) {
    $("#p-heading").textContent = "작업 불러오는 중";
    $("#p-title").textContent = "작업 불러오는 중…";
    updateProgress(0, "작업 상태를 확인하고 있습니다.");
    $("#p-log").textContent = "";
    $("#p-error").textContent = "";
    $("#p-retry").classList.add("hidden");
    $("#p-refresh").classList.add("hidden");
  }
}

function updateProgress(progress, stage) {
  const value = Math.max(0, Math.min(100, Math.round((Number(progress) || 0) * 100)));
  const bar = $("#p-bar");
  bar.style.width = `${value}%`;
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", "악보 분석 진행률");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(value));
  bar.setAttribute("aria-valuetext", `${value}% · ${stage}`);
  $("#p-stage").textContent = stage;
  $("#p-stage").setAttribute("role", "status");
  $("#p-stage").setAttribute("aria-live", "polite");
  $("#p-error").setAttribute("role", "alert");
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
  for (const k of [...MAJOR_KEYS, ...MINOR_KEYS]) tk.add(new Option(keyName(k), k));
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
  $("#btn-start").disabled = state.startingJob || !(url || state.file);
  $("#btn-start").setAttribute("aria-busy", String(state.startingJob));
  const what = $("#keep-video").checked ? "영상" : "음성";
  $("#btn-start").textContent = state.startingJob ? "시작하는 중…" : url && $("#fetch-only").checked ? `${what} 받기 시작` :
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
  $$("#quality button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.v === state.quality));
    b.addEventListener("click", () => {
      $$("#quality button").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      state.quality = b.dataset.v;
    });
  });
  $("#url").addEventListener("input", updateStartButton);
  $("#url").addEventListener("keydown", (e) => { if (e.key === "Enter" && urlValue()) startJob(); });
  $("#fetch-only").addEventListener("change", updateStartButton);
  $("#keep-video").addEventListener("change", updateStartButton);
  $("#btn-start").addEventListener("click", startJob);
  $("#c-make").addEventListener("click", makeSongs);
  $("#c-add").addEventListener("click", addManualSong);
}

async function startJob() {
  if (state.startingJob || !(urlValue() || state.file)) return;
  state.startingJob = true;
  const context = jobContext();
  const file = state.file;
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
    split_songs: $("#split-songs").checked,
  };
  const url = urlValue();
  updateStartButton();
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
      if (isCurrentJob(context) && urlValue() === url) $("#url").value = "";
    } else {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("options", JSON.stringify(options));
      job = await api("/api/jobs", { method: "POST", body: fd });
      if (isCurrentJob(context) && state.file === file) {
        setFile(null);
        $("#file").value = "";
      }
    }
    await loadJobs();
    if (isCurrentJob(context)) await openJob(job.id);
  } catch (e) {
    if (isCurrentJob(context)) $("#start-error").textContent = e.message;
  } finally {
    state.startingJob = false;
    updateStartButton();
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
  updateAnalysisButtons();
}

function updateAnalysisButtons() {
  const pending = state.analysisJobs.has(state.jobId);
  const canAnalyze = state.job && state.job.id === state.jobId && ["ready", "error"].includes(state.job.status);
  for (const [selector, label] of [["#s-analyze", "악보 만들기 시작"], ["#p-retry", "분석 다시 시도"]]) {
    const button = $(selector);
    button.disabled = pending || !canAnalyze;
    button.textContent = pending ? "시작하는 중…" : label;
    button.setAttribute("aria-busy", String(pending));
  }
}

function updateDeleteButtons() {
  const pending = state.deletingJobs.has(state.jobId);
  for (const selector of ["#s-delete", "#r-delete"]) {
    $(selector).disabled = pending;
    $(selector).setAttribute("aria-busy", String(pending));
  }
}

async function deleteJob(message, errorEl) {
  const context = jobContext();
  if (!context.id || state.deletingJobs.has(context.id) || !canLeaveJob() || !confirm(message)) return false;
  state.deletingJobs.add(context.id);
  updateDeleteButtons();
  if (errorEl) errorEl.textContent = "";
  try {
    await api(`/api/jobs/${context.id}`, { method: "DELETE" });
    if (isCurrentJob(context)) selectJob(null);
    if (state.sourceJob === context.id) state.sourceJob = null;
    await loadJobs();
    return true;
  } catch (e) {
    if (isCurrentJob(context)) {
      if (errorEl) errorEl.textContent = e.message;
      else toast(e.message);
    }
    return false;
  } finally {
    state.deletingJobs.delete(context.id);
    updateDeleteButtons();
  }
}

async function startAnalysis(options, errorEl) {
  const context = jobContext();
  const job = state.job;
  if (!job || job.id !== context.id || !["ready", "error"].includes(job.status) || state.analysisJobs.has(context.id)) return;
  state.analysisJobs.add(context.id);
  updateAnalysisButtons();
  errorEl.textContent = "";
  try {
    await api(`/api/jobs/${context.id}/analyze`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ options }),
    });
    // The accepted action still belongs to this job after navigating away and back.
    if (state.jobId === context.id && state.job) state.job.status = "queued";
    await loadJobs();
    if (state.jobId === context.id) await refreshJob();
  } catch (e) {
    if (isCurrentJob(context)) errorEl.textContent = e.message;
  } finally {
    state.analysisJobs.delete(context.id);
    updateAnalysisButtons();
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
  $("#p-refresh").addEventListener("click", refreshJob);
  $("#p-new").addEventListener("click", newJob);
  $("#s-delete").addEventListener("click", () => deleteJob("받은 파일을 지울까요?", $("#s-error")));
}

// ------------------------------------------------------------------ 작업 목록
async function loadJobs() {
  const request = ++state.jobsRequest;
  const ul = $("#job-list");
  const retry = $("#jobs-retry");
  ul.setAttribute("aria-busy", "true");
  retry.disabled = true;
  retry.textContent = "목록 확인하는 중…";
  let jobs;
  try {
    jobs = await api("/api/jobs");
  } catch (e) {
    if (request === state.jobsRequest) {
      $("#jobs-error").textContent = `작업 목록을 불러오지 못했습니다: ${e.message}`;
      $("#jobs-error").classList.remove("hidden");
      retry.classList.remove("hidden");
      $("#job-empty").classList.add("hidden");
    }
    return [];
  } finally {
    if (request === state.jobsRequest) {
      ul.setAttribute("aria-busy", "false");
      retry.disabled = false;
      retry.textContent = "목록 다시 확인";
    }
  }
  if (request !== state.jobsRequest) return jobs;
  $("#jobs-error").textContent = "";
  $("#jobs-error").classList.add("hidden");
  retry.classList.add("hidden");
  const focusedJob = document.activeElement && document.activeElement.dataset.jobId;
  ul.innerHTML = "";
  $("#job-empty").classList.toggle("hidden", jobs.length > 0);
  for (const j of jobs) {
    const li = document.createElement("li");
    li.classList.toggle("active", j.id === state.jobId);
    const st = j.status === "done" ? `완료 · ${j.key || ""}` : j.status === "error" ? "오류" :
      j.status === "choose" ? `곡 고르기 · ${j.songs}곡` :
      j.status === "ready" ? "영상·음성 준비됨 · 악보 만들기 전" :
      j.status === "queued" ? "대기 중" : `${Math.round(j.progress * 100)}% · ${j.stage}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "job-button";
    button.dataset.jobId = j.id;
    if (j.id === state.jobId) button.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "t";
    title.textContent = j.title;
    const status = document.createElement("span");
    status.className = `s ${j.status}`;
    status.textContent = st;
    button.append(title, status);
    button.addEventListener("click", () => openJob(j.id));
    li.appendChild(button);
    ul.appendChild(li);
    if (focusedJob === j.id) button.focus({ preventScroll: true });
  }
  return jobs;
}

async function openJob(id) {
  if (id === state.jobId && state.job) return true;
  if (!canLeaveJob()) return false;
  selectJob(id);
  const context = jobContext();
  await loadJobs();
  if (isCurrentJob(context)) await refreshJob();
}

async function refreshJob() {
  const context = jobContext();
  if (!context.id) return;
  const request = ++state.jobRequest;
  const current = () => isCurrentJob(context) && request === state.jobRequest;
  const retry = $("#p-refresh");
  retry.disabled = true;
  retry.setAttribute("aria-busy", "true");
  retry.textContent = "다시 확인하는 중…";
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  let job;
  try {
    job = await api(`/api/jobs/${context.id}`);
  } catch (e) {
    if (!current()) return;
    if (!state.job || ["queued", "running"].includes(state.job.status)) {
      show("progress");
      $("#player").classList.add("hidden");
      $("#p-heading").textContent = "작업을 확인하지 못했습니다";
      $("#p-title").textContent = state.job ? state.job.title : "선택한 작업";
      updateProgress(state.job ? state.job.progress : 0, "연결을 확인한 뒤 작업 상태를 다시 불러오세요.");
      $("#p-error").textContent = e.message;
      $("#p-retry").classList.add("hidden");
      retry.classList.remove("hidden");
      if (state.job) state.pollTimer = setTimeout(() => { if (current()) refreshJob(); }, 2500);
    } else {
      toast(e.message);
    }
    return;
  } finally {
    if (current()) {
      retry.disabled = false;
      retry.setAttribute("aria-busy", "false");
      retry.textContent = "상태 다시 확인";
    }
  }
  if (!current()) return;
  retry.classList.add("hidden");
  state.job = job;
  updateAnalysisButtons();
  if (job.status === "done") {
    await showResult();
    loadJobs();
    return;
  }
  if (job.status === "choose") {
    showChoose(job);
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
  $("#p-heading").textContent = job.status === "error" ? "분석을 완료하지 못했습니다" : job.status === "queued" ? "분석 대기 중" : "악보 분석 중";
  updateProgress(job.progress, job.status === "error" ? "오류를 확인한 뒤 분석을 다시 시도하거나 다른 파일로 시작하세요." :
    job.status === "queued" ? "다른 작업이 끝나기를 기다리는 중…" : job.stage);
  $("#p-log").textContent = job.log.join("\n");
  $("#p-log").scrollTop = 1e9;
  $("#p-error").textContent = job.error || "";
  $("#p-retry").classList.toggle("hidden", job.status !== "error");
  if (job.status === "running" || job.status === "queued") {
    state.pollTimer = setTimeout(() => {
      if (current()) { refreshJob(); loadJobs(); }
    }, 1200);
  } else {
    loadJobs();
  }
}

// ------------------------------------------------------------------ 곡 나누기: 곡 고르기
function showChoose(job) {
  show("choose");
  $("#player").classList.add("hidden");
  $("#c-title").textContent = `${job.title} — 곡 ${job.songs.length}개를 찾았어요`;
  $("#c-error").textContent = job.songs.length ? "" : "찬양 구간을 찾지 못했어요. 구간을 직접 추가해 주세요.";
  if (!state.chooseAudio || state.chooseJob !== job.id) {
    if (state.chooseAudio) state.chooseAudio.pause();
    state.chooseAudio = new Audio(`/api/jobs/${job.id}/audio/full`);
    state.chooseJob = job.id;
    state.chooseAudio.addEventListener("timeupdate", drawChooseCursor);
  }
  state.picks = job.songs.map((s) => ({ ...s, on: true, title: "" }));
  renderChoose(job);
}

function renderChoose(job) {
  const total = job.duration || Math.max(1, ...state.picks.map((p) => p.end));
  const tl = $("#c-timeline");
  tl.innerHTML = '<div class="cursor"></div>';
  state.picks.forEach((p, i) => {
    const seg = document.createElement("div");
    seg.className = "seg" + (p.on ? "" : " off");
    seg.style.left = `${(p.start / total) * 100}%`;
    seg.style.width = `${Math.max(0.5, ((p.end - p.start) / total) * 100)}%`;
    seg.textContent = `${i + 1}`;
    seg.title = `${fmtTime(p.start)} ~ ${fmtTime(p.end)}`;
    seg.addEventListener("click", () => previewSong(i));
    tl.appendChild(seg);
  });
  const box = $("#c-songs");
  box.innerHTML = "";
  state.picks.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "c-song";
    row.innerHTML = `<input type="checkbox" ${p.on ? "checked" : ""}>
      <input class="name" placeholder="${i + 1}번째 곡 (제목을 적어 두면 좋아요)">
      <span class="meta"></span>
      <span class="small">시작 <input type="number" class="st" min="0" step="1"> 끝 <input type="number" class="en" min="1" step="1"></span>
      <button class="ghost">▶ 들어보기</button>`;
    row.querySelector(".name").value = p.title || "";
    row.querySelector(".meta").textContent =
      `${fmtTime(p.start)}~${fmtTime(p.end)} · ${fmtTime(p.end - p.start)}` + (p.key ? ` · 키 ${p.key}` : "") + (p.tempo ? ` · 약 ${Math.round(p.tempo)} BPM` : "");
    row.querySelector(".st").value = Math.round(p.start);
    row.querySelector(".en").value = Math.round(p.end);
    row.querySelector("input[type=checkbox]").addEventListener("change", (e) => { p.on = e.target.checked; renderChooseTimeline(job); });
    row.querySelector(".name").addEventListener("input", (e) => { p.title = e.target.value; });
    row.querySelector(".st").addEventListener("change", (e) => { p.start = Math.max(0, +e.target.value); renderChoose(job); });
    row.querySelector(".en").addEventListener("change", (e) => { p.end = Math.max(p.start + 5, +e.target.value); renderChoose(job); });
    row.querySelector("button").addEventListener("click", () => previewSong(i));
    box.appendChild(row);
  });
  $("#c-make").disabled = !state.picks.some((p) => p.on);
}

function renderChooseTimeline(job) {
  $$("#c-timeline .seg").forEach((el, i) => el.classList.toggle("off", !state.picks[i].on));
  $("#c-make").disabled = !state.picks.some((p) => p.on);
}

function previewSong(i) {
  const a = state.chooseAudio, p = state.picks[i];
  if (!a) return;
  if (!a.paused && state.previewing === i) { a.pause(); return; }
  state.previewing = i;
  a.currentTime = p.start;
  a.play().catch(() => {});
}

function drawChooseCursor() {
  const a = state.chooseAudio, job = state.job;
  if (!a || !job || job.status !== "choose") return;
  const total = job.duration || 1;
  const c = $("#c-timeline .cursor");
  if (c) c.style.left = `${(a.currentTime / total) * 100}%`;
}

async function makeSongs() {
  const picks = state.picks.filter((p) => p.on).map((p) => ({ start: p.start, end: p.end, title: p.title || null, index: p.index }));
  if (!picks.length) return;
  $("#c-make").disabled = true;
  try {
    const r = await api(`/api/jobs/${state.job.id}/songs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ songs: picks }) });
    if (state.chooseAudio) state.chooseAudio.pause();
    toast(`${r.jobs.length}곡의 악보를 만들기 시작했어요`);
    await loadJobs();
    if (r.jobs.length) openJob(r.jobs[0]);
  } catch (e) {
    $("#c-error").textContent = e.message;
    $("#c-make").disabled = false;
  }
}

function addManualSong() {
  const a = state.chooseAudio;
  const t = a ? Math.floor(a.currentTime) : 0;
  state.picks.push({ start: t, end: t + 240, on: true, title: "", index: state.picks.length });
  renderChoose(state.job);
}

// ------------------------------------------------------------------ 결과 화면
async function showResult() {
  const context = jobContext();
  const job = state.job;
  state.result = job.result;
  show("result");
  $("#player").classList.remove("hidden");
  $("#r-title").textContent = job.title;
  $("#r-title").title = job.title;
  buildMixer();
  renderActivity();
  renderFiles();
  const keep = state.viewJob === job.id && state.view;
  const loaded = await loadView({ semitones: keep ? state.view.semitones : (job.result.semitones || 0) });
  if (loaded && isCurrentJob(context)) switchView(state.pane || "chart");
}

async function loadView(params, { discardUnsaved = false } = {}) {
  const context = jobContext();
  if (!state.job || state.job.id !== context.id) return false;
  const editRevision = discardUnsaved ? Views.getEditRevision() : null;
  const request = ++state.viewRequest;
  const current = () => isCurrentJob(context) && request === state.viewRequest;
  const q = new URLSearchParams();
  if (params.target_key) q.set("key", params.target_key);
  else q.set("semitones", String(params.semitones || 0));
  $("#t-info").textContent = "불러오는 중…";
  try {
    const v = await api(`/api/jobs/${context.id}/view?${q}`);
    if (!current()) return false;
    if (discardUnsaved && Views.getEditRevision() !== editRevision) {
      renderHeader();
      $("#t-info").textContent = "기다리는 동안 수정한 내용이 있어 조옮김을 적용하지 않았습니다. 다시 조옮김해 주세요.";
      return false;
    }
    if (discardUnsaved) Views.discardUnsaved();
    state.view = v;
    state.viewJob = context.id;
    updateScoreButtons();
    renderHeader();
    renderStructure();
    Views.setData(v, context.id);
    updateStale();
    syncPlaybackKey();
    if (state.pane === "score" && scoreStale()) refreshScore();
    return true;
  } catch (e) {
    if (current()) {
      if (discardUnsaved && state.view) renderHeader();
      $("#t-info").textContent = e.message;
    }
    return false;
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
  const context = jobContext();
  const view = state.view;
  if (!state.job || state.job.id !== context.id || !view) return;
  if (state.refreshing && isCurrentJob(state.refreshing.context) && state.refreshing.view === view) return;
  const token = { context, view, request: ++state.scoreRequest };
  const current = () => isCurrentJob(context) && state.view === view && token.request === state.scoreRequest;
  state.refreshing = token;
  updateScoreButtons();
  beginSheetLoading(token, "오선 악보·파일 만드는 중…");
  // Rendering writes output files and the server's saved result. Serialize each
  // job's writes, skipping superseded queued views while other jobs remain usable.
  const previous = state.renderQueues.get(context.id);
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  state.renderQueues.set(context.id, turn);
  try {
    if (previous) await previous;
    if (!current()) return;
    const result = await api(`/api/jobs/${context.id}/render`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ semitones: view.semitones }),
    });
    if (!current()) return;
    state.result = result;
    renderFiles();
    updateStale();
    renderActivity();
    if (state.pane === "score") renderScorePane();
    loadJobs();
  } catch (e) {
    if (current()) toast(e.message);
  } finally {
    release();
    if (state.renderQueues.get(context.id) === turn) state.renderQueues.delete(context.id);
    if (state.refreshing === token) {
      state.refreshing = null;
      updateScoreButtons();
    }
    endSheetLoading(token);
  }
}

function updateScoreButtons() {
  const pending = !!state.refreshing && isCurrentJob(state.refreshing.context) && state.refreshing.view === state.view;
  for (const selector of ["#score-refresh", "#files-refresh"]) {
    $(selector).disabled = pending;
    $(selector).setAttribute("aria-busy", String(pending));
  }
}

function beginSheetLoading(token, label) {
  state.sheetLoading = token;
  $("#sheet-loading").textContent = label;
  $("#sheet-loading").classList.remove("hidden");
}

function endSheetLoading(token) {
  if (state.sheetLoading !== token) return;
  state.sheetLoading = null;
  $("#sheet-loading").textContent = "악보 그리는 중…";
  $("#sheet-loading").classList.add("hidden");
}

function switchView(name) {
  state.pane = name;
  $$("#viewtabs button").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === name);
    b.setAttribute("aria-pressed", String(b.dataset.view === name));
  });
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
    b.type = "button";
    b.innerHTML = `<span></span>${it.badge ? ` <span class="badge">${it.badge}</span>` : ""}`;
    b.firstChild.textContent = it.label;
    b.classList.toggle("on", it.id === state.tab);
    b.setAttribute("aria-pressed", String(it.id === state.tab));
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
  const context = jobContext();
  const r = state.result;
  const part = state.tab;
  if (!r || !state.job || state.job.id !== context.id) return;
  const token = { request: ++state.sheetRequest };
  const current = () => isCurrentJob(context) && state.result === r && state.tab === part && token.request === state.sheetRequest;
  beginSheetLoading(token, "악보 그리는 중…");
  try {
    const xml = await api(`/api/jobs/${context.id}/files/${r.sheet_dir}/${part}.musicxml`);
    if (!current()) return;
    // OSMD.load mutates its instance asynchronously. Keep it detached until this
    // exact job visit, output revision, and selected part are still current.
    const container = document.createElement("div");
    const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
      autoResize: false, backend: "svg", drawTitle: false, drawSubtitle: false, drawComposer: false,
      drawLyricist: false, drawCredits: false, drawingParameters: "default", followCursor: true,
      newSystemFromXML: true, // 악보 파일에 넣은 줄바꿈(구간 시작·4마디) 그대로
      newPageFromXML: false,
      autoGenerateMultipleRestMeasuresFromRestMeasures: true, // 쉬는 마디는 여러 마디 쉼표로
      drawPartAbbreviations: true, stretchLastSystemLine: false,
    });
    const R = osmd.EngravingRules;
    R.ChordSymbolTextHeight = 2.3; // 코드 이름 크게
    R.RehearsalMarkFontSize = 11;
    // 템포 표시와 첫 구간 상자가 겹치지 않게: 템포는 위로, 줄 첫 마디의 구간 상자는 오른쪽으로
    R.MetronomeMarkYShift = -4.5;
    R.RehearsalMarkXOffsetSystemStartMeasure = 0;
    R.LyricsHeight = 2.2;
    R.SheetSubtitleHeight = 1.8;
    R.MinimumDistanceBetweenSystems = 6;
    R.VoiceSpacingMultiplierVexflow = 0.75; // 조금 촘촘하게 (기본 0.85 / 3)
    R.VoiceSpacingAddendVexflow = 2.5;
    await osmd.load(xml);
    if (!current()) return;
    $("#sheet").replaceChildren(container);
    state.osmd = osmd;
    drawSheet();
    state.lastMeasure = -1;
  } catch (e) {
    if (current()) {
      $("#sheet").textContent = `악보를 불러오지 못했습니다: ${e.message}`;
      state.osmd = null;
    }
  } finally {
    endSheetLoading(token);
  }
}

async function transpose(body) {
  if (!canLeaveJob()) { renderHeader(); return; }
  await loadView(body, { discardUnsaved: true });
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
  $("#r-delete").addEventListener("click", () => deleteJob("이 작업과 만든 악보를 모두 지울까요?"));
  $("#m-play").addEventListener("click", togglePlay);
  $$("#mix-preset button").forEach((b) => b.addEventListener("click", () => setPreset(b.dataset.p)));
  $("#m-keyfollow").addEventListener("change", syncPlaybackKey);
  $("#dl-mr").addEventListener("click", downloadMr);
  $("#dl-inst").addEventListener("click", downloadMr);
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
    reload: () => loadView({ semitones: state.view ? state.view.semitones : 0 }).then((loaded) => {
      if (loaded) { markStale(); refreshScoreAudio(); }
    }),
  });
}

// 4마디씩 끊은 줄이 화면 폭에 안 들어가면 OSMD 가 마지막 마디만 다음 줄로 넘긴다.
// 그런 외톨이 마디가 생기면 배율을 조금씩 줄여(최대 70%까지) 다시 그린다.
function lonelyBars(osmd) {
  let n = 0;
  for (const page of osmd.GraphicSheet.MusicPages) {
    const systems = page.MusicSystems;
    systems.forEach((sys, i) => {
      const bars = sys.GraphicalMeasures;
      if (bars.length !== 1 || i === systems.length - 1) return;
      const m = (bars[0] || []).find((x) => x);
      if (m && m.parentSourceMeasure && m.parentSourceMeasure.multipleRestMeasures > 0) return;
      const prev = systems[i - 1];
      if (prev && prev.GraphicalMeasures.length >= 3) n++;
    });
  }
  return n;
}

function drawSheet() {
  const osmd = state.osmd;
  let fit = 1;
  osmd.zoom = state.zoom;
  osmd.render();
  try {
    while (fit > 0.75 && lonelyBars(osmd) > 0) {
      fit = Math.round((fit - 0.1) * 10) / 10;
      osmd.zoom = state.zoom * fit;
      osmd.render();
    }
  } catch (e) {
    console.warn("auto-fit", e);
  }
  $("#z-val").textContent = `${Math.round(state.zoom * 100)}%` + (fit < 1 ? ` (맞춤 ${Math.round(state.zoom * fit * 100)}%)` : "");
}

// 창 크기가 바뀌면 오선 악보가 보일 때만 다시 그린다 (숨겨진 상태에서 그리면 폭이 0)
window.addEventListener("resize", () => {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    if (state.osmd && state.pane === "score" && !$("#v-score").classList.contains("hidden")) drawSheet();
  }, 250);
});

function setZoom(z) {
  state.zoom = Math.min(2, Math.max(0.4, Math.round(z * 10) / 10));
  $("#z-val").textContent = `${Math.round(state.zoom * 100)}%`;
  if (state.osmd) drawSheet();
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
const STEM_LABELS = { score: "악보 소리 (채보 음표)", mix: "원곡(전체)", vocals: "보컬(메인)", backing_vocals: "코러스", drums: "드럼", bass: "베이스", guitar: "기타", piano: "피아노", other: "건반·신스 등" };

function stopAudio() {
  state.mixerJob = null;
  for (const a of Object.values(state.audios)) { a.pause(); a.removeAttribute("src"); a.load(); }
  state.audios = {};
  state.gains = {};
  state.mute.clear();
  state.solo.clear();
  state.playKey = 0;
  $("#m-play").textContent = "재생";
}

function masterAudio() {
  return Object.values(state.audios)[0];
}

// 소리는 Web Audio 로 모아서 낸다: 악기마다 볼륨(부드럽게 바뀌어 '틱' 소리가 없음) → 전체 → 리미터(찌그러짐 방지)
function ensureGraph() {
  if (state.ctx) return state.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    const ctx = new AC({ latencyHint: "playback" });
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.002; limiter.release.value = 0.12;
    const master = ctx.createGain();
    master.connect(limiter).connect(ctx.destination);
    state.ctx = ctx; state.master = master;
  } catch (e) { return null; }
  return state.ctx;
}

function connectAudio(name, a) {
  const ctx = state.ctx;
  if (!ctx || state.gains[name]) return;
  try {
    const g = ctx.createGain();
    ctx.createMediaElementSource(a).connect(g).connect(state.master);
    state.gains[name] = g;
    a.volume = 1;
  } catch (e) { /* 연결 실패하면 audio.volume 으로 */ }
}

function audioUrl(name, semis) {
  return `/api/jobs/${state.job.id}/audio/${name}` + (semis ? `?semitones=${semis}` : "");
}

const MIX_HIDE = new Set(["mr", "inst"]);  // 반주 파일은 믹서 줄 대신 프리셋·내려받기로

function buildMixer() {
  const stems = (state.result.stems || []).filter((s) => !MIX_HIDE.has(s));
  const box = $("#mixer");
  if (state.mixerJob === state.job.id && Object.keys(state.audios).length) return;  // 조옮김 후에도 재생 유지
  stopAudio();
  state.mixerJob = state.job.id;
  box.innerHTML = "";
  const synth = !!(state.info && state.info.synth);
  if (!stems.length && !synth) { box.innerHTML = '<p class="muted small">미리듣기 음원이 없습니다.</p>'; return; }
  const order = stems.filter((s) => s !== "mix").concat(stems.includes("mix") ? ["mix"] : []);
  // 악보 소리: 채보한 음표를 실제 악기 음색으로 연주 (원곡과 같은 시간축 — 같이 들으며 채보 확인)
  // MIDI·MusicXML 로 만든 작업은 원곡 음원이 없어 악보 소리만 있다
  if (synth) order.push("score");
  for (const name of order) {
    const a = new Audio(audioUrl(name, 0));
    a.preload = "auto";
    a.preservesPitch = false; a.webkitPreservesPitch = false;  // 싱크 맞출 때 아주 조금 빠르게/느리게 — 늘이기 잡음 없이
    state.audios[name] = a;
    const row = document.createElement("div");
    row.className = "mix-row";
    const off = name === "mix" || (name === "score" && order.length > 1);
    row.innerHTML = `<span></span><button class="m" title="음소거">M</button><button class="s" title="이 악기만">S</button><input type="range" min="0" max="100" value="${off ? 0 : 90}">`;
    row.firstChild.textContent = STEM_LABELS[name] || name;
    const label = STEM_LABELS[name] || name;
    row.querySelector(".m").setAttribute("aria-label", `${label} 음소거`);
    row.querySelector(".s").setAttribute("aria-label", `${label}만 재생`);
    row.querySelector("input").setAttribute("aria-label", `${label} 음량`);
    row.querySelector(".m").addEventListener("click", () => { toggleSet(state.mute, name); setPreset(null); applyMix(); });
    row.querySelector(".s").addEventListener("click", () => { toggleSet(state.solo, name); setPreset(null); applyMix(); });
    row.querySelector("input").addEventListener("input", applyMix);
    row.dataset.name = name;
    box.appendChild(row);
  }
  const master = masterAudio();
  master.addEventListener("timeupdate", onTime);
  master.addEventListener("ended", () => { $("#m-play").textContent = "재생"; });
  $("#preset-score").classList.toggle("hidden", !state.audios.score);
  setPreset("all");
  applyMix();
  updateDownloads();
}

function toggleSet(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }

// 프리셋: 전체 / 반주(MR: 메인 보컬 음소거) / 보컬만
function setPreset(p) {
  $$("#mix-preset button").forEach((b) => b.classList.toggle("on", b.dataset.p === p));
  if (!p) return;
  state.mute.clear(); state.solo.clear();
  if (p === "mr") state.mute.add("vocals");
  if (p === "vocal") { state.solo.add("vocals"); if (state.audios.backing_vocals) state.solo.add("backing_vocals"); }
  if (p === "score") {
    state.solo.add("score");
    const row = $('#mixer .mix-row[data-name="score"] input');
    if (row && row.value === "0") row.value = 90;
  }
  applyMix();
}

function applyMix() {
  const now = state.ctx ? state.ctx.currentTime : 0;
  for (const row of $$("#mixer .mix-row")) {
    const name = row.dataset.name;
    const a = state.audios[name];
    if (!a) continue;
    for (const [cls, on, set] of [[".m", "on-m", state.mute], [".s", "on-s", state.solo]]) {
      const b = row.querySelector(cls);
      b.classList.toggle(on, set.has(name));
      b.setAttribute("aria-pressed", String(set.has(name)));
    }
    const vol = row.querySelector("input").value / 100;
    const audible = state.solo.size ? state.solo.has(name) : !state.mute.has(name);
    const v = audible ? vol * vol : 0;  // 귀에 고르게 들리도록 제곱 곡선
    const g = state.gains[name];
    if (g) g.gain.setTargetAtTime(v, now, 0.03);
    else a.volume = v;
  }
}

function togglePlay() {
  const all = Object.values(state.audios);
  if (!all.length) return;
  if (ensureGraph()) {
    for (const [name, a] of Object.entries(state.audios)) connectAudio(name, a);
    if (state.ctx.state === "suspended") state.ctx.resume();
    applyMix();
  }
  const master = all[0];
  if (master.paused) {
    const t = master.currentTime;
    for (const a of all) { a.currentTime = t; a.playbackRate = 1; a.play().catch(() => {}); }
    $("#m-play").textContent = "일시정지";
  } else {
    for (const a of all) a.pause();
    $("#m-play").textContent = "재생";
  }
}

function seekAll(t) {
  for (const a of Object.values(state.audios)) { a.currentTime = t; a.playbackRate = 1; }
  const m = masterAudio();
  if (!m || m.paused) setTimeout(onTime, 30);
}

// 여러 스템이 어긋나지 않게: 조금 어긋나면 속도를 아주 살짝(±0.4% 이하) 바꿔 따라잡고, 많이 어긋날 때만 위치를 옮긴다
function syncStems(master) {
  const t = master.currentTime;
  for (const a of Object.values(state.audios)) {
    if (a === master || a.paused) continue;
    const drift = a.currentTime - t;
    if (Math.abs(drift) > 0.25) { a.currentTime = t; a.playbackRate = 1; }
    else if (Math.abs(drift) > 0.012) a.playbackRate = 1 - Math.max(-0.004, Math.min(0.004, drift * 0.1));
    else if (a.playbackRate !== 1) a.playbackRate = 1;
  }
}

// ------------------------------------------------------------------ 조옮김한 키로 듣기
async function syncPlaybackKey() {
  if (!state.view || !Object.keys(state.audios).length) return;
  const want = $("#m-keyfollow").checked ? (state.view.semitones || 0) : 0;
  updateDownloads();
  if (want === (state.playKey || 0)) { $("#pb-status").classList.add("hidden"); return; }
  const token = (state.pbToken = (state.pbToken || 0) + 1);
  const box = $("#pb-status");
  try {
    let st = await api(`/api/jobs/${state.job.id}/playback`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ semitones: want }) });
    while (st.status === "working") {
      if (token !== state.pbToken) return;
      box.textContent = `${keyLabel(want)} 키로 반주를 옮기는 중… ${Math.round(st.progress * 100)}% (원래 키로 계속 들을 수 있어요)`;
      box.classList.remove("hidden");
      await new Promise((r) => setTimeout(r, 1200));
      st = await api(`/api/jobs/${state.job.id}/playback?semitones=${want}`);
    }
    if (token !== state.pbToken) return;
    if (st.status !== "ready") throw new Error(st.error || "음원을 만들지 못했습니다");
    swapSources(want);
    box.classList.add("hidden");
  } catch (e) {
    box.textContent = `키를 옮긴 음원을 만들지 못했습니다: ${e.message}`;
    box.classList.remove("hidden");
  }
}

function keyLabel(semis) {
  const v = state.view;
  return semis === v.semitones ? v.key_short : (semis ? `${semis > 0 ? "+" : ""}${semis}` : v.original_key_short);
}

function swapSources(semis) {
  const all = Object.entries(state.audios);
  if (!all.length) return;
  const master = all[0][1];
  const t = master.currentTime, playing = !master.paused;
  for (const [name, a] of all) {
    a.pause();
    a.src = audioUrl(name, semis);
    a.load();
  }
  state.playKey = semis;
  // 모두 준비되면 같은 위치에서 다시 재생
  let left = all.length;
  const go = () => {
    if (--left > 0) return;
    for (const [, a] of all) { a.currentTime = t; a.playbackRate = 1; if (playing) a.play().catch(() => {}); }
  };
  for (const [, a] of all) {
    a.addEventListener("canplay", go, { once: true });
    a.addEventListener("error", go, { once: true });
  }
  toast(semis ? `이제 ${keyLabel(semis)} 키로 들려요` : "원래 키로 들려요");
}

// 반주 내려받기: 그 키의 음원이 아직 없으면(예전 작업, 아직 안 옮긴 키) 먼저 만든다
async function downloadMr(e) {
  e.preventDefault();
  const kind = e.currentTarget.id === "dl-inst" ? "inst" : "mr";
  const semis = $("#m-keyfollow").checked && state.view ? (state.view.semitones || 0) : 0;
  try {
    let st = await api(`/api/jobs/${state.job.id}/playback?semitones=${semis}`);
    if (st.status !== "ready" || !st.tracks.includes(kind)) {
      st = await api(`/api/jobs/${state.job.id}/playback`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ semitones: semis }) });
    }
    if (st.status !== "ready") { toast("반주 음원을 만드는 중이에요 (1분 안팎). 다 되면 다시 눌러 주세요"); return; }
    location.href = `/api/jobs/${state.job.id}/mr?semitones=${semis}&kind=${kind}`;
  } catch (err) {
    toast(`반주를 받지 못했습니다: ${err.message}`);
  }
}

// 음표를 고치면 악보 소리를 다시 받는다 (서버가 새로 만든다)
function refreshScoreAudio() {
  const a = state.audios.score;
  if (!a) return;
  const master = masterAudio();
  a.src = audioUrl("score", state.playKey || 0) + (state.playKey ? "&" : "?") + `v=${Date.now()}`;
  a.load();
  a.addEventListener("canplay", () => { a.currentTime = master.currentTime; if (!master.paused) a.play().catch(() => {}); }, { once: true });
}

function updateDownloads() {
  const semis = $("#m-keyfollow").checked && state.view ? (state.view.semitones || 0) : 0;
  const stems = (state.result && state.result.stems) || [];
  const base = `/api/jobs/${state.job.id}/mr?semitones=${semis}`;
  $("#dl-mr").href = `${base}&kind=mr`;
  $("#dl-inst").href = `${base}&kind=inst`;
  $("#dl-mr").classList.toggle("hidden", !stems.includes("vocals"));
  $("#dl-inst").classList.toggle("hidden", !stems.includes("backing_vocals"));
  $(".mr-dl").classList.toggle("hidden", !stems.includes("vocals"));
}

function onTime() {
  const all = Object.values(state.audios);
  const master = all[0];
  const t = master.currentTime;
  if (isFinite(master.duration)) $("#m-seek").value = Math.round((t / master.duration) * 1000);
  $("#m-time").textContent = `${fmtTime(t)} / ${fmtTime(master.duration)}`;
  if (!master.paused) syncStems(master);
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
  initResultView();
  $("#btn-new").addEventListener("click", newJob);
  $("#jobs-retry").addEventListener("click", loadJobs);
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
