"use strict";

// Real browser controller, deterministic DOM/fetch substitutes; no server or audio models.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../band2sheet/app/static/app.js"), "utf8");

function element(tag = "div", document = null) {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(), textContent: "", value: "", disabled: false, checked: false,
    get innerHTML() { return this.html || ""; },
    set innerHTML(value) { this.html = value; this.children = []; },
    style: {}, dataset: {}, children: [], attributes: {}, listeners: {},
    classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    pause() {}, add(option) { this.children.push(option); },
    focus() { if (document) document.activeElement = this; },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    querySelector() { return element(); },
  };
}

function harness({ jobsError = null, jobs = [], unsaved = false, confirmResult = true } = {}) {
  const elements = new Map();
  const requests = [];
  const timers = new Map();
  const renderedViews = [];
  const osmdLoads = [];
  const osmdInstances = [];
  const controls = { jobsError, jobs, unsaved, confirmResult, prompts: [], discarded: 0, editRevision: 0, undo: [], drag: null };
  const document = { activeElement: null };
  let timerId = 0;
  const node = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element("div", document));
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: Object.assign(document, { querySelector: node, querySelectorAll: () => [], createElement: (tag) => element(tag, document) }),
    window: { addEventListener() {} }, console, URLSearchParams,
    confirm(message) { controls.prompts.push(message); return controls.confirmResult; },
    opensheetmusicdisplay: { OpenSheetMusicDisplay: class {
      constructor(container) {
        this.container = container;
        this.EngravingRules = {};
        this.GraphicSheet = { MusicPages: [] };
        osmdInstances.push(this);
      }
      load(xml) {
        return new Promise((resolve, reject) => osmdLoads.push({
          xml, osmd: this, resolve: () => { this.xml = xml; resolve(); }, reject,
        }));
      }
      render() { this.rendered = this.xml; }
    } },
    Option: function(text, value) { return { text, value }; },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    Views: {
      setData(view, id) { renderedViews.push({ view, id, unsaved: controls.unsaved }); },
      shown() {}, hasUnsaved: () => controls.unsaved,
      getEditRevision: () => controls.editRevision,
      discardUnsaved() { controls.unsaved = false; controls.discarded++; controls.undo = []; controls.drag = null; },
    },
    fetch(url, options = {}) {
      if (url === "/api/jobs") return controls.jobsError ? Promise.reject(controls.jobsError) : Promise.resolve(response(controls.jobs));
      return new Promise((resolve, reject) => requests.push({
        url, options, resolve: (body) => resolve(response(body)), reject,
      }));
    },
  });
  vm.runInContext(source + "\nglobalThis.app = { state, openJob, refreshJob, startAnalysis, loadView, startJob, updateStartButton, loadJobs, initSourceView, selectJob, refreshScore, loadSheet, transpose, newJob, deleteJob };", context);
  return { ...context.app, node, requests, timers, renderedViews, controls, document, osmdLoads, osmdInstances };
}

function response(body) {
  return { ok: true, headers: { get: () => "application/json" }, json: async () => body };
}

function job(id, status = "ready") {
  return { id, status, title: `Song ${id}`, progress: 0, stage: "", log: [], options: {}, source: {} };
}

function view(semitones) {
  return {
    semitones, original_key: "C major", original_key_short: "C", key: "C major", key_short: "C",
    key_changes: [], tempo: 120, time_signature: "4/4", sections: [],
  };
}

function select(h, id, status = "ready") {
  h.state.jobId = id;
  h.state.job = job(id, status);
}

async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

test("analysis submission is single-flight, gives feedback, and permits retry after failure", async () => {
  const h = harness();
  select(h, "a");
  const error = h.node("#s-error");
  const first = h.startAnalysis({}, error);
  const second = h.startAnalysis({}, error);
  assert.equal(h.requests.length, 1, "rapid clicks must issue only one analysis POST");
  assert.equal(h.node("#s-analyze").disabled, true);
  assert.equal(h.node("#s-analyze").attributes["aria-busy"], "true");
  h.requests[0].reject(new Error("try again"));
  await Promise.all([first, second]);
  assert.equal(error.textContent, "try again");
  assert.equal(h.node("#s-analyze").disabled, false);
  const retry = h.startAnalysis({}, error);
  assert.equal(h.requests.length, 2);
  h.requests[1].reject(new Error("still unavailable"));
  await retry;
});

