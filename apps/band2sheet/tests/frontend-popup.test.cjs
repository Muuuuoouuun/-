"use strict";

// Exercise the real Views controller with a small DOM and controlled save promises.
// No browser, server, third-party packages, or audio models are needed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../band2sheet/app/static/views.js"), "utf8");

const decode = (s) => s.replace(/&(amp|lt|gt|quot);/g, (_, n) => ({ amp: "&", lt: "<", gt: ">", quot: '"' }[n]));

function dom() {
  let document;
  class Element {
    constructor(tag = "div") {
      this.tagName = tag;
      this.attributes = {};
      this.children = [];
      this.dataset = {};
      this.listeners = {};
      this.style = { setProperty() {} };
      this.value = "";
      this.text = "";
      this.classList = {
        contains: (name) => (this.attributes.class || "").split(/\s+/).includes(name),
        add: (name) => this.classList.toggle(name, true),
        remove: (name) => this.classList.toggle(name, false),
        toggle: (name, on) => {
          const classes = new Set((this.attributes.class || "").split(/\s+/).filter(Boolean));
          if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name);
          this.attributes.class = [...classes].join(" ");
        },
      };
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value);
      if (name === "value") this.value = value;
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    get isConnected() { return document.contains(this); }
    get childElementCount() { return this.children.length; }
    get textContent() { return this.text + this.children.map((e) => e.textContent).join(""); }
    set textContent(text) { this.text = String(text); this.children = []; }
    set innerHTML(html) {
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this.text = "";
      const stack = [this];
      for (const part of html.match(/<[^>]+>|[^<]+/g) || []) {
        if (part.startsWith("</")) { stack.pop(); continue; }
        if (part.startsWith("<")) {
          const tag = part.match(/^<(\w+)/)[1];
          const child = new Element(tag);
          for (const attr of part.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
            child.setAttribute(attr[1], decode(attr[2] || ""));
          }
          stack.at(-1).appendChild(child);
          if (!["input", "br", "hr"].includes(tag)) stack.push(child);
        } else stack.at(-1).text += decode(part);
      }
    }
    matches(selector) {
      const tag = selector.match(/^\w+/)?.[0];
      if (tag && tag !== this.tagName) return false;
      for (const [, id] of selector.matchAll(/#([\w-]+)/g)) if (this.attributes.id !== id) return false;
      for (const [, cls] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(cls)) return false;
      for (const [, name, quoted, bare] of selector.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]+)))?\]/g)) {
        const value = quoted ?? bare;
        if (value === undefined ? !(name in this.attributes) : this.attributes[name] !== value) return false;
      }
      return true;
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (selector.split(/,\s*/).some((s) => node.matches(s))) return node;
      return null;
    }
    querySelectorAll(selector) {
      const parts = selector.split(/\s+(?![^\[]*\])/);
      const results = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(parts.at(-1))) {
            let ancestor = child.parentElement, index = parts.length - 2;
            while (ancestor && index >= 0) { if (ancestor.matches(parts[index])) index--; ancestor = ancestor.parentElement; }
            if (index < 0) results.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return results;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(child) { for (let node = child; node; node = node.parentElement) if (node === this) return true; return false; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    fire(type, details = {}) {
      const event = {
        type, target: this, clientX: 100, defaultPrevented: false, stopped: false, ...details,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      };
      for (let node = this; node; node = node.parentElement) {
        for (const fn of node.listeners[type] || []) fn(event);
        if (event.stopped) break;
      }
      return event;
    }
    focus() {
      if (document.activeElement === this) return;
      const previous = document.activeElement;
      document.activeElement = this;
      if (previous?.onblur) previous.onblur();
    }
    blur() { document.activeElement = null; if (this.onblur) this.onblur(); }
    get isContentEditable() { return this.contentEditable === "true"; }
    select() { this.selected = true; }
    scrollIntoView() {}
    getContext() { return new Proxy({}, { get: (target, key) => target[key] || (() => {}) }); }
    getBoundingClientRect() { return { left: 100, top: 100, bottom: 160, width: 300, height: 240 }; }
  }
  document = new Element("document");
  document.activeElement = null;
  document.innerHTML = `<div id="cs-mode"><button data-v="chords"></button><button data-v="numbers"></button></div>
    <button id="cs-edit"></button><div id="cs-edit-hint"></div><div id="chordsheet"></div><div id="chord-pop" class="hidden"></div>
    ${["cs-font-up", "cs-font-down", "cs-print", "live-capo", "roll", "roll-scroll", "roll-zoom-in", "roll-zoom-out", "roll-follow", "roll-save", "roll-undo", "roll-delete", "roll-sound", "live-beats", "live-bar", "live-sec", "live-now", "live-next", "live-piano", "live-strip", "roll-tracks", "roll-status"].map((id) => `<div id="${id}"></div>`).join("")}
    <select id="native-select"></select><div id="custom-button" role="button"></div>
    <div id="v-live" class="hidden"></div><div id="v-roll" class="hidden"></div>`;
  document.clientWidth = 1024;
  return document;
}

