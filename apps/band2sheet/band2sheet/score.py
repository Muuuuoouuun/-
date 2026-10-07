"""악보 생성: 음표(초 단위)를 박자에 맞춰 양자화하고 music21 로 MusicXML 악보를 만든다."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace

import numpy as np
from music21 import (
    bar, chord, clef, duration, harmony, instrument, key as m21key, layout, metadata,
    meter, note, stream, tempo,
)

from .chords import ChordEvent
from .instruments import InstrumentSpec
from .project import Note, Project, TimeMap
from .theory import Key, KeyMap, spell_midi


@dataclass
class Event:
    """악보 위의 음(또는 화음) 하나. offset/dur 은 4분음표 단위."""
    offset: float
    dur: float
    pitches: list[int]
    velocity: int = 80
    lyric: str | None = None
    sources: list[int] = field(default_factory=list)  # 원래 Note 인덱스


@dataclass
class Grid:
    """초 -> 악보 위치 변환기."""
    timemap: TimeMap
    downbeat: int
    beat_ql: float
    beats_per_bar: int
    subdiv: int  # 한 박을 몇 칸으로 나눌지
    shift_beats: int = 0  # 시작 전 음표가 있을 때 마디 단위로 밀어주는 양
    triplets: frozenset[int] = frozenset()  # 셋잇단 격자로 맞출 박 번호
    auto_triplets: bool = True
    phase: float = 0.0  # 비트 추적이 음 시작보다 일정하게 앞/뒤로 찍힌 양 (박 단위)

    @property
    def bar_ql(self) -> float:
        return self.beats_per_bar * self.beat_ql

    def raw_beat(self, t: float) -> float:
        return float(self.timemap.to_beats(t)) - self.downbeat + self.shift_beats - self.phase

    def beat(self, t: float) -> float:
        b = self.raw_beat(t)
        g = 3 if math.floor(b) in self.triplets else self.subdiv
        return round(b * g) / g

    def with_triplets(self, notes: list[Note]) -> "Grid":
        """박마다 16분음표 격자와 셋잇단 격자 중 음 시작 위치에 더 잘 맞는 쪽을 고른다."""
        if not self.auto_triplets or self.subdiv % 3 == 0 or not notes:
            return self
        by_beat: dict[int, list[float]] = {}
        for n in notes:
            b = self.raw_beat(n.start)
            k = math.floor(b + 1 / 24)  # 박 직전에 살짝 이르게 친 음은 다음 박으로
            by_beat.setdefault(k, []).append(b - k)
        errs = {}
        for k, fr in by_beat.items():
            if not any(0.1 < f < 0.9 for f in fr):  # 박 안쪽(정박이 아닌) 음이 없으면 상관없음
                continue
            e4 = sum(abs(f - round(f * self.subdiv) / self.subdiv) for f in fr)
            e3 = sum(abs(f - round(f * 3) / 3) for f in fr)
            errs[k] = (e3, e4, len(fr))
        # 1차: 셋잇단 위치(1/3, 2/3)에 분명히 가깝고 16분 격자로는 많이 어긋날 때만
        trip = {k for k, (e3, e4, n) in errs.items() if e3 < 0.5 * e4 and e4 / n > 0.035}
        # 2차: 곡에서 셋잇단이 여러 번 나온 '마디 안 박 위치'(예: 후렴마다 3박)는 반복되는 리듬이므로
        #      애매한 박도 셋잇단 쪽이 더 맞으면 셋잇단으로 (같은 후렴이 마디마다 다르게 적히지 않게)
        bpb = self.beats_per_bar
        common = {pos for pos in {k % bpb for k in trip} if sum(1 for k in trip if k % bpb == pos) >= 2}
        trip |= {k for k, (e3, e4, n) in errs.items()
                 if k % bpb in common and e3 < 0.8 * e4 and e4 / n > 0.03}
        return replace(self, triplets=frozenset(trip)) if trip else self

    def ql(self, t: float) -> float:
        return self.beat(t) * self.beat_ql

    @classmethod
    def for_project(cls, project: Project, subdiv: int | None = None) -> "Grid":
        tm = TimeMap(project.beat_times)
        if subdiv is None:
            subdiv = 6 if project.compound else 4
        g = cls(tm, project.downbeat, project.beat_ql, project.beats_per_bar, subdiv)
        starts = [n.start for t in project.tracks.values() for n in t.notes]
        # 정박 근처 음들의 평균 어긋남 = 비트 추적의 위상 오차 -> 보정 (최대 ±0.2박)
        if starts:
            fr = np.array([float(tm.to_beats(t)) for t in starts])
            dev = fr - np.round(fr)
            near = dev[np.abs(dev) < 0.2]
            if near.size >= 8:
                g.phase = float(np.clip(np.median(near), -0.2, 0.2))
        if starts:
            first = g.beat(min(starts))
            if first < 0:
                bars = math.ceil(-first / g.beats_per_bar)
                g.shift_beats = bars * g.beats_per_bar
        return g


# ---------------------------------------------------------------------------
# 음표 -> 악보 이벤트
# ---------------------------------------------------------------------------

def mono_events(notes: list[Note], grid: Grid) -> list[Event]:
    """단선율: 같은 위치에 겹치면 하나만, 다음 음 시작에서 이전 음을 자른다."""
    grid = grid.with_triplets(notes)
    min_ql = grid.beat_ql / grid.subdiv
    events: list[Event] = []
    for i, n in sorted(enumerate(notes), key=lambda x: x[1].start):
        on = grid.ql(n.start)
        off = max(grid.ql(n.end), on + min_ql)
        if events and abs(events[-1].offset - on) < 1e-6:
            if n.velocity > events[-1].velocity:
                events[-1] = Event(on, off - on, [n.pitch], n.velocity, sources=[i])
            continue
        events.append(Event(on, off - on, [n.pitch], n.velocity, sources=[i]))
    for a, b in zip(events, events[1:]):
        a.dur = min(a.dur, b.offset - a.offset)
    return tidy_durations([e for e in events if e.dur > 0 and e.offset >= 0], grid, legato=0.25)


def poly_events(notes: list[Note], grid: Grid) -> list[Event]:
    """다성: 같은 위치에서 시작하는 음들을 화음 하나로 묶는다 (한 성부로 단순화)."""
    grid = grid.with_triplets(notes)
    min_ql = grid.beat_ql / grid.subdiv
    groups: dict[float, list[tuple[float, Note, int]]] = {}
    for i, n in enumerate(notes):
        on = grid.ql(n.start)
        off = max(grid.ql(n.end), on + min_ql)
        groups.setdefault(on, []).append((off, n, i))
    onsets = sorted(groups)
    events: list[Event] = []
    for k, on in enumerate(onsets):
        items = groups[on]
        end = max(off for off, _, _ in items)
        if k + 1 < len(onsets):
            end = min(end, onsets[k + 1])
        pitches = sorted({n.pitch for _, n, _ in items})
        vel = max(n.velocity for _, n, _ in items)
        if on >= 0 and end > on:
            events.append(Event(on, end - on, pitches, vel, sources=[i for _, _, i in items]))
    # 반주 악기는 감쇠음이라 길이가 짧게 잡히기 쉬우므로 더 넉넉하게 이어 준다
    return tidy_durations(events, grid, legato=0.75)


def _nice_units(subdiv: int) -> list[int]:
    """읽기 쉬운 음표 길이(격자 칸 수). 4분할: 16분, 8분, 점8분, 4분, 점4분, 2분 ..."""
    if subdiv % 3 == 0:  # 겹박자/셋잇단 격자
        unit = subdiv // 3
        return sorted({1} | {unit * k for k in (1, 2, 3, 4, 6, 9, 12, 18, 24)})
    unit = max(1, subdiv // 4)
    return sorted({unit * k for k in (1, 2, 3, 4, 6, 8, 12, 16, 24, 32)})


def tidy_durations(events: list[Event], grid: Grid, legato: float = 0.25) -> list[Event]:
    """연주 중의 짧은 끊김을 쉼표로 적지 않도록 음을 다음 음까지 이어 주고,
    남는 음 길이는 읽기 쉬운 값(4분, 점4분, 2분 ...)으로 맞춘다.

    legato: 다음 음까지의 틈이 이 박 수 이하이면 이어 붙인다.
    """
    beat = grid.beat_ql
    u = beat / grid.subdiv
    nice = [k * u for k in _nice_units(grid.subdiv)]
    nice_trip = sorted(set(nice) | {beat / 3, 2 * beat / 3})
    for i, e in enumerate(events):
        pos = e.offset / beat
        in_triplet = math.floor(pos + 1e-6) in grid.triplets
        nxt = events[i + 1].offset if i + 1 < len(events) else None
        room = (nxt - e.offset) if nxt is not None else None
        if room is not None:
            gap = room - e.dur
            if gap <= legato * beat + 1e-9 or gap <= 0.25 * e.dur + 1e-9:
                e.dur = room
                continue
        if e.dur <= nice[-1]:
            pool = nice_trip if in_triplet else nice
            cands = [d for d in pool if room is None or d <= room + 1e-9] or [e.dur]
            e.dur = min(cands, key=lambda d: (abs(d - e.dur), -d))
    return events


# ---------------------------------------------------------------------------
# music21 파트 만들기
# ---------------------------------------------------------------------------

def _pitch(midi: int, key: Key) -> "note.pitch.Pitch":
    from music21 import pitch

    name, octave = spell_midi(midi, key)
    return pitch.Pitch(name.replace("b", "-") + str(octave))


def _clean_duration(ql: float) -> float:
    # 부동소수 오차 제거 (1/48 박 단위)
    return round(ql * 48) / 48


def _make_element(ev: Event, key: Key):
    if len(ev.pitches) == 1:
        el = note.Note(_pitch(ev.pitches[0], key))
    else:
        el = chord.Chord([_pitch(p, key) for p in ev.pitches])
    el.duration = duration.Duration(_clean_duration(ev.dur))
    el.volume.velocity = int(ev.velocity)
    if ev.lyric:
        el.lyric = ev.lyric
    return el


def _m21_instrument(spec: InstrumentSpec):
    inst = {
        "vocals": instrument.Vocalist,
        "backing_vocals": instrument.Choir,
        "guitar": instrument.AcousticGuitar,
        "piano": instrument.Piano,
        "other": instrument.ElectricPiano,
        "bass": instrument.ElectricBass,
    }.get(spec.stem, instrument.Instrument)()
    inst.partName = spec.label
    inst.partAbbreviation = spec.label[:3] + "."
    inst.midiProgram = spec.program
    return inst


def _clef_for(spec: InstrumentSpec, events: list[Event]):
    staff = spec.staff
    if staff == "auto":
        pitches = [p for e in events for p in e.pitches]
        staff = "treble8" if pitches and np.median(pitches) < 57 else "treble"
    return {
        "treble": clef.TrebleClef,
        "treble8": clef.Treble8vbClef,
        "bass8": clef.Bass8vbClef,
        "bass": clef.BassClef,
    }[staff]()


def _header(part: stream.Stream, key: Key, project: Project, with_tempo: bool):
    part.insert(0, m21key.KeySignature(key.fifths))
    part.insert(0, meter.TimeSignature(project.time_signature))
    if with_tempo:
        part.insert(0, _metronome(project))


def _finish(part: stream.Stream, total_ql: float, final_bar: bool = True) -> stream.Stream:
    part.makeRests(refStreamOrTimeRange=[0.0, total_ql], fillGaps=True, inPlace=True,
                   timeRangeFromBarDuration=False)
    part = part.makeNotation()
    last = part.getElementsByClass(stream.Measure).last()
    if last is not None and final_bar:
        last.rightBarline = bar.Barline("final")
    return part


def _metronome(project: Project) -> tempo.MetronomeMark:
    referent = duration.Duration(1.5) if project.compound else duration.Duration(project.beat_ql)
    return tempo.MetronomeMark(number=int(round(project.tempo_bpm)), referent=referent)


def build_pitched(spec: InstrumentSpec, events: list[Event], key: Key | KeyMap, project: Project,
                  total_ql: float, chords_: list[tuple[float, str]] | None = None,
                  with_tempo: bool = True, pedals_ql: list[tuple[float, float]] | None = None,
                  with_dynamics: bool = True, with_tab: bool = True,
                  segments: list[float] | None = None, slash_empty: bool = False) -> list[stream.Part]:
    """음높이 악기 파트.

    - grand 보표(피아노/건반): 양손 자동 분리한 PartStaff 2개 (+ 페달)
    - TAB 이 있는 악기(기타/베이스): 오선보 + TAB PartStaff 2개
    - 나머지: Part 1개
    """
    from . import notation as nt

    key_map = key if isinstance(key, KeyMap) else KeyMap([(0.0, key)])
    key = key_map.first
    bar_ql = project.beats_per_bar * project.beat_ql

    def add_key_changes(st):
        for off, k in key_map.changes():
            if off < total_ql:
                st.insert(off, m21key.KeySignature(k.fifths))
    dyn = []
    if with_dynamics:
        dyn = nt.section_dynamics(events, segments) if segments else nt.dynamic_marks(events, bar_ql)

    if spec.staff == "grand":
        upper, lower = nt.split_hands(events)
        staves = []
        for evs, cl in ((upper, clef.TrebleClef()), (lower, clef.BassClef())):
            ps = stream.PartStaff()
            ps.insert(0, _m21_instrument(spec))
            ps.insert(0, cl)
            _header(ps, key, project, with_tempo and not staves)
            add_key_changes(ps)
            for e in evs:
                if e.pitches:
                    ps.insert(e.offset, _make_element(e, key_map.at(e.offset)))
            if not staves:
                if chords_:
                    _insert_chords(ps, chords_)
                nt.insert_dynamics(ps, dyn)
            staves.append(_finish(ps, total_ql))
        if pedals_ql:
            nt.add_pedals(staves[1], pedals_ql)
        return staves

    fingerings = None
    if spec.tab and with_tab:
        max_fret = 17 if len(spec.tab) == 6 else 15
        playable = [nt.playable_subset(e.pitches, spec.tab, max_fret) for e in events]
        events = [Event(e.offset, e.dur, p, e.velocity, e.lyric, e.sources)
                  for e, p in zip(events, playable) if p]
        fingerings = nt.assign_frets([e.pitches for e in events], spec.tab, max_fret)

    part = stream.PartStaff() if fingerings is not None else stream.Part()
    part.insert(0, _m21_instrument(spec))
    part.insert(0, _clef_for(spec, events))
    _header(part, key, project, with_tempo)
    add_key_changes(part)
    for e in events:
        part.insert(e.offset, _make_element(e, key_map.at(e.offset)))
    if slash_empty and chords_:
        _insert_slashes(part, events, chords_, total_ql, bar_ql, project.beat_ql)
    if chords_:
        _insert_chords(part, chords_)
    nt.insert_dynamics(part, dyn)
    staves = [_finish(part, total_ql)]
    if fingerings is not None:
        staves.append(nt.build_tab_staff(events, fingerings, spec.tab, project.time_signature,
                                         total_ql, _finish))
    return staves


def _insert_slashes(part: stream.Stream, events: list[Event], chords_: list[tuple[float, str]],
                    total_ql: float, bar_ql: float, beat_ql: float) -> None:
    """리드시트: 멜로디가 쉬는 마디(전주·간주 등)에 코드가 있으면 박마다 사선(/)으로 표시."""
    busy = set()
    for e in events:
        b0 = int(e.offset // bar_ql)
        b1 = int((e.offset + e.dur - 1e-6) // bar_ql)
        busy.update(range(b0, b1 + 1))
    first_chord = min((off for off, _ in chords_), default=total_ql)
    last_chord = max((off for off, _ in chords_), default=0.0)
    n_bars = int(round(total_ql / bar_ql))
    for b in range(n_bars):
        start = b * bar_ql
        if b in busy or start + bar_ql <= first_chord + 1e-6 or start > last_chord + bar_ql:
            continue
        k = 0.0
        while k < bar_ql - 1e-6:
            n = note.Note("B4")
            n.notehead = "slash"
            n.stemDirection = "noStem"
            n.duration = duration.Duration(beat_ql)
            part.insert(start + k, n)
            k += beat_ql


def add_system_breaks(score: stream.Score, section_starts: list[int], every: int = 4) -> None:
    """줄바꿈: 구간이 시작하는 마디에서, 그리고 구간 안에서는 4마디마다.

    모든 파트가 쉬는 구간 안에서는 나누지 않아 '여러 마디 쉼표'로 짧게 묶이게 한다.
    """
    parts = list(score.parts)
    if not parts:
        return
    numbers = [m.number for m in parts[0].getElementsByClass(stream.Measure)]
    if not numbers:
        return
    first, last = min(numbers), max(numbers)
    busy: set[int] = set()
    for p in parts:
        for m in p.getElementsByClass(stream.Measure):
            if any(not n.isRest and not n.style.hideObjectOnPrint for n in m.recurse().notesAndRests):
                busy.add(m.number)
    starts = sorted({s for s in section_starts if max(first, 1) < s <= last})
    anchors = [max(first, 1)] + starts
    breaks = set(starts)
    for i, a in enumerate(anchors):
        if every <= 0:
            break
        end = anchors[i + 1] if i + 1 < len(anchors) else last + 1
        for n in range(a + every, end, every):
            before = any(x in busy for x in range(n - every, n))
            after = any(x in busy for x in range(n, min(n + every, end)))
            if before and after:
                breaks.add(n)
    for p in parts:
        for m in p.getElementsByClass(stream.Measure):
            if m.number in breaks:
                m.insert(0, layout.SystemLayout(isNew=True))


def build_drums(events: list[Event], project: Project, total_ql: float,
                with_tempo: bool = True) -> stream.Part:
    from .notation import build_drum_kit

    return build_drum_kit(events, project.time_signature,
                          _metronome(project) if with_tempo else None, total_ql, _finish)


def drum_events(notes: list[Note], grid: Grid) -> list[Event]:
    """드럼: 같은 위치의 타격을 묶고, 길이는 다음 타격까지(최대 1박)."""
    grid = grid.with_triplets(notes)
    groups: dict[float, list[Note]] = {}
    for n in notes:
        groups.setdefault(grid.ql(n.start), []).append(n)
    onsets = sorted(o for o in groups if o >= 0)
    events = []
    for k, on in enumerate(onsets):
        nxt = onsets[k + 1] if k + 1 < len(onsets) else on + grid.beat_ql
        bar_end = (math.floor(on / grid.bar_ql + 1e-9) + 1) * grid.bar_ql
        # 드럼은 울림을 길게 적지 않는다: 다음 타격, 1박, 마디 끝 중 가장 가까운 곳까지
        dur = min(nxt - on, grid.beat_ql, bar_end - on)
        ns = groups[on]
        events.append(Event(on, dur, sorted({n.pitch for n in ns}), max(n.velocity for n in ns)))
    return events


CYMBALS = (42, 44, 46, 51, 53, 59)  # 하이햇·라이드 — 일정하게 이어 치는 악기


def _complete_ostinato(groove: set[tuple[float, int]], bar_ql: float) -> set[tuple[float, int]]:
    """하이햇·라이드가 8분(또는 16분)음표 자리를 거의 다 채우면 빠진 한두 자리도 채운다
    (킥·스네어와 같이 칠 때 하이햇 소리가 묻혀 잘 안 잡힌다)."""
    out = set(groove)
    for p in CYMBALS:
        pos = {round(x, 4) for x, q in groove if q == p}
        if not pos:
            continue
        for step in (0.5, 0.25):
            grid = {round(k * step, 4) for k in range(int(round(bar_ql / step)))}
            if pos <= grid and len(grid) - len(pos) <= max(1, len(grid) // 4):
                out |= {(g, p) for g in grid}
                break
    return out


def regularize_drums(events: list[Event], bar_ql: float, segments: list[float] | None,
                     total_ql: float, snap: float = 0.6) -> list[Event]:
    """구간(절·후렴 …)마다 기본 리듬(그루브)을 찾고, 조금만 다른 마디는 그 그루브로 맞춘다.

    드럼 채보는 하이햇 한두 개를 놓치거나 킥이 조금 밀리기 쉬워 마디마다 모양이 달라 읽기 어렵다.
    기본 그루브와 비슷한(겹침 비율 >= snap) 마디만 맞추고, 크게 다른 마디(필인·브레이크)는 그대로 둔다.
    """
    if not events:
        return events
    n_bars = int(math.ceil(total_ql / bar_ql - 1e-9))
    bars: list[set[tuple[float, int]]] = [set() for _ in range(n_bars)]
    vel: dict[tuple[int, float, int], int] = {}
    for ev in events:
        b = int(math.floor(ev.offset / bar_ql + 1e-9))
        if not 0 <= b < n_bars:
            continue
        pos = round(ev.offset - b * bar_ql, 4)
        for p in ev.pitches:
            bars[b].add((pos, p))
            vel[(b, pos, p)] = ev.velocity
    bounds = sorted({0, n_bars, *(int(round(x / bar_ql)) for x in (segments or []) if 0 < x / bar_ql < n_bars)})
    for a, z in zip(bounds, bounds[1:]):
        played = [b for b in range(a, z) if bars[b]]
        if len(played) < 3:
            continue
        counts: dict[tuple[float, int], int] = {}
        for b in played:
            for hit in bars[b]:
                counts[hit] = counts.get(hit, 0) + 1
        groove = {hit for hit, c in counts.items() if c >= 0.6 * len(played)}
        if len(groove) < 2:
            continue
        groove = _complete_ostinato(groove, bar_ql)
        for b in played:
            union = bars[b] | groove
            sim = len(bars[b] & groove) / len(union) if union else 1.0
            last = b == z - 1  # 구간 마지막 마디는 필인일 때가 많아 더 비슷할 때만
            if sim >= (0.8 if last else snap) and bars[b] != groove:
                default_v = int(np.median([vel[(b, pos, p)] for pos, p in bars[b]])) if bars[b] else 90
                for pos, p in groove:
                    vel.setdefault((b, pos, p), default_v)
                bars[b] = set(groove)
    out: list[Event] = []
    for b in range(n_bars):
        by_pos: dict[float, list[int]] = {}
        for pos, p in bars[b]:
            by_pos.setdefault(pos, []).append(p)
        positions = sorted(by_pos)
        for k, pos in enumerate(positions):
            on = b * bar_ql + pos
            nxt = b * bar_ql + positions[k + 1] if k + 1 < len(positions) else (b + 1) * bar_ql
            pitches = sorted(by_pos[pos])
            out.append(Event(on, min(nxt - on, 1.0), pitches, max(vel[(b, pos, p)] for p in pitches)))
    return out


def _insert_chords(part: stream.Stream, chords_: list[tuple[float, str]]) -> None:
    for offset, figure in chords_:
        if figure == "N.C.":
            cs = harmony.NoChord()
        else:
            try:
                # music21 은 플랫을 '-' 로 쓴다: Bbmaj7 -> B-maj7, D/Bb -> D/B-
                cs = harmony.ChordSymbol(re.sub(r"(^|/)([A-G])b", r"\1\2-", figure))
            except Exception:  # 해석 못 하는 코드 이름은 건너뜀
                continue
        cs.writeAsChord = False
        part.insert(offset, cs)


def chord_offsets(chords_: list[ChordEvent], key: Key | KeyMap,
                  grid: Grid) -> list[tuple[float, str]]:
    km = key if isinstance(key, KeyMap) else KeyMap([(0.0, key)])
    out = []
    for c in chords_:
        off = (c.start + grid.shift_beats) * grid.beat_ql
        out.append((off, c.name(km.at(off))))
    return out


def assemble(parts: list[stream.Part], title: str, subtitle: str | None = None,
             groups: list[tuple[list[stream.Part], str]] | None = None) -> stream.Score:
    """groups: [(묶을 보표들, 'brace' | 'bracket')] — 피아노 큰보표, 기타 오선+TAB 등."""
    sc = stream.Score()
    md = metadata.Metadata()
    md.title = title
    # 부제(어떤 악보·키)만 따로 — 뷰어가 제목과 부제를 나눠 그린다
    md.movementName = subtitle or title
    md.composer = "band2sheet 자동 채보"
    sc.metadata = md
    for p in parts:
        sc.insert(0, p)
    for group, symbol in groups or []:
        sc.insert(0, layout.StaffGroup(group, symbol=symbol, barTogether=True))
    return sc


def add_section_marks(score: stream.Score, marks: list[tuple[int, str]]) -> None:
    """구간 시작 마디에 리허설 마크(상자 글씨)를 달고, 구간 경계에 겹세로줄을 긋는다.

    marks: [(마디 번호(1부터), 이름)] — 마크는 맨 위 보표에만, 겹세로줄은 모든 보표에.
    """
    from music21 import expressions

    if not marks:
        return
    starts = {m for m, _ in marks}
    for i, part in enumerate(score.parts):
        measures = {m.number: m for m in part.getElementsByClass(stream.Measure)}
        for number, name in marks:
            m = measures.get(number)
            if m is None:
                continue
            if i == 0:
                m.insert(0, expressions.RehearsalMark(name))
            prev = measures.get(number - 1)
            if prev is not None and number in starts and number > 1:
                prev.rightBarline = bar.Barline("light-light")


def _first_measure_ok_for_pickup(part: stream.Stream, lead_ql: float) -> bool:
    ms = part.getElementsByClass(stream.Measure)
    if not ms:
        return True
    m = ms.first()
    for c in list(m.voices) or [m]:
        for el in c.notesAndRests:
            if el.offset < lead_ql - 1e-6 and not el.isRest:
                return False
    return True


def make_pickup(score: stream.Score, lead_ql: float) -> bool:
    """첫 마디 앞부분이 모두 쉼표면 그 부분을 지워 못갖춘마디(0번 마디)로 만든다.

    lead_ql: 첫 마디에서 지울 앞부분 길이(4분음표 단위). 모든 보표에서 가능할 때만 적용.
    """
    if lead_ql <= 0 or not all(_first_measure_ok_for_pickup(p, lead_ql) for p in score.parts):
        return False
    keep_at_zero = (clef.Clef, m21key.KeySignature, meter.TimeSignature, tempo.MetronomeMark,
                    layout.StaffLayout, stream.Voice)
    for part in score.parts:
        ms = list(part.getElementsByClass(stream.Measure))
        if not ms:
            continue
        m = ms[0]
        for c in list(m.voices) + [m]:
            for el in list(c.elements):
                if isinstance(el, keep_at_zero):
                    continue
                if getattr(el, "isRest", False) and el.offset < lead_ql - 1e-6:
                    end = el.offset + el.quarterLength
                    if end > lead_ql + 1e-6:  # 앞부분에 걸친 쉼표는 남는 길이만큼으로 줄인다
                        el.duration = duration.Duration(round((end - lead_ql) * 48) / 48)
                        c.setElementOffset(el, 0.0)
                    else:
                        c.remove(el)
                elif el.offset >= lead_ql - 1e-6:
                    c.setElementOffset(el, el.offset - lead_ql)
                else:  # 앞부분에 걸친 표시(셈여림·코드 등)는 마디 처음으로
                    c.setElementOffset(el, 0.0)
            c.coreElementsChanged()
        m.paddingLeft = lead_ql
        for k, mm in enumerate(ms):
            mm.number = k
        # 뒤 마디들의 위치를 당긴다
        for mm in ms[1:]:
            part.setElementOffset(mm, part.elementOffset(mm) - lead_ql)
        part.coreElementsChanged()
    return True