test("successful analysis remains locked through status refresh and displays running progress", async () => {
  const h = harness();
  select(h, "a");
  const pending = h.startAnalysis({}, h.node("#s-error"));
  h.requests[0].resolve({});
  await settle();
  assert.equal(h.node("#s-analyze").disabled, true);
  await h.startAnalysis({}, h.node("#s-error"));
  assert.equal(h.requests.filter((r) => r.options.method === "POST").length, 1);
  h.requests.find((r) => r.url === "/api/jobs/a").resolve(job("a", "running"));
  await pending;
  assert.equal(h.state.job.status, "running");
  assert.equal(h.node("#view-progress").classList.contains("hidden"), false);
  assert.equal(h.node("#s-analyze").disabled, true);
  assert.equal(h.node("#s-analyze").attributes["aria-busy"], "false");
  assert.equal(h.timers.size, 1);
});

test("a sidebar failure cannot hide a successfully started analysis", async () => {
  const h = harness({ jobsError: new Error("sidebar unavailable") });
  select(h, "a");
  const pending = h.startAnalysis({}, h.node("#s-error"));
  h.requests[0].resolve({});
  await settle();
  const refresh = h.requests.find((r) => r.url === "/api/jobs/a");
  assert.ok(refresh, "status refresh must continue when the sidebar list fails");
  refresh.resolve(job("a", "running"));
  await pending;
  assert.equal(h.state.job.status, "running");
  assert.equal(h.node("#view-progress").classList.contains("hidden"), false);
});

test("a transient status error after accepted analysis shows feedback and retries polling", async () => {
  const h = harness();
  select(h, "a");
  const pending = h.startAnalysis({}, h.node("#s-error"));
  h.requests[0].resolve({});
  await settle();
  h.requests.find((r) => r.url === "/api/jobs/a").reject(new Error("temporary connection error"));
  await pending;
  assert.equal(h.node("#view-progress").classList.contains("hidden"), false);
  assert.equal(h.node("#p-error").textContent, "temporary connection error");
  const timer = h.timers.get(h.state.pollTimer);
  assert.ok(timer, "running job status must recover without a duplicate analysis POST");
  h.timers.delete(h.state.pollTimer);
  timer();
  await settle();
  h.requests[h.requests.length - 1].resolve(job("a", "running"));
  await settle();
  assert.equal(h.state.job.status, "running");
  assert.equal(h.node("#p-error").textContent, "");
  assert.equal(h.requests.filter((r) => r.options.method === "POST").length, 1);
});

test("an old job response cannot replace a newly selected job or restart its poll", async () => {
  const h = harness();
  select(h, "a");
  const old = h.refreshJob();
  const next = h.openJob("b");
  await settle();
  h.requests.find((r) => r.url === "/api/jobs/b").resolve(job("b"));
  await next;
  h.requests.find((r) => r.url === "/api/jobs/a").resolve(job("a", "running"));
  await old;
  assert.equal(h.state.job.id, "b");
  assert.equal(h.node("#s-title").textContent, "Song b");
  assert.equal(h.node("#view-source").classList.contains("hidden"), false);
  assert.equal(h.timers.size, 0);
});

test("returning to the same job does not revive a response from its previous visit", async () => {
  const h = harness();
  select(h, "a");
  const old = h.refreshJob();
  const away = h.openJob("b");
  const back = h.openJob("a");
  await settle();
  const aRequests = h.requests.filter((r) => r.url === "/api/jobs/a");
  aRequests[aRequests.length - 1].resolve(job("a", "error"));
  await back;
  aRequests[0].resolve(job("a", "running"));
  await old;
  for (const request of h.requests.slice(1, -1)) request.resolve(job("a", "error"));
  await away;
  assert.equal(h.state.job.status, "error");
  assert.equal(h.timers.size, 0);
});

