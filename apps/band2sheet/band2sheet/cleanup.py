"""분리 후처리: 악기 활동 구간과 블리딩(다른 악기 소리가 새어 들어온 것) 판별.

분리된 스템 X 와 '나머지 전체' O(= 믹스 - X)의 스펙트럼을 프레임마다 비교한다.

- 고유 성분 비율(own): X 를 O 의 상수배로 최대한 설명하고 남는 에너지 비율.
  새어 들어온 소리뿐이면 X ≈ βO 라서 0 에 가깝고, 실제로 연주하면 커진다.
- 활동 구간: own 이 충분히 크고 소리가 들리는 구간 (짧은 끊김은 메우고 짧은 잡음은 버림)
- 음표 검증: 음표의 배음 위치에서 X 의 에너지가 '새어 들어온 양(βO)'보다 충분히 큰지 확인해
  블리딩으로 생긴 가짜 음표를 지운다.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from pathlib import Path

import librosa
import numpy as np

from .project import Note

SR = 22050
N_FFT = 4096
HOP = 1024
FINE_FFT = 2048
FINE_HOP = 256


def _smooth(x: np.ndarray, n: int) -> np.ndarray:
    if n <= 1 or len(x) == 0:
        return x
    k = np.ones(n) / n
    return np.convolve(np.pad(x, (n // 2, n - 1 - n // 2), mode="edge"), k, mode="valid")


def _clean_mask(mask: np.ndarray, fill: int, min_len: int) -> np.ndarray:
    """짧은 비활성 틈은 메우고, 너무 짧은 활성 조각은 지운다."""
    m = mask.copy()
    n = len(m)

    def runs(value):
        i = 0
        while i < n:
            if m[i] == value:
                j = i
                while j < n and m[j] == value:
                    j += 1
                yield i, j
                i = j
            else:
                i += 1

    for i, j in list(runs(False)):
        if 0 < i and j < n and j - i <= fill:
            m[i:j] = True
    for i, j in list(runs(True)):
        if j - i < min_len:
            m[i:j] = False
    return m


@dataclass
class StemActivity:
    name: str
    times: np.ndarray
    own: np.ndarray  # 고유 성분 비율 (0~1, 다듬은 값)
    level_db: np.ndarray  # 스템 자체의 큰 소리 대비 음량
    active: np.ndarray  # 연주 중인 프레임
    bleed: np.ndarray  # 프레임별 블리딩 비율 β (X ≈ βO)
    frame_t: float = HOP / SR

    def intervals(self) -> list[tuple[float, float]]:
        out, start = [], None
        for t, a in zip(self.times, self.active):
            if a and start is None:
                start = float(t)
            elif not a and start is not None:
                out.append((start, float(t)))
                start = None
        if start is not None:
            out.append((start, float(self.times[-1] + self.frame_t)))
        return [(round(a, 2), round(b, 2)) for a, b in out]

    def active_fraction(self, t0: float, t1: float) -> float:
        i0 = int(np.searchsorted(self.times, t0))
        i1 = max(int(np.searchsorted(self.times, t1)), i0 + 1)
        seg = self.active[i0:i1]
        return float(seg.mean()) if seg.size else 0.0

    def report(self) -> dict:
        act = self.active
        bleed = self.bleed[act] if act.any() else self.bleed
        bleed = bleed[bleed > 0]
        return {
            "active_ratio": round(float(act.mean()), 3) if act.size else 0.0,
            "own_ratio": round(float(self.own[act].mean()), 3) if act.any() else 0.0,
            "bleed_db": round(float(20 * np.log10(np.median(bleed))), 1) if bleed.size else None,
            "intervals": self.intervals(),
        }


@dataclass
class SeparationAnalyzer:
    """스템들을 한 번 읽어 두고, 스템별 활동 구간 계산과 음표 검증을 한다."""

    stems: dict[str, Path]
    own_threshold: float = 0.22
    silence_db: float = -42.0
    _ys: dict[str, np.ndarray] = field(default_factory=dict, repr=False)
    _mix: np.ndarray | None = field(default=None, repr=False)
    _cache: dict[str, tuple[np.ndarray, np.ndarray]] = field(default_factory=dict, repr=False)
    _fine_cache: dict[str, np.ndarray] = field(default_factory=dict, repr=False)
    activity: dict[str, StemActivity] = field(default_factory=dict)

    def __post_init__(self):
        for name, path in self.stems.items():
            y, _ = librosa.load(str(path), sr=SR, mono=True)
            self._ys[name] = y.astype(np.float32)
        n = max(len(y) for y in self._ys.values())
        for k, y in self._ys.items():
            if len(y) < n:
                self._ys[k] = np.pad(y, (0, n - len(y)))
        # 스템들의 합 = 분리 전 믹스 (분리는 합이 믹스가 되도록 만든다)
        self._mix = librosa.stft(sum(self._ys.values()), n_fft=N_FFT, hop_length=HOP)

    def _spectra(self, name: str) -> tuple[np.ndarray, np.ndarray]:
        """(|X|, |O|) — 마지막으로 쓴 스템 하나만 캐시 (메모리 절약)."""
        if name not in self._cache:
            self._cache.clear()
            X = librosa.stft(self._ys[name], n_fft=N_FFT, hop_length=HOP)
            self._cache[name] = (np.abs(X), np.abs(self._mix - X))
        return self._cache[name]

    def fine_power(self, name: str) -> np.ndarray:
        """음 시작(어택) 판별용 촘촘한 시간 해상도(약 12ms)의 파워 스펙트럼 — 스템 하나만 캐시."""
        if name not in self._fine_cache:
            self._fine_cache.clear()
            X = librosa.stft(self._ys[name], n_fft=FINE_FFT, hop_length=FINE_HOP)
            self._fine_cache[name] = (np.abs(X) ** 2).astype(np.float32)
        return self._fine_cache[name]

    def analyze(self, name: str) -> StemActivity:
        if name in self.activity:
            return self.activity[name]
        A, O = self._spectra(name)
        alpha = (A * O).sum(0) / ((O * O).sum(0) + 1e-12)
        resid = (np.clip(A - alpha * O, 0, None) ** 2).sum(0) / ((A * A).sum(0) + 1e-12)
        rms = np.sqrt((A * A).mean(0))
        ref = np.percentile(rms[rms > 0], 95) if np.any(rms > 0) else 1.0
        level = 20 * np.log10(rms / ref + 1e-9)

        # 블리딩 비율 β: O 가 강한 주파수에서 |X|/|O| 의 낮은 분위수 (X 가 연주하지 않는 칸)
        strong = O > 0.1 * (O.max(axis=0, keepdims=True) + 1e-12)
        ratio = np.where(strong, A / (O + 1e-12), np.nan)
        with np.errstate(all="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # 완전히 조용한 프레임
            bleed = np.nanpercentile(ratio, 25, axis=0)
        bleed = np.nan_to_num(bleed, nan=0.0)
        bleed = _smooth(bleed, 11)

        sec = SR / HOP  # 초당 프레임 수
        own = _smooth(resid, int(1.0 * sec))
        active = (own > self.own_threshold) & (_smooth(level, int(0.5 * sec)) > self.silence_db)
        active = _clean_mask(active, fill=int(1.5 * sec), min_len=int(0.6 * sec))
        # 다듬은 값은 소리 시작보다 조금 늦게 올라오므로 앞뒤로 0.3초 넓힌다 (첫 타격 보호)
        pad = int(0.3 * sec)
        if pad and active.any():
            active = np.convolve(active.astype(float), np.ones(2 * pad + 1), mode="same") > 0
        times = librosa.frames_to_time(np.arange(A.shape[1]), sr=SR, hop_length=HOP)
        act = StemActivity(name, times, own, level, active, bleed)
        self.activity[name] = act
        return act

    def verify_notes(self, name: str, notes: list[Note], margin_db: float = 7.0,
                     min_active: float = 0.3) -> tuple[list[Note], int]:
        """블리딩으로 생긴 음표를 지운다. 반환: (남은 음표, 지운 개수)."""
        if not notes:
            return notes, 0
        act = self.analyze(name)
        A, O = self._spectra(name)
        n_frames = A.shape[1]
        margin = 10 ** (margin_db / 10)
        kept: list[Note] = []
        for n in notes:
            if act.active_fraction(n.start, n.end) < min_active:
                continue  # 이 악기가 연주하지 않는 구간의 음표
            f0, f1 = int(n.start * SR / HOP), max(int(n.end * SR / HOP), int(n.start * SR / HOP) + 1)
            f0, f1 = min(f0, n_frames - 1), min(f1, n_frames)
            hz = float(librosa.midi_to_hz(n.pitch))
            bins = []
            # 기본음 자리로 판정한다. 배음까지 합치면 이 악기가 실제로 내는 다른 음(예: 화음의 옥타브 위 음)과
            # 겹쳐서 새어 든 음도 통과해 버린다. 아주 낮은 음(E2 아래)만 기본음이 약할 수 있어 2배음까지.
            for h in ((1,) if n.pitch >= 40 else (1, 2)):
                b = int(round(h * hz * N_FFT / SR))
                if b + 1 < A.shape[0]:
                    bins += [b - 1, b, b + 1]
            if not bins:
                kept.append(n)
                continue
            ex = float((A[bins, f0:f1] ** 2).sum())
            leak = float(((act.bleed[f0:f1] * O[bins, f0:f1]) ** 2).sum())
            if leak <= 0 or ex > margin * leak:
                kept.append(n)
        return kept, len(notes) - len(kept)

    def filter_hits(self, name: str, hits: list[Note], min_active: float = 0.5) -> tuple[list[Note], int]:
        """드럼 타격: 드럼이 연주하지 않는 구간의 타격만 지운다."""
        act = self.analyze(name)
        kept = [h for h in hits if act.active_fraction(h.start - 0.05, h.start + 0.15) >= min_active]
        return kept, len(hits) - len(kept)


def _bins(hz: float, harmonics=(1,)) -> list[int]:
    out = []
    for h in harmonics:
        b = int(round(h * hz * N_FFT / SR))
        if 1 <= b < N_FFT // 2:
            out += [b - 1, b, b + 1]
    return out


def remove_ghosts(analyzer: "SeparationAnalyzer", name: str, notes: list[Note],
                  together: float = 0.06, missing_db: float = -10.0,
                  weaker: float = 0.7) -> tuple[list[Note], int]:
    """다성 채보의 옥타브 유령음을 지운다.

    - 아래 유령음: 같은 때 옥타브 위 음이 있고, 이 음의 기본음 주파수 에너지가 2배음보다 훨씬 작으면
      (기본음이 실제로는 없으면) 위 음의 배음을 잘못 잡은 것.
    - 위 유령음(옥타브·12도·2옥타브 위): 기본음이 확인된 아래 음보다 훨씬 약하면 아래 음의 배음.
    """
    if len(notes) < 2:
        return notes, 0
    A, _ = analyzer._spectra(name)
    n_frames = A.shape[1]

    def energy(n: Note, hz: float) -> float:
        f0 = min(int(n.start * SR / HOP), n_frames - 1)
        f1 = min(max(int(n.end * SR / HOP), f0 + 1), n_frames)
        b = _bins(hz)
        return float((A[b, f0:f1] ** 2).sum()) if b else 0.0

    cache: dict[int, bool] = {}

    def has_fundamental(n: Note) -> bool:
        if id(n) not in cache:
            hz = float(librosa.midi_to_hz(n.pitch))
            e1, e2 = energy(n, hz), energy(n, 2 * hz)
            cache[id(n)] = e2 <= 0 or 10 * np.log10((e1 + 1e-12) / (e2 + 1e-12)) > missing_db
        return cache[id(n)]

    notes = sorted(notes, key=lambda n: n.start)
    drop: set[int] = set()
    for i, a in enumerate(notes):
        for j in range(i + 1, len(notes)):
            b = notes[j]
            if b.start - a.start > together:
                break
            lo, hi = (a, b) if a.pitch < b.pitch else (b, a)
            d = hi.pitch - lo.pitch
            if d in (12, 19, 24) and not has_fundamental(lo):
                drop.add(id(lo))  # 기본음이 실제로는 없는 아래 유령음
            elif d in (12, 19, 24) and hi.velocity < weaker * lo.velocity and has_fundamental(lo):
                drop.add(id(hi))
    kept = [n for n in notes if id(n) not in drop]
    return kept, len(notes) - len(kept)


def remove_unstruck(analyzer: "SeparationAnalyzer", name: str, notes: list[Note],
                    min_rise_db: float = 2.0, merge_gap: float = 0.1) -> tuple[list[Note], int]:
    """새로 치지 않은 음표를 지운다 (건반·기타처럼 '치는' 악기용).

    실제로 친 음은 시작 순간 그 음 주파수의 소리가 커진다(어택). 이미 울리던 낮은 음의 배음(옥타브 위),
    다른 악기에서 새어 든 작은 소리, 울리는 음이 중간에 끊겨 다시 잡힌 조각은 커지지 않는다.
    음 시작 직전의 가장 작은 값과 직후의 가장 큰 값을 비교한다.
    어택이 없는 음이 같은 음 바로 뒤에 붙어 있으면(끊겨 잡힌 조각) 지우지 않고 앞 음에 합친다.
    """
    if not notes:
        return notes, 0
    P = analyzer.fine_power(name)
    n_frames = P.shape[1]
    fps = SR / FINE_HOP
    pre0, pre1 = int(0.12 * fps), int(0.03 * fps)  # 시작 120ms~30ms 전
    post = int(0.08 * fps)  # 시작 ~80ms 후 (채보 시작 시각 오차 감안해 30ms 전부터)
    kept: list[Note] = []
    last: dict[int, Note] = {}
    for n in sorted(notes, key=lambda n: n.start):
        f = int(round(n.start * fps))
        b = int(round(float(librosa.midi_to_hz(n.pitch)) * FINE_FFT / SR))
        struck = True  # 판단할 수 없으면(곡 처음·끝, 너무 높은 음) 남긴다
        if f - pre0 >= 0 and f + post < n_frames and 1 <= b and b + 2 < P.shape[0]:
            e = P[b - 1:b + 2].sum(0)
            before = float(e[f - pre0:f - pre1].min())
            after = float(e[f - pre1:f + post].max())
            struck = before <= 0 or 10 * np.log10(after / before + 1e-12) >= min_rise_db
        if struck:
            kept.append(n)
            last[n.pitch] = n
            continue
        prev = last.get(n.pitch)
        if prev is not None and n.start - prev.end <= merge_gap:
            prev.end = max(prev.end, n.end)
    return kept, len(notes) - len(kept)


def remove_harmonic_ghosts(analyzer: "SeparationAnalyzer", name: str, notes: list[Note],
                           together: float = 0.1, factor: float = 2.5,
                           min_samples: int = 10) -> tuple[list[Note], int]:
    """아래 음의 배음만으로 설명되는 옥타브·12도·2옥타브 위 음표를 지운다.

    악기마다 배음 세기(2배음/기본음 …)가 다르므로, 같은 스템에서 옥타브 짝이 없는 음표들로
    '이 악기의 배음 비율'을 먼저 배운다. 짝이 있는 위 음 자리의 에너지가 아래 음 기본음 × 배음 비율의
    factor 배도 안 되면, 그 위 음은 따로 친 음이 아니라 아래 음의 배음이다. 정말로 옥타브를 함께 친
    경우에는 위 음 소리가 더해져 훨씬 커진다.
    """
    if len(notes) < 2:
        return notes, 0
    P = analyzer.fine_power(name)
    n_frames = P.shape[1]
    fps = SR / FINE_HOP
    win = max(1, int(0.15 * fps))

    def energy(n: Note, mult: int, t0: float) -> float:
        f0 = int(t0 * fps)
        b = int(round(mult * float(librosa.midi_to_hz(n.pitch)) * FINE_FFT / SR))
        if f0 >= n_frames or b < 1 or b + 2 >= P.shape[0]:
            return 0.0
        return float(P[b - 1:b + 2, f0:min(n_frames, f0 + win)].sum())

    notes = sorted(notes, key=lambda n: n.start)
    starts = np.array([n.start for n in notes])
    intervals = {12: 2, 19: 3, 24: 4}

    def partners(i: int) -> list[int]:
        lo_i = int(np.searchsorted(starts, starts[i] - together))
        hi_i = int(np.searchsorted(starts, starts[i] + together, side="right"))
        return [j for j in range(lo_i, hi_i) if j != i]

    # 1) 옥타브 짝이 없는 음표로 배음 비율 배우기
    samples: dict[int, list[float]] = {h: [] for h in intervals.values()}
    for i, n in enumerate(notes):
        if any(abs(notes[j].pitch - n.pitch) in intervals for j in partners(i)):
            continue
        e1 = energy(n, 1, n.start)
        if e1 <= 0:
            continue
        for h in samples:
            samples[h].append(energy(n, h, n.start) / e1)
    if len(samples[2]) < min_samples:
        return notes, 0
    ratio = {h: float(np.median(v)) for h, v in samples.items()}

    # 2) 짝이 있는 위 음: 위 음이 시작하는 때부터 같은 구간에서 비교
    drop: set[int] = set()
    for i, lo in enumerate(notes):
        for j in partners(i):
            hi = notes[j]
            h = intervals.get(hi.pitch - lo.pitch)
            if not h or id(lo) in drop:
                continue
            t0 = max(lo.start, hi.start)
            if energy(lo, h, t0) < factor * ratio[h] * energy(lo, 1, t0):
                drop.add(id(hi))
    kept = [n for n in notes if id(n) not in drop]
    return kept, len(notes) - len(kept)
