"""박자 분석: 비트 트래킹, 마디 첫 박 추정, 박자표 추정, 박 단위 양자화."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import librosa
import numpy as np

from .engines import available, torch_device
from .instruments import KICK, SNARE
from .project import Note, TimeMap


@dataclass
class BeatInfo:
    beats: list[float]
    downbeats: list[float] = field(default_factory=list)  # 딥러닝 엔진만 제공
    engine: str = "librosa"


def librosa_beats(path: Path, bpm: float | None = None, sr: int = 22050) -> list[float]:
    """비트 위치(초) 목록. bpm 을 주면 그 템포로 고정해서 추적한다."""
    y, sr = librosa.load(str(path), sr=sr, mono=True)
    hop = 512
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, aggregate=np.median)
    kwargs = {"bpm": bpm} if bpm else {"start_bpm": 100.0}
    _, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=hop,
                                       units="time", trim=False, **kwargs)
    beats = [float(b) for b in beats]
    if len(beats) < 2:
        period = 60.0 / (bpm or 100.0)
        duration = len(y) / sr
        beats = list(np.arange(0.0, max(duration, period * 2), period))
    return beats


def beat_this_beats(path: Path, device: str | None = None) -> tuple[list[float], list[float]]:
    """CPJKU Beat This! — 비트와 마디 첫 박(다운비트)을 함께 추정."""
    import soundfile as sf
    from beat_this.inference import Audio2Beats

    signal, sr = sf.read(str(path), always_2d=True)
    model = Audio2Beats(checkpoint_path="final0", device=torch_device(device), dbn=False)
    a, b = model(signal.mean(axis=1).astype(np.float32), sr)
    a, b = [float(x) for x in a], [float(x) for x in b]
    return (a, b) if len(a) >= len(b) else (b, a)


def track_beats(path: Path, bpm: float | None = None, engine: str = "auto",
                device: str | None = None, log=print) -> BeatInfo:
    """비트 추적. 템포를 직접 지정하면 librosa(템포 고정)를, 아니면 가능한 경우 Beat This! 를 쓴다."""
    if engine == "auto":
        engine = "beat_this" if (available("beat_this") and not bpm) else "librosa"
    if engine == "beat_this":
        try:
            beats, downbeats = beat_this_beats(path, device)
            if len(beats) >= 4:
                return BeatInfo(beats, downbeats, "beat_this")
        except Exception as e:  # 체크포인트 다운로드 실패 등
            log(f"   ! Beat This! 생략 ({e}) — librosa 사용")
    return BeatInfo(librosa_beats(path, bpm), [], "librosa")


def downbeat_from_model(beats: list[float], downbeats: list[float],
                        beats_per_bar: int) -> int | None:
    """모델이 준 다운비트 시각을 비트 번호로 바꿔, 가장 많이 나오는 마디 위상을 고른다."""
    if not downbeats or not beats:
        return None
    bt = np.asarray(beats)
    idx = [int(np.argmin(np.abs(bt - d))) for d in downbeats]
    phase = Counter(i % beats_per_bar for i in idx).most_common(1)
    return phase[0][0] if phase else None


def guess_meter(beats: list[float], downbeats: list[float]) -> str | None:
    """다운비트 간격(비트 수)으로 박자표 추정: 3 -> 3/4, 4 -> 4/4."""
    if len(downbeats) < 3:
        return None
    bt = np.asarray(beats)
    idx = [int(np.argmin(np.abs(bt - d))) for d in downbeats]
    counts = Counter(np.diff(idx).tolist())
    if not counts:
        return None
    n = counts.most_common(1)[0][0]
    return {2: "2/4", 3: "3/4", 4: "4/4", 6: "6/8"}.get(int(n))


def estimate_downbeat(tracks: dict[str, list[Note]], timemap: TimeMap, beats_per_bar: int) -> int:
    """몇 번째 박이 마디의 첫 박인지(0..beats_per_bar-1) 추정 (다운비트 모델이 없을 때).

    베이스 음의 시작(길이 가중), 킥 드럼, 화음 악기의 음 시작이 주로 첫 박에 모인다는 점을 이용한다.
    """
    if beats_per_bar <= 1:
        return 0
    scores = np.zeros(beats_per_bar)

    def add(notes: list[Note], weight: float, use_duration: bool):
        for n in notes:
            b = float(timemap.to_beats(n.start))
            nearest = round(b)
            if abs(b - nearest) > 0.15:  # 박 위에 있는 음만
                continue
            w = weight * (min(n.duration, 4.0) if use_duration else 1.0)
            scores[int(nearest) % beats_per_bar] += w

    add(tracks.get("bass", []), 2.0, True)
    add([n for n in tracks.get("drums", []) if n.pitch == KICK], 1.0, False)
    for name in ("piano", "guitar", "other"):
        add(tracks.get(name, []), 0.3, True)
    if scores.sum() > 0:
        scores = scores / scores.sum()

    # 화성 리듬: 코드가 바뀌는 곳은 대부분 마디 첫 박이다 (킥·베이스가 1·3박에 똑같이 나올 때 결정적)
    changes = harmonic_change_by_phase(tracks, timemap, beats_per_bar)
    if changes.sum() > 0:
        scores = scores + 1.5 * changes / changes.sum()
    if not scores.any():
        return 0
    return int(np.argmax(scores))


def harmonic_change_by_phase(tracks: dict[str, list[Note]], timemap: TimeMap,
                             beats_per_bar: int) -> np.ndarray:
    """박마다 화음(음높이 분포)이 얼마나 바뀌는지를 마디 위상별로 더한다."""
    from .chords import _beat_chroma

    harm = {k: v for k, v in tracks.items() if k in ("piano", "guitar", "other", "bass")}
    notes = [n for ns in harm.values() for n in ns]
    out = np.zeros(beats_per_bar)
    if not notes:
        return out
    n_beats = int(np.ceil(float(timemap.to_beats(max(n.end for n in notes))))) + 1
    if n_beats < beats_per_bar * 2:
        return out
    chroma, _, _ = _beat_chroma(harm, timemap, n_beats, 0.0)
    norm = np.linalg.norm(chroma, axis=1) + 1e-9
    unit = chroma / norm[:, None]
    for k in range(1, n_beats):
        if norm[k] > 1e-6 and norm[k - 1] > 1e-6:
            out[k % beats_per_bar] += 1.0 - float(unit[k] @ unit[k - 1])
    return out


def quantize(value: float, grid: int) -> float:
    """박 단위 값을 1/grid 박 격자에 맞춘다 (grid=4 -> 16분음표)."""
    return round(value * grid) / grid


# ---------------------------------------------------------------------------
# 템포 2배/절반 오류 바로잡기
# ---------------------------------------------------------------------------

def _tempo_candidates(beats: list[float]) -> dict[str, list[float]]:
    bt = list(beats)
    mids = [(a + b) / 2 for a, b in zip(bt, bt[1:])]
    double = sorted(bt + mids)
    return {"x1": bt, "half0": bt[0::2], "half1": bt[1::2], "double": double}


def tempo_octave_scores(beats: list[float], tracks: dict[str, list[Note]]) -> dict[str, float]:
    """비트 후보(그대로 / 절반(두 위상) / 2배)마다 '박다운 정도' 점수.

    - 템포 선호: 60~140 BPM 사이 (로그 가우시안, 중심 95)
    - 드럼: 킥·스네어가 거의 모든 박 위에 있고, 박 사이(반 박)에는 드물수록 그 격자가 박
      (8분음표 하이햇·아르페지오에 끌려 2배로 잡히면 킥·스네어가 두 박에 한 번만 나온다)
    - 보컬: 음절(음 시작) 간격의 중앙값이 대략 한 박
    """
    drums = [n.start for n in tracks.get("drums", []) if n.pitch in (KICK, SNARE)]
    vocal = sorted(n.start for n in tracks.get("vocals", []))
    out = {}
    for name, bt in _tempo_candidates(beats).items():
        if len(bt) < 8:
            continue
        tm = TimeMap(bt)
        bpm = 60.0 / tm.period
        score = -((np.log2(bpm / 95.0)) ** 2) / (2 * 0.45 ** 2)
        if len(drums) >= 16:
            pos = tm.to_beats(np.asarray(drums))
            frac = pos - np.round(pos)
            on = np.abs(frac) < 0.15
            hit_beats = set(np.round(pos[on]).astype(int).tolist())
            lo, hi = int(np.ceil(pos.min())), int(np.floor(pos.max()))
            coverage = len(hit_beats) / max(1, hi - lo + 1)
            offbeat = float(np.mean(np.abs(np.abs(frac) - 0.5) < 0.15))
            score += 2.0 * coverage - 2.0 * offbeat
        if len(vocal) >= 8:
            ioi = np.diff(tm.to_beats(np.asarray(vocal)))
            ioi = ioi[(ioi > 0.05) & (ioi < 4.5)]
            if len(ioi) >= 6:
                score -= 0.8 * abs(np.log2(float(np.median(ioi)) / 0.9))
        out[name] = float(score)
    return out


def fix_tempo_octave(beats: list[float], tracks: dict[str, list[Note]], margin: float = 0.3) -> tuple[list[float], str]:
    """템포가 2배/절반으로 잡혔으면 바로잡은 비트 목록을 돌려준다. 반환: (비트, 고른 후보 이름)."""
    scores = tempo_octave_scores(beats, tracks)
    if "x1" not in scores:
        return beats, "x1"
    best = max(scores, key=scores.get)
    if best != "x1" and scores[best] > scores["x1"] + margin:
        return _tempo_candidates(beats)[best], best
    return beats, "x1"