test("overlapping refreshes retain the latest response for the same selected job", async () => {
  const h = harness();
  select(h, "a");
  const older = h.refreshJob();
  const newer = h.refreshJob();
  h.requests[1].resolve(job("a", "error"));
  await newer;
  h.requests[0].resolve(job("a", "running"));
  await older;
  assert.equal(h.state.job.status, "error");
  assert.equal(h.timers.size, 0);
});

test("analysis errors from a previous selection do not leak into the current screen", async () => {
  const h = harness();
  select(h, "a");
  const error = h.node("#s-error");
  const pending = h.startAnalysis({}, error);
  const next = h.openJob("b");
  await settle();
  h.requests.find((r) => r.url === "/api/jobs/b").resolve(job("b"));
  await next;
  h.requests[0].reject(new Error("a failed"));
  await pending;
  assert.equal(error.textContent, "");
  assert.equal(h.node("#s-analyze").disabled, false);
});

test("finishing an old analysis request does not unlock another job's pending submission", async () => {
  const h = harness();
  select(h, "a");
  const old = h.startAnalysis({}, h.node("#s-error"));
  const next = h.openJob("b");
  await settle();
  h.requests.find((r) => r.url === "/api/jobs/b").resolve(job("b"));
  await next;
  const pending = h.startAnalysis({}, h.node("#s-error"));
  h.requests[0].reject(new Error("old failure"));
  await old;
  assert.equal(h.node("#s-analyze").disabled, true);
  h.requests.find((r) => r.url === "/api/jobs/b/analyze").reject(new Error("current failure"));
  await pending;
  assert.equal(h.node("#s-error").textContent, "current failure");
  assert.equal(h.node("#s-analyze").disabled, false);
});

test("returning to a job with a pending analysis still displays its successful start", async () => {
  const h = harness();
  select(h, "a");
  const pending = h.startAnalysis({}, h.node("#s-error"));
  const away = h.openJob("b");
  await settle();
  h.requests.find((r) => r.url === "/api/jobs/b").resolve(job("b"));
  await away;
  const back = h.openJob("a");
  await settle();
  h.requests.find((r) => r.url === "/api/jobs/a").resolve(job("a"));
  await back;
  assert.equal(h.node("#s-analyze").disabled, true);
  h.requests[0].resolve({});
  await settle();
  const refreshes = h.requests.filter((r) => r.url === "/api/jobs/a");
  assert.equal(refreshes.length, 2, "accepted analysis must refresh the currently revisited job");
  refreshes[1].resolve(job("a", "running"));
  await pending;
  assert.equal(h.state.job.status, "running");
  assert.equal(h.node("#s-analyze").disabled, true);
});

test("a transposition response from a previous job does not attach to the current job", async () => {
  const h = harness();
  select(h, "a", "done");
  const old = h.loadView({ semitones: 1 });
  const next = h.openJob("b");
  await settle();
  h.requests.find((r) => r.url === "/api/jobs/b").resolve(job("b"));
  await next;
  h.requests[0].resolve(view(1));
  await old;
  assert.equal(h.renderedViews.length, 0);
  assert.notEqual(h.state.viewJob, "b");
});

test("rapid transposition selections keep the last requested view", async () => {
  const h = harness();
  select(h, "a", "done");
  const first = h.loadView({ semitones: 1 });
  const second = h.loadView({ semitones: 2 });
  h.requests[1].resolve(view(2));
  await second;
  h.requests[0].resolve(view(1));
  await first;
  assert.equal(h.state.view.semitones, 2);
  assert.deepEqual(h.renderedViews.map((v) => v.view.semitones), [2]);
});

