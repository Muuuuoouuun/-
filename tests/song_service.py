"""예배 실황처럼 '말씀 - 찬양 - 전환 - 찬양 - 기도' 가 이어진 합성 녹음 (곡 나누기 시험용)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from tests.song_live import SR, voice


def speech(sec: float, rng) -> np.ndarray:
    """말소리 비슷한 것: 음절(초당 4~5개)마다 높낮이가 바뀌고, 단어·문장 사이에 쉼."""
    n = int(sec * SR)
    f0 = np.full(n, 140.0)
    amp = np.zeros(n)
    t = 0.0
    while t < sec - 0.5:
        words = rng.integers(2, 6)
        for _ in range(words):
            syl = rng.uniform(0.12, 0.25)
            i0, i1 = int(t * SR), int(min(sec, t + syl) * SR)
            tt = np.arange(i1 - i0) / SR
            f0[i0:i1] = rng.uniform(110, 190) * (1 + 0.15 * (tt / syl - 0.5) * rng.choice([-1, 1]))
            amp[i0:i1] = 0.25 * np.sin(np.pi * tt / syl) ** 0.5
            t += syl + rng.uniform(0.02, 0.08)
        t += rng.uniform(0.25, 0.7)  # 단어/문장 사이 쉼
    return voice(f0, amp, rng)


def pad(sec: float, chord: list[int]) -> np.ndarray:
    t = np.arange(int(sec * SR)) / SR
    y = sum(np.sin(2 * np.pi * 440 * 2 ** ((p - 69) / 12) * t) for p in chord)
    env = np.minimum(1, t / 1.5) * np.minimum(1, (sec - t) / 1.5)
    return (0.05 * y * env).astype(np.float32)


def load_mix(stems_dir: Path, sec: float) -> np.ndarray:
    ys = [sf.read(p, dtype="float32")[0] for p in sorted(Path(stems_dir).glob("*.wav"))]
    n = min(min(len(y) for y in ys), int(sec * SR))
    y = sum(y[:n] for y in ys)
    return (y / (np.abs(y).max() + 1e-9) * 0.7).astype(np.float32)


def make_service(out: Path, song_a: Path, song_b: Path, seed: int = 2) -> tuple[Path, list[tuple[float, float]]]:
    """song_a/b: 스템 폴더. 반환: (wav 경로, 정답 곡 구간 [(시작, 끝)])."""
    rng = np.random.default_rng(seed)
    parts, truth, t = [], [], 0.0

    def add(y, is_song=False):
        nonlocal t
        parts.append(y)
        if is_song:
            truth.append((t, t + len(y) / SR))
        t += len(y) / SR

    add(speech(25, rng))                       # 말씀/인사
    add(load_mix(song_a, 70), True)           # 찬양 1 (D, 74 BPM)
    add(pad(10, [62, 66, 69]))                 # 건반 패드로 전환
    add(load_mix(song_b, 70), True)           # 찬양 2 (G, 100 BPM)
    add(speech(5, rng) * 0.5)                  # 짧은 멘트
    add(speech(20, rng))                       # 기도
    y = np.concatenate(parts)
    y += 0.003 * rng.standard_normal(len(y)).astype(np.float32)  # 회중 잡음
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, y, SR)
    return out, truth
