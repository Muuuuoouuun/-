"""악보 생성: 음표(초 단위)를 박자에 맞춰 양자화하고 music21 로 MusicXML 악보를 만든다."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

import numpy as np
from music21 import (
    bar, chord, clef, duration, harmony, instrument, key as m21key, layout, metadata,
    meter, note, stream, tempo,
)

from .chords import ChordEvent
from .instruments import InstrumentSpec
from .project import Note, Project, TimeMap
from .theory import Key, spell_midi


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

    @property
    def bar_ql(self) -> float:
        return self.beats_per_bar * self.beat_ql

    def beat(self, t: float) -> float:
        b = float(self.timemap.to_beats(t)) - self.downbeat + self.shift_beats
        return round(b * self.subdiv) / self.subdiv

    def ql(self, t: float) -> float:
        return self.beat(t) * self.beat_ql

    @classmethod
    def for_project(cls, project: Project, subdiv: int | None = None) -> "Grid":
        tm = TimeMap(project.beat_times)
        if subdiv is None:
            subdiv = 6 if project.compound else 4
        g = cls(tm, project.downbeat, project.beat_ql, project.beats_per_bar, subdiv)
        starts = [n.start for t in project.tracks.values() for n in t.notes]
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
    for i, e in enumerate(events):
        nxt = events[i + 1].offset if i + 1 < len(events) else None
        room = (nxt - e.offset) if nxt is not None else None
        if room is not None:
            gap = room - e.dur
            if gap <= legato * beat + 1e-9 or gap <= 0.25 * e.dur + 1e-9:
                e.dur = room
                continue
        if e.dur <= nice[-1]:
            cands = [d for d in nice if room is None or d <= room + 1e-9] or [e.dur]
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


def build_pitched(spec: InstrumentSpec, events: list[Event], key: Key, project: Project,
                  total_ql: float, chords_: list[tuple[float, str]] | None = None,
                  with_tempo: bool = True, pedals_ql: list[tuple[float, float]] | None = None,
                  with_dynamics: bool = True, with_tab: bool = True) -> list[stream.Part]:
    """음높이 악기 파트.

    - grand 보표(피아노/건반): 양손 자동 분리한 PartStaff 2개 (+ 페달)
    - TAB 이 있는 악기(기타/베이스): 오선보 + TAB PartStaff 2개
    - 나머지: Part 1개
    """
    from . import notation as nt

    bar_ql = project.beats_per_bar * project.beat_ql
    dyn = nt.dynamic_marks(events, bar_ql) if with_dynamics else []

    if spec.staff == "grand":
        upper, lower = nt.split_hands(events)
        staves = []
        for evs, cl in ((upper, clef.TrebleClef()), (lower, clef.BassClef())):
            ps = stream.PartStaff()
            ps.insert(0, _m21_instrument(spec))
            ps.insert(0, cl)
            _header(ps, key, project, with_tempo and not staves)
            for e in evs:
                if e.pitches:
                    ps.insert(e.offset, _make_element(e, key))
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
    for e in events:
        part.insert(e.offset, _make_element(e, key))
    if chords_:
        _insert_chords(part, chords_)
    nt.insert_dynamics(part, dyn)
    staves = [_finish(part, total_ql)]
    if fingerings is not None:
        staves.append(nt.build_tab_staff(events, fingerings, spec.tab, project.time_signature,
                                         total_ql, _finish))
    return staves


def build_drums(events: list[Event], project: Project, total_ql: float,
                with_tempo: bool = True) -> stream.Part:
    from .notation import build_drum_kit

    return build_drum_kit(events, project.time_signature,
                          _metronome(project) if with_tempo else None, total_ql, _finish)


def drum_events(notes: list[Note], grid: Grid) -> list[Event]:
    """드럼: 같은 위치의 타격을 묶고, 길이는 다음 타격까지(최대 1박)."""
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


def chord_offsets(chords_: list[ChordEvent], key: Key, grid: Grid) -> list[tuple[float, str]]:
    return [((c.start + grid.shift_beats) * grid.beat_ql, c.name(key)) for c in chords_]


def assemble(parts: list[stream.Part], title: str, subtitle: str | None = None,
             groups: list[tuple[list[stream.Part], str]] | None = None) -> stream.Score:
    """groups: [(묶을 보표들, 'brace' | 'bracket')] — 피아노 큰보표, 기타 오선+TAB 등."""
    sc = stream.Score()
    md = metadata.Metadata()
    md.title = title
    md.movementName = f"{title} — {subtitle}" if subtitle else title
    md.composer = "band2sheet 자동 채보"
    sc.metadata = md
    for p in parts:
        sc.insert(0, p)
    for group, symbol in groups or []:
        sc.insert(0, layout.StaffGroup(group, symbol=symbol, barTogether=True))
    return sc