test("a stale transposition failure does not replace the latest success feedback", async () => {
  const h = harness();
  select(h, "a", "done");
  const first = h.loadView({ semitones: 1 });
  const second = h.loadView({ semitones: 2 });
  h.requests[1].resolve(view(2));
  await second;
  const feedback = h.node("#t-info").textContent;
  h.requests[0].reject(new Error("outdated failure"));
  await first;
  assert.equal(h.node("#t-info").textContent, feedback);
  assert.equal(h.state.view.semitones, 2);
});

test("Enter and button submissions cannot create duplicate URL jobs while pending", async () => {
  const h = harness();
  h.node("#url").value = "https://example.invalid/test";
  const first = h.startJob();
  const second = h.startJob();
  assert.equal(h.requests.length, 1);
  h.updateStartButton();
  assert.equal(h.node("#btn-start").disabled, true);
  h.requests[0].reject(new Error("unavailable"));
  await Promise.all([first, second]);
  assert.equal(h.node("#btn-start").disabled, false);
});

test("an earlier job creation cannot clear input or change selection after navigation", async () => {
  const h = harness();
  h.node("#url").value = "https://example.invalid/old";
  const creation = h.startJob();
  const next = h.openJob("b");
  await settle();
  h.requests.find((r) => r.url === "/api/jobs/b").resolve(job("b"));
  await next;
  h.node("#url").value = "https://example.invalid/new";
  h.requests[0].resolve(job("a", "queued"));
  await creation;
  assert.equal(h.node("#url").value, "https://example.invalid/new");
  assert.equal(h.state.jobId, "b");
  assert.equal(h.state.job.id, "b");
});

test("job navigation cancellation preserves unsaved edits, playback, selection, and focus", async () => {
  const h = harness({ unsaved: true, confirmResult: false });
  select(h, "a", "done");
  const selected = h.state.job;
  const audio = { src: "a.wav", pause() { this.paused = true; } };
  h.state.audios.mix = audio;
  const trigger = h.node("#btn-new");
  trigger.focus();
  const navigation = h.openJob("b");
  assert.equal(h.state.job, selected);
  assert.equal(h.state.jobId, "a");
  assert.equal(h.state.audios.mix, audio);
  assert.equal(audio.paused, undefined);
  assert.equal(h.document.activeElement, trigger);
  assert.equal(h.controls.unsaved, true);
  assert.equal(h.controls.discarded, 0);
  assert.equal(h.requests.length, 0);
  await navigation;
});

test("new song navigation uses the same cancellable guard", async () => {
  const h = harness({ unsaved: true, confirmResult: false });
  select(h, "a", "done");
  assert.equal(typeof h.newJob, "function");
  await h.newJob();
  assert.equal(h.state.jobId, "a");
  assert.equal(h.controls.unsaved, true);
  h.controls.confirmResult = true;
  await h.newJob();
  assert.equal(h.state.jobId, null);
  assert.equal(h.controls.unsaved, false);
  assert.equal(h.controls.discarded, 1);
});

test("delete cancellation and request failure preserve edits; success discards only after confirmation", async () => {
  const h = harness({ unsaved: true, confirmResult: false });
  select(h, "a", "done");
  assert.equal(typeof h.deleteJob, "function");
  await h.deleteJob("삭제할까요?", h.node("#p-error"));
  assert.equal(h.requests.length, 0);
  assert.equal(h.controls.unsaved, true);
  h.controls.confirmResult = true;
  const failed = h.deleteJob("삭제할까요?", h.node("#p-error"));
  h.requests[0].reject(new Error("삭제할 수 없습니다"));
  await failed;
  assert.equal(h.state.jobId, "a");
  assert.equal(h.controls.unsaved, true);
  assert.equal(h.controls.discarded, 0);
  assert.equal(h.node("#p-error").textContent, "삭제할 수 없습니다");
  const retry = h.deleteJob("삭제할까요?", h.node("#p-error"));
  h.requests[1].resolve({});
  await retry;
  assert.equal(h.state.jobId, null);
  assert.equal(h.controls.unsaved, false);
});

