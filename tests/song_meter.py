"""박자표 인식 시험용 합성 곡: 3/4 왈츠, 6/8 발라드 (+ 비교용 4/4).

- 3/4: 1박 베이스, 2·3박 화음(쿵-짝-짝), 킥 1박 / 스네어 2·3박, 4분·2분음표 멜로디
- 6/8: 한 박 = 점4분음표(8분음표 3개). 피아노 8분음표 분산화음, 베이스 1·4번째 8분음표,
  킥 1, 스네어 4, 멜로디는 8분·4분·점4분음표 (셋잇단 느낌)
템포는 조금씩 흔들린다. 정답(박·마디 첫 박·코드·음표)을 함께 돌려준다.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from tests.song_live import SR, Truth, pluck, place, voice

# 마디마다 코드 (근음 pc, 성질) — G C D G / Em C D G
PROG = [(7, ""), (0, ""), (2, ""), (7, ""), (4, "m"), (0, ""), (2, ""), (7, "")]
QUAL = {"": (0, 4, 7), "m": (0, 3, 7)}


def make_meter_song(out: Path, meter: str = "3/4", bars: int = 24, seed: int = 5) -> tuple[dict[str, Path], Truth, dict]:
    """meter: '3/4' | '6/8' | '4/4'. 반환: (스템 경로, 정답, 정보)."""
    rng = np.random.default_rng(seed)
    if meter == "6/8":
        beats_per_bar, bpm = 2, 58.0  # 박 = 점4분, 한 박에 8분음표 3개
    elif meter == "3/4":
        beats_per_bar, bpm = 3, 96.0
    else:
        beats_per_bar, bpm = 4, 92.0
    n_beats = bars * beats_per_bar
    lead = 1.0
    bt, t = [], lead
    for k in range(n_beats + 4):
        bt.append(t)
        t += 60 / bpm * (1 + 0.025 * np.sin(2 * np.pi * k / 11) + rng.normal(0, 0.005))
    bt = np.array(bt)

    def at(beat: float) -> float:
        k = int(np.floor(beat))
        return float(bt[k] + (beat - k) * (bt[k + 1] - bt[k]))

    n = int((bt[n_beats] + 3) * SR)
    stems = {k: np.zeros(n, np.float32) for k in ("vocals", "piano", "bass", "drums")}
    truth = Truth(beats=[float(x) for x in bt[: n_beats + 1]], notes={k: [] for k in ("vocals", "piano", "bass")})
    melody_rng = np.random.default_rng(seed + 1)
    f0, amp = np.zeros(n), np.zeros(n)

    for bar in range(bars):
        root, q = PROG[bar % len(PROG)]
        tones = [(root + i) % 12 for i in QUAL[q]]
        b0 = bar * beats_per_bar
        for k in range(beats_per_bar):
            truth.chords.append((b0 + k, root, q, None))
        bass_note = 40 + (root - 40) % 12
        voicing = sorted(55 + (pc - 55) % 12 for pc in tones)
        tt = np.arange(int(0.18 * SR)) / SR
        kick = (np.sin(2 * np.pi * (50 + 60 * np.exp(-tt * 40)) * tt) * np.exp(-tt * 18)).astype(np.float32)
        snare = (rng.standard_normal(len(tt)) * np.exp(-tt * 25)).astype(np.float32)
        if meter == "3/4":
            s, e = at(b0), at(b0 + 3) - 0.05
            place(stems["bass"], s, pluck(bass_note, e - s, 0.35, 1.0), 0.55)
            truth.notes["bass"].append((s, e, bass_note))
            for k in (1, 2):
                s, e = at(b0 + k), at(b0 + k + 1) - 0.05
                for p in voicing:
                    place(stems["piano"], s, pluck(p, e - s, 0.45, 3.0), 0.16)
                    truth.notes["piano"].append((s, e, p))
            place(stems["drums"], at(b0), kick, 0.9)
            for k in (1, 2):
                place(stems["drums"], at(b0 + k), snare, 0.25)
        elif meter == "6/8":
            arp = voicing + [voicing[1] + 12, voicing[2], voicing[1]]
            for j in range(6):
                pos = b0 + j / 3
                s, e = at(pos), at(pos + 1 / 3)
                p = arp[j % len(arp)]
                place(stems["piano"], s, pluck(p, (e - s) * 2.0, 0.45, 3.0), 0.2)
                truth.notes["piano"].append((s, e, p))
            for k in (0, 1):
                s, e = at(b0 + k), at(b0 + k + 1) - 0.05
                bn = bass_note if k == 0 else bass_note + 7 - (12 if bass_note + 7 > 52 else 0)
                place(stems["bass"], s, pluck(bn, e - s, 0.35, 1.2), 0.55)
                truth.notes["bass"].append((s, e, bn))
            place(stems["drums"], at(b0), kick, 0.9)
            place(stems["drums"], at(b0 + 1), snare, 0.4)
            for j in range(6):
                hh = np.diff(rng.standard_normal(int(0.04 * SR)), prepend=0) * np.exp(-np.arange(int(0.04 * SR)) / SR * 90)
                place(stems["drums"], at(b0 + j / 3), hh.astype(np.float32), 0.1)
        else:
            for h in (0, 2):
                s, e = at(b0 + h), at(b0 + h + 2) - 0.05
                place(stems["bass"], s, pluck(bass_note, e - s, 0.35, 1.0), 0.55)
                truth.notes["bass"].append((s, e, bass_note))
            for k in range(4):
                s, e = at(b0 + k), at(b0 + k + 1) - 0.05
                for p in voicing:
                    place(stems["piano"], s, pluck(p, e - s, 0.45, 3.0), 0.16)
                    truth.notes["piano"].append((s, e, p))
                place(stems["drums"], at(b0 + k), kick if k % 2 == 0 else snare, 0.9 if k % 2 == 0 else 0.35)
        # 멜로디: 마디 안 리듬 패턴 (박 단위), 코드 음 + 경과음
        if meter == "3/4":
            rhythm = [[(0, 2), (2, 1)], [(0, 1), (1, 1), (2, 1)], [(0, 3)]][bar % 3]
        elif meter == "6/8":
            rhythm = [[(0, 2 / 3), (2 / 3, 1 / 3), (1, 1)], [(0, 1 / 3), (1 / 3, 1 / 3), (2 / 3, 1 / 3), (1, 1)],
                      [(0, 2)]][bar % 3]
        else:
            rhythm = [[(0, 1), (1, 1), (2, 2)], [(0, 2), (2, 1), (3, 1)]][bar % 2]
        scale = [62, 64, 66, 67, 69, 71, 72, 74]
        for sb, lb in rhythm:
            if sb == 0:
                p = 67 + (tones[melody_rng.integers(0, 3)] - 67) % 12
            else:
                p = int(melody_rng.choice(scale))
            s, e = at(b0 + sb), at(b0 + sb + lb) - 0.05
            i0, i1 = int(s * SR), int(e * SR)
            tt2 = np.arange(i1 - i0) / SR
            f0[i0:i1] = 440 * 2 ** ((p + 0.2 * np.minimum(1, tt2 / 0.3) * np.sin(2 * np.pi * 5.5 * tt2) - 69) / 12)
            amp[i0:i1] = 0.3 * np.minimum(1, tt2 / 0.03) * np.minimum(1, (e - s - tt2) / 0.04)
            truth.notes["vocals"].append((s, e, p))
    stems["vocals"] += voice(np.where(f0 > 0, f0, 200.0), amp, rng)
    mix = sum(stems.values())
    out.mkdir(parents=True, exist_ok=True)
    paths = {}
    for k, y in stems.items():
        y = y + 0.03 * (mix - y)
        paths[k] = out / f"{k}.wav"
        sf.write(paths[k], y, SR)
    return paths, truth, {"meter": meter, "beats_per_bar": beats_per_bar, "bpm": bpm}
