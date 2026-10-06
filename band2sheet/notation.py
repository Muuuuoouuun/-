"""악기별 상세 표기.

- 기타/베이스 TAB: 줄·프렛 배정을 비터비(동적 계획법)로 최적화 (손 이동 최소화, 개방현 선호)
- 피아노: 음 높이에 따라 고정 분할 대신 손 위치를 따라가며 양손 분리, 서스테인 페달 표기
- 셈여림: 마디별 세기 변화로 pp~ff 표기
- 드럼: 손(위 성부) / 발(아래 성부) 2성부 키트 표기
"""

from __future__ import annotations

import copy
import itertools
from dataclasses import dataclass

import numpy as np
from music21 import (
    articulations, clef, duration, dynamics, expressions, instrument, layout, meter, note,
    percussion, stream, tempo,
)

from .instruments import DRUM_KIT


# ---------------------------------------------------------------------------
# TAB: 줄/프렛 배정
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Fingering:
    frets: tuple[tuple[int, int], ...]  # (줄 인덱스: 0 = 가장 낮은 줄, 프렛)

    @property
    def position(self) -> float | None:
        fretted = [f for _, f in self.frets if f > 0]
        return float(np.mean(fretted)) if fretted else None


def _chord_fingerings(pitches: list[int], tuning: tuple[int, ...], max_fret: int,
                      limit: int = 60) -> list[Fingering]:
    options = [[(s, p - o) for s, o in enumerate(tuning) if 0 <= p - o <= max_fret] for p in pitches]
    if any(not o for o in options):
        return []
    out = []
    for combo in itertools.product(*options):
        strings = [s for s, _ in combo]
        if len(set(strings)) != len(strings):
            continue
        fretted = [f for _, f in combo if f > 0]
        if fretted and max(fretted) - min(fretted) > 4:
            continue
        out.append(Fingering(tuple(combo)))
        if len(out) >= limit:
            break
    return out


def _local_cost(f: Fingering, max_fret: int) -> float:
    fretted = [x for _, x in f.frets if x > 0]
    span = (max(fretted) - min(fretted)) if fretted else 0
    opens = len(f.frets) - len(fretted)
    high = sum(max(0, x - 12) for x in fretted)
    return 0.08 * (np.mean(fretted) if fretted else 0) + 0.25 * span - 0.15 * opens + 0.2 * high


