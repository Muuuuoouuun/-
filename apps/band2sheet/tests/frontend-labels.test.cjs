"use strict";

// 화면에 보이는 이름표: 파일 묶음·작업 종류·시각 (DOM 없이 순수 함수만)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../band2sheet/app/static/app.js"), "utf8");

function load(now = 1_700_000_000_000) {
  const context = vm.createContext({
    window: { addEventListener() {} }, document: {}, console,
    Date: class extends Date { static now() { return now; } },
  });
  vm.runInContext(`${source}\nglobalThis.app = { fileInfo, jobKind, timeAgo, FILE_GROUPS };`, context);
  return context.app;
}

test("result files are grouped with readable labels instead of raw paths", () => {
  const { fileInfo, FILE_GROUPS } = load();
  const groups = new Set(FILE_GROUPS.map(([id]) => id));
  const cases = {
    "full_score.musicxml": ["sheet", "총보 (모든 악기)", "MusicXML"],
    "lead_sheet.musicxml": ["sheet", "리드시트 (멜로디·코드·가사)", "MusicXML"],
    "vocals.musicxml": ["sheet", "보컬(메인)", "MusicXML"],
    "full_score.pdf": ["pdf", "총보 (모든 악기)", "PDF"],
    "midi/all.mid": ["midi", "전체 (모든 악기)", "MIDI"],
    "midi/bass.mid": ["midi", "베이스", "MIDI"],
    "chords.txt": ["chords", "코드표", "TXT"],
    "chords_nashville.txt": ["chords", "내슈빌 넘버 (1·4·5)", "TXT"],
    "song.chordpro": ["chords", "ChordPro (가사+코드 앱)", "ChordPro"],
    "notes.json": ["other", "notes.json", "JSON"],
  };
  for (const [file, [group, label, type]] of Object.entries(cases)) {
    const info = fileInfo(file);
    assert.equal(info.group, group, file);
    assert.equal(info.label, label, file);
    assert.equal(info.type, type, file);
    assert.ok(groups.has(info.group), file);
  }
});

test("job kinds and relative times read naturally and never throw on missing data", () => {
  const now = 1_700_000_000_000;
  const { jobKind, timeAgo } = load(now);
  assert.equal(jobKind({ kind: "remix", status: "done" }).label, "후보정");
  assert.equal(jobKind({ status: "choose", songs: 2 }).label, "곡 나누기");
  assert.equal(jobKind({ status: "done", parent: "abc", songs: 0 }).label, "실황 한 곡");
  assert.equal(jobKind({ status: "done", url: "https://example.invalid/v", songs: 0 }).label, "링크");
  assert.equal(jobKind({ status: "done", songs: 0 }).label, "악보");
  const sec = now / 1000;
  assert.equal(timeAgo(sec - 5), "방금");
  assert.equal(timeAgo(sec - 5 * 60), "5분 전");
  assert.equal(timeAgo(sec - 3 * 3600), "3시간 전");
  assert.equal(timeAgo(sec - 2 * 86400), "2일 전");
  assert.match(timeAgo(sec - 30 * 86400), /^\d{1,2}\/\d{1,2}$/);
  assert.equal(timeAgo(sec + 60), "방금", "a slightly fast server clock is not shown as the future");
});
