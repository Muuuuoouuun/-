"""정답(템포·박자·코드)을 아는 합성 '노래' — 반주 없이 목소리만 녹음한 영상을 흉내 낸다.

코드마다 강박에는 코드 구성음, 약박에는 지나가는 음을 부르고, 박자를 사람처럼 조금씩 흔들고,
음정도 조금씩 틀리게 부른다.
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np
from scipy.signal import lfilter

SR = 44100
QUAL = {"": (0, 4, 7), "m": (0, 3, 7)}
NAMES = {"C": 0, "C#": 1, "Db": 1, "D": 2, "Eb": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "Ab": 8, "A": 9,
         "Bb": 10, "B": 11}


@dataclass
class VocalSong:
    audio: np.ndarray
    bpm: float
    beats_per_bar: int
    chords: list[str]  # 마디마다 하나
    key: str
    lead_in: float  # 첫 마디 시작 (초)
    events: list  # 실제로 부른 음 (시작 초, 길이 초, midi)


def _parse(ch: str) -> tuple[int, tuple[int, ...]]:
    m = ch.endswith("m")
    return NAMES[ch[:-1] if m else ch], QUAL["m" if m else ""]


def make_song(chords: list[str], key: str, bpm: float = 90, beats_per_bar: int = 4, seed: int = 0,
              detune: float = 0.3, jitter: float = 0.02, lead_in: float = 0.6) -> VocalSong:
    rng = np.random.default_rng(seed)
    tonic = NAMES[key.rstrip("m")]
    minor = key.endswith("m")
    scale = [(tonic + s) % 12 for s in ((0, 2, 3, 5, 7, 8, 10) if minor else (0, 2, 4, 5, 7, 9, 11))]
    beat = 60.0 / bpm
    events = []  # (시작 초, 길이 초, midi)
    prev = 67
    for bar, ch in enumerate(chords):
        root, ivs = _parse(ch)
        tones = [(root + i) % 12 for i in ivs]
        # 리듬: 박 단위 + 가끔 8분음표 둘, 마디 끝은 길게
        slots = []
        b = 0.0
        while b < beats_per_bar - 1e-6:
            if b == 0 or rng.uniform() < 0.7 or b + 0.5 >= beats_per_bar:
                length = 1.0 if b + 1 <= beats_per_bar else beats_per_bar - b
            else:
                length = 0.5
            if b + length > beats_per_bar - 1.0 - 1e-6 and rng.uniform() < 0.5:
                length = beats_per_bar - b  # 마디 끝 음을 길게
            slots.append((b, length))
            b += length
        last_bar = bar == len(chords) - 1
        if last_bar:  # 노래는 대개 으뜸음을 길게 부르며 끝난다
            slots = [(0.0, 1.0), (1.0, beats_per_bar - 1.0)]
        for si, (b, length) in enumerate(slots):
            strong = b == 0 or (beats_per_bar == 4 and b == 2)
            pool = tones if strong or rng.uniform() < 0.6 else scale
            if last_bar and si == len(slots) - 1:
                pool = [tonic]
            cands = [p for p in range(60, 77) if p % 12 in pool]
            # 가까운 음으로 움직이되 같은 음만 반복하지 않게 (실제 멜로디처럼)
            p = min(cands, key=lambda q: abs(q - prev) + rng.uniform(0, 4) + (1.5 if q == prev else 0))
            prev = p
            t = lead_in + (bar * beats_per_bar + b) * beat + rng.normal(0, jitter)
            events.append((max(0.0, t), length * beat * 0.92, p))
    total = lead_in + len(chords) * beats_per_bar * beat + 1.0
    x = np.zeros(int(total * SR))
    for k, (t, d, m) in enumerate(events):
        n = int(d * SR)
        tt = np.arange(n) / SR
        f = librosa.midi_to_hz(m + rng.uniform(-detune, detune)) * \
            2 ** (0.3 * np.sin(2 * np.pi * 5.5 * tt) * np.clip(tt / 0.3, 0, 1) / 12)
        ph = np.cumsum(f) / SR + rng.uniform()
        env = np.clip(tt / 0.04, 0, 1) * np.clip((d - tt) / 0.06, 0, 1)
        s0 = int(t * SR)
        seg = ((2 * (ph % 1) - 1) * env)[:len(x) - s0]
        x[s0:s0 + len(seg)] += seg
    for fc, bw in ((650, 100), (1100, 120), (2500, 160)):
        r = np.exp(-np.pi * bw / SR)
        th = 2 * np.pi * fc / SR
        x = lfilter([1 - r], [1, -2 * r * np.cos(th), r * r], x)
    x = x / np.abs(x).max() * 0.5
    return VocalSong(x, bpm, beats_per_bar, chords, key, lead_in, events)


SONGS = [
    dict(chords=["G", "C", "D", "G", "Em", "C", "D", "G"], key="G", bpm=90),
    dict(chords=["C", "Am", "F", "G", "C", "F", "G", "C"], key="C", bpm=72),
    dict(chords=["D", "G", "A", "D", "Bm", "G", "A", "D"], key="D", bpm=120),
    dict(chords=["Am", "F", "C", "G", "Am", "Dm", "E", "Am"], key="Am", bpm=100),
    dict(chords=["F", "Bb", "C", "F", "Dm", "Bb", "C", "F"], key="F", bpm=80, beats_per_bar=3),
    dict(chords=["E", "A", "B", "E", "C#m", "A", "B", "E"], key="E", bpm=110),
]