function harness({ tracks = {} } = {}) {
  const document = dom();
  const requests = [], seeks = [], toasts = [], events = {};
  let reloads = 0, staleMarks = 0;
  const sandbox = vm.createContext({ document, devicePixelRatio: 1, confirm: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    window: { innerWidth: 1024, innerHeight: 768, addEventListener(type, fn) { (events[type] ||= []).push(fn); } },
  });
  vm.runInContext(source + "\nglobalThis.views = Views;", sandbox);
  const views = sandbox.views;
  const data = {
    title: "Test", key_short: "C", key_changes: [], tempo: 120, time_signature: "4/4", beats_per_bar: 4,
    sections: [], semitones: 0, tracks, drum_kit: {}, beat_times: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
    bars: [0, 1].map((index) => ({ index, number: index + 1, start: index * 2, end: (index + 1) * 2,
      chords: [{ name: index ? "Am" : "C", number: index ? "vi" : "I", beat: 0, root: null }], lyrics: "" })),
  };
  views.init({
    seek: (...args) => seeks.push(args),
    toast: (message) => toasts.push(message),
    markStale: () => { staleMarks++; },
    api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    reload: () => { reloads++; views.setData(data, "a"); },
  });
  views.setData(data, "a");
  const node = (selector) => document.querySelector(selector);
  const row = (bar = 0) => node(`.cs-chords[data-bar="${bar}"]`);
  const open = (bar = 0) => { if (!views.ctx.edit) node("#cs-edit").fire("click"); row(bar).focus(); row(bar).fire("keydown", { key: "Enter" }); };
  const key = (key, target = node("#roll"), extras = {}) => {
    const event = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extras };
    for (const fn of events.keydown || []) fn(event);
    return event;
  };
  return { document, views, data, node, row, open, requests, seeks, toasts, events, key,
    get reloads() { return reloads; }, get staleMarks() { return staleMarks; } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("editing makes chord rows named keyboard buttons and stops exposing buttons when disabled", () => {
  const h = harness();
  assert.equal(h.row().getAttribute("tabindex"), null);
  h.node("#cs-edit").fire("click");
  assert.equal(h.row().getAttribute("role"), "button");
  assert.equal(h.row().getAttribute("tabindex"), "0");
  assert.equal(h.row().getAttribute("aria-label"), "1마디 코드 편집");
  assert.equal(h.row().getAttribute("aria-haspopup"), "dialog");
  assert.equal(h.node("#cs-edit").getAttribute("aria-pressed"), "true");
  h.node("#cs-edit").fire("click");
  assert.equal(h.row().getAttribute("role"), null);
  assert.equal(h.row().getAttribute("tabindex"), null);
  assert.equal(h.node("#cs-edit").getAttribute("aria-pressed"), "false");
});

for (const key of ["Enter", " "]) test(`${JSON.stringify(key)} opens a named, described dialog at the first beat`, () => {
  const h = harness();
  h.node("#cs-edit").fire("click");
  const event = h.row(1).fire("keydown", { key });
  assert.equal(event.defaultPrevented, true);
  const pop = h.node("#chord-pop");
  assert.equal(pop.classList.contains("hidden"), false);
  assert.equal(pop.getAttribute("role"), "dialog");
  assert.match(h.node(`#${pop.getAttribute("aria-labelledby")}`).textContent, /2마디 1박부터 코드 편집/);
  assert.match(h.node(`#${pop.getAttribute("aria-describedby")}`).textContent, /Escape/);
  assert.equal(h.document.activeElement, h.node("#pop-input"));
  assert.equal(h.node("#pop-input").value, "Am");
  assert.equal(h.node('label[for="pop-input"]').textContent, "코드 이름");
});

for (const selector of ["#pop-input", ".pop-quick button", "#pop-ok", "#pop-del", "#pop-cancel"]) {
  test(`Escape from ${selector} closes and restores the originating chord row`, () => {
    const h = harness();
    h.open(1);
    h.node(selector).focus();
    const event = h.node(selector).fire("keydown", { key: "Escape" });
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.node("#chord-pop").classList.contains("hidden"), true);
    assert.equal(h.document.activeElement, h.row(1));
    assert.equal(h.requests.length, 0);
  });
}

