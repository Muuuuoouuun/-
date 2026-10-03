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
        el.articulations.append(articulations.OpenString())
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