test("opening the active song does not reload and overwrite unsaved edits", async () => {
  const h = harness({ unsaved: true });
  select(h, "a", "done");
  const opening = h.openJob("a");
  await settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.controls.prompts.length, 0);
  assert.equal(h.controls.unsaved, true);
  await opening;
});

test("job list provides native buttons with current selection and retains keyboard focus on refresh", async () => {
  const h = harness({ jobs: [job("a"), job("b", "error")] });
  select(h, "a");
  await h.loadJobs();
  const rows = h.node("#job-list").children;
  assert.equal(rows[0].children[0].tagName, "BUTTON");
  assert.equal(rows[0].children[0].type, "button");
  assert.equal(rows[0].children[0].attributes["aria-current"], "true");
  rows[1].children[0].focus();
  await h.loadJobs();
  assert.equal(h.document.activeElement, h.node("#job-list").children[1].children[0]);
});

test("list failures preserve loaded songs, show a persistent retry, and never claim an empty library", async () => {
  const h = harness({ jobs: [job("a")] });
  await h.loadJobs();
  const row = h.node("#job-list").children[0];
  h.controls.jobsError = new Error("connection lost");
  await h.loadJobs();
  assert.equal(h.node("#job-list").children[0], row);
  assert.match(h.node("#jobs-error").textContent, /connection lost/);
  assert.equal(h.node("#jobs-error").classList.contains("hidden"), false);
  assert.equal(h.node("#jobs-retry").classList.contains("hidden"), false);
  assert.equal(h.node("#jobs-retry").disabled, false);
  assert.equal(h.node("#job-empty").classList.contains("hidden"), true);
  h.controls.jobsError = null;
  await h.loadJobs();
  assert.equal(h.node("#jobs-error").textContent, "");
  assert.equal(h.node("#jobs-retry").classList.contains("hidden"), true);
  assert.equal(h.node("#job-list").attributes["aria-busy"], "false");
});

test("the first job GET failure offers a GET-only retry and recovers", async () => {
  const h = harness();
  h.initSourceView();
  const opening = h.openJob("a");
  await settle();
  h.requests[0].reject(new Error("connection lost"));
  await opening;
  assert.equal(h.node("#p-refresh").classList.contains("hidden"), false);
  assert.equal(h.node("#p-refresh").disabled, false);
  assert.match(h.node("#p-heading").textContent, /확인하지 못했습니다/);
  assert.equal(h.node("#p-retry").classList.contains("hidden"), true);
  const retry = h.node("#p-refresh").listeners.click();
  assert.equal(h.node("#p-refresh").disabled, true);
  assert.equal(h.requests[1].url, "/api/jobs/a");
  assert.equal(h.requests[1].options.method, undefined);
  h.requests[1].resolve(job("a", "running"));
  await retry;
  assert.equal(h.state.job.status, "running");
  assert.equal(h.node("#p-refresh").classList.contains("hidden"), true);
  assert.equal(h.node("#p-error").textContent, "");
});

test("analysis errors override stale stage text and expose accessible progress", async () => {
  const h = harness();
  select(h, "a");
  const refreshing = h.refreshJob();
  h.requests[0].resolve({ ...job("a", "error"), stage: "대기 중", progress: 0.4, error: "분리 엔진을 확인하세요" });
  await refreshing;
  assert.match(h.node("#p-heading").textContent, /완료하지 못했습니다/);
  assert.doesNotMatch(h.node("#p-stage").textContent, /대기 중/);
  assert.equal(h.node("#p-bar").attributes.role, "progressbar");
  assert.equal(h.node("#p-bar").attributes["aria-valuenow"], "40");
  assert.equal(h.node("#p-error").attributes.role, "alert");
  assert.equal(h.node("#p-retry").classList.contains("hidden"), false);
});

function scoreResult(id, semitones = 0) {
  return { sheet_dir: id, semitones, files: [], parts: [], stems: [] };
}

function selectScore(h, id, semitones = 0) {
  h.selectJob(id);
  select(h, id, "done");
  h.state.result = scoreResult(id, semitones);
  h.state.view = view(semitones);
}