test("cancel restores the original chord row, while outside clicks keep the new focus", () => {
  const h = harness();
  h.open();
  h.node("#pop-cancel").fire("click");
  assert.equal(h.document.activeElement, h.row());
  h.open(1);
  const outside = h.node("#native-select");
  outside.focus();
  outside.fire("click");
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), true);
  assert.equal(h.document.activeElement, outside);
  assert.equal(h.requests.length, 0);
});

test("a rejected save retains the input and accessible error, allows retry, and preserves focus after redraw", async () => {
  const h = harness();
  h.open();
  const input = h.node("#pop-input");
  input.value = "Dm7";
  input.fire("keydown", { key: "Enter" });
  h.node("#pop-ok").fire("click");
  assert.equal(h.requests.length, 1, "one save may be in flight per popup");
  h.requests[0].reject(new Error("코드를 확인해 주세요"));
  await settle();
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), false);
  assert.equal(h.node("#pop-input"), input);
  assert.equal(input.value, "Dm7");
  assert.equal(h.node("#pop-err").textContent, "코드를 확인해 주세요");
  assert.equal(h.node("#pop-err").getAttribute("role"), "alert");
  assert.equal(input.getAttribute("aria-describedby"), "pop-err");
  h.node("#pop-ok").fire("click");
  assert.equal(h.requests.length, 2);
  assert.equal(h.node("#pop-err").textContent, "");
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { bar: 0, beat: 0, name: "Dm7", semitones: 0 });
  h.requests[1].resolve({});
  await settle();
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), true);
  assert.equal(h.reloads, 1);
  assert.equal(h.document.activeElement, h.row(), "focus survives the save's chord-sheet redraw");
});

test("pointer editing retains beat selection and reading mode retains seek behavior", async () => {
  const h = harness();
  h.row(1).fire("click");
  assert.deepEqual(h.seeks, [[2, true]]);
  h.node("#cs-edit").fire("click");
  h.row(1).fire("click", { clientX: 280 });
  h.node("#pop-ok").fire("click");
  assert.equal(JSON.parse(h.requests[0].options.body).beat, 2);
  h.requests[0].resolve({});
  await settle();
});

for (const outcome of ["resolve", "reject"]) test(`a previous popup's ${outcome} cannot alter a replacement popup`, async () => {
  const h = harness();
  h.open();
  h.node("#pop-ok").fire("click");
  h.node("#pop-cancel").fire("click");
  h.open(1);
  h.node("#pop-input").value = "G7";
  h.requests[0][outcome](new Error("old error"));
  await settle();
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), false);
  assert.equal(h.node("#pop-input").value, "G7");
  assert.equal(h.node("#pop-err").textContent, "");
  assert.equal(h.reloads, 0);
});

test("switching jobs dismisses the old popup and ignores its save completion", async () => {
  const h = harness();
  h.open();
  h.node("#pop-ok").fire("click");
  h.views.setData(h.data, "b");
  h.requests[0].resolve({});
  await settle();
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), true);
  assert.equal(h.reloads, 0);
  assert.equal(h.requests[0].url, "/api/jobs/a/chord");
});

test("approved discard clears roll edit markers and closes the popup", () => {
  const h = harness();
  h.open();
  Object.assign(h.views.ctx.roll, { dirty: true, undo: ["old"], sel: 1, drag: {} });
  h.views.discardUnsaved();
  assert.equal(h.views.hasUnsaved(), false);
  assert.equal(h.views.ctx.roll.undo.length, 0);
  assert.equal(h.views.ctx.roll.sel, null);
  assert.equal(h.views.ctx.roll.drag, null);
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), true);
});

