"""테스트용 합성 밴드 음원 생성 (G장조, 100 BPM, 4/4, G-D-Em-C 진행)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

SR = 22050
BPM = 100.0
BEAT = 60.0 / BPM
PROGRESSION = [  # (근음 MIDI, 구성음들) — 마디당 하나
    (43, [55, 59, 62]),  # G
    (38, [54, 57, 62]),  # D/F#? 여기서는 D 근음
    (40, [55, 59, 64]),  # Em
    (36, [55, 60, 64]),  # C
]
# 멜로디: (시작 박, 길이 박, MIDI)
MELODY = [
    (0, 1, 67), (1, 1, 71), (2, 2, 74),
    (4, 1, 74), (5, 1, 72), (6, 2, 71),
    (8, 1, 71), (9, 1, 67), (10, 2, 64),
    (12, 1, 64), (13, 1, 67), (14, 2, 72),
]


def tone(midi: int, dur: float, harmonics=(1.0, 0.5, 0.25), decay: float = 0.0) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    f = 440.0 * 2 ** ((midi - 69) / 12)
    y = sum(a * np.sin(2 * np.pi * f * (k + 1) * t) for k, a in enumerate(harmonics))
    env = np.minimum(1, t / 0.01) * np.minimum(1, (dur - t) / 0.03)
    if decay:
        env *= np.exp(-t * decay)
    return (y * env).astype(np.float32)


def bandpass(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    spec[(f < lo) | (f > hi)] = 0
    return np.fft.irfft(spec, len(x)).astype(np.float32)


def place(buf: np.ndarray, start: float, sig: np.ndarray, gain: float = 1.0) -> None:
    i = int(start * SR)
    j = min(len(buf), i + len(sig))
    buf[i:j] += gain * sig[: j - i]


def make_stems(out: Path, bars: int = 8, lead_in: float = 0.5) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    n = int((lead_in + bars * 4 * BEAT + 1.0) * SR)
    stems = {k: np.zeros(n, np.float32) for k in ("vocals", "bass", "piano", "drums")}
    rng = np.random.default_rng(0)
    for bar in range(bars):
        root, chord = PROGRESSION[bar % 4]
        t0 = lead_in + bar * 4 * BEAT
        # 베이스: 2분음표 두 개
        for h in range(2):
            place(stems["bass"], t0 + h * 2 * BEAT, tone(root, 2 * BEAT * 0.95, (1.0, 0.6, 0.3)), 0.5)
        # 피아노: 박마다 화음
        for b in range(4):
            for p in chord:
                place(stems["piano"], t0 + b * BEAT, tone(p, BEAT * 0.9, (1.0, 0.3), decay=2.0), 0.25)
        # 드럼: 킥 1,3 / 스네어 2,4 / 하이햇 8분
        for b in range(4):
            tb = t0 + b * BEAT
            if b in (0, 2):
                k = tone(36, 0.15, (1.0,), decay=25) + tone(28, 0.15, (1.0,), decay=25)
                place(stems["drums"], tb, k, 0.9)
            else:
                s = bandpass(rng.standard_normal(int(0.12 * SR)), 300, 4000)
                s *= np.exp(-np.arange(len(s)) / SR * 30)
                place(stems["drums"], tb, s + tone(55, 0.12, (1.0,), decay=30), 0.5)
            for e in range(2):
                hh = bandpass(rng.standard_normal(int(0.04 * SR)), 7000, SR / 2)
                hh *= np.exp(-np.arange(len(hh)) / SR * 80)
                place(stems["drums"], tb + e * BEAT / 2, hh, 0.3)
    # 보컬 멜로디 (앞 4마디 x2)
    for rep in range(bars // 4):
        for sb, lb, p in MELODY:
            t = lead_in + (rep * 16 + sb) * BEAT
            place(stems["vocals"], t, tone(p, lb * BEAT * 0.92, (1.0, 0.4, 0.2)), 0.4)
    paths = {}
    for k, y in stems.items():
        paths[k] = out / f"{k}.wav"
        sf.write(paths[k], y, SR)
    return paths


if __name__ == "__main__":
    import sys

    print(make_stems(Path(sys.argv[1] if len(sys.argv) > 1 else "synth_stems")))