def playable_subset(pitches: list[int], tuning: tuple[int, ...], max_fret: int) -> list[int]:
    """연주 불가능한 화음은 음을 줄여서(가운데 음부터) 연주 가능하게 만든다."""
    pitches = sorted(set(p for p in pitches if tuning[0] <= p <= tuning[-1] + max_fret))
    while len(pitches) > len(tuning):
        pitches.pop(len(pitches) // 2)
    while pitches and not _chord_fingerings(pitches, tuning, max_fret, limit=1):
        if len(pitches) == 1:
            return []
        pitches.pop(len(pitches) // 2 if len(pitches) > 2 else 0)
    return pitches


def assign_frets(chords: list[list[int]], tuning: tuple[int, ...],
                 max_fret: int = 17) -> list[Fingering | None]:
    """화음(또는 단음) 목록에 대해 전체 손 이동이 가장 적은 운지 조합을 찾는다."""
    cands = [_chord_fingerings(sorted(c), tuning, max_fret) if c else [] for c in chords]
    result: list[Fingering | None] = [None] * len(chords)
    idx = [i for i, c in enumerate(cands) if c]
    if not idx:
        return result
    prev_cost = np.array([_local_cost(f, max_fret) for f in cands[idx[0]]])
    back: list[np.ndarray] = []
    for a, b in zip(idx, idx[1:]):
        pa, pb = cands[a], cands[b]
        trans = np.zeros((len(pa), len(pb)))
        for i, fa in enumerate(pa):
            for j, fb in enumerate(pb):
                xa, xb = fa.position, fb.position
                trans[i, j] = 0.0 if xa is None or xb is None else abs(xa - xb) * 0.3
        total = prev_cost[:, None] + trans
        back.append(np.argmin(total, axis=0))
        prev_cost = total.min(axis=0) + np.array([_local_cost(f, max_fret) for f in pb])
    j = int(np.argmin(prev_cost))
    for k in range(len(idx) - 1, -1, -1):
        result[idx[k]] = cands[idx[k]][j]
        if k > 0:
            j = int(back[k - 1][j])
    # 같은 화음(같은 음들)은 곡 전체에서 같은 운지로 — 후렴마다 자리가 바뀌면 읽기 어렵다.
    # 가장 많이 고른 운지를 쓰고, 같으면 낮은 자리.
    from collections import Counter

    by_chord: dict[tuple[int, ...], Counter] = {}
    for i in idx:
        by_chord.setdefault(tuple(sorted(chords[i])), Counter())[result[i]] += 1
    for i in idx:
        counts = by_chord[tuple(sorted(chords[i]))]
        if len(counts) > 1:
            result[i] = max(counts, key=lambda f: (counts[f], -(f.position or 0.0)))
    return result


def build_tab_staff(events, fingerings: list[Fingering | None], tuning: tuple[int, ...],
                    time_signature: str, total_ql: float, finish) -> stream.PartStaff:
    """TAB 보표 (줄 번호/프렛). MusicXML 의 <string>/<fret> 로 저장된다.

    music21 은 화음 안 개별 음의 줄/프렛을 내보내지 않으므로, 화음의 각 음을
    별도 성부(낮은 음부터 1성부, 2성부 ...)로 나눠 적는다. TAB 에서는 똑같이 세로로 쌓여 보인다.
    """
    n_strings = len(tuning)
    layers: list[list[tuple[float, float, int, int]]] = [[] for _ in range(n_strings)]
    for ev, fing in zip(events, fingerings):
        if fing is None:
            continue
        for k, (s, f) in enumerate(sorted(fing.frets, key=lambda x: x[0])):
            layers[k].append((ev.offset, ev.dur, s, f))
    layers = [layer for layer in layers if layer] or [[]]

    bar_ql = meter.TimeSignature(time_signature).barDuration.quarterLength
    simple = [4.0, 3.0, 2.0, 1.5, 1.0, 0.75, 0.5, 0.375, 0.25, 0.125]

    def tab_duration(off: float, dur: float) -> float:
        # TAB 은 붙임줄을 쓰지 않으므로 마디를 넘지 않는 단순한 길이로 자른다
        room = (np.floor(off / bar_ql + 1e-9) + 1) * bar_ql - off
        limit = min(dur, room)
        return next((d for d in simple if d <= limit + 1e-9), limit)

    def layer_part(items):
        p = stream.Part()
        p.insert(0, clef.TabClef())
        p.insert(0, layout.StaffLayout(staffLines=n_strings))
        p.insert(0, meter.TimeSignature(time_signature))
        for off, dur, s, f in items:
            n = note.Note(tuning[s] + f)
            n.articulations += [articulations.StringIndication(n_strings - s),
                                articulations.FretIndication(f)]
            n.stemDirection = "noStem"
            n.duration = duration.Duration(tab_duration(off, dur))
            p.insert(off, n)
        return finish(p, total_ql, final_bar=False)

    parts = [layer_part(items) for items in layers]
    staff = merge_voices(parts, stream.PartStaff(), hide_rests_from=1)
    staff.insert(0, layout.StaffLayout(staffLines=n_strings))
    return staff


def merge_voices(parts: list[stream.Part], out: stream.Stream, hide_rests_from: int = 1,
                 stems: list[str | None] | None = None, metronome=None) -> stream.Stream:
    """마디가 같은 여러 Part 를 한 보표의 여러 성부(Voice)로 합친다."""
    from music21 import bar

    measures = [list(p.getElementsByClass(stream.Measure)) for p in parts]
    for i, first in enumerate(measures[0]):
        m = stream.Measure(number=first.number)
        for el in first.getElementsByClass([clef.Clef, meter.TimeSignature, layout.StaffLayout]):
            m.insert(el.offset, copy.deepcopy(el))
        if i == 0 and metronome is not None:
            m.insert(0, metronome)
        for v_idx, ms in enumerate(measures):
            if i >= len(ms):
                continue
            src = ms[i]
            only_rest = all(el.isRest for el in src.notesAndRests)
            if v_idx > 0 and only_rest:
                continue  # 빈 마디의 추가 성부는 생략
            voice = stream.Voice(id=str(v_idx + 1))
            for el in src.notesAndRests:
                c = copy.deepcopy(el)
                if c.isRest:
                    if v_idx >= hide_rests_from:
                        c.style.hideObjectOnPrint = True
                elif stems and stems[v_idx]:
                    c.stemDirection = stems[v_idx]
                voice.insert(el.offset, c)
            m.insert(0, voice)
        out.append(m)
    last = out.getElementsByClass(stream.Measure).last()
    if last is not None:
        last.rightBarline = bar.Barline("final")
    return out


def capo_suggestion(key_tonic: int, mode: str) -> tuple[int, str] | None:
    """기타 카포 추천: 개방현 코드로 치기 쉬운 키 모양 (C, G, D, A, E / Am, Em, Dm)."""
    from .theory import Key

    easy = [0, 7, 2, 9, 4] if mode == "major" else [9, 4, 2]  # 선호 순서
    best = None
    for capo in range(0, 8):
        shape = (key_tonic - capo) % 12
        if shape in easy:
            score = capo + easy.index(shape) * 0.5
            if best is None or score < best[0]:
                best = (score, capo, shape)
    if best is None or best[1] == 0:
        return None
    return best[1], Key.from_tonic(best[2], mode).short_name


# ---------------------------------------------------------------------------
# 피아노 양손 분리
# ---------------------------------------------------------------------------

def split_hands(events, left_center: float = 48.0, right_center: float = 67.0, max_span: int = 14):
    """화음마다 '왼손/오른손 중심'에 가까운 쪽으로 나누되, 한 손 폭은 max_span 이내로.

    고정 분할점(가운데 도)보다 자연스럽게 손 위치 이동(예: 왼손이 위로 올라가는 반주)을 따라간다.
    """
    from .score import Event

    cl, cr = left_center, right_center
    upper, lower = [], []
    for e in events:
        ps = sorted(e.pitches)
        best = None
        for k in range(len(ps) + 1):
            lh, rh = ps[:k], ps[k:]
            cost = sum(abs(p - cl) for p in lh) + sum(abs(p - cr) for p in rh)
            if lh and lh[-1] - lh[0] > max_span:
                cost += 100
            if rh and rh[-1] - rh[0] > max_span:
                cost += 100
            # 한쪽 손에 너무 많은 음이 몰리지 않게
            cost += 4 * max(0, len(lh) - 5) + 4 * max(0, len(rh) - 5)
            if best is None or cost < best[0]:
                best = (cost, lh, rh)
        _, lh, rh = best
        if lh:
            cl = 0.7 * cl + 0.3 * float(np.mean(lh))
        if rh:
            cr = 0.7 * cr + 0.3 * float(np.mean(rh))
        # 두 손 중심이 너무 붙지 않게
        if cr - cl < 7:
            mid = (cl + cr) / 2
            cl, cr = mid - 3.5, mid + 3.5
        upper.append(Event(e.offset, e.dur, rh, e.velocity))
        lower.append(Event(e.offset, e.dur, lh, e.velocity))
    return upper, lower


def add_pedals(staff: stream.Stream, ranges_ql: list[tuple[float, float]]) -> int:
    """서스테인 페달 구간을 'Ped. ___ *' 로 표기. 반환: 표기한 개수."""
    notes = list(staff.recurse().notes)
    if not notes:
        return 0
    offs = [n.getOffsetInHierarchy(staff) for n in notes]
    count = 0
    for a, b in ranges_ql:
        inside = [n for n, o in zip(notes, offs) if a - 1e-6 <= o < b - 1e-6]
        if not inside:
            continue
        mark = expressions.PedalMark(inside[0], inside[-1]) if len(inside) > 1 else \
            expressions.PedalMark(inside[0])
        staff.insert(0, mark)
        count += 1
    return count


# ---------------------------------------------------------------------------
# 셈여림
# ---------------------------------------------------------------------------

LEVELS = ["pp", "p", "mp", "mf", "f", "ff"]


def _level(z: float) -> str:
    return ("pp" if z < -1.6 else "p" if z < -0.9 else "mp" if z < -0.4 else
            "mf" if z < 0.4 else "f" if z < 1.1 else "ff")


def section_dynamics(events, segments: list[float]) -> list[tuple[float, str]]:
    """구간(절·후렴 …)마다 셈여림 하나 — 악보가 마디마다 흔들리지 않고 음악적인 단위로 바뀐다."""
    if not events:
        return []
    bounds = sorted({0.0, *segments})
    vals = []
    for i, a in enumerate(bounds):
        b = bounds[i + 1] if i + 1 < len(bounds) else float("inf")
        vs = [e.velocity for e in events if a <= e.offset < b]
        if len(vs) >= 4:
            vals.append((a, float(np.median(vs))))
    if not vals:
        return []
    arr = np.array([v for _, v in vals])
    mu, sd = float(np.median(arr)), max(float(np.std(arr)), 10.0)
    out: list[tuple[float, str]] = []
    for (a, v) in vals:
        lv = _level((v - mu) / sd)
        if not out or out[-1][1] != lv:
            out.append((a, lv))
    return out


def dynamic_marks(events, bar_ql: float, min_run: int = 2) -> list[tuple[float, str]]:
    """마디별 세기를 파트 전체 기준으로 비교해 셈여림 기호 위치를 정한다.

    3마디 이동평균으로 다듬고, min_run 마디보다 짧게 바뀌는 셈여림은 무시해 깜빡임을 막는다.
    """
    if not events:
        return []
    bars: dict[int, list[int]] = {}
    for e in events:
        bars.setdefault(int(e.offset // bar_ql), []).append(e.velocity)
    idx = sorted(bars)
    vals = np.array([float(np.median(bars[b])) for b in idx])
    mu = float(np.median(vals))
    sd = max(float(np.std(vals)), 10.0)  # 세기 차이가 작으면 변화 표기를 하지 않음
    smooth = np.convolve(np.pad(vals, 1, mode="edge"), np.ones(3) / 3, mode="valid")
    z = (smooth - mu) / sd
    levels = [("pp" if v < -1.6 else "p" if v < -0.9 else "mp" if v < -0.4 else
               "mf" if v < 0.4 else "f" if v < 1.1 else "ff") for v in z]
    # 짧은 구간은 앞 구간 셈여림으로 흡수
    runs: list[list] = []
    for b, lv in zip(idx, levels):
        if runs and runs[-1][1] == lv:
            runs[-1][2] += 1
        else:
            runs.append([b, lv, 1])
    merged: list[list] = []
    for r in runs:
        if merged and (r[2] < min_run or merged[-1][1] == r[1]):
            merged[-1][2] += r[2]
        else:
            merged.append(r)
    return [(b * bar_ql, lv) for b, lv, _ in merged]


def insert_dynamics(part: stream.Stream, marks: list[tuple[float, str]]) -> None:
    for off, level in marks:
        part.insert(off, dynamics.Dynamic(level))


# ---------------------------------------------------------------------------
# 드럼 키트 (2성부)
# ---------------------------------------------------------------------------

def _drum_element(pitches: list[int], dur: float, velocity: int):
    heads = []
    for p in pitches:
        piece = DRUM_KIT.get(p)
        u = note.Unpitched(displayName=piece.display if piece else "C5")
        u.notehead = piece.notehead if piece else "normal"
        if piece and piece.notehead == "circle-x":
            u.notehead = "circle-x"
        heads.append(u)
    el = heads[0] if len(heads) == 1 else percussion.PercussionChord(heads)
    el.duration = duration.Duration(round(dur * 48) / 48)
    el.volume.velocity = int(velocity)
    if any(p == 46 for p in pitches):  # 열린 하이햇 'o'
        el.articulations.append(articulations.OpenString(placement="above"))
    return el


def build_drum_kit(events, time_signature: str, metronome: tempo.MetronomeMark | None,
                   total_ql: float, finish) -> stream.Part:
    """손으로 치는 악기는 위 성부(기둥 위), 킥은 아래 성부(기둥 아래)."""
    from .score import Event

    hands, feet = [], []
    for e in events:
        up = [p for p in e.pitches if not (DRUM_KIT.get(p) and DRUM_KIT[p].foot)]
        down = [p for p in e.pitches if DRUM_KIT.get(p) and DRUM_KIT[p].foot]
        if up:
            hands.append(Event(e.offset, e.dur, up, e.velocity))
        if down:
            feet.append(Event(e.offset, e.dur, down, e.velocity))

    def tidy(evs):  # 같은 성부 안에서 다음 타격까지 길이로
        for a, b in zip(evs, evs[1:]):
            a.dur = min(a.dur, b.offset - a.offset) if b.offset > a.offset else a.dur
        return evs

    def voice_part(evs):
        p = stream.Part()
        p.insert(0, clef.PercussionClef())
        p.insert(0, meter.TimeSignature(time_signature))
        for e in tidy(evs):
            p.insert(e.offset, _drum_element(e.pitches, e.dur, e.velocity))
        return finish(p, total_ql, final_bar=False)

    out = stream.Part()
    inst = instrument.UnpitchedPercussion()
    inst.partName = "Drums"
    inst.partAbbreviation = "Dr."
    out.insert(0, inst)
    return merge_voices([voice_part(hands), voice_part(feet)], out, hide_rests_from=1,
                        stems=["up", "down"], metronome=metronome)


# ---------------------------------------------------------------------------
# MusicXML 후처리: TAB 보표 줄 수 / 조율
# ---------------------------------------------------------------------------

def add_tab_details(xml_path) -> int:
    """music21 이 내보내지 않는 TAB 보표의 <staff-details>(줄 수, 각 줄의 조율)를 넣는다.

    MuseScore·OSMD 가 6줄(기타)/4줄(베이스) TAB 으로 정확히 그리게 된다. 반환: 고친 보표 수.
    """
    import re as _re
    from pathlib import Path as _Path

    from .instruments import BASS_TUNING, GUITAR_TUNING

    path = _Path(xml_path)
    text = path.read_text(encoding="utf-8")
    names = dict(_re.findall(r'<score-part id="([^"]+)">\s*<part-name>([^<]*)</part-name>', text))
    steps = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"]
    alters = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]
    fixed = 0

    def details(number: str | None, tuning) -> str:
        num = f' number="{number}"' if number else ""
        rows = "".join(
            f'<staff-tuning line="{i + 1}"><tuning-step>{steps[m % 12]}</tuning-step>'
            + (f"<tuning-alter>{alters[m % 12]}</tuning-alter>" if alters[m % 12] else "")
            + f"<tuning-octave>{m // 12 - 1}</tuning-octave></staff-tuning>"
            for i, m in enumerate(tuning))
        return f"<staff-details{num}><staff-lines>{len(tuning)}</staff-lines>{rows}</staff-details>"

    def fix_part(match):
        nonlocal fixed
        pid, body = match.group(1), match.group(2)
        tuning = BASS_TUNING if "bass" in names.get(pid, "").lower() else GUITAR_TUNING
        clef = _re.search(r'<clef(?: number="(\d+)")?>\s*<sign>TAB</sign>.*?</clef>', body, _re.S)
        if not clef or "<staff-details" in body[: clef.end() + 200]:
            return match.group(0)
        fixed += 1
        # <attributes> 안에서 clef 뒤에 staff-details 가 와야 한다 (MusicXML 순서)
        attrs_end = body.find("</attributes>", clef.end())
        insert_at = attrs_end if attrs_end != -1 else clef.end()
        # clef 들이 여러 개면 마지막 clef 다음에
        last_clef = max(m.end() for m in _re.finditer(r"</clef>", body[:insert_at]))
        between = body[last_clef:insert_at]
        anchor = last_clef + (between.find("<transpose") if "<transpose" in between else
                              between.find("<directive") if "<directive" in between else len(between))
        body = body[:anchor] + details(clef.group(1), tuning) + body[anchor:]
        return f'<part id="{pid}">{body}</part>'

    text = _re.sub(r'<part id="([^"]+)">(.*?)</part>', fix_part, text, flags=_re.S)
    if fixed:
        path.write_text(text, encoding="utf-8")
    return fixed


def add_multi_rests(xml_path, min_bars: int = 2) -> int:
    """모든 보표가 쉬는 마디가 이어지면 '여러 마디 쉼표'(<multiple-rest>)로 묶는다.

    구간 표시·코드·조표 변경·줄바꿈이 있는 마디에서는 끊는다. PDF(Verovio)·MuseScore 에서도
    긴 쉼 구간이 짧게 보이도록. 반환: 묶은 구간 수.
    """
    import xml.etree.ElementTree as ET
    from pathlib import Path as _Path

    path = _Path(xml_path)
    text = path.read_text(encoding="utf-8")
    head_end = text.index("<score-partwise")
    header = text[:head_end]
    root = ET.fromstring(text[head_end:])
    parts = root.findall("part")
    if not parts:
        return 0
    measures = [p.findall("measure") for p in parts]
    n = min(len(m) for m in measures)

    def resting(m) -> bool:
        notes = m.findall("note")
        if not notes or any(x.find("rest") is None for x in notes):
            return False
        if m.find("harmony") is not None:
            return False
        # 구간 표시가 있는 마디는 묶지 않는다 (Verovio 가 여러 마디 쉼표 위의 구간 표시를 지움)
        return not any(d.find(".//words") is not None or d.find(".//rehearsal") is not None
                       for d in m.findall("direction"))

    def starts_new(i) -> bool:
        """구간 표시·줄바꿈·조표/박자 변경이 있는 마디 — 여러 마디 쉼표는 여기서 새로 시작한다."""
        for ms in measures:
            m = ms[i]
            if m.find("print[@new-system='yes']") is not None:
                return True
            if any(d.find(".//rehearsal") is not None for d in m.findall("direction")):
                return True
            attrs = m.find("attributes")
            if attrs is not None and (attrs.find("key") is not None or attrs.find("time") is not None):
                return True
        return False

    flags = [all(resting(ms[i]) for ms in measures) for i in range(n)]
    runs, i = [], 0
    while i < n:
        if not flags[i]:
            i += 1
            continue
        j = i + 1
        while j < n and flags[j] and not starts_new(j):
            j += 1
        if j - i >= min_bars:
            runs.append((i, j - i))
        i = j
    for start, length in runs:
        for ms in measures:
            m = ms[start]
            attrs = m.find("attributes")
            if attrs is None:
                attrs = ET.Element("attributes")
                m.insert(0 if m.find("print") is None else 1, attrs)
            style = ET.SubElement(attrs, "measure-style")
            ET.SubElement(style, "multiple-rest").text = str(length)
    if runs:
        path.write_text(header + ET.tostring(root, encoding="unicode"), encoding="utf-8")
    return len(runs)
