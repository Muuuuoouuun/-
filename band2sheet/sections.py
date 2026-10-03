"""곡 구조 인식: 전주 / 절 / 프리코러스 / 후렴 / 브리지 / 간주 / 후주.

4마디(프레이즈) 단위로 특징을 만들어 서로 비교한다.
- 키 기준으로 돌린 음높이 분포와 코드 근음 (전조된 후렴도 같은 후렴으로 알아봄)
- 보컬 멜로디 분포, 악기 편성(어떤 악기가 연주하는지), 세기
비슷한 프레이즈끼리 같은 글자(A, B, C …)를 붙이고, 반복 횟수·보컬 유무·위치로 이름을 정한다.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .chords import ChordEvent
from .project import Note, Project, TimeMap

NAMES_KO = {"Intro": "전주", "Verse": "절", "Pre-Chorus": "프리코러스", "Chorus": "후렴",
            "Bridge": "브리지", "Interlude": "간주", "Outro": "후주", "Section": "구간"}


@dataclass
class Section:
    start_bar: int  # 0부터 (악보 마디 번호 - 1)
    end_bar: int  # 끝 (포함하지 않음)
    label: str  # A, B, C ...
    kind: str  # Intro, Verse, Chorus ...
    number: int = 0  # 같은 종류의 몇 번째 (Verse 1, Verse 2)

    @property
    def name(self) -> str:
        return f"{self.kind} {self.number}" if self.number else self.kind

    @property
    def name_ko(self) -> str:
        base = NAMES_KO.get(self.kind, self.kind)
        return f"{base} {self.number}" if self.number else base

    def to_dict(self) -> dict:
        return {"start_bar": self.start_bar, "end_bar": self.end_bar, "label": self.label,
                "kind": self.kind, "number": self.number, "name": self.name, "name_ko": self.name_ko}


def bar_features(project: Project, chords: list[ChordEvent], n_bars: int) -> tuple[np.ndarray, dict]:
    """마디마다 특징 벡터 (키 기준 화음 12 + 코드 근음 12 + 멜로디 12 + 편성 n + 세기 1)."""
    tm = TimeMap(project.beat_times)
    bpb = project.beats_per_bar
    names = [n for n in project.tracks if n != "drums"] + (["drums"] if "drums" in project.tracks else [])
    harm = np.zeros((n_bars, 12))
    melody = np.zeros((n_bars, 12))
    inst = np.zeros((n_bars, len(names)))
    energy = np.zeros(n_bars)
    vocal_pitch = np.zeros(n_bars)
    vocal_dur = np.zeros(n_bars)

    def bar_of(t: float) -> int:
        return int((float(tm.to_beats(t)) - project.downbeat) // bpb)

    for j, name in enumerate(names):
        for n in project.tracks[name].notes:
            b = bar_of(n.start)
            if not 0 <= b < n_bars:
                continue
            tonic = project.key_at_beat(b * bpb).tonic
            w = n.duration * n.velocity / 127
            inst[b, j] += 1
            energy[b] += n.velocity / 127
            if name == "drums":
                continue
            rel = (n.pitch - tonic) % 12
            if name == "vocals":
                melody[b, rel] += w
                vocal_pitch[b] += (n.pitch - tonic) * n.duration
                vocal_dur[b] += n.duration
            else:
                harm[b, rel] += w
    roots = np.zeros((n_bars, 12))
    for c in chords:
        if c.root is None:
            continue
        for beat in range(int(c.start), int(np.ceil(c.end))):
            b = beat // bpb
            if 0 <= b < n_bars:
                tonic = project.key_at_beat(beat).tonic
                roots[b, (c.root - tonic) % 12] += 1

    def unit(x):
        nrm = np.linalg.norm(x, axis=1, keepdims=True)
        return np.where(nrm > 0, x / (nrm + 1e-9), 0)

    inst_on = (inst > 0).astype(float)
    feats = np.hstack([unit(harm), unit(roots) * 1.2, unit(melody) * 1.2, inst_on * 0.5,
                       (energy / (energy.max() + 1e-9))[:, None] * 0.5])
    info = {
        "vocals": vocal_dur > 0.3,
        "vocal_pitch": np.where(vocal_dur > 0, vocal_pitch / np.maximum(vocal_dur, 1e-9), np.nan),
        "energy": energy,
        "n_inst": inst_on.sum(axis=1),
        "active": (inst.sum(axis=1) > 0),
    }
    return feats, info


def _block_sim(F: np.ndarray, a: int, b: int, size: int) -> float:
    sims = []
    for k in range(size):
        x, y = F[a + k], F[b + k]
        nx, ny = np.linalg.norm(x), np.linalg.norm(y)
        if nx == 0 and ny == 0:
            sims.append(1.0)
        elif nx == 0 or ny == 0:
            sims.append(0.0)
        else:
            sims.append(float(x @ y / (nx * ny)))
    return float(np.mean(sims))


def detect_sections(project: Project, chords: list[ChordEvent], n_bars: int,
                    phrase: int = 4, threshold: float = 0.86) -> list[Section]:
    """프레이즈 단위로 묶어 곡 구조를 찾는다."""
    if n_bars < phrase:
        return [Section(0, max(n_bars, 1), "A", "Section")]
    F, info = bar_features(project, chords, n_bars)
    first = int(np.argmax(info["active"])) if info["active"].any() else 0
    last = int(np.nonzero(info["active"])[0][-1]) + 1 if info["active"].any() else n_bars
    starts = list(range(first, last, phrase))

    # 1) 프레이즈마다 글자 붙이기 (앞에서부터 가장 비슷한 대표와 비교)
    labels: list[str] = []
    reps: list[tuple[str, int]] = []
    for s in starts:
        size = min(phrase, last - s)
        best, best_sim = None, threshold
        for lab, r in reps:
            sim = _block_sim(F, s, r, min(size, last - r))
            if sim > best_sim:
                best, best_sim = lab, sim
        if best is None:
            best = chr(ord("A") + len(reps)) if len(reps) < 26 else "Z"
            reps.append((best, s))
        labels.append(best)

    # 2) 같은 글자가 이어지면 한 구간으로
    raw: list[list] = []
    for s, lab in zip(starts, labels):
        e = min(s + phrase, last)
        if raw and raw[-1][2] == lab:
            raw[-1][1] = e
        else:
            raw.append([s, e, lab])
    # 같은 글자가 길게 이어진 구간은 그 글자의 기본 길이(가장 짧은 구간)나 전조 지점에서 나눈다
    #   예) 후렴 2 + 반음 올린 후렴 3 이 붙어 있으면 둘로
    key_bars = {int(b // project.beats_per_bar) for b, _ in project.key_changes}
    base_len: dict[str, int] = {}
    for s, e, lab in raw:
        base_len[lab] = min(base_len.get(lab, e - s), e - s)
    split: list[list] = []
    for s, e, lab in raw:
        cuts = {c for c in key_bars if s < c < e}
        unit = base_len[lab]
        if unit >= phrase and e - s > unit and (e - s) % unit == 0:
            cuts |= set(range(s + unit, e, unit))
        bounds = [s] + sorted(cuts) + [e]
        split += [[a, b, lab] for a, b in zip(bounds, bounds[1:])]
    raw = split
    if raw and raw[0][0] > 0:
        raw[0][0] = 0
    if raw:
        raw[-1][1] = max(raw[-1][1], n_bars)

    # 3) 이름 정하기
    def has_vocals(s, e):
        return float(np.mean(info["vocals"][s:e])) > 0.3

    def mean_of(arr, s, e):
        v = arr[s:e]
        v = v[~np.isnan(v)] if v.dtype.kind == "f" else v
        return float(np.mean(v)) if len(v) else float("nan")

    stats: dict[str, dict] = {}
    for s, e, lab in raw:
        st = stats.setdefault(lab, {"count": 0, "bars": 0, "vocal": 0, "pitch": [], "energy": [],
                                    "first": s, "positions": []})
        st["count"] += 1
        st["bars"] += e - s
        st["vocal"] += has_vocals(s, e)
        st["pitch"].append(mean_of(info["vocal_pitch"], s, e))
        st["energy"].append(mean_of(info["energy"], s, e) + 0.2 * mean_of(info["n_inst"], s, e))
        st["positions"].append(len(st["positions"]))
    vocal_labels = [lab for lab, st in stats.items() if st["vocal"] > 0]

    kinds: dict[str, str] = {}
    if vocal_labels:
        def chorus_score(lab):
            st = stats[lab]
            pitch = np.nanmean(st["pitch"]) if not all(np.isnan(st["pitch"])) else 0
            return st["count"] * 2 + np.mean(st["energy"]) * 0.5 + pitch * 0.05

        chorus = max(vocal_labels, key=chorus_score) if len(vocal_labels) > 1 else None
        if chorus and stats[chorus]["count"] < 2 and len(vocal_labels) > 1:
            chorus = None
        others = sorted((lab for lab in vocal_labels if lab != chorus), key=lambda x: stats[x]["first"])
        if chorus:
            kinds[chorus] = "Chorus"
        if others:
            kinds[others[0]] = "Verse"
            for lab in others[1:]:
                # 매번 후렴 바로 앞에 나오면 프리코러스, 아니면 브리지
                idx = [i for i, r in enumerate(raw) if r[2] == lab]
                before_chorus = all(i + 1 < len(raw) and kinds.get(raw[i + 1][2]) == "Chorus" for i in idx)
                kinds[lab] = "Pre-Chorus" if before_chorus and len(idx) >= 2 else "Bridge"
        if not chorus and len(others) == 1:
            kinds[others[0]] = "Verse"

    sections: list[Section] = []
    counters: dict[str, int] = {}
    for i, (s, e, lab) in enumerate(raw):
        kind = kinds.get(lab)
        if kind is None:  # 보컬 없는 구간
            kind = "Intro" if i == 0 else "Outro" if i == len(raw) - 1 else "Interlude"
        sections.append(Section(s, e, lab, kind))
    totals: dict[str, int] = {}
    for sec in sections:
        totals[sec.kind] = totals.get(sec.kind, 0) + 1
    for sec in sections:
        if totals[sec.kind] > 1 and sec.kind in ("Verse", "Chorus", "Pre-Chorus", "Bridge", "Interlude"):
            counters[sec.kind] = counters.get(sec.kind, 0) + 1
            sec.number = counters[sec.kind]
    return sections


def note_at_bar(notes: list[Note], tm: TimeMap, downbeat: int, bpb: int, bar: int) -> bool:
    return any(int((float(tm.to_beats(n.start)) - downbeat) // bpb) == bar for n in notes)
