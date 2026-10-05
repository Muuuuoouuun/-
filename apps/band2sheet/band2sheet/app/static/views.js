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

  let chordPopup = null;
  let viewEpoch = 0, rollEpoch = 0, rollRevision = 0;
  const rollSaves = new Map();
  const chordQueues = new Map();
  const lyricSaves = new Map();
  const lyricQueues = new Map();
  const viewContext = () => ({ jobId: ctx.jobId, epoch: viewEpoch });
  const currentView = (session) => session.jobId === ctx.jobId && session.epoch === viewEpoch;

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
      $("#cs-edit").setAttribute("aria-pressed", String(ctx.edit));
      if (!ctx.edit) closePop();
      updateChordButtons();
    });
    $("#cs-print").addEventListener("click", () => window.print());
    $("#live-capo").addEventListener("change", (e) => { ctx.capo = e.target.checked; renderLive(true); });
    initRoll();
    $("#chord-pop").addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePop();
      }
    });
    document.addEventListener("click", (e) => {
      const pop = $("#chord-pop");
      if (!pop.classList.contains("hidden") && !pop.contains(e.target) && !e.target.closest(".cs-chords")) closePop(false);
    });
  }

  function setData(view, jobId) {
    const changedJob = ctx.jobId !== jobId;
    const localTrack = ctx.view && ctx.view.tracks[ctx.roll.track];
    const incomingTrack = view.tracks[ctx.roll.track];
    const keepRollEdits = !changedJob && ctx.view && (ctx.view.semitones || 0) === (view.semitones || 0) &&
      (ctx.roll.dirty || ctx.roll.drag?.moved) && localTrack && incomingTrack && localTrack.kind === incomingTrack.kind;
    if (keepRollEdits) {
      // Chord/lyric refreshes must not replace the unsaved notes currently being edited.
      view.tracks[ctx.roll.track] = { ...incomingTrack, notes: localTrack.notes, range: localTrack.range };
      ctx.roll.dirty = true;
      if (!Number.isInteger(ctx.roll.sel) || !localTrack.notes[ctx.roll.sel]) ctx.roll.sel = null;
    } else {
      ctx.roll.dirty = false;
      ctx.roll.sel = null;
      ctx.roll.undo = [];
    }
    viewEpoch++;
    lyricSaves.clear();
    closePop(false);
    ctx.view = view;
    ctx.timeline = null;
    ctx.jobId = jobId;
    ctx.nowBar = -1;
    ctx.roll.drag = null;
    if (changedJob) {
      ctx.roll.track = null;
      ctx.roll.scroll = 0;
      ctx.roll.dirty = false;
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
    const focusedRow = document.activeElement && document.activeElement.closest(".cs-chords");
    const focusedBar = focusedRow && box.contains(focusedRow) ? focusedRow.dataset.bar : null;
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
      const row = el.querySelector(".cs-chords");
      row.addEventListener("keydown", (e) => {
        if (!ctx.edit || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        openChordPop(row, Number(el.dataset.bar));
      });
    });
    updateChordButtons();
    if (focusedBar !== null && ctx.edit) box.querySelector(`.cs-chords[data-bar="${focusedBar}"]`)?.focus();
  }

  function updateChordButtons() {
    $$q("#chordsheet .cs-chords").forEach((row) => {
      if (ctx.edit) {
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        row.setAttribute("aria-haspopup", "dialog");
        row.setAttribute("aria-label", `${ctx.view.bars[Number(row.dataset.bar)].number}마디 코드 편집`);
      } else {
        for (const attr of ["role", "tabindex", "aria-haspopup", "aria-label"]) row.removeAttribute(attr);
      }
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
    const clientX = e ? e.clientX : rect.left;
    const rel = Math.min(0.999, Math.max(0, (clientX - rect.left) / rect.width));
    const beat = Math.floor(rel * v.beats_per_bar);
    const current = [...v.bars[bar].chords].reverse().find((c) => c.beat <= beat);
    const pop = $("#chord-pop");
    const session = chordPopup = { ...viewContext(), row, bar, saving: false };
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-labelledby", "pop-title");
    pop.setAttribute("aria-describedby", "pop-help");
    pop.setAttribute("aria-busy", "false");
    pop.innerHTML = `<div class="pop-head" id="pop-title">${v.bars[bar].number}마디 ${beat + 1}박부터 코드 편집</div>
      <p id="pop-help" class="small muted">코드를 입력하거나 아래에서 선택하세요. Escape로 닫을 수 있어요.</p>
      <label for="pop-input">코드 이름</label>
      <input id="pop-input" aria-describedby="pop-err" value="${esc(current && !current.held ? current.name : "")}" placeholder="예: G, Em7, D/F#">
      <div class="pop-quick">${diatonic().map((n) => `<button data-n="${esc(n)}">${esc(n)}</button>`).join("")}</div>
      <div class="pop-actions"><button class="primary" id="pop-ok">적용</button><button id="pop-del">코드 지우기</button><button id="pop-cancel" class="ghost">취소</button></div>
      <p class="error small" id="pop-err" role="alert" aria-atomic="true"></p>`;
    pop.classList.remove("hidden");
    const pr = pop.getBoundingClientRect();
    pop.style.left = `${Math.min(window.innerWidth - pr.width - 10, Math.max(10, clientX - 40))}px`;
    pop.style.top = `${Math.min(window.innerHeight - pr.height - 10, rect.bottom + 6)}px`;
    const input = $("#pop-input");
    input.focus();
    input.select();
    const submit = async (name) => {
      if (session !== chordPopup || !currentView(session) || session.saving) return;
      session.saving = true;
      const error = $("#pop-err");
      error.textContent = "";
      pop.setAttribute("aria-busy", "true");
      $("#pop-ok").textContent = "저장 중…";
      const queueKey = JSON.stringify([session.jobId, bar]);
      const previous = chordQueues.get(queueKey);
      const write = (async () => {
        if (previous) { try { await previous; } catch (_) { /* allow the next edit to retry */ } }
        if (session !== chordPopup || !currentView(session)) return false;
        await ctx.hooks.api(`/api/jobs/${session.jobId}/chord`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bar, beat, name, semitones: v.semitones }),
        });
        return true;
      })();
      chordQueues.set(queueKey, write);
      try {
        if (!await write || session !== chordPopup || !currentView(session)) return;
        closePop();
        ctx.hooks.reload();
      } catch (err) {
        if (session === chordPopup && currentView(session)) error.textContent = err.message;
      } finally {
        session.saving = false;
        if (chordQueues.get(queueKey) === write) chordQueues.delete(queueKey);
        if (session === chordPopup) {
          pop.setAttribute("aria-busy", "false");
          $("#pop-ok").textContent = "적용";
        }
      }
    };
    pop.querySelectorAll(".pop-quick button").forEach((b) => b.addEventListener("click", () => submit(b.dataset.n)));
    $("#pop-ok").addEventListener("click", () => submit(input.value));
    $("#pop-del").addEventListener("click", () => submit(""));
    $("#pop-cancel").addEventListener("click", () => closePop());
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submit(input.value); } });
  }

  function closePop(restoreFocus = true) {
    $("#chord-pop").classList.add("hidden");
    $("#chord-pop").setAttribute("aria-busy", "false");
    const session = chordPopup;
    chordPopup = null;
    if (restoreFocus && session && session.jobId === ctx.jobId) {
      const row = session.row.isConnected ? session.row : $(`#chordsheet .cs-chords[data-bar="${session.bar}"]`);
      if (row && ctx.edit) row.focus();
    }
  }

  function editLyrics(el, bar) {
    if (el.isContentEditable) return;
    const session = viewContext(), view = ctx.view;
    let completed = false;
    el.contentEditable = "true";
    el.classList.add("typing");
    el.focus();
    const done = async (save) => {
      if (completed) return;
      completed = true;
      el.contentEditable = "false";
      el.classList.remove("typing");
      if (!save) { el.textContent = view.bars[bar].lyrics || ""; return; }
      if (!currentView(session)) return;
      const text = el.textContent.trim();
      const queueKey = JSON.stringify([session.jobId, bar]);
      if (text === (view.bars[bar].lyrics || "") && !lyricQueues.has(queueKey)) return;
      const request = {};
      lyricSaves.set(bar, request);
      const current = () => currentView(session) && lyricSaves.get(bar) === request;
      const previous = lyricQueues.get(queueKey);
      // Keep writes to the same bar in order as well as guarding their UI responses.
      const write = (async () => {
        if (previous) { try { await previous; } catch (_) { /* a failed save must allow retry */ } }
        if (!current()) return false;
        await ctx.hooks.api(`/api/jobs/${session.jobId}/lyrics`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bar, text }),
        });
        return true;
      })();
      lyricQueues.set(queueKey, write);
      try {
        if (!await write || !current()) return;
        view.bars[bar].lyrics = text;
        el.classList.add("edited");
        ctx.hooks.toast("가사를 저장했어요");
        ctx.hooks.markStale();
      } catch (err) { if (current()) ctx.hooks.toast(err.message); }
      finally { if (lyricQueues.get(queueKey) === write) lyricQueues.delete(queueKey); }
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
      if (e.defaultPrevented || e.isComposing || !track() || $("#v-roll").closest(".hidden") ||
        e.target.closest(".hidden, input, textarea, select, button, summary, a[href], [contenteditable], [role=button], [role=dialog]") ||
        e.target.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); undoRoll(); return; }
      if (R.sel == null) return;
      const n = notes()[R.sel];
      if (!n) { R.sel = null; updateRollStatus(); return; }
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
      if (R.track === b.dataset.t) return;
      if (R.dirty && !confirm("저장하지 않은 수정이 있어요. 버리고 다른 악기로 갈까요?")) return;
      rollEpoch++;
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
    rollRevision++;
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
    rollRevision++;
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
    rollRevision++;
    R.dirty = true;
    drawRoll();
    updateRollStatus();
  }

  function updateRollStatus() {
    const t = track();
    if (!t) return;
    const saving = rollSaves.has(JSON.stringify([ctx.jobId, R.track]));
    $("#roll-save").disabled = !R.dirty || Boolean(saving);
    $("#roll-save").setAttribute("aria-busy", String(Boolean(saving)));
    $("#roll-undo").disabled = !R.undo.length;
    $("#roll-delete").disabled = R.sel == null;
    let msg = saving ? "음표를 저장하고 있어요" : R.dirty ? "저장하지 않은 수정이 있어요" : `${t.notes.length}개 음표`;
    if (R.sel != null && t.notes[R.sel]) {
      const n = t.notes[R.sel];
      const label = t.kind === "drums" ? (ctx.view.drum_kit[String(n[2])] || {}).name_ko : NOTE[n[2] % 12] + (Math.floor(n[2] / 12) - 1);
      msg += ` · 선택: ${label} (${n[0].toFixed(2)}초)`;
    }
    $("#roll-status").textContent = msg;
  }

  function currentRollSave(session) {
    return currentView(session) && session.track === R.track && session.rollEpoch === rollEpoch;
  }

  async function saveRoll() {
    const saveKey = JSON.stringify([ctx.jobId, R.track]);
    if (!ctx.view || !track() || !R.dirty || rollSaves.has(saveKey)) return;
    const session = { ...viewContext(), track: R.track, rollEpoch, revision: rollRevision };
    rollSaves.set(saveKey, session);
    updateRollStatus();
    try {
      await ctx.hooks.api(`/api/jobs/${session.jobId}/notes/${session.track}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes(), semitones: ctx.view.semitones }),
      });
      if (!currentRollSave(session)) return;
      if (session.revision === rollRevision) {
        R.dirty = false;
        R.undo = [];
        ctx.hooks.toast("음표를 저장했어요. 오선 악보·파일은 다시 만들 때 반영돼요.");
      } else ctx.hooks.toast("이전 수정은 저장했어요. 새 수정은 다시 저장해 주세요.");
      ctx.hooks.markStale();
    } catch (err) { if (currentRollSave(session)) ctx.hooks.toast(err.message); }
    finally {
      if (rollSaves.get(saveKey) === session) rollSaves.delete(saveKey);
      updateRollStatus();
    }
  }

  // 음표 미리듣기: 악기마다 비슷한 음색으로 (현을 튕기는 소리는 Karplus-Strong 합성)
  let audioCtx = null, previewOut = null;
  const pluckCache = new Map();
  const TIMBRE = {  // 감쇠(0~1, 클수록 오래 울림), 밝기(0~1), 길이(초), 음량
    piano: { damp: 0.996, bright: 0.55, len: 1.2, gain: 0.5, strings: 2 },
    guitar: { damp: 0.994, bright: 0.8, len: 1.0, gain: 0.45, strings: 1 },
    bass: { damp: 0.997, bright: 0.3, len: 1.0, gain: 0.7, strings: 1 },
    other: { damp: 0.998, bright: 0.4, len: 1.2, gain: 0.4, strings: 2 },
  };

  function audio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -6; comp.ratio.value = 8;
      previewOut = audioCtx.createGain(); previewOut.gain.value = 0.8;
      previewOut.connect(comp).connect(audioCtx.destination);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function pluckBuffer(pitch, t) {
    const key = `${pitch}:${t.damp}:${t.bright}:${t.strings}`;
    if (pluckCache.has(key)) return pluckCache.get(key);
    const sr = audioCtx.sampleRate, n = Math.floor(sr * t.len);
    const buf = audioCtx.createBuffer(1, n, sr), data = buf.getChannelData(0);
    for (let s = 0; s < t.strings; s++) {
      const hz = 440 * Math.pow(2, (pitch - 69) / 12) * (s ? 1.0015 : 1);  // 두 줄은 살짝 어긋나게 (피아노 현)
      const period = Math.max(2, Math.round(sr / hz));
      const line = new Float32Array(period);
      let last = 0;
      for (let i = 0; i < period; i++) {  // 처음 튕김: 밝기만큼 고역을 남긴 잡음
        const w = Math.random() * 2 - 1;
        last = t.bright * w + (1 - t.bright) * last;
        line[i] = last;
      }
      // 낮은 음일수록 덜 감쇠되도록 (실제 현처럼)
      const damp = Math.min(0.9995, t.damp + (60 - pitch) * 0.00008);
      for (let i = 0, j = 0; i < n; i++) {
        const nxt = (j + 1) % period;
        const v = line[j];
        line[j] = damp * 0.5 * (line[j] + line[nxt]);
        data[i] += v / t.strings;
        j = nxt;
      }
    }
    const fade = Math.floor(sr * 0.03);
    for (let i = 0; i < fade; i++) data[n - 1 - i] *= i / fade;
    pluckCache.set(key, buf);
    return buf;
  }

  function preview(pitch) {
    if (isDrums() || !$("#roll-sound").checked) return;
    try {
      const ac = audio(), now = ac.currentTime;
      const name = R.track || "";
      const gn = ac.createGain();
      gn.connect(previewOut);
      if (name === "vocals" || name === "backing_vocals") {
        // 목소리: 부드럽게 시작하는 따뜻한 음 + 살짝 떨림(비브라토)
        const hz = 440 * Math.pow(2, (pitch - 69) / 12);
        const o = ac.createOscillator(), o2 = ac.createOscillator(), lp = ac.createBiquadFilter();
        const lfo = ac.createOscillator(), depth = ac.createGain();
        o.type = "sawtooth"; o2.type = "sine";
        o.frequency.value = hz; o2.frequency.value = hz;
        lp.type = "lowpass"; lp.frequency.value = Math.min(4000, hz * 4); lp.Q.value = 0.7;
        lfo.frequency.value = 5.2; depth.gain.value = hz * 0.006;
        lfo.connect(depth); depth.connect(o.frequency); depth.connect(o2.frequency);
        const mixSaw = ac.createGain(); mixSaw.gain.value = 0.25;
        o.connect(mixSaw).connect(lp); o2.connect(lp); lp.connect(gn);
        gn.gain.setValueAtTime(0.0001, now);
        gn.gain.linearRampToValueAtTime(0.3, now + 0.06);
        gn.gain.setTargetAtTime(0.0001, now + 0.45, 0.08);
        for (const x of [o, o2, lfo]) { x.start(now); x.stop(now + 0.9); }
        return;
      }
      const t = TIMBRE[name] || TIMBRE.piano;
      const src = ac.createBufferSource();
      src.buffer = pluckBuffer(pitch, t);
      gn.gain.value = t.gain;
      src.connect(gn);
      src.start(now);
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

  function hasUnsaved() { return R.dirty || Boolean(R.drag?.moved); }
  function getEditRevision() { return rollRevision; }

  function discardUnsaved() {
    viewEpoch++;
    rollEpoch++;
    lyricSaves.clear();
    R.dirty = false;
    R.undo = [];
    R.sel = null;
    R.drag = null;
    closePop(false);
    updateRollStatus();
  }

  function chordAt(t) {
    if (!ctx.view) return null;
    let cur = null;
    for (const c of chordTimeline()) { if (c.t <= t + 0.05) cur = c; else break; }
    return cur;
  }

  return { init, setData, tick, shown, hasUnsaved, getEditRevision, discardUnsaved, chordAt, ctx };
})();
