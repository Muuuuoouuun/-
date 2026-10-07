"""멜로디만 있는 노래(반주 없이 녹음한 영상)의 템포·마디·키·코드 추정.

악기 반주가 없으면 일반 코드 인식(크로마 템플릿)은 근거가 부족해 sus4 같은 엉뚱한 코드를 고른다.
여기서는 '사람이 멜로디에 반주를 붙이는 방식'을 그대로 따른다.

1. 템포: 음 시작점(길이 가중)이 가장 잘 맞는 박 간격을 찾고(사람이 편하게 느끼는 템포 쪽을 선호),
   그 템포로 박 위치를 따라간다(조금씩 빨라지거나 느려져도 따라감).
2. 코드: 조 안의 3화음(I ii iii IV V vi, 단조는 i iv V VI III VII)만 후보로, 강박에 오는 음과 긴 음이
   코드 구성음이 되도록, 자연스러운 진행(V→I, IV→V, ii→V, 끝은 I)을 선호하며 비터비로 고른다.
   4박자는 반 마디마다 바뀔 수도 있지만, 마디 첫 박에서 바뀌는 쪽을 선호한다.
3. 마디 첫 박과 키: 가능한 경우를 모두 화성을 붙여 보고 가장 자연스러운 쪽을 고른다.
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np

from .project import Note
from .theory import Key

MAJOR_DEGREES = [(0, ""), (2, "m"), (4, "m"), (5, ""), (7, ""), (9, "m")]  # I ii iii IV V vi
MINOR_DEGREES = [(0, "m"), (5, "m"), (7, ""), (8, ""), (3, ""), (10, "")]  # i iv V VI III VII
QUALITY_IVS = {"": (0, 4, 7), "m": (0, 3, 7)}

# 화성 진행 선호 (으뜸음 기준 반음 거리: 앞 코드 -> 뒤 코드)
_PROGRESS_MAJOR = {
    (7, 0): 0.45, (5, 7): 0.25, (2, 7): 0.30, (5, 0): 0.15, (9, 5): 0.20, (9, 2): 0.15,
    (0, 5): 0.15, (0, 7): 0.15, (0, 9): 0.12, (4, 9): 0.15, (7, 9): 0.15, (7, 5): -0.1,
}
_PROGRESS_MINOR = {
    (7, 0): 0.45, (10, 0): 0.25, (5, 7): 0.25, (8, 10): 0.20, (0, 8): 0.15, (8, 3): 0.15,
    (3, 10): 0.15, (10, 3): 0.15, (0, 5): 0.15, (5, 0): 0.10, (0, 10): 0.10, (8, 7): 0.15,
    (3, 8): 0.10, (0, 7): 0.10, (10, 8): 0.10,
}
_PRIOR_MAJOR = {0: 0.25, 5: 0.15, 7: 0.15, 9: 0.08, 2: 0.0, 4: -0.05}
_PRIOR_MINOR = {0: 0.25, 8: 0.10, 5: 0.10, 7: 0.12, 3: 0.05, 10: 0.05}


@dataclass
class Harmony:
    key: Key
    beats: list[float]
    beats_per_bar: int
    downbeat: int  # 몇 번째 박이 마디 첫 박인지
    chords: list[tuple[float, float, int, str]]  # (시작 초, 끝 초, 근음, 'm' 또는 '')
    score: float


# ---------------------------------------------------------------------------
# 템포 / 박
# ---------------------------------------------------------------------------

def _weights(notes: list[Note], cap: float = 1.2) -> np.ndarray:
    return np.array([min(n.duration, cap) for n in notes]) + 0.05


def estimate_tempo(notes: list[Note], lo: float = 50.0, hi: float = 180.0) -> float:
    """음 시작점들이 가장 잘 맞는 템포(BPM).

    박 위치에서 시작하는 음은 가산, 반 박(8분음표) 위치는 중립, 그 밖은 감점하는 박자 틀로
    가장 잘 맞는 박 간격·위상을 찾는다. 두 배/절반 템포가 비슷하게 맞으면 60~120 근처를 고른다.
    """
    if len(notes) < 4:
        return 90.0
    on = np.array([n.start for n in notes])
    w = _weights(notes)
    bpms = np.arange(lo, hi, 0.25)
    periods = 60.0 / bpms
    phases = np.linspace(0, 1, 32, endpoint=False)  # 두 박 길이 안에서 위상
    best = np.zeros(len(bpms))
    for k, T in enumerate(periods):
        theta = 2 * np.pi * (on[None, :] / T - 2 * phases[:, None])  # 위상은 0~2박
        fit = np.cos(theta) + 0.6 * np.cos(2 * theta) + 0.3 * np.cos(theta / 2)
        best[k] = (fit @ w).max() / (1.9 * w.sum())
    prior = np.exp(-0.5 * (np.log2(bpms / 92.0) / 0.5) ** 2)
    return float(bpms[int(np.argmax(np.maximum(best, 0) * prior))])


def track_beats_from_notes(notes: list[Note], duration: float, bpm: float, sr: int = 22050,
                           hop: int = 256) -> list[float]:
    """템포를 고정하고 음 시작점을 따라 박 위치를 추적 (사람의 템포 흔들림을 따라감)."""
    n = int(duration * sr / hop) + 1
    env = np.zeros(n)
    w = _weights(notes)
    for note, wt in zip(notes, w):
        k = int(note.start * sr / hop)
        if 0 <= k < n:
            env[k] += wt
    env = np.convolve(env, np.hanning(5), mode="same")
    if not env.any():
        return list(np.arange(0.0, duration, 60.0 / bpm))
    _, beats = librosa.beat.beat_track(onset_envelope=env, sr=sr, hop_length=hop, bpm=bpm,
                                       tightness=300, trim=False, units="time")
    beats = [float(b) for b in beats]
    period = 60.0 / bpm
    if len(beats) < 2:
        return list(np.arange(0.0, duration, period))
    # 앞뒤로 박 채우기 (노래 시작 전/끝난 뒤)
    while beats[0] - period > -0.5 * period:
        beats.insert(0, beats[0] - period)
    while beats[-1] < duration:
        beats.append(beats[-1] + period)
    return [b for b in beats if b > -0.5 * period]


# ---------------------------------------------------------------------------
# 코드 붙이기
# ---------------------------------------------------------------------------

def _candidates(key: Key) -> list[tuple[int, str, int]]:
    """(근음 pc, 성질, 으뜸음 기준 반음)"""
    degs = MAJOR_DEGREES if key.mode == "major" else MINOR_DEGREES
    return [((key.tonic + d) % 12, q, d) for d, q in degs]


def _unit_profiles(notes: list[Note], beats: np.ndarray, start_beat: int, unit: int, n_units: int,
                   bpb: int) -> np.ndarray:
    """단위(마디 또는 반 마디)마다 12음 가중치. 강박에서 시작하는 음, 긴 음에 높은 가중치."""
    idx = np.arange(len(beats), dtype=float)
    prof = np.zeros((n_units, 12))
    for n in notes:
        b0 = float(np.interp(n.start, beats, idx)) - start_beat
        b1 = float(np.interp(n.end, beats, idx)) - start_beat
        if b1 <= 0 or b0 >= n_units * unit:
            continue
        pos = b0 % bpb
        near = round(pos)
        on_beat = abs(pos - near) < 0.2
        accent = 1.0
        if on_beat and near % bpb == 0:
            accent = 1.8
        elif on_beat and bpb == 4 and near == 2:
            accent = 1.4
        elif on_beat:
            accent = 1.1
        else:
            accent = 0.7
        for u in range(max(0, int(b0 // unit)), min(n_units, int(np.ceil(b1 / unit)))):
            ov = min(b1, (u + 1) * unit) - max(b0, u * unit)
            if ov > 0:
                # 음이 시작한 단위에서만 강세 적용 (앞 단위에서 이어진 음은 덜 중요)
                a = accent if u == int(b0 // unit) else 0.6
                prof[u, n.pitch % 12] += ov * a
    return prof


def _harmonize_units(prof: np.ndarray, key: Key, units_per_bar: int) -> tuple[float, list[int]]:
    cands = _candidates(key)
    scale = set((key.tonic + s) % 12 for s in ((0, 2, 4, 5, 7, 9, 11) if key.mode == "major"
                                                else (0, 2, 3, 5, 7, 8, 10, 11)))
    n_units, n_c = len(prof), len(cands)
    emis = np.zeros((n_units, n_c))
    for j, (root, q, deg) in enumerate(cands):
        tones = {(root + i) % 12 for i in QUALITY_IVS[q]}
        v = np.array([1.0 if pc in tones else (-0.55 if pc in scale else -1.2) for pc in range(12)])
        emis[:, j] = prof @ v
    tot = prof.sum(axis=1, keepdims=True)
    emis = emis / np.maximum(tot, 1.0)  # 단위마다 비슷한 크기로
    major = key.mode == "major"
    prior = np.array([(_PRIOR_MAJOR if major else _PRIOR_MINOR).get(d, 0.0) for _, _, d in cands])
    emis += prior * 0.5
    empty = tot[:, 0] < 1e-6

    trans = np.zeros((n_c, n_c))
    for a, (_, _, da) in enumerate(cands):
        for b, (_, _, db) in enumerate(cands):
            trans[a, b] = (_PROGRESS_MAJOR if major else _PROGRESS_MINOR).get((da, db), 0.0) if a != b else 0.0

    score = emis[0] + np.where(np.array([d for _, _, d in cands]) == 0, 0.25, 0.0)  # 첫 코드 I 선호
    back = np.zeros((n_units, n_c), dtype=int)
    for u in range(1, n_units):
        mid_bar = u % units_per_bar != 0
        t = trans.copy()
        if mid_bar:  # 마디 중간에서 바뀌는 건 근거가 충분할 때만
            t = t - 0.45 * (1 - np.eye(n_c))
        if empty[u]:  # 음이 없는 구간은 앞 코드 유지
            t = t - 0.6 * (1 - np.eye(n_c))
        total = score[:, None] + t
        back[u] = np.argmax(total, axis=0)
        score = total[back[u], np.arange(n_c)] + emis[u]
    # 끝맺음: 마지막 코드가 I(i) 이면 가산
    final = score + np.array([0.6 if d == 0 else 0.0 for _, _, d in cands])
    path = [int(np.argmax(final))]
    for u in range(n_units - 1, 0, -1):
        path.append(int(back[u, path[-1]]))
    path.reverse()
    return float(final.max()), path


def harmonize(notes: list[Note], beats: list[float], beats_per_bar: int = 4, key: Key | None = None,
              downbeat: int | None = None) -> Harmony:
    """멜로디에 어울리는 코드 진행. key/downbeat 를 주면 그대로 쓰고, 아니면 함께 추정."""
    bt = np.asarray(beats, dtype=float)
    bpb = max(1, beats_per_bar)
    unit = bpb // 2 if bpb == 4 else bpb  # 4박자는 반 마디(2박) 단위로도 바뀔 수 있음
    upb = bpb // unit
    if key is not None:
        keys = [key]
    else:
        keys = _key_candidates(notes)
    first = min(n.start for n in notes) if notes else 0.0
    first_beat = int(np.floor(np.interp(first, bt, np.arange(len(bt))) + 0.25))
    phases = [downbeat] if downbeat is not None else list(range(bpb))
    best = None
    for k in keys:
        for ph in phases:
            start = first_beat - ((first_beat - ph) % bpb)  # 첫 음을 포함하는 마디의 첫 박
            if start < 0:
                start += bpb
                if start > first_beat:
                    start -= bpb
            n_units = int(np.ceil((len(bt) - max(start, 0)) / unit))
            if n_units <= 0:
                continue
            prof = _unit_profiles(notes, bt, start, unit, n_units, bpb)
            used = np.flatnonzero(prof.sum(axis=1) > 0)
            if not used.size:
                continue
            last_u = int(used[-1]) + 1
            last_u = int(np.ceil(last_u / upb) * upb)  # 마디 끝까지
            prof = prof[:last_u]
            sc, path = _harmonize_units(prof, k, upb)
            # 단위 수가 위상마다 달라지므로 단위당 점수로 비교 (그냥 합하면 마디가 많은 쪽이 유리)
            sc = sc / len(prof)
            sc += 0.05 * _downbeat_evidence(notes, bt, ph, bpb)
            sc += 0.15 * _key_fit(notes, k)
            if k.mode == "major":  # 근거가 비슷하면 장조 (대중음악·찬양은 장조가 훨씬 많음)
                sc += 0.04
            if best is None or sc > best[0]:
                best = (sc, k, ph, start, path)
    if best is None:
        k = keys[0]
        return Harmony(k, list(beats), bpb, 0, [], 0.0)
    sc, k, ph, start, path = best
    cands = _candidates(k)
    chords = []
    for u, j in enumerate(path):
        root, q, _ = cands[j]
        b0, b1 = start + u * unit, start + (u + 1) * unit
        t0, t1 = _beat_time(bt, b0), _beat_time(bt, b1)
        if chords and chords[-1][2] == root and chords[-1][3] == q:
            chords[-1] = (chords[-1][0], t1, root, q)
        else:
            chords.append((t0, t1, root, q))
    return Harmony(k, list(beats), bpb, ph % bpb, chords, sc)


def _beat_time(bt: np.ndarray, b: float) -> float:
    if b < 0:
        return float(bt[0] + b * (bt[1] - bt[0]))
    if b >= len(bt) - 1:
        return float(bt[-1] + (b - len(bt) + 1) * (bt[-1] - bt[-2]))
    return float(np.interp(b, np.arange(len(bt)), bt))


def _downbeat_evidence(notes: list[Note], bt: np.ndarray, phase: int, bpb: int) -> float:
    """마디 첫 박에서 시작하는 긴 음의 비율 (노래는 프레이즈가 마디 첫 박에서 시작·끝나는 경우가 많음)."""
    idx = np.arange(len(bt), dtype=float)
    hit = tot = 0.0
    for n in notes:
        b = float(np.interp(n.start, bt, idx))
        if abs(b - round(b)) > 0.2:
            continue
        w = min(n.duration, 2.0)
        tot += w
        if (round(b) - phase) % bpb == 0:
            hit += w
    return hit / tot if tot else 0.0


def _key_fit(notes: list[Note], key: Key) -> float:
    """조 안의 음 비율 + 마지막 긴 음이 으뜸음이면 가산."""
    scale = {(key.tonic + s) % 12 for s in ((0, 2, 4, 5, 7, 9, 11) if key.mode == "major"
                                            else (0, 2, 3, 5, 7, 8, 10, 11))}
    w = _weights(notes)
    inside = sum(wt for n, wt in zip(notes, w) if n.pitch % 12 in scale) / w.sum()
    last = max(notes[-3:], key=lambda n: n.duration) if notes else None
    ending = 0.5 if last is not None and last.pitch % 12 == key.tonic else 0.0
    return inside + ending


def _key_candidates(notes: list[Note], top: int = 4) -> list[Key]:
    """Krumhansl 상관이 높은 키 몇 개 + 각각의 나란한조(같은 조표)·같은으뜸음조(G ↔ Gm).

    멜로디만으로는 장/단조가 헷갈리기 쉬우므로 후보를 넉넉히 두고, 화성을 붙여 본 결과로 고른다.
    """
    from .theory import KK_MAJOR, KK_MINOR

    if not notes:
        return [Key.from_tonic(0, "major")]
    hist = np.zeros(12)
    for n, wt in zip(notes, _weights(notes)):
        hist[n.pitch % 12] += wt
    scored = []
    for tonic in range(12):
        for mode, prof in (("major", KK_MAJOR), ("minor", KK_MINOR)):
            r = np.corrcoef(hist, np.roll(prof, tonic))[0, 1]
            scored.append((-1.0 if np.isnan(r) else r, tonic, mode))
    scored.sort(reverse=True)
    out, seen = [], set()

    def add(tonic: int, mode: str) -> None:
        if (tonic, mode) not in seen:
            seen.add((tonic, mode))
            out.append(Key.from_tonic(tonic, mode))

    for _, tonic, mode in scored[:top]:
        add(tonic, mode)
        add((tonic + 9) % 12 if mode == "major" else (tonic + 3) % 12, "minor" if mode == "major" else "major")
        add(tonic, "minor" if mode == "major" else "major")
    return out


def chord_name(root: int, quality: str, key: Key) -> str:
    from .theory import spell_pc

    return spell_pc(root, key.fifths, key.mode, key.tonic) + quality
