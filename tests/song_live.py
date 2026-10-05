"""실황(라이브) 같은 합성 곡 — 인식 성능을 재는 어려운 시험용.

실제 예배·밴드 녹음에서 어려운 점을 일부러 넣었다.
- 템포가 조금씩 흔들리고(±3%) 뒤로 갈수록 빨라짐 (72 -> 76 BPM), 못갖춘마디(한 박 먼저 시작)
- 보컬: 비브라토, 음 사이 미끄러짐(포르타멘토), 박에서 조금씩 어긋남, 음정이 살짝 높거나 낮음,
  같은 음을 음절마다 다시 부름(같은 높이 연속), 자음 잡음
- 코드: 7화음·sus4·슬래시 코드(A/C#, D/F#), 한 마디에 두 코드
- 피아노: 절은 분산화음(아르페지오), 후렴은 블록 화음 / 베이스: 경과음 / 기타: 후렴 스트로크
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 22050
LEAD_IN = 1.2
KEY = "D"

# 코드: (근음 pc, 성질, 베이스 pc 또는 None, 박 수) — 마디는 4박
D, E, Fs, G, A, B, Cs = 2, 4, 6, 7, 9, 11, 1
VERSE = [
    [(D, "", None, 4)], [(A, "", Cs, 4)], [(B, "m7", None, 4)], [(G, "", None, 4)],
    [(D, "", None, 4)], [(A, "sus4", None, 2), (A, "", None, 2)], [(G, "", None, 4)], [(D, "", None, 4)],
]
CHORUS = [
    [(G, "", None, 4)], [(D, "", Fs, 4)], [(E, "m7", None, 4)], [(A, "", None, 4)],
    [(G, "", None, 4)], [(D, "", Fs, 4)], [(B, "m7", None, 2), (A, "", None, 2)], [(D, "", None, 4)],
]
QUAL = {"": (0, 4, 7), "m": (0, 3, 7), "m7": (0, 3, 7, 10), "7": (0, 4, 7, 10), "sus4": (0, 5, 7),
        "maj7": (0, 4, 7, 11)}
# 멜로디 (시작 박, 길이 박, MIDI) — 4마디 단위, 같은 음 반복(음절) 포함
VERSE_MEL = [(0, 1, 66), (1, 1, 66), (2, 1, 69), (3, 1, 66), (4, 2, 64), (6, 1, 64), (7, 1, 61),
             (8, 1, 62), (9, 1, 62), (10, 0.5, 64), (10.5, 0.5, 66), (11, 1, 62), (12, 3, 59), (15, 1, 62)]
CHORUS_MEL = [(0, 1.5, 71), (1.5, 0.5, 69), (2, 1, 67), (3, 1, 66), (4, 2, 66), (6, 1, 64), (7, 1, 66),
              (8, 1, 67), (9, 1, 67), (10, 1, 69), (11, 1, 71), (12, 2, 69), (14, 1, 66), (15, 1, 69)]
SECTIONS = [("Verse", VERSE, VERSE_MEL), ("Chorus", CHORUS, CHORUS_MEL),
            ("Verse", VERSE, VERSE_MEL), ("Chorus", CHORUS, CHORUS_MEL)]
PICKUP = (-1, 1, 69)  # 곡 시작 한 박 전 못갖춘마디 음 (A)


@dataclass
class Truth:
    beats: list[float] = field(default_factory=list)  # 박 시각 (첫 마디 첫 박 = beats[0])
    notes: dict[str, list[tuple[float, float, int]]] = field(default_factory=dict)  # (시작, 끝, 음)
    chords: list[tuple[int, int, str, int | None]] = field(default_factory=list)  # 박마다 (박, 근음, 성질, 베이스)


def beat_times(n_beats: int, seed: int = 3) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t, out = LEAD_IN + 60 / 72, []
    for k in range(n_beats + 8):
        bpm = 72 + 4 * k / n_beats  # 점점 빨라짐
        wobble = 1 + 0.03 * np.sin(2 * np.pi * k / 13) + rng.normal(0, 0.006)
        out.append(t)
        t += 60 / bpm * wobble
    return np.array(out)


def voice(f0: np.ndarray, amp: np.ndarray, rng) -> np.ndarray:
    """목소리 비슷한 소리: 기본 주파수 곡선 -> 배음 + 모음 포먼트 + 숨소리."""
    phase = 2 * np.pi * np.cumsum(f0) / SR
    y = np.zeros_like(f0)
    for h in range(1, 12):
        fh = f0 * h
        # 모음 'a' 비슷한 포먼트 (700, 1200, 2600 Hz)
        g = sum(a * np.exp(-((fh - fc) / bw) ** 2) for fc, bw, a in ((700, 300, 1.0), (1200, 400, .6),
                                                                      (2600, 500, .25)))
        g += 0.15 / h
        y += g * np.sin(h * phase) * (fh < SR / 2)
    y += 0.02 * rng.standard_normal(len(f0))  # 숨소리
    return (y * amp).astype(np.float32)


def pluck(midi: float, dur: float, bright: float = 0.5, decay: float = 2.5) -> np.ndarray:
    t = np.arange(int(dur * SR)) / SR
    f = 440 * 2 ** ((midi - 69) / 12)
    y = sum((bright ** (k - 1)) / k * np.sin(2 * np.pi * f * k * t * (1 + 0.0004 * k * k)) for k in range(1, 9))
    env = np.minimum(1, t / 0.004) * np.exp(-t * decay) * np.minimum(1, (dur - t) / 0.02)
    return (y * env).astype(np.float32)


def place(buf, start, sig, gain=1.0):
    i = int(start * SR)
    if i < 0:
        sig, i = sig[-i:], 0
    j = min(len(buf), i + len(sig))
    buf[i:j] += gain * sig[: j - i]


def make_live_song(out: Path, bleed: float = 0.03, seed: int = 7) -> tuple[dict[str, Path], Truth]:
    rng = np.random.default_rng(seed)
    bars = sum(len(c) for _, c, _ in SECTIONS)
    bt = beat_times(bars * 4)
    n = int((bt[bars * 4] + 3.0) * SR)
    names = ["vocals", "piano", "guitar", "bass", "drums"]
    stems = {k: np.zeros(n, np.float32) for k in names}
    truth = Truth(beats=[float(x) for x in bt[: bars * 4 + 1]], notes={k: [] for k in names[:-1]})

    def at(beat: float) -> float:  # 박(실수) -> 초 (박 사이는 선형)
        if beat < 0:
            return float(bt[0] + beat * (bt[1] - bt[0]))
        k = int(beat)
        return float(bt[k] + (beat - k) * (bt[k + 1] - bt[k]))

    # ---- 반주
    bar = 0
    for _, chords, _ in SECTIONS:
        chorus = chords is CHORUS
        for chord_bar in chords:
            pos = 0
            for root, q, bass_pc, length in chord_bar:
                b0 = bar * 4 + pos
                for k in range(length):
                    truth.chords.append((b0 + k, root, q, bass_pc))
                tones = [(root + i) % 12 for i in QUAL[q]]
                bass_note = 36 + ((bass_pc if bass_pc is not None else root) - 36) % 12
                if bass_note < 38:
                    bass_note += 12
                # 베이스: 1, 3박 (+ 마디 끝 경과음)
                for h in range(0, length, 2):
                    s, e = at(b0 + h), at(b0 + h + min(2, length - h)) - 0.04
                    place(stems["bass"], s, pluck(bass_note, e - s, 0.35, 1.2), 0.55)
                    truth.notes["bass"].append((s, e, bass_note))
                # 피아노 음 (가운데 C 주변 펼친 화음)
                voicing = sorted({48 + (pc - 48) % 12 + 12 for pc in tones})
                if chorus:  # 블록 화음, 박마다
                    for k in range(length):
                        s, e = at(b0 + k), at(b0 + k + 1) - 0.03
                        for p in voicing:
                            place(stems["piano"], s + rng.normal(0, 0.004), pluck(p, e - s, 0.45, 2.0), 0.16)
                            truth.notes["piano"].append((s, e, p))
                else:  # 분산화음 8분음표
                    arp = voicing + [voicing[1] + 12 if len(voicing) > 1 else voicing[0] + 12]
                    for k in range(length * 2):
                        p = arp[k % len(arp)]
                        s, e = at(b0 + k / 2), at(b0 + k / 2 + 0.5)
                        place(stems["piano"], s + rng.normal(0, 0.006), pluck(p, (e - s) * 1.8, 0.45, 3.0), 0.22)
                        truth.notes["piano"].append((s, e, p))
                # 기타: 후렴에서 8분음표 스트로크 (위 성부 4음)
                if chorus:
                    gv = sorted({55 + (pc - 55) % 12 for pc in tones} | {67 + (tones[0] - 67) % 12})
                    for k in range(length * 2):
                        s, e = at(b0 + k / 2), at(b0 + k / 2 + 0.5)
                        for j, p in enumerate(gv if k % 2 == 0 else gv[::-1]):
                            place(stems["guitar"], s + j * 0.008, pluck(p, (e - s) * 0.95, 0.6, 3.5), 0.09)
                            truth.notes["guitar"].append((s, e, p))
                pos += length
            bar += 1
    # ---- 드럼
    for k in range(bars * 4):
        s = at(k) + rng.normal(0, 0.005)
        tt = np.arange(int(0.18 * SR)) / SR
        if k % 4 in (0, 2):
            kick = np.sin(2 * np.pi * (50 + 60 * np.exp(-tt * 40)) * tt) * np.exp(-tt * 18)
            place(stems["drums"], s, kick.astype(np.float32), 0.9)
        else:
            sn = rng.standard_normal(len(tt)) * np.exp(-tt * 25) + 0.4 * np.sin(2 * np.pi * 190 * tt) * np.exp(-tt * 30)
            place(stems["drums"], s, sn.astype(np.float32), 0.35)
        for e in (0, 0.5):
            hh = np.diff(rng.standard_normal(int(0.04 * SR)), prepend=0) * np.exp(-np.arange(int(0.04 * SR)) / SR * 90)
            place(stems["drums"], at(k + e), hh.astype(np.float32), 0.12)
    # ---- 보컬: 연속된 음높이 곡선으로
    f0 = np.zeros(n)
    amp = np.zeros(n)
    events = [PICKUP]
    bar = 0
    for _, chords, mel in SECTIONS:
        for rep in range(len(chords) // 4):
            events += [(bar * 4 + rep * 16 + sb, lb, p) for sb, lb, p in mel]
        bar += len(chords)
    prev_end, prev_pitch = None, None
    for sb, lb, p in events:
        s = at(sb) + rng.normal(0.01, 0.02)  # 조금 늦게/빠르게
        e = at(sb + lb) - 0.06 + rng.normal(0, 0.015)
        detune = rng.normal(0, 0.12)  # 반음의 ±12% 정도
        i0, i1 = int(s * SR), int(e * SR)
        t = np.arange(i1 - i0) / SR
        vib = 0.35 * np.minimum(1, t / 0.3) * np.sin(2 * np.pi * 5.5 * t)  # 늦게 시작하는 비브라토 (±35 cent)
        pitch = p + detune + vib
        if prev_end is not None and s - prev_end < 0.12 and prev_pitch != p:
            glide = np.minimum(1, t / 0.06)  # 앞 음에서 미끄러져 들어감
            pitch = prev_pitch + (pitch - prev_pitch) * glide
        f0[i0:i1] = 440 * 2 ** ((pitch - 69) / 12)
        env = np.minimum(1, t / 0.04) * np.minimum(1, (e - s - t) / 0.05)
        amp[i0:i1] = 0.3 * env
        # 자음 (짧은 잡음)
        place(stems["vocals"], s - 0.02, (0.05 * rng.standard_normal(int(0.03 * SR))).astype(np.float32))
        truth.notes["vocals"].append((at(sb), at(sb + lb), p))
        prev_end, prev_pitch = e, p
    f0 = np.where(f0 > 0, f0, 200.0)
    stems["vocals"] += voice(f0, amp, rng)

    mix = sum(stems.values())
    out.mkdir(parents=True, exist_ok=True)
    paths = {}
    for k, y in stems.items():
        y = y + bleed * (mix - y)
        paths[k] = out / f"{k}.wav"
        sf.write(paths[k], y, SR)
    return paths, truth
