"""테스트용 합성 밴드 음원 생성 (G장조, 100 BPM, 4/4, G-D-Em-C 진행).

보컬(메인), 코러스(3도 위 화음), 피아노, 기타(아르페지오), 베이스, 드럼과
드럼 조각 트랙(drums/kick.wav, snare.wav, hh.wav, toms.wav, crash.wav)을 만든다.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

SR = 22050
BPM = 100.0
BEAT = 60.0 / BPM
PROGRESSION = [  # (베이스 근음 MIDI, 피아노 구성음, 기타 아르페지오)
    (43, [55, 59, 62], [43, 50, 55, 59, 62, 67]),  # G
    (38, [54, 57, 62], [50, 57, 62, 66, 62, 57]),  # D
    (40, [55, 59, 64], [40, 47, 52, 55, 59, 64]),  # Em
    (36, [55, 60, 64], [48, 52, 55, 60, 64, 60]),  # C
]
# 멜로디: (시작 박, 길이 박, MIDI)
MELODY = [
    (0, 1, 67), (1, 1, 71), (2, 2, 74),
    (4, 1, 74), (5, 1, 72), (6, 2, 71),
    (8, 1, 71), (9, 1, 67), (10, 2, 64),
    (12, 1, 64), (13, 1, 67), (14, 2, 72),
]
# 코러스: 멜로디 아래 3도/6도 화음 (G 장조 음계 안)
SCALE = [55, 57, 59, 60, 62, 64, 66, 67, 69, 71, 72, 74, 76]


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


def third_below(p: int) -> int:
    i = min(range(len(SCALE)), key=lambda k: abs(SCALE[k] - p))
    return SCALE[max(0, i - 2)]


def make_stems(out: Path, bars: int = 8, lead_in: float = 0.5, guitar: bool = False,
               backing: bool = False, drum_parts: bool = False) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    n = int((lead_in + bars * 4 * BEAT + 2.0) * SR)
    names = ["vocals", "bass", "piano", "drums"] + (["guitar"] if guitar else []) + \
        (["backing_vocals"] if backing else [])
    stems = {k: np.zeros(n, np.float32) for k in names}
    parts = {k: np.zeros(n, np.float32) for k in ("kick", "snare", "hh", "toms", "crash")}
    rng = np.random.default_rng(0)

    def hit(part: str, t: float, sig: np.ndarray, gain: float):
        place(parts[part], t, sig, gain)
        place(stems["drums"], t, sig, gain)

    for bar in range(bars):
        root, chord, arp = PROGRESSION[bar % 4]
        t0 = lead_in + bar * 4 * BEAT
        # 베이스: 2분음표 두 개
        for h in range(2):
            place(stems["bass"], t0 + h * 2 * BEAT, tone(root, 2 * BEAT * 0.95, (1.0, 0.6, 0.3)), 0.5)
        # 피아노: 박마다 화음
        for b in range(4):
            for p in chord:
                place(stems["piano"], t0 + b * BEAT, tone(p, BEAT * 0.9, (1.0, 0.3), decay=2.0), 0.25)
        # 기타: 8분음표 아르페지오 (2박 패턴 x2 -> 6음 + 2음)
        if guitar:
            for k in range(8):
                p = arp[k % 6]
                place(stems["guitar"], t0 + k * BEAT / 2, tone(p, BEAT / 2 * 0.95, (1.0, 0.4, 0.2),
                                                               decay=1.5), 0.3)
        # 드럼: 킥 1,3 / 스네어 2,4 / 하이햇 8분 (마디 끝 열린 하이햇), 4마디마다 탐 필인, 크래시
        for b in range(4):
            tb = t0 + b * BEAT
            fill = bar % 4 == 3 and b == 3
            if b in (0, 2):
                k = tone(36, 0.15, (1.0,), decay=25) + tone(28, 0.15, (1.0,), decay=25)
                hit("kick", tb, k, 0.9)
            elif not fill:
                s = bandpass(rng.standard_normal(int(0.12 * SR)), 300, 4000)
                s *= np.exp(-np.arange(len(s)) / SR * 30)
                hit("snare", tb, s + tone(55, 0.12, (1.0,), decay=30), 0.5)
            if fill:
                for j, tp in enumerate((57, 52, 45, 40)):  # 하이 -> 플로어
                    hit("toms", tb + j * BEAT / 4, tone(tp, 0.2, (1.0, 0.3), decay=12), 0.6)
                continue
            for e in range(2):
                open_hh = b == 3 and e == 1
                length = 0.35 if open_hh else 0.04
                hh = bandpass(rng.standard_normal(int(length * SR)), 7000, SR / 2)
                hh *= np.exp(-np.arange(len(hh)) / SR * (8 if open_hh else 80))
                hit("hh", tb + e * BEAT / 2, hh, 0.3)
        if bar % 4 == 0:
            cr = bandpass(rng.standard_normal(int(1.5 * SR)), 3000, SR / 2)
            cr *= np.exp(-np.arange(len(cr)) / SR * 2.5)
            hit("crash", t0, cr, 0.35)
    # 보컬 멜로디 (앞 4마디 x2), 코러스는 아래 3도
    for rep in range(bars // 4):
        for sb, lb, p in MELODY:
            t = lead_in + (rep * 16 + sb) * BEAT
            place(stems["vocals"], t, tone(p, lb * BEAT * 0.92, (1.0, 0.4, 0.2)), 0.4)
            if backing:
                place(stems["backing_vocals"], t, tone(third_below(p), lb * BEAT * 0.92,
                                                       (1.0, 0.4, 0.2)), 0.3)
    paths = {}
    for k, y in stems.items():
        paths[k] = out / f"{k}.wav"
        sf.write(paths[k], y, SR)
    if drum_parts:
        (out / "drums").mkdir(exist_ok=True)
        for k, y in parts.items():
            sf.write(out / "drums" / f"{k}.wav", y, SR)
    return paths


def make_mix(out: Path, **kw) -> Path:
    """분리 전 믹스(하나의 파일)를 만든다. 앱/파일 입력 테스트용."""
    paths = make_stems(out / "_stems", **kw)
    mix = sum(sf.read(str(p))[0] for p in paths.values())
    mix = mix / max(1.0, float(np.abs(mix).max()))
    dst = out / "mix.wav"
    sf.write(dst, mix, SR)
    return dst


if __name__ == "__main__":
    import sys

    print(make_stems(Path(sys.argv[1] if len(sys.argv) > 1 else "synth_stems"),
                     guitar=True, backing=True, drum_parts=True))