test("score renders survive A to B to A navigation without old results or errors replacing the latest visit", async () => {
  const h = harness();
  selectScore(h, "a");
  const oldA = h.refreshScore();
  selectScore(h, "b");
  const oldB = h.refreshScore();
  selectScore(h, "a", 2);
  const latest = h.refreshScore();
  assert.equal(h.requests.length, 2, "other jobs remain usable while same-job writes are serialized");
  h.requests[0].resolve(scoreResult("a-old"));
  h.requests[1].reject(new Error("outdated B failure"));
  await Promise.all([oldA, oldB]);
  await settle();
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve(scoreResult("a-new", 2));
  await latest;
  assert.equal(h.state.result.sheet_dir, "a-new");
  assert.equal(h.node("#r-zip").href, "/api/jobs/a/zip/a-new");
  assert.equal(h.node("#toast").textContent, "");
});

test("render requests for the same view are single-flight while a new transpose has its own request", async () => {
  const h = harness();
  selectScore(h, "a");
  const older = h.refreshScore();
  await h.refreshScore();
  assert.equal(h.requests.length, 1);
  h.state.view = view(2);
  const latest = h.refreshScore();
  assert.equal(h.requests.length, 1, "new transpose must wait for the same job's previous write");
  h.requests[0].resolve(scoreResult("old"));
  await older;
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.node("#sheet-loading").classList.contains("hidden"), false, "old completion must not hide the latest progress");
  h.requests[1].resolve(scoreResult("new", 2));
  await latest;
  assert.equal(h.state.result.semitones, 2);
});

test("reverse XML responses display only the latest selected part", async () => {
  const h = harness();
  selectScore(h, "a");
  const full = h.loadSheet();
  h.state.tab = "bass";
  const bass = h.loadSheet();
  h.requests[1].resolve("<bass/>");
  await settle();
  h.requests[0].resolve("<full/>");
  await settle();
  assert.equal(h.osmdLoads.length, 1, "superseded XML must never reach an engraving instance");
  h.osmdLoads[0].resolve();
  await Promise.all([full, bass]);
  assert.equal(h.state.osmd.rendered, "<bass/>");
});

test("each asynchronous engraving load is isolated and an older completion cannot mutate the visible score", async () => {
  const h = harness();
  selectScore(h, "a");
  const full = h.loadSheet();
  h.requests[0].resolve("<full/>");
  await settle();
  h.state.tab = "bass";
  const bass = h.loadSheet();
  h.requests[1].resolve("<bass/>");
  await settle();
  assert.equal(h.osmdInstances.length, 2, "shared mutable OSMD instances are unsafe across await load()");
  h.osmdLoads[1].resolve();
  await bass;
  const visible = h.state.osmd;
  h.osmdLoads[0].resolve();
  await full;
  assert.equal(h.state.osmd, visible);
  assert.equal(visible.rendered, "<bass/>");
  assert.equal(h.node("#sheet").children[0], visible.container);
});

test("engraving load from a previous A visit cannot commit after A to B to A", async () => {
  const h = harness();
  selectScore(h, "a");
  const old = h.loadSheet();
  h.requests[0].resolve("<old-a/>");
  await settle();
  selectScore(h, "b");
  selectScore(h, "a");
  const fresh = h.loadSheet();
  h.requests[1].resolve("<fresh-a/>");
  await settle();
  h.osmdLoads[1].resolve();
  await fresh;
  const visible = h.state.osmd;
  h.osmdLoads[0].resolve();
  await old;
  assert.equal(h.state.osmd, visible);
  assert.equal(visible.rendered, "<fresh-a/>");
});

test("an obsolete score load failure cannot clear the new score or hide its loading state", async () => {
  const h = harness();
  selectScore(h, "a");
  const old = h.loadSheet();
  h.requests[0].resolve("<full/>");
  await settle();
  h.state.tab = "bass";
  const latest = h.loadSheet();
  h.requests[1].resolve("<bass/>");
  await settle();
  h.osmdLoads[0].reject(new Error("old parse failure"));
  await old;
  assert.equal(h.node("#sheet-loading").classList.contains("hidden"), false);
  h.osmdLoads[1].resolve();
  await latest;
  assert.equal(h.state.osmd.rendered, "<bass/>");
  assert.equal(h.node("#sheet").textContent, "");
});