function tracks() {
  return {
    piano: { label_ko: "피아노", kind: "pitched", range: [60, 72], notes: [[0, 1, 60, 90]] },
    bass: { label_ko: "베이스", kind: "pitched", range: [36, 48], notes: [[0, 1, 36, 90]] },
  };
}
function rollHarness() {
  const h = harness({ tracks: tracks() });
  h.node("#v-roll").classList.remove("hidden");
  h.views.ctx.roll.sel = 0;
  h.key("ArrowUp");
  return h;
}
function startNotesSave(h) { h.node("#roll-save").fire("click"); return h.requests.at(-1); }
function editLyric(h, text, bar = 0) {
  if (!h.views.ctx.edit) h.node("#cs-edit").fire("click");
  const el = h.node(`.cs-lyrics[data-bar="${bar}"]`);
  el.fire("click");
  el.textContent = text;
  el.blur();
  return el;
}

test("note saves give pending feedback, reject duplicate submits, preserve failed edits, and permit retry", async () => {
  const h = rollHarness();
  const first = startNotesSave(h);
  startNotesSave(h);
  assert.equal(h.requests.length, 1);
  assert.equal(h.node("#roll-save").disabled, true);
  assert.equal(h.node("#roll-save").getAttribute("aria-busy"), "true");
  first.reject(new Error("note save failed"));
  await settle();
  assert.equal(h.views.hasUnsaved(), true);
  assert.equal(h.views.ctx.roll.undo.length, 1);
  assert.equal(h.node("#roll-save").disabled, false);
  assert.equal(h.node("#roll-save").getAttribute("aria-busy"), "false");
  assert.deepEqual(h.toasts, ["note save failed"]);
  const retry = startNotesSave(h);
  retry.resolve({});
  await settle();
  assert.equal(h.views.hasUnsaved(), false);
  assert.equal(h.views.ctx.roll.undo.length, 0);
  assert.equal(h.staleMarks, 1);
});

test("edits made during a note save retain dirty state and undo history", async () => {
  const h = rollHarness();
  const pending = startNotesSave(h);
  const savedPitch = JSON.parse(pending.options.body).notes[0][2];
  h.key("ArrowUp");
  const undoCount = h.views.ctx.roll.undo.length;
  pending.resolve({});
  await settle();
  assert.equal(savedPitch, 61);
  assert.equal(h.data.tracks.piano.notes[0][2], 62);
  assert.equal(h.views.hasUnsaved(), true);
  assert.equal(h.views.ctx.roll.undo.length, undoCount);
  assert.equal(h.node("#roll-save").disabled, false);
  assert.match(h.toasts.at(-1), /새 수정/);
});

test("old job note completion cannot clear the current job's pending edits or output state", async () => {
  const h = rollHarness();
  const older = startNotesSave(h);
  h.views.discardUnsaved();
  h.views.setData({ ...h.data, tracks: tracks() }, "b");
  h.views.ctx.roll.sel = 0;
  h.key("ArrowUp");
  const newer = startNotesSave(h);
  newer.resolve({});
  await settle();
  h.key("ArrowUp");
  older.resolve({});
  await settle();
  assert.equal(h.views.ctx.jobId, "b");
  assert.equal(h.views.hasUnsaved(), true);
  assert.equal(h.views.ctx.roll.undo.length, 1);
  assert.equal(h.staleMarks, 1);
  assert.equal(h.toasts.length, 1);
});

for (const outcome of ["resolve", "reject"]) test(`track changes ignore a previous track's note save ${outcome}`, async () => {
  const h = rollHarness();
  const pending = startNotesSave(h);
  h.node('#roll-tracks button[data-t="bass"]').fire("click");
  h.views.ctx.roll.sel = 0;
  h.key("ArrowUp");
  const bassPitch = h.views.ctx.view.tracks.bass.notes[0][2];
  pending[outcome](new Error("piano save failed"));
  await settle();
  assert.equal(h.views.ctx.roll.track, "bass");
  assert.equal(h.views.ctx.view.tracks.bass.notes[0][2], bassPitch);
  assert.equal(h.views.hasUnsaved(), true);
  assert.equal(h.views.ctx.roll.undo.length, 1);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.staleMarks, 0);
});

