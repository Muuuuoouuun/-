"""앱 자체 화면용 데이터와 사용자 수정.

오선 악보(MusicXML) 대신 앱이 직접 그리는 화면 — 코드 악보, 라이브 코드 진행, 피아노롤/드럼 그리드 —
에 필요한 정보를 JSON 하나로 만든다. 키 변경은 여기서 바로 반영돼 악보 파일을 다시 만들 필요가 없다.

사용자가 고친 코드·가사·음표는 project.json 에 원래 키 기준으로 저장한다.
"""

from __future__ import annotations

import re

import numpy as np

from .chords import QUALITIES, ChordEvent
from .instruments import DRUM_KIT, SCORE_ORDER, spec_for
from .project import Note, Project, TimeMap
from .theory import PITCH_CLASSES, KeyMap, transpose_target

# 앱에서 고를 수 있는 코드 종류 (music21 이 읽을 수 있는 이름)
EDIT_QUALITIES = list(QUALITIES) + ["6", "m6", "9", "add9", "aug", "7sus4", "m7b5", "dim7", "m9", "maj9"]
CHORD_RE = re.compile(r"^\s*([A-Ga-g])([#b]?)(.*?)(?:/([A-Ga-g])([#b]?))?\s*$")


def measure_times(project: Project) -> list[float]:
    """악보 마디마다 시작 시각(초). 재생 위치에 맞춰 현재 마디를 표시하는 데 쓴다."""
    from .score import Grid

    grid = Grid.for_project(project)
    tm: TimeMap = grid.timemap
    bpb = project.beats_per_bar
    ends = [n.end for t in project.tracks.values() for n in t.notes]
    last_beat = float(tm.to_beats(max(ends, default=project.beat_times[-1])))
    n_bars = int((last_beat - project.downbeat + grid.shift_beats) // bpb) + 2
    return [round(float(tm.to_seconds(m * bpb + project.downbeat - grid.shift_beats + grid.phase)), 3)
            for m in range(max(n_bars, 1))]


def parse_chord(name: str) -> tuple[int | None, str, int | None]:
    """'F#m7/C#' -> (근음 pc, 'm7', 베이스 pc). 'N.C.' 나 빈 문자열은 (None, '', None)."""
    if not name or name.strip().upper() in ("N.C.", "NC", "-"):
        return None, "", None
    m = CHORD_RE.match(name.replace("♯", "#").replace("♭", "b"))
    if not m:
        raise ValueError(f"코드 이름을 이해하지 못했습니다: {name}")
    letter, acc, quality, bl, bacc = m.groups()
    quality = quality.strip()
    quality = {"M": "", "maj": "", "min": "m", "-": "m", "M7": "maj7", "Δ": "maj7", "°": "dim",
               "m7-5": "m7b5", "ø": "m7b5", "+": "aug"}.get(quality, quality)
    if quality not in EDIT_QUALITIES:
        raise ValueError(f"지원하지 않는 코드 종류입니다: {quality} (가능: {', '.join(EDIT_QUALITIES)})")
    root = PITCH_CLASSES[letter.upper() + acc.upper()]
    bass = PITCH_CLASSES[bl.upper() + bacc.upper()] if bl else None
    return root, quality, bass


def _chords_list(project: Project) -> list[ChordEvent]:
    from .pipeline import project_chords

    return project_chords(project)


def _store(project: Project, events: list[ChordEvent]) -> None:
    events = sorted(events, key=lambda c: c.start)
    merged: list[ChordEvent] = []
    for c in events:
        if c.end <= c.start:
            continue
        if merged and (merged[-1].root, merged[-1].quality, merged[-1].bass) == (c.root, c.quality, c.bass) \
                and abs(merged[-1].end - c.start) < 1e-6:
            merged[-1].end = c.end
        else:
            merged.append(c)
    project.chords = [[c.start, c.end, c.root, c.quality, c.bass] for c in merged]


def set_chord(project: Project, beat: float, name: str, semitones: int = 0,
              length: float | None = None) -> None:
    """beat(마디 첫 박 기준 박 위치)부터 코드를 바꾼다. name 이 비면 앞 코드를 이어 쓴다.

    semitones: 사용자가 보고 있던 화면의 조옮김 양 (원래 키로 되돌려 저장).
    """
    root, quality, bass = parse_chord(name)
    if root is not None:
        root = (root - semitones) % 12
    if bass is not None:
        bass = (bass - semitones) % 12
    events = _chords_list(project)
    if not events:
        events = [ChordEvent(0.0, beat + (length or project.beats_per_bar), None)]
    out: list[ChordEvent] = []
    target_end = None
    for c in events:
        if c.start <= beat + 1e-6 < c.end:
            end = min(c.end, beat + length) if length else c.end
            target_end = end
            if c.start < beat - 1e-6:
                out.append(ChordEvent(c.start, beat, c.root, c.quality, c.bass))
            out.append(ChordEvent(beat, end, root, quality, bass))
            if end < c.end - 1e-6:
                out.append(ChordEvent(end, c.end, c.root, c.quality, c.bass))
        else:
            out.append(c)
    if target_end is None:  # 코드가 없던 곳 (곡 끝 뒤 등)
        out.append(ChordEvent(beat, beat + (length or project.beats_per_bar), root, quality, bass))
    if not name.strip():  # 지우기: 앞 코드가 이어지도록
        out = [c for c in out if not (abs(c.start - beat) < 1e-6 and c.root is None)]
        out.sort(key=lambda c: c.start)
        for a, b in zip(out, out[1:]):
            a.end = b.start
    _store(project, out)


def set_bar_lyrics(project: Project, bar: int, text: str) -> None:
    """마디(마디 첫 박 기준 0부터) 가사를 직접 입력."""
    text = text.strip()
    if text:
        project.bar_lyrics[str(bar)] = text[:200]
    else:
        project.bar_lyrics.pop(str(bar), None)


def set_track_notes(project: Project, name: str, notes: list[list[float]], semitones: int = 0) -> None:
    """피아노롤에서 고친 음표 목록 저장 ([시작 초, 끝 초, 음, 세기])."""
    if name not in project.tracks:
        raise KeyError(name)
    shift = 0 if name == "drums" else semitones
    clean = []
    for row in notes:
        s, e, p, v = float(row[0]), float(row[1]), int(row[2]) - shift, int(row[3]) if len(row) > 3 else 80
        if e > s and 0 <= p <= 127:
            clean.append(Note(round(s, 4), round(e, 4), p, max(1, min(127, v))))
    project.tracks[name].notes = sorted(clean, key=lambda n: (n.start, n.pitch))


def build_view(project: Project, semitones: int | None = None, target_key: str | None = None,
               direction: str = "nearest") -> dict:
    """앱 화면 하나를 그리는 데 필요한 모든 정보."""
    from .notation import capo_suggestion
    from .score import Grid
    from .sections import detect_sections

    shift, key = transpose_target(project.key, target_key, semitones, direction)
    grid = Grid.for_project(project)
    bpb = project.beats_per_bar
    bar_offset = grid.shift_beats // bpb
    key_map = KeyMap([(0.0, key)] + [((b + grid.shift_beats) * grid.beat_ql, k.transposed(shift))
                                     for b, k in project.key_changes])
    measures = measure_times(project)
    n_meas = len(measures)

    # 못갖춘마디: 첫 음이 첫 마디 중간에서 시작 (악보 렌더링과 같은 기준)
    starts = [grid.ql(n.start) for t in project.tracks.values() for n in t.notes]
    first_on = min(starts, default=0.0)
    pickup = 0 < first_on < grid.bar_ql and first_on / grid.beat_ql >= 1 - 1e-6 and grid.shift_beats > 0

    def number(i: int) -> int:
        return i if pickup else i + 1

    chords_orig = _chords_list(project)
    chords = [c.transposed(shift) for c in chords_orig]

    bars = []
    for i in range(n_meas):
        start = measures[i]
        end = measures[i + 1] if i + 1 < n_meas else start + (measures[1] - measures[0] if n_meas > 1 else 2)
        k = key_map.at(i * grid.bar_ql)
        bars.append({"index": i, "number": number(i), "start": start, "end": round(end, 3),
                     "key": k.short_name, "chords": [], "lyrics": ""})
    for c in chords:
        b0 = int((c.start + grid.shift_beats) // bpb)
        b1 = int(np.ceil((c.end + grid.shift_beats) / bpb - 1e-6))
        for b in range(max(b0, 0), min(b1, n_meas)):
            k = key_map.at(b * grid.bar_ql)
            beat = (c.start + grid.shift_beats) - b * bpb if b == b0 else 0.0
            bars[b]["chords"].append({
                "beat": round(float(beat), 3), "name": c.name(k), "number": c.number(k),
                "held": b != b0, "root": c.root, "quality": c.quality, "bass": c.bass,
            })
    # 가사: 직접 입력한 마디 가사 > 음성 인식 가사
    words = project.tracks["vocals"].lyrics if "vocals" in project.tracks else []
    per_bar: dict[int, list[str]] = {}
    for w in words:
        b = int(grid.beat(w.start) // bpb)
        per_bar.setdefault(b, []).append(w.text)
    for b, ws in per_bar.items():
        if 0 <= b < n_meas:
            bars[b]["lyrics"] = " ".join(ws)
    for kk, text in project.bar_lyrics.items():
        b = int(kk) + bar_offset
        if 0 <= b < n_meas:
            bars[b]["lyrics"] = text
            bars[b]["lyrics_edited"] = True

    n_bars = n_meas - bar_offset
    sections = []
    for s in detect_sections(project, chords_orig, max(n_bars, 1)) if n_bars >= 4 else []:
        i0, i1 = s.start_bar + bar_offset, min(s.end_bar + bar_offset, n_meas)
        sections.append(dict(s.to_dict(), start_index=i0, end_index=i1,
                             start_number=number(i0), end_number=number(i1 - 1)))

    tracks = {}
    for name in [n for n in SCORE_ORDER if n in project.tracks] + \
            [n for n in project.tracks if n not in SCORE_ORDER]:
        spec = spec_for(name)
        notes = project.tracks[name].notes
        sh = 0 if name == "drums" else shift
        rows = [[round(n.start, 4), round(n.end, 4), n.pitch + sh, n.velocity] for n in notes]
        pitches = [r[2] for r in rows]
        tracks[name] = {
            "label": spec.label, "label_ko": spec.label_ko,
            "kind": "drums" if name == "drums" else "pitched",
            "notes": rows,
            "range": [min(pitches), max(pitches)] if pitches else [spec.low, spec.high],
            "tab": list(spec.tab) if spec.tab else None,
        }
    capo = capo_suggestion(key.tonic, key.mode)
    return {
        "title": project.title,
        "key": key.name, "key_short": key.short_name,
        "original_key": project.key.name, "original_key_short": project.key.short_name,
        "semitones": shift,
        "tempo": round(project.tempo_bpm, 1),
        "time_signature": project.time_signature,
        "beats_per_bar": bpb,
        "beat_times": [round(t, 4) for t in project.beat_times],
        "pickup": bool(pickup),
        "measures": measures,
        "bars": bars,
        "sections": sections,
        "key_changes": [{"index": int(off // grid.bar_ql), "number": number(int(off // grid.bar_ql)),
                         "key": k.name, "key_short": k.short_name} for off, k in key_map.changes()],
        "tracks": tracks,
        "drum_kit": {str(m): {"name": p.name, "name_ko": p.name_ko} for m, p in DRUM_KIT.items()},
        "capo": {"fret": capo[0], "shape": capo[1]} if capo else None,
        "qualities": EDIT_QUALITIES,
        "bar_offset": bar_offset,
        "edited": project.chords is not None or bool(project.bar_lyrics),
    }
