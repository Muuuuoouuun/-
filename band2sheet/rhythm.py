"""박자 분석: 비트 트래킹, 마디 첫 박 추정, 박 단위 양자화."""

from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

from .instruments import KICK
from .project import Note, TimeMap


def track_beats(path: Path, bpm: float | None = None, sr: int = 22050) -> list[float]:
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


def estimate_downbeat(tracks: dict[str, list[Note]], timemap: TimeMap, beats_per_bar: int) -> int:
    """몇 번째 박이 마디의 첫 박인지(0..beats_per_bar-1) 추정.

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
    if not scores.any():
        return 0
    return int(np.argmax(scores))


def quantize(value: float, grid: int) -> float:
    """박 단위 값을 1/grid 박 격자에 맞춘다 (grid=4 -> 16분음표)."""
    return round(value * grid) / grid
