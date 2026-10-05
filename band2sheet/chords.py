"""코드(화음) 인식: 화성 악기 음표에서 박 단위 코드 진행을 추정한다.

박마다 음높이 분포(크로마)를 만들고 코드 템플릿과 비교한 뒤,
비터비(Viterbi) 탐색으로 '자주 바뀌지 않는' 자연스러운 진행을 고른다.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .project import Note, TimeMap
from .theory import Key, spell_pc

QUALITIES: dict[str, tuple[tuple[int, ...], float]] = {
    # 이름: (구성음 간격, 사전 점수 — 단순한 코드를 선호)
    "": ((0, 4, 7), 0.0),
    "m": ((0, 3, 7), 0.0),
    "7": ((0, 4, 7, 10), -0.03),
    "maj7": ((0, 4, 7, 11), -0.04),
    "m7": ((0, 3, 7, 10), -0.025),
    "sus4": ((0, 5, 7), -0.06),
    "sus2": ((0, 2, 7), -0.08),
    "dim": ((0, 3, 6), -0.10),
}

HARMONY_WEIGHTS = {"piano": 1.0, "guitar": 1.0, "other": 0.8, "bass": 1.2, "vocals": 0.25}

MAJOR_SCALE = (0, 2, 4, 5, 7, 9, 11)
MINOR_SCALE = (0, 2, 3, 5, 7, 8, 10, 11)  # 자연단음계 + 이끈음


@dataclass
class ChordEvent:
    start: float  # 박
    end: float  # 박
    root: int | None  # None 이면 N.C. (코드 없음)
    quality: str = ""
    bass: int | None = None

    def name(self, key: Key) -> str:
        if self.root is None:
            return "N.C."
        text = spell_pc(self.root, key.fifths, key.mode, key.tonic) + self.quality
        if self.bass is not None and self.bass != self.root:
            text += "/" + spell_pc(self.bass, key.fifths, key.mode, key.tonic)
        return text

    def number(self, key: Key) -> str:
        """내슈빌 넘버 표기 (예: G 키에서 D/F# -> 5/7, Em -> 6m)."""
        if self.root is None:
            return "N.C."
        text = nashville_degree(self.root, key) + self.quality
        if self.bass is not None and self.bass != self.root:
            text += "/" + nashville_degree(self.bass, key)
        return text

    def transposed(self, semitones: int) -> "ChordEvent":
        t = lambda pc: None if pc is None else (pc + semitones) % 12  # noqa: E731
        return ChordEvent(self.start, self.end, t(self.root), self.quality, t(self.bass))


_DEGREES = {0: "1", 1: "b2", 2: "2", 3: "b3", 4: "3", 5: "4", 6: "#4", 7: "5", 8: "b6", 9: "6",
            10: "b7", 11: "7"}


def nashville_degree(pc: int, key: Key) -> str:
    """키의 으뜸음 기준 음 번호. 단조 키는 으뜸음(1)을 단조 으뜸음으로 본다 (b3, b6, b7 이 조 안의 음)."""
    return _DEGREES[(pc - key.tonic) % 12]


def _beat_chroma(tracks: dict[str, list[Note]], timemap: TimeMap, n_beats: int,
                 offset: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """박마다 (12차원 크로마, 12차원 베이스 크로마, 베이스를 뺀 윗성부 크로마)."""
    chroma = np.zeros((n_beats, 12))
    bass = np.zeros((n_beats, 12))
    upper = np.zeros((n_beats, 12))
    for name, notes in tracks.items():
        w = HARMONY_WEIGHTS.get(name)
        if w is None:
            continue
        for n in notes:
            b0 = float(timemap.to_beats(n.start)) - offset
            b1 = float(timemap.to_beats(n.end)) - offset
            lo, hi = max(int(np.floor(b0)), 0), min(int(np.ceil(b1)), n_beats)
            for k in range(lo, hi):
                overlap = min(b1, k + 1) - max(b0, k)
                if overlap <= 0:
                    continue
                v = w * overlap * (n.velocity / 127.0)
                chroma[k, n.pitch % 12] += v
                if name == "bass":
                    bass[k, n.pitch % 12] += overlap
                elif name != "vocals":  # 멜로디의 경과음·꾸밈음은 코드 모양에 넣지 않는다
                    upper[k, n.pitch % 12] += v
    return chroma, bass, upper


def _templates(key: Key):
    scale = MAJOR_SCALE if key.mode == "major" else MINOR_SCALE
    in_key = {(key.tonic + s) % 12 for s in scale}
    labels, vecs, priors = [], [], []
    for root in range(12):
        for q, (ivs, prior) in QUALITIES.items():
            v = np.zeros(12)
            for i in ivs:
                v[(root + i) % 12] = 1.0
            v /= np.linalg.norm(v)
            tones = {(root + i) % 12 for i in ivs}
            diatonic = 0.06 if tones <= in_key else 0.0
            labels.append((root, q))
            vecs.append(v)
            priors.append(prior + diatonic)
    return labels, np.array(vecs), np.array(priors)


def detect_chords(tracks: dict[str, list[Note]], timemap: TimeMap, key: Key,
                  beats_per_bar: int, downbeat: int, n_beats: int | None = None,
                  key_at=None) -> list[ChordEvent]:
    """박 단위 코드 진행 추정. 반환되는 start/end 는 '악보 박'(downbeat 기준) 단위.

    key_at(박) 을 주면 전조된 구간에서는 그 구간의 키를 기준으로 '조에 맞는 코드'를 선호한다.
    """
    all_notes = [n for name, ns in tracks.items() if name in HARMONY_WEIGHTS for n in ns]
    if not all_notes:
        return []
    if n_beats is None:
        last = max(float(timemap.to_beats(n.end)) for n in all_notes) - downbeat
        n_beats = int(np.ceil(last)) + 1
    if n_beats <= 0:
        return []
    chroma, bass, upper = _beat_chroma(tracks, timemap, n_beats, float(downbeat))

    labels, T, priors = _templates(key)
    roots = np.array([r for r, _ in labels])
    # 템플릿마다 구성음 표 (베이스 음이 구성음인지 = 자리바꿈 코드인지 보려고)
    member = np.zeros((len(labels), 12), dtype=bool)
    for i, (r, q) in enumerate(labels):
        for iv in QUALITIES[q][0]:
            member[i, (r + iv) % 12] = True
    prior_cache: dict[tuple[int, str], np.ndarray] = {(key.tonic, key.mode): priors}

    def priors_at(k: int) -> np.ndarray:
        if key_at is None:
            return priors
        kk = key_at(k)
        if (kk.tonic, kk.mode) not in prior_cache:
            prior_cache[(kk.tonic, kk.mode)] = _templates(kk)[2]
        return prior_cache[(kk.tonic, kk.mode)]
    n_states = len(labels) + 1  # 마지막 상태 = N.C.
    energy = chroma.sum(axis=1)
    loud = np.percentile(energy[energy > 0], 75) if np.any(energy > 0) else 1.0

    # 분산화음(아르페지오)은 한 박에 코드 음이 2~3개만 들어 있다 — 같은 반 마디(4/4 의 1·2박, 3·4박)의
    # 이웃 박을 조금 섞어 코드 모양을 본다 (마디 구조를 따라 섞으므로 코드가 바뀌는 곳은 잘 흐려지지 않는다)
    group = 2 if beats_per_bar % 2 == 0 else beats_per_bar
    pooled = upper.copy()
    for k in range(n_beats):
        g0 = (k // group) * group
        others = [j for j in range(g0, min(g0 + group, n_beats)) if j != k]
        if others:
            pooled[k] = upper[k] + 0.6 * upper[others].sum(axis=0)

    emis = np.full((n_beats, n_states), -1.0)
    for k in range(n_beats):
        c = chroma[k]
        norm = np.linalg.norm(c)
        if norm > 0:
            # 화음 모양은 윗성부(건반·기타 등)로 맞춘다 — 베이스까지 섞으면 베이스 음이 너무 커서
            # 7화음의 7음 같은 윗성부 음이 묻히고, 자리바꿈(A/C#)이 엉뚱한 코드(C#m)가 된다.
            u = pooled[k]
            un = np.linalg.norm(u)
            has_upper = np.linalg.norm(upper[k]) > 0.25 * norm
            shape = u / un if has_upper else c / norm  # 화음 악기가 거의 없으면(베이스+보컬만) 전체로
            sim = T @ shape + priors_at(k)
            bvec = bass[k]
            if bvec.sum() > 0:
                # 베이스 음: 근음이면 가장 좋고, 다른 구성음이면(자리바꿈) 조금 좋고, 구성음이 아니면 나쁘다.
                # 화음 악기가 없으면 베이스가 화성의 주된 근거라 근음 쪽으로 더 기운다.
                bpc = int(np.argmax(bvec))
                dominance = bvec[bpc] / bvec.sum()
                is_root = roots == bpc
                in_chord = member[:, bpc]
                w_root, w_inv = (0.16, 0.08) if has_upper else (0.25, 0.0)
                sim = sim + dominance * np.where(is_root, w_root, np.where(in_chord, w_inv, -0.12))
            emis[k, :-1] = sim
        # 소리가 거의 없으면 N.C.
        emis[k, -1] = 0.9 if energy[k] < 0.05 * loud else -0.5

    def change_cost(beat: int) -> float:
        pos = beat % beats_per_bar
        if pos == 0:
            return 0.25
        if beats_per_bar % 2 == 0 and pos == beats_per_bar // 2:
            return 0.4
        return 0.7

    # 비터비
    score = emis[0].copy()
    back = np.zeros((n_beats, n_states), dtype=int)
    for k in range(1, n_beats):
        cost = change_cost(k)
        best_prev = int(np.argmax(score))
        stay = score
        switch = score[best_prev] - cost
        use_switch = switch > stay
        back[k] = np.where(use_switch, best_prev, np.arange(n_states))
        score = np.where(use_switch, switch, stay) + emis[k]
    path = [int(np.argmax(score))]
    for k in range(n_beats - 1, 0, -1):
        path.append(int(back[k, path[-1]]))
    path.reverse()

    segments: list[list[int]] = []  # [상태, 시작 박, 끝 박]
    for k, s in enumerate(path):
        if segments and segments[-1][0] == s:
            segments[-1][2] = k + 1
        else:
            segments.append([s, k, k + 1])

    events: list[ChordEvent] = []
    for s, start, end in segments:
        if s == n_states - 1:
            events.append(ChordEvent(start, end, None))
            continue
        root, q = labels[s]
        ev = ChordEvent(start, end, root, q)
        # 베이스 음으로 자리바꿈(슬래시 코드) 결정: 구간에서 가장 오래 울린 베이스 음
        bvec = bass[start:end].sum(axis=0)
        if bvec.sum() > 0:
            bpc = int(np.argmax(bvec))
            if bvec[bpc] / bvec.sum() >= 0.6 and bpc != root:
                tones = {(root + i) % 12 for i in QUALITIES[q][0]}
                if bpc in tones or (bpc - root) % 12 in (2, 9, 10):
                    ev.bass = bpc
        events.append(ev)

    # 앞뒤 N.C. 는 잘라낸다
    while events and events[0].root is None:
        events.pop(0)
    while events and events[-1].root is None:
        events.pop()
    return events