test("queued renders skip superseded transposes and issue only the latest same-job write", async () => {
  const h = harness();
  selectScore(h, "a");
  const first = h.refreshScore();
  h.state.view = view(1);
  const superseded = h.refreshScore();
  h.state.view = view(2);
  const latest = h.refreshScore();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(scoreResult("old"));
  await Promise.all([first, superseded]);
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[1].options.body).semitones, 2);
  h.requests[1].resolve(scoreResult("latest", 2));
  await latest;
  assert.equal(h.state.result.sheet_dir, "latest");
  assert.equal(h.state.renderQueues.size, 0);
});

test("canceled or failed transposition retains edits and resets a canceled key control", async () => {
  const h = harness();
  selectScore(h, "a");
  h.controls.unsaved = true;
  h.controls.confirmResult = false;
  h.node("#t-key").value = "D";
  await h.transpose({ target_key: "D" });
  assert.equal(h.node("#t-key").value, "C");
  assert.equal(h.requests.length, 0);
  assert.equal(h.controls.unsaved, true);
  h.controls.confirmResult = true;
  h.node("#t-key").value = "D";
  const failed = h.transpose({ target_key: "D" });
  h.requests[0].reject(new Error("offline"));
  await failed;
  assert.equal(h.controls.unsaved, true);
  assert.equal(h.node("#t-key").value, "C");
  assert.equal(h.node("#t-info").textContent, "offline");
});

test("confirmed transposition discards edits only immediately before committing a successful view", async () => {
  const h = harness();
  selectScore(h, "a");
  h.controls.unsaved = true;
  const pending = h.transpose({ semitones: 0 });
  assert.equal(h.controls.unsaved, true);
  h.requests[0].resolve(view(0));
  await pending;
  assert.equal(h.controls.unsaved, false);
  assert.equal(h.renderedViews[0].unsaved, false);
});

for (const editKind of ["note", "drag"]) {
  test(`a delayed transpose cannot discard a new ${editKind} edit or its undo history`, async () => {
    const h = harness();
    selectScore(h, "a");
    const originalView = h.state.view;
    h.node("#t-key").value = "D";
    const pending = h.transpose({ target_key: "D" });
    h.controls.editRevision++;
    h.controls.unsaved = editKind !== "drag"; // movement exists before pointerup marks dirty
    const undo = ["original notes"];
    const drag = editKind === "drag" ? { moved: true } : null;
    h.controls.undo = undo;
    h.controls.drag = drag;
    const discarded = h.controls.discarded;
    h.requests[0].resolve({ ...view(2), key_short: "D", key: "D major" });
    await pending;
    assert.equal(h.state.view, originalView);
    assert.equal(h.controls.discarded, discarded);
    assert.equal(h.controls.undo, undo);
    assert.equal(h.controls.drag, drag);
    assert.equal(h.controls.unsaved, editKind !== "drag");
    assert.equal(h.renderedViews.length, 0);
    assert.equal(h.node("#t-key").value, "C");
    assert.match(h.node("#t-info").textContent, /수정.*적용하지 않았습니다/);
  });
}

test("a failed transpose retains edits made while pending and restores the original selected key", async () => {
  const h = harness();
  selectScore(h, "a");
  h.node("#t-key").value = "D";
  const pending = h.transpose({ target_key: "D" });
  h.controls.editRevision++;
  h.controls.unsaved = true;
  const undo = ["edit while waiting"];
  h.controls.undo = undo;
  h.requests[0].reject(new Error("offline"));
  await pending;
  assert.equal(h.controls.unsaved, true);
  assert.equal(h.controls.undo, undo);
  assert.equal(h.node("#t-key").value, "C");
  assert.equal(h.node("#t-info").textContent, "offline");
});
