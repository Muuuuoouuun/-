"use strict";

// Real browser controller, deterministic DOM/fetch substitutes; no server or audio models.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../band2sheet/app/static/app.js"), "utf8");

function element() {
  const classes = new Set();
  return {
    textContent: "", innerHTML: "", value: "", disabled: false, checked: false,
    style: {}, dataset: {}, children: [], attributes: {}, listeners: {},
    classList: {
      add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    },
    pause() {}, add(option) { this.children.push(option); },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    querySelector() { return element(); },
  };
}

function harness({ jobsError = null } = {}) {
  const elements = new Map();
  const requests = [];
  const timers = new Map();
  const renderedViews = [];
  let timerId = 0;
  const node = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: () => [], createElement: element },
    window: { addEventListener() {} }, console, URLSearchParams,
    Option: function(text, value) { return { text, value }; },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    Views: {
      setData(view, id) { renderedViews.push({ view, id }); },
      shown() {}, hasUnsaved: () => false,
    },
    fetch(url, options = {}) {
      if (url === "/api/jobs") return jobsError ? Promise.reject(jobsError) : Promise.resolve(response([]));
      return new Promise((resolve, reject) => requests.push({
        url, options, resolve: (body) => resolve(response(body)), reject,
      }));
    },
  });
  vm.runInContext(source + "\nglobalThis.app = { state, openJob, refreshJob, startAnalysis, loadView, startJob, updateStartButton };", context);
  return { ...context.app, node, requests, timers, renderedViews };
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
