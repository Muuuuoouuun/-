/* 자체 화면: 코드 악보 · 라이브 코드 · 악기별 보기(피아노롤/드럼 그리드) — 오선 악보 없이 보고, 연습하고, 고친다 */
"use strict";

const Views = (() => {
  const SEC_KO = { Intro: "전주", Verse: "절", "Pre-Chorus": "프리코러스", Chorus: "후렴", Bridge: "브리지",
    Interlude: "간주", Outro: "후주", Section: "구간" };
  const NOTE = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const ctx = {
    view: null, // 서버 view JSON
    jobId: null,
    numbers: false,
    fontScale: 1,
    edit: false,
    nowBar: -1,
    capo: false,
    roll: { track: null, pxPerSec: 80, scroll: 0, sel: null, dirty: false, undo: [], drag: null, follow: true },
    hooks: { seek: () => {}, time: () => 0, playing: () => false, reload: () => {}, toast: () => {} },
  };
  const $ = (s) => document.querySelector(s);
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function init(hooks) {
    Object.assign(ctx.hooks, hooks);
    $("#cs-mode").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      ctx.numbers = b.dataset.v === "numbers";
      renderChordSheet();
    });
    $("#cs-font-up").addEventListener("click", () => { ctx.fontScale = Math.min(1.8, ctx.fontScale + 0.1); applyFont(); });
    $("#cs-font-down").addEventListener("click", () => { ctx.fontScale = Math.max(0.7, ctx.fontScale - 0.1); applyFont(); });
    $("#cs-edit").addEventListener("click", () => {
      ctx.edit = !ctx.edit;
      $("#cs-edit").classList.toggle("on", ctx.edit);
      $("#chordsheet").classList.toggle("editing", ctx.edit);
      $("#cs-edit-hint").classList.toggle("hidden", !ctx.edit);
    });
    $("#cs-print").addEventListener("click", () => window.print());
    $("#live-capo").addEventListener("change", (e) => { ctx.capo = e.target.checked; renderLive(true); });
    initRoll();
    document.addEventListener("click", (e) => {
      const pop = $("#chord-pop");
      if (!pop.classList.contains("hidden") && !pop.contains(e.target) && !e.target.closest(".cs-chords")) closePop();
    });
  }

  function setData(view, jobId) {
    const changedJob = ctx.jobId !== jobId;
    ctx.view = view;
    ctx.timeline = null;
    ctx.jobId = jobId;
    ctx.nowBar = -1;
    if (changedJob) {
      ctx.roll.track = null;
      ctx.roll.scroll = 0;
      ctx.roll.dirty = false;
      ctx.roll.undo = [];
    }
    renderChordSheet();
    renderLive(true);
    renderRollTabs();
    drawRoll();
  }

  // ------------------------------------------------------------ 공통 시간 계산
  function barAt(t) {
    const bars = ctx.view.bars;
    let lo = 0, hi = bars.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function beatTime(bar, beat) {
    const b = ctx.view.bars[bar];
    return b.start + ((b.end - b.start) * beat) / ctx.view.beats_per_bar;
  }

  /** 모든 코드 변화를 시간순으로 [{t, bar, beat, name, number, root, quality, bass}] */
  function chordTimeline() {
    if (ctx.timeline) return ctx.timeline;
    const out = [];
    ctx.timeline = out;
    for (const b of ctx.view.bars) {
      for (const c of b.chords) {
        if (c.held && out.length && out[out.length - 1].name === c.name) continue;
        out.push({ ...c, bar: b.index, t: beatTime(b.index, c.beat) });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ 1) 코드 악보
  function applyFont() {
    $("#chordsheet").style.setProperty("--cs-scale", ctx.fontScale);
  }

  function groups() {
    const v = ctx.view;
    const secs = v.sections.length ? v.sections : [{ name: "", name_ko: "", kind: "Section", start_index: 0, end_index: v.bars.length }];
    const out = [];
    if (secs[0].start_index > 0) out.push({ title: "", kind: "", from: 0, to: secs[0].start_index });
    secs.forEach((s, i) => {
      const to = i + 1 < secs.length ? secs[i + 1].start_index : v.bars.length;
      out.push({ title: s.name_ko, en: s.name, kind: s.kind, from: s.start_index, to });
    });
    return out;
  }

  function renderChordSheet() {
    const v = ctx.view;
    if (!v) return;
    $$q("#cs-mode button").forEach((b) => b.classList.toggle("on", (b.dataset.v === "numbers") === ctx.numbers));
    const head = [`<b>Key ${esc(v.key_short)}</b>`, `${Math.round(v.tempo)} BPM`, esc(v.time_signature)];
    if (v.capo) head.push(`기타 카포 ${v.capo.fret} (${esc(v.capo.shape)} 모양)`);
    for (const k of v.key_changes) head.push(`<span class="cs-mod">${k.number}마디부터 ${esc(k.key_short)}</span>`);
    let html = `<div class="cs-title">${esc(v.title)}</div><div class="cs-head">${head.join(" · ")}</div>`;
    if (v.sections.length) {
      html += `<div class="cs-flow">${v.sections.map((s) => `<span class="sec-${s.kind}">${esc(s.name_ko)}</span>`).join("")}</div>`;
    }
    const keyChangeAt = new Map(v.key_changes.map((k) => [k.index, k.key_short]));
    for (const g of groups()) {
      if (g.to <= g.from) continue;
      const mod = [...keyChangeAt.entries()].find(([i]) => i >= g.from && i < g.to);
      html += `<section class="cs-sec">`;
      if (g.title) html += `<h4 class="cs-sec-title sec-${g.kind}">${esc(g.title)} <small>${esc(g.en || "")}</small>${mod ? ` <span class="cs-mod">▶ Key ${esc(mod[1])}</span>` : ""}</h4>`;
      html += `<div class="cs-bars">`;
      for (let i = g.from; i < g.to; i++) {
        const b = v.bars[i];
        const chords = b.chords.map((c) => {
          const left = (c.beat / v.beats_per_bar) * 100;
          const text = ctx.numbers ? c.number : c.name;
          return `<span class="cs-chord${c.held ? " held" : ""}" style="left:${left}%" data-beat="${c.beat}">${esc(text)}</span>`;
        }).join("");
        html += `<div class="cs-bar${b.index === ctx.nowBar ? " now" : ""}" data-bar="${b.index}">
          <span class="cs-num">${b.number}</span>
          <div class="cs-chords" data-bar="${b.index}">${chords || '<span class="cs-chord held" style="left:0">·</span>'}</div>
          <div class="cs-lyrics${b.lyrics_edited ? " edited" : ""}" data-bar="${b.index}">${esc(b.lyrics || "")}</div>
        </div>`;
      }
      html += `</div></section>`;
    }
    const box = $("#chordsheet");
    box.innerHTML = html;
    applyFont();
    box.querySelectorAll(".cs-bar").forEach((el) => {
      el.addEventListener("click", (e) => {
        const bar = Number(el.dataset.bar);
        if (ctx.edit) {
          if (e.target.closest(".cs-lyrics")) return editLyrics(e.target.closest(".cs-lyrics"), bar);
          return openChordPop(el.querySelector(".cs-chords"), bar, e);
        }
        ctx.hooks.seek(v.bars[bar].start, true);
      });
    });
  }

  function $$q(s) { return Array.from(document.querySelectorAll(s)); }

  function highlightBar(bar) {
    if (bar === ctx.nowBar) return;
    ctx.nowBar = bar;
    $$q("#chordsheet .cs-bar.now").forEach((el) => el.classList.remove("now"));
    const el = document.querySelector(`#chordsheet .cs-bar[data-bar="${bar}"]`);
    if (el) {
      el.classList.add("now");
      if (ctx.hooks.playing() && !$("#v-chart").classList.contains("hidden")) {
        const r = el.getBoundingClientRect();
        if (r.top < 120 || r.bottom > window.innerHeight - 40) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }

  // ---- 코드 고치기
  function diatonic() {
    const v = ctx.view;
    const k = v.key_short;
    const minor = k.endsWith("m");
    const tonic = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 }[k.replace(/m$/, "")];
    const steps = minor ? [[0, "m"], [3, ""], [5, "m"], [7, "m"], [7, ""], [8, ""], [10, ""]]
      : [[0, ""], [2, "m"], [4, "m"], [5, ""], [7, ""], [9, "m"], [7, "7"]];
    const flats = /b|F$|Dm|Gm|Cm|Fm/.test(k);
    const names = flats ? ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] : NOTE.map((n) => n.replace("Eb", "D#").replace("Ab", "G#").replace("Bb", "A#"));
    return steps.map(([s, q]) => names[(tonic + s) % 12] + q);
  }

  function openChordPop(row, bar, e) {
    const v = ctx.view;
    const rect = row.getBoundingClientRect();
    const rel = Math.min(0.999, Math.max(0, (e.clientX - rect.left) / rect.width));
    const beat = Math.floor(rel * v.beats_per_bar);
    const current = [...v.bars[bar].chords].reverse().find((c) => c.beat <= beat);
    const pop = $("#chord-pop");
    pop.innerHTML = `<div class="pop-head">${v.bars[bar].number}마디 ${beat + 1}박부터</div>
      <input id="pop-input" value="${esc(current && !current.held ? current.name : "")}" placeholder="예: G, Em7, D/F#">
      <div class="pop-quick">${diatonic().map((n) => `<button data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div>
      <div class="pop-actions"><button class="primary" id="pop-ok">적용</button><button id="pop-del">코드 지우기</button><button id="pop-cancel" class="ghost">취소</button></div>
      <p class="error small" id="pop-err"></p>`;
    pop.classList.remove("hidden");
    const pr = pop.getBoundingClientRect();
    pop.style.left = `${Math.min(window.innerWidth - pr.width - 10, Math.max(10, e.clientX - 40))}px`;
    pop.style.top = `${Math.min(window.innerHeight - pr.height - 10, rect.bottom + 6)}px`;
    const input = $("#pop-input");
    input.focus();
    input.select();
    const submit = async (name) => {
      try {
        await ctx.hooks.api(`/api/jobs/${ctx.jobId}/chord`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bar, beat, name, semitones: v.semitones }),
        });
        closePop();
        ctx.hooks.reload();
      } catch (err) { $("#pop-err").textContent = err.message; }
    };
    pop.querySelectorAll(".pop-quick button").forEach((b) => b.addEventListener("click", () => submit(b.dataset.n)));
    $("#pop-ok").addEventListener("click", () => submit(input.value));
    $("#pop-del").addEventListener("click", () => submit(""));
    $("#pop-cancel").addEventListener("click", closePop);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(input.value); if (ev.key === "Escape") closePop(); });
  }

  function closePop() { $("#chord-pop").classList.add("hidden"); }

  function editLyrics(el, bar) {
    if (el.isContentEditable) return;
    el.contentEditable = "true";
    el.classList.add("typing");
    el.focus();
    const done = async (save) => {
      el.contentEditable = "false";
      el.classList.remove("typing");
      if (!save) { el.textContent = ctx.view.bars[bar].lyrics || ""; return; }
      const text = el.textContent.trim();
      if (text === (ctx.view.bars[bar].lyrics || "")) return;
      try {
        await ctx.hooks.api(`/api/jobs/${ctx.jobId}/lyrics`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bar, text }),
        });
        ctx.view.bars[bar].lyrics = text;
        el.classList.add("edited");
        ctx.hooks.toast("가사를 저장했어요");
        ctx.hooks.markStale();
      } catch (err) { ctx.hooks.toast(err.message); }
    };
    el.onkeydown = (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); el.blur(); }
      if (ev.key === "Escape") { el.onblur = null; done(false); }
    };
    el.onblur = () => done(true);
  }

  // ------------------------------------------------------------ 2) 라이브 코드
  function shapeChord(c) {
    if (!c || c.root == null) return null;
    const capo = ctx.capo && ctx.view.capo ? ctx.view.capo.fret : 0;
    return { root: (c.root - capo + 12) % 12, quality: c.quality, bass: c.bass == null ? null : (c.bass - capo + 12) % 12 };
  }

  function chordCard(c, big) {
    if (!c) return `<div class="live-card empty">—</div>`;
    const s = shapeChord(c);
    const label = ctx.numbers ? c.number : c.name;
    const shapeName = s ? ChordGfx.name(s.root, s.quality) + (s.bass != null && s.bass !== s.root ? "/" + ChordGfx.NAMES[s.bass] : "") : "";
    const gtr = s ? ChordGfx.guitarSVG(ChordGfx.guitar(s.root, s.quality), big ? { width: 130, height: 150 } : {}) : "";
    return `<div class="live-card${big ? " big" : ""}">
      <div class="live-name">${esc(label)}</div>
      ${ctx.capo && ctx.view.capo && s ? `<div class="live-shape">카포 ${ctx.view.capo.fret} · ${esc(shapeName)} 모양</div>` : ""}
      <div class="live-gtr">${gtr}</div>
    </div>`;
  }

  let liveIdx = -2;
  function renderLive(force) {
    const v = ctx.view;
    if (!v) return;
    const tl = chordTimeline();
    const t = ctx.hooks.time();
    let idx = -1;
    for (let i = 0; i < tl.length; i++) if (tl[i].t <= t + 0.05) idx = i;
    const bar = barAt(t);
    const beatLen = (v.bars[bar].end - v.bars[bar].start) / v.beats_per_bar;
    const beatIn = Math.min(v.beats_per_bar - 1, Math.max(0, Math.floor((t - v.bars[bar].start) / beatLen)));
    $("#live-beats").innerHTML = Array.from({ length: v.beats_per_bar }, (_, i) => `<span class="${i === beatIn ? "on" : ""}">${i + 1}</span>`).join("");
    $("#live-bar").textContent = `${v.bars[bar].number}마디`;
    const sec = [...v.sections].reverse().find((s) => s.start_index <= bar);
    $("#live-sec").textContent = sec ? sec.name_ko : "";
    if (!force && idx === liveIdx) return;
    liveIdx = idx;
    const cur = tl[idx] || tl[0];
    const nexts = tl.slice(idx + 1, idx + 4);
    $("#live-now").innerHTML = chordCard(cur, true);
    $("#live-next").innerHTML = nexts.map((c) => chordCard(c, false)).join("") || `<div class="muted">끝</div>`;
    const tones = cur && cur.root != null ? ChordGfx.tones(cur.root, cur.quality) : [];
    $("#live-piano").innerHTML = cur && cur.root != null ? ChordGfx.pianoSVG(tones, cur.bass != null ? cur.bass : cur.root, { width: 300, height: 90 }) : "";
    // 전체 진행 (누르면 이동)
    const strip = $("#live-strip");
    if (force || !strip.childElementCount) {
      strip.innerHTML = tl.map((c, i) => `<button data-i="${i}">${esc(ctx.numbers ? c.number : c.name)}<small>${v.bars[c.bar].number}</small></button>`).join("");
      strip.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => ctx.hooks.seek(tl[Number(b.dataset.i)].t, true)));
    }
    strip.querySelectorAll("button.now").forEach((b) => b.classList.remove("now"));
    const nb = strip.querySelector(`button[data-i="${idx}"]`);
    if (nb) {
      nb.classList.add("now");
      if (!$("#v-live").classList.contains("hidden")) nb.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    }
  }

  // ------------------------------------------------------------ 3) 악기별 보기 (피아노롤 / 드럼 그리드)
  const R = ctx.roll;
  const GUTTER = 66, TOP = 38;

  function initRoll() {
    const cv = $("#roll");
    cv.addEventListener("mousedown", rollDown);
    window.addEventListener("mousemove", rollMove);
    window.addEventListener("mouseup", rollUp);
    cv.addEventListener("dblclick", rollDouble);
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) setZoom(R.pxPerSec * (e.deltaY < 0 ? 1.15 : 0.87));
      else { R.scroll = Math.max(0, R.scroll + (e.deltaX || e.deltaY) / R.pxPerSec); R.follow = false; syncScroll(); drawRoll(); }
    }, { passive: false });
    $("#roll-scroll").addEventListener("input", (e) => { R.scroll = Number(e.target.value); R.follow = false; drawRoll(); });
    $("#roll-zoom-in").addEventListener("click", () => setZoom(R.pxPerSec * 1.3));
    $("#roll-zoom-out").addEventListener("click", () => setZoom(R.pxPerSec / 1.3));
    $("#roll-follow").addEventListener("change", (e) => { R.follow = e.target.checked; });
    $("#roll-save").addEventListener("click", saveRoll);
    $("#roll-undo").addEventListener("click", undoRoll);
    $("#roll-delete").addEventListener("click", () => { if (R.sel != null) { pushUndo(); notes().splice(R.sel, 1); R.sel = null; dirty(); } });
    window.addEventListener("keydown", (e) => {
      if ($("#v-roll").classList.contains("hidden") || e.target.closest("input, textarea, [contenteditable=true]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undoRoll(); return; }
      if (R.sel == null) return;
      const n = notes()[R.sel];
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); pushUndo(); notes().splice(R.sel, 1); R.sel = null; dirty(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        pushUndo();
        const d = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1);
        if (isDrums()) { const lanes = drumLanes(); const li = lanes.indexOf(n[2]); n[2] = lanes[Math.min(lanes.length - 1, Math.max(0, li - d))]; }
        else n[2] = Math.min(127, Math.max(0, n[2] + d));
        preview(n[2]);
        dirty();
      }
    });
    window.addEventListener("resize", () => drawRoll());
  }

  function track() { return R.track && ctx.view ? ctx.view.tracks[R.track] : null; }
  function notes() { return track().notes; }
  function isDrums() { return track() && track().kind === "drums"; }
  function duration() { const b = ctx.view.bars; return b[b.length - 1].end; }

  function renderRollTabs() {
    const v = ctx.view;
    const box = $("#roll-tracks");
    const names = Object.keys(v.tracks);
    if (!R.track || !v.tracks[R.track]) R.track = names.find((n) => n !== "drums") || names[0] || null;
    box.innerHTML = names.map((n) => `<button data-t="${n}" class="${n === R.track ? "on" : ""}">${esc(v.tracks[n].label_ko)} <small>${v.tracks[n].notes.length}</small></button>`).join("");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      if (R.dirty && !confirm("저장하지 않은 수정이 있어요. 버리고 다른 악기로 갈까요?")) return;
      if (R.dirty) { R.dirty = false; ctx.hooks.reload(); }
      R.track = b.dataset.t; R.sel = null; R.undo = [];
      renderRollTabs(); drawRoll();
    }));
    updateRollStatus();
  }

  function drumLanes() {
    const order = [49, 51, 46, 42, 50, 47, 38, 43, 36];
    const used = new Set(notes().map((n) => n[2]));
    return order.filter((m) => used.has(m) || [36, 38, 42].includes(m)).concat([...used].filter((m) => !order.includes(m)));
  }

  function rowsInfo(cv) {
    const h = cv.height / devicePixelRatio - TOP;
    if (isDrums()) {
      const lanes = drumLanes();
      return { kind: "drums", lanes, rowH: h / lanes.length, rowOf: (p) => lanes.indexOf(p), pitchAt: (row) => lanes[row] };
    }
    const [lo0, hi0] = track().range;
    const lo = Math.max(0, lo0 - 2), hi = Math.min(127, hi0 + 2);
    const n = hi - lo + 1;
    return { kind: "pitched", lo, hi, rowH: h / n, rowOf: (p) => hi - p, pitchAt: (row) => hi - row };
  }

  function setZoom(px) {
    const cv = $("#roll");
    const center = R.scroll + (cv.width / devicePixelRatio - GUTTER) / 2 / R.pxPerSec;
    R.pxPerSec = Math.min(600, Math.max(15, px));
    R.scroll = Math.max(0, center - (cv.width / devicePixelRatio - GUTTER) / 2 / R.pxPerSec);
    syncScroll();
    drawRoll();
  }

  function syncScroll() {
    const s = $("#roll-scroll");
    s.max = Math.max(0, duration() - 1);
    s.step = 0.01;
    s.value = R.scroll;
  }

  function xOf(t) { return GUTTER + (t - R.scroll) * R.pxPerSec; }
  function tOf(x) { return R.scroll + (x - GUTTER) / R.pxPerSec; }

  function snap(t) {
    // 16분음표(1/4박) 격자에 맞춘다 — 비트 위치 기준이라 템포가 흔들려도 맞음
    const bt = ctx.view.beat_times;
    let i = 0;
    while (i + 1 < bt.length && bt[i + 1] <= t) i++;
    const a = bt[Math.min(i, bt.length - 2)], b = bt[Math.min(i + 1, bt.length - 1)];
    const per = b - a || 0.5;
    const pos = (t - a) / per;
    return a + (Math.round(pos * 4) / 4) * per;
  }

  function beatLen(t) {
    const bt = ctx.view.beat_times;
    let i = 0;
    while (i + 1 < bt.length && bt[i + 1] <= t) i++;
    return (bt[Math.min(i + 1, bt.length - 1)] - bt[Math.min(i, bt.length - 2)]) || 0.5;
  }

  function drawRoll() {
    const cv = $("#roll");
    if (!ctx.view || !track() || $("#v-roll").classList.contains("hidden")) return;
    const wrap = cv.parentElement;
    const W = wrap.clientWidth, H = 440;
    if (cv.width !== W * devicePixelRatio || cv.height !== H * devicePixelRatio) {
      cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio;
      cv.style.width = W + "px"; cv.style.height = H + "px";
    }
    const g = cv.getContext("2d");
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = (n, d) => (css.getPropertyValue(n) || d).trim();
    const bg = "#ffffff", line = "#e3e6ef", text = "#4a5068", accent = col("--accent", "#4f5bd5");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const info = rowsInfo(cv);
    const t0 = R.scroll, t1 = tOf(W);
    // 줄 배경
    for (let r = 0; r * info.rowH < H - TOP; r++) {
      const p = info.pitchAt(r);
      const black = info.kind === "pitched" && [1, 3, 6, 8, 10].includes(p % 12);
      g.fillStyle = black ? "#f2f3f8" : (r % 2 && info.kind === "drums" ? "#f8f9fc" : bg);
      g.fillRect(GUTTER, TOP + r * info.rowH, W - GUTTER, info.rowH);
      if (info.kind === "pitched" && p % 12 === 0) { g.fillStyle = line; g.fillRect(GUTTER, TOP + (r + 1) * info.rowH - 1, W - GUTTER, 1); }
    }
    // 구간 띠 + 마디선 + 코드
    const v = ctx.view;
    for (const s of v.sections) {
      const a = v.bars[s.start_index].start, b = v.bars[Math.min(s.end_index, v.bars.length) - 1].end;
      if (b < t0 || a > t1) continue;
      g.fillStyle = { Chorus: "#ffe2c2", Verse: "#d8e8ff", Bridge: "#d4f3de", "Pre-Chorus": "#e8e0ff" }[s.kind] || "#eceef3";
      g.fillRect(Math.max(GUTTER, xOf(a)), 0, xOf(b) - Math.max(GUTTER, xOf(a)), 16);
      g.fillStyle = "#333"; g.font = "11px system-ui";
      g.fillText(s.name_ko, Math.max(GUTTER + 2, xOf(a) + 4), 12);
    }
    g.font = "10px system-ui";
    for (const bar of v.bars) {
      if (bar.end < t0 || bar.start > t1) continue;
      const x = xOf(bar.start);
      g.fillStyle = "#c7cbd8"; g.fillRect(x, 16, 1, H - 16);
      // 박 선
      for (let k = 1; k < v.beats_per_bar; k++) {
        const bx = xOf(bar.start + ((bar.end - bar.start) * k) / v.beats_per_bar);
        g.fillStyle = "#eef0f5"; g.fillRect(bx, TOP, 1, H - TOP);
      }
      g.fillStyle = text; g.fillText(String(bar.number), x + 3, 27);
      for (const c of bar.chords) {
        if (c.held) continue;
        const cx = xOf(bar.start + ((bar.end - bar.start) * c.beat) / v.beats_per_bar);
        g.fillStyle = accent; g.font = "bold 11px system-ui";
        g.fillText(ctx.numbers ? c.number : c.name, cx + 3, TOP - 2);
        g.font = "10px system-ui";
      }
    }
    // 음표
    const ns = notes();
    ns.forEach((n, i) => {
      const [s, e, p, vel] = n;
      if (e < t0 || s > t1) return;
      const r = info.rowOf(p);
      if (r < 0) return;
      const y = TOP + r * info.rowH;
      const x = xOf(s);
      const sel = i === R.sel;
      if (info.kind === "drums") {
        const cx = x, cy = y + info.rowH / 2, rr = Math.min(7, info.rowH / 2.4);
        g.fillStyle = sel ? "#e0a100" : `rgba(79,91,213,${0.35 + 0.65 * vel / 127})`;
        g.beginPath(); g.moveTo(cx, cy - rr); g.lineTo(cx + rr, cy); g.lineTo(cx, cy + rr); g.lineTo(cx - rr, cy); g.closePath(); g.fill();
      } else {
        const w = Math.max(3, (e - s) * R.pxPerSec - 1);
        g.fillStyle = sel ? "#e0a100" : `rgba(79,91,213,${0.4 + 0.6 * vel / 127})`;
        g.fillRect(x, y + 1, w, Math.max(2, info.rowH - 2));
        if (info.rowH >= 11 && w > 22) { g.fillStyle = "#fff"; g.font = "9px system-ui"; g.fillText(NOTE[p % 12], x + 2, y + info.rowH - 3); }
      }
    });
    // 왼쪽 이름
    g.fillStyle = "#f6f7fb"; g.fillRect(0, TOP, GUTTER, H - TOP);
    g.fillStyle = text; g.font = "10px system-ui";
    for (let r = 0; r * info.rowH < H - TOP; r++) {
      const p = info.pitchAt(r);
      let label = "";
      if (info.kind === "drums") label = (v.drum_kit[String(p)] || { name_ko: String(p) }).name_ko;
      else if (p % 12 === 0 || info.rowH >= 12) label = NOTE[p % 12] + (Math.floor(p / 12) - 1);
      if (label) g.fillText(label, 4, TOP + r * info.rowH + info.rowH / 2 + 3);
    }
    // 재생 위치
    const ph = xOf(ctx.hooks.time());
    if (ph >= GUTTER && ph <= W) { g.fillStyle = "#d64545"; g.fillRect(ph, 16, 2, H - 16); }
  }

  function hit(x, y) {
    const cv = $("#roll");
    const info = rowsInfo(cv);
    const t = tOf(x);
    const row = Math.floor((y - TOP) / info.rowH);
    const p = info.pitchAt(row);
    const ns = notes();
    for (let i = ns.length - 1; i >= 0; i--) {
      const [s, e, pp] = ns[i];
      if (pp !== p) continue;
      const tol = isDrums() ? 8 / R.pxPerSec : 0;
      if (t >= s - tol && t <= Math.max(e, s + tol)) return { index: i, edge: !isDrums() && (xOf(e) - x) < 6 };
    }
    return { index: null, t, p };
  }

  function rollDown(e) {
    if (!track()) return;
    const r = e.target.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < TOP) { ctx.hooks.seek(Math.max(0, tOf(x)), false); return; }
    const h = hit(x, y);
    R.sel = h.index;
    if (h.index != null) {
      const n = notes()[h.index];
      preview(n[2]);
      R.drag = { x, y, orig: [...n], resize: h.edge, moved: false };
    }
    drawRoll();
    updateRollStatus();
  }

  function rollMove(e) {
    if (!R.drag || R.sel == null) return;
    const cv = $("#roll");
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const info = rowsInfo(cv);
    const dt = (x - R.drag.x) / R.pxPerSec;
    const dRow = Math.round((y - R.drag.y) / info.rowH);
    if (!R.drag.moved && Math.abs(x - R.drag.x) < 3 && dRow === 0) return;
    if (!R.drag.moved) { pushUndo(); R.drag.moved = true; }
    const n = notes()[R.sel];
    const [s0, e0, p0] = R.drag.orig;
    if (R.drag.resize) {
      n[1] = Math.max(s0 + 0.05, snap(e0 + dt));
    } else {
      const ns = Math.max(0, snap(s0 + dt));
      n[0] = ns; n[1] = ns + (e0 - s0);
      const row = info.rowOf(p0) + dRow;
      const np = info.pitchAt(Math.max(0, row));
      if (np != null && np !== n[2]) { n[2] = np; preview(np); }
    }
    R.dirtyFlag = true;
    drawRoll();
  }

  function rollUp() {
    if (R.drag && R.drag.moved) dirty();
    R.drag = null;
  }

  function rollDouble(e) {
    const r = e.target.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < TOP) return;
    const h = hit(x, y);
    if (h.index != null) return;
    pushUndo();
    const s = snap(h.t);
    const len = isDrums() ? 0.1 : beatLen(s);
    notes().push([Number(s.toFixed(4)), Number((s + len).toFixed(4)), h.p, 90]);
    notes().sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    R.sel = notes().findIndex((n) => n[0] === Number(s.toFixed(4)) && n[2] === h.p);
    preview(h.p);
    dirty();
  }

  function pushUndo() {
    R.undo.push(JSON.stringify(notes()));
    if (R.undo.length > 100) R.undo.shift();
  }

  function undoRoll() {
    if (!R.undo.length) return;
    track().notes = JSON.parse(R.undo.pop());
    R.sel = null;
    dirty();
  }

  function dirty() {
    R.dirty = true;
    drawRoll();
    updateRollStatus();
  }

  function updateRollStatus() {
    const t = track();
    if (!t) return;
    $("#roll-save").disabled = !R.dirty;
    $("#roll-undo").disabled = !R.undo.length;
    $("#roll-delete").disabled = R.sel == null;
    let msg = R.dirty ? "저장하지 않은 수정이 있어요" : `${t.notes.length}개 음표`;
    if (R.sel != null && t.notes[R.sel]) {
      const n = t.notes[R.sel];
      const label = t.kind === "drums" ? (ctx.view.drum_kit[String(n[2])] || {}).name_ko : NOTE[n[2] % 12] + (Math.floor(n[2] / 12) - 1);
      msg += ` · 선택: ${label} (${n[0].toFixed(2)}초)`;
    }
    $("#roll-status").textContent = msg;
  }

  async function saveRoll() {
    try {
      await ctx.hooks.api(`/api/jobs/${ctx.jobId}/notes/${R.track}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes(), semitones: ctx.view.semitones }),
      });
      R.dirty = false;
      R.undo = [];
      updateRollStatus();
      ctx.hooks.toast("음표를 저장했어요. 오선 악보·파일은 다시 만들 때 반영돼요.");
      ctx.hooks.markStale();
    } catch (err) { ctx.hooks.toast(err.message); }
  }

  let audioCtx = null;
  function preview(pitch) {
    if (isDrums() || !$("#roll-sound").checked) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
      o.type = "triangle";
      o.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
      gn.gain.setValueAtTime(0.18, audioCtx.currentTime);
      gn.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
      o.connect(gn).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.36);
    } catch (_) { /* 소리 미리듣기 실패는 무시 */ }
  }

  // ------------------------------------------------------------ 재생 시간에 따라
  function tick(t) {
    if (!ctx.view) return;
    highlightBar(barAt(t));
    if (!$("#v-live").classList.contains("hidden")) renderLive(false);
    if (!$("#v-roll").classList.contains("hidden")) {
      const cv = $("#roll");
      const visible = (cv.width / devicePixelRatio - GUTTER) / R.pxPerSec;
      if (R.follow && ctx.hooks.playing() && (t > R.scroll + visible * 0.8 || t < R.scroll)) {
        R.scroll = Math.max(0, t - visible * 0.2);
        syncScroll();
      }
      drawRoll();
    }
  }

  function shown(name) {
    if (name === "roll") { syncScroll(); drawRoll(); }
    if (name === "live") renderLive(true);
  }

  function hasUnsaved() { return R.dirty; }

  function chordAt(t) {
    if (!ctx.view) return null;
    let cur = null;
    for (const c of chordTimeline()) { if (c.t <= t + 0.05) cur = c; else break; }
    return cur;
  }

  return { init, setData, tick, shown, hasUnsaved, chordAt, ctx };
})();