test("returning to a track does not revive its old save, and same-target writes never overlap", async () => {
  const h = rollHarness();
  const pending = startNotesSave(h);
  h.node('#roll-tracks button[data-t="bass"]').fire("click");
  h.node('#roll-tracks button[data-t="piano"]').fire("click");
  h.views.ctx.roll.sel = 0;
  h.key("ArrowUp");
  startNotesSave(h);
  assert.equal(h.requests.length, 1);
  pending.resolve({});
  await settle();
  assert.equal(h.views.hasUnsaved(), true);
  assert.equal(h.staleMarks, 0);
  assert.equal(h.node("#roll-save").disabled, false);
  startNotesSave(h).resolve({});
  await settle();
  assert.equal(h.views.hasUnsaved(), false);
});

test("replacing the same job view invalidates saves and stale note selection/drag/undo", async () => {
  const h = rollHarness();
  const pending = startNotesSave(h);
  h.views.ctx.roll.drag = { moved: true };
  h.views.setData({ ...h.data, tracks: tracks(), semitones: 2 }, "a");
  pending.resolve({});
  await settle();
  assert.equal(h.views.ctx.roll.sel, null);
  assert.equal(h.views.ctx.roll.drag, null);
  assert.equal(h.views.ctx.roll.undo.length, 0);
  assert.equal(h.staleMarks, 0);
  assert.equal(h.toasts.length, 0);
});

test("accepted navigation invalidates an in-flight save before the next view loads", async () => {
  const h = rollHarness();
  const pending = startNotesSave(h);
  h.views.discardUnsaved();
  pending.reject(new Error("old job failed"));
  await settle();
  assert.equal(h.toasts.length, 0);
  assert.equal(h.staleMarks, 0);
});

test("lyric edits keep server writes ordered and ignore superseded response feedback", async () => {
  const h = harness();
  editLyric(h, "first words");
  const first = h.requests[0];
  editLyric(h, "latest words");
  assert.equal(h.requests.length, 1, "same-bar writes must wait for prior completion");
  first.resolve({});
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.toasts.length, 0, "superseded response must not announce or apply old text");
  assert.equal(h.data.bars[0].lyrics, "");
  assert.equal(JSON.parse(h.requests[1].options.body).text, "latest words");
  h.requests[1].resolve({});
  await settle();
  assert.equal(h.data.bars[0].lyrics, "latest words");
  assert.equal(h.toasts.length, 1);
  assert.equal(h.staleMarks, 1);
});

test("different-bar lyric responses can finish in reverse order without overwriting each other", async () => {
  const h = harness();
  editLyric(h, "first bar", 0);
  editLyric(h, "second bar", 1);
  h.requests[1].resolve({});
  h.requests[0].resolve({});
  await settle();
  assert.equal(h.data.bars[0].lyrics, "first bar");
  assert.equal(h.data.bars[1].lyrics, "second bar");
});

for (const outcome of ["resolve", "reject"]) test(`old lyric ${outcome} cannot mutate or announce a later job`, async () => {
  const h = harness();
  editLyric(h, "old words");
  h.views.discardUnsaved();
  const next = { ...h.data, bars: h.data.bars.map((bar) => ({ ...bar, lyrics: "new words" })) };
  h.views.setData(next, "b");
  h.requests[0][outcome](new Error("old lyric failure"));
  await settle();
  assert.equal(next.bars[0].lyrics, "new words");
  assert.equal(h.toasts.length, 0);
  assert.equal(h.staleMarks, 0);
});

test("blurring an old lyric editor after navigation never sends to the new job", () => {
  const h = harness();
  h.node("#cs-edit").fire("click");
  const el = h.node('.cs-lyrics[data-bar="0"]');
  el.fire("click");
  el.textContent = "old unsaved text";
  h.views.discardUnsaved();
  h.views.setData(h.data, "b");
  el.blur();
  assert.equal(h.requests.length, 0);
});

test("a failed lyric save retains entered text and a queued retry still saves", async () => {
  const h = harness();
  const el = editLyric(h, "first words");
  editLyric(h, "retry words");
  h.requests[0].reject(new Error("network failed"));
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(el.textContent, "retry words");
  h.requests[1].resolve({});
  await settle();
  assert.equal(h.data.bars[0].lyrics, "retry words");
});

for (const selector of ["#native-select", "#cs-edit", "#custom-button"]) test(`note shortcuts leave ${selector} keyboard behavior alone`, () => {
  const h = rollHarness();
  const before = JSON.stringify(h.data.tracks.piano.notes);
  const count = h.views.ctx.roll.undo.length;
  for (const key of ["ArrowUp", "ArrowDown", "Delete", "Backspace"]) {
    const event = h.key(key, h.node(selector));
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(JSON.stringify(h.data.tracks.piano.notes), before);
  assert.equal(h.views.ctx.roll.undo.length, count);
});

test("note shortcuts respect composition and handled keys, and recover a stale selection", () => {
  const h = rollHarness();
  const before = JSON.stringify(h.data.tracks.piano.notes);
  h.key("ArrowUp", h.node("#roll"), { isComposing: true });
  h.key("ArrowUp", h.node("#roll"), { defaultPrevented: true });
  assert.equal(JSON.stringify(h.data.tracks.piano.notes), before);
  h.views.ctx.roll.sel = 100;
  assert.doesNotThrow(() => h.key("ArrowUp"));
  assert.equal(h.views.ctx.roll.sel, null);
});

test("closing and reopening a chord editor serializes writes to the same bar", async () => {
  const h = harness();
  h.open();
  h.node("#pop-input").value = "Dm";
  h.node("#pop-ok").fire("click");
  assert.equal(h.node("#chord-pop").getAttribute("aria-busy"), "true");
  h.node("#pop-cancel").fire("click");
  h.open();
  h.node("#pop-input").value = "G7";
  h.node("#pop-ok").fire("click");
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({});
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), false);
  assert.equal(JSON.parse(h.requests[1].options.body).name, "G7");
  h.requests[1].resolve({});
  await settle();
  assert.equal(h.reloads, 1);
});

test("same-job view replacement invalidates a pending chord response", async () => {
  const h = harness();
  h.open();
  h.node("#pop-ok").fire("click");
  h.views.setData({ ...h.data, semitones: 2 }, "a");
  h.open(1);
  h.requests[0].reject(new Error("old transposition"));
  await settle();
  assert.equal(h.node("#pop-err").textContent, "");
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), false);
});

test("reverting lyric text while a save is pending is queued instead of dropping the user's revert", async () => {
  const h = harness();
  editLyric(h, "temporary words");
  editLyric(h, "");
  h.requests[0].resolve({});
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[1].options.body).text, "");
  h.requests[1].resolve({});
  await settle();
  assert.equal(h.data.bars[0].lyrics, "");
});

test("note changes while a drag is still active survive an in-flight save", async () => {
  const h = rollHarness();
  const r = h.views.ctx.roll;
  r.drag = { x: 100, y: 50, orig: [...h.data.tracks.piano.notes[0]], resize: false, moved: true };
  const pending = startNotesSave(h);
  for (const fn of h.events.mousemove) fn({ clientX: 260, clientY: 150 });
  pending.resolve({});
  await settle();
  assert.equal(r.dirty, true);
  assert.equal(r.undo.length, 1);
  assert.ok(r.drag, "test resolves the response before mouseup");
  assert.match(h.toasts.at(-1), /새 수정/);
});

test("same-job same-key refresh preserves dirty notes, undo, selection, and updated server lyrics", () => {
  const h = rollHarness();
  const r = h.views.ctx.roll;
  const localNotes = h.views.ctx.view.tracks.piano.notes;
  const localUndo = r.undo;
  const serverView = {
    ...h.data, tracks: tracks(),
    bars: h.data.bars.map((bar) => ({ ...bar, lyrics: "saved lyric" })),
  };
  h.views.setData(serverView, "a");
  assert.equal(h.views.ctx.view.tracks.piano.notes, localNotes);
  assert.equal(localNotes[0][2], 61);
  assert.equal(r.undo, localUndo);
  assert.equal(r.sel, 0);
  assert.equal(r.dirty, true);
  assert.equal(h.views.ctx.view.bars[0].lyrics, "saved lyric");
  h.node("#roll-undo").fire("click");
  assert.equal(h.views.ctx.view.tracks.piano.notes[0][2], 60);
});

test("chord save reload preserves unsaved piano-roll notes and undo state", async () => {
  const h = rollHarness();
  const localNotes = h.views.ctx.view.tracks.piano.notes;
  const undo = h.views.ctx.roll.undo;
  h.views.ctx.hooks.reload = () => h.views.setData({ ...h.data, tracks: tracks() }, "a");
  h.open();
  h.node("#pop-input").value = "Dm7";
  h.node("#pop-ok").fire("click");
  h.requests[0].resolve({});
  await settle();
  assert.equal(h.views.ctx.view.tracks.piano.notes, localNotes);
  assert.equal(localNotes[0][2], 61);
  assert.equal(h.views.ctx.roll.undo, undo);
  assert.equal(h.views.ctx.roll.sel, 0);
  assert.equal(h.views.hasUnsaved(), true);
});

test("lyric save followed by refresh preserves dirty notes while displaying the saved lyric", async () => {
  const h = rollHarness();
  const localNotes = h.views.ctx.view.tracks.piano.notes;
  const undo = h.views.ctx.roll.undo;
  editLyric(h, "saved words");
  h.requests[0].resolve({});
  await settle();
  h.views.setData({ ...h.data, tracks: tracks() }, "a");
  assert.equal(h.views.ctx.view.bars[0].lyrics, "saved words");
  assert.equal(h.views.ctx.view.tracks.piano.notes, localNotes);
  assert.equal(h.views.ctx.roll.undo, undo);
  assert.equal(h.views.hasUnsaved(), true);
});

test("a successful explicit discard replaces dirty notes even when the job and key stay the same", () => {
  const h = rollHarness();
  h.views.discardUnsaved();
  h.views.setData({ ...h.data, tracks: tracks() }, "a");
  assert.equal(h.views.ctx.view.tracks.piano.notes[0][2], 60);
  assert.equal(h.views.hasUnsaved(), false);
  assert.equal(h.views.ctx.roll.sel, null);
  assert.equal(h.views.ctx.roll.undo.length, 0);
});

test("new job or transposition never carries old local notes into the new view", () => {
  for (const [jobId, semitones] of [["b", 0], ["a", 2]]) {
    const h = rollHarness();
    h.views.setData({ ...h.data, tracks: tracks(), semitones }, jobId);
    assert.equal(h.views.ctx.view.tracks.piano.notes[0][2], 60);
    assert.equal(h.views.hasUnsaved(), false);
    assert.equal(h.views.ctx.roll.sel, null);
    assert.equal(h.views.ctx.roll.undo.length, 0);
  }
});

test("preserving local notes clears an invalid selection and keeps a partial drag as an unsaved edit", () => {
  const h = rollHarness();
  const r = h.views.ctx.roll;
  r.dirty = false;
  r.sel = 100;
  r.drag = { moved: true };
  assert.equal(h.views.hasUnsaved(), true, "an active moved drag already contains unsaved edits");
  h.views.setData({ ...h.data, tracks: tracks() }, "a");
  assert.equal(h.views.ctx.view.tracks.piano.notes[0][2], 61);
  assert.equal(r.sel, null);
  assert.equal(r.drag, null);
  assert.equal(r.dirty, true);
});

test("clicking lyrics outside the popup keeps the lyric editor focused and editable after bubbling", () => {
  const h = harness();
  h.open();
  const lyric = h.node('.cs-lyrics[data-bar="1"]');
  lyric.fire("click");
  assert.equal(h.node("#chord-pop").classList.contains("hidden"), true);
  assert.equal(h.document.activeElement, lyric);
  assert.equal(lyric.isContentEditable, true, "popup dismissal must not blur and immediately end lyric editing");
  assert.equal(h.requests.length, 0);
  lyric.textContent = "new lyric";
  h.node("#native-select").focus();
  assert.equal(lyric.isContentEditable, false, "a later intentional focus move should still save");
  assert.equal(h.requests.length, 1);
});

test("edit revision detects keyboard changes, undo, and motion within an active drag", () => {
  const h = rollHarness();
  const first = h.views.getEditRevision();
  h.key("ArrowUp");
  const second = h.views.getEditRevision();
  assert.ok(second > first);
  h.node("#roll-undo").fire("click");
  const third = h.views.getEditRevision();
  assert.ok(third > second);
  const r = h.views.ctx.roll;
  r.sel = 0;
  r.drag = { x: 100, y: 50, orig: [...h.data.tracks.piano.notes[0]], resize: false, moved: true };
  for (const fn of h.events.mousemove) fn({ clientX: 260, clientY: 150 });
  assert.ok(h.views.getEditRevision() > third);
  const beforeDiscard = h.views.getEditRevision();
  h.views.discardUnsaved();
  assert.equal(h.views.getEditRevision(), beforeDiscard, "discard must not reset the revision counter");
});
