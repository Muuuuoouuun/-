"""구조가 있는 합성 곡 (분리·악보 고도화 검증용).

전주(4) - 절(8) - 후렴(8) - 절(8) - 후렴(8) - 마지막 후렴 반음 위(8) = 44마디, 100 BPM, G장조 -> Ab장조.
- 기타·코러스는 후렴에서만 연주 (악기 활동 구간 검증)
- 후렴 멜로디에 셋잇단 8분음표 (셋잇단 양자화 검증)
- 각 스템에 다른 악기 소리가 조금씩 새어 들어감 (블리딩 정리 검증)
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

from tests.synth import BEAT, SR, bandpass, place, tone

LEAD_IN = 0.5
VERSE_CHORDS = [(43, [55, 59, 62]), (38, [54, 57, 62]), (40, [55, 59, 64]), (36, [55, 60, 64])]  # G D Em C
CHORUS_CHORDS = [(36, [55, 60, 64]), (43, [55, 59, 62]), (38, [54, 57, 62]), (40, [55, 59, 64])]  # C G D Em
# (시작 박, 길이 박, 음) — 4마디 단위 멜로디
VERSE_MELODY = [(0, 1, 67), (1, 1, 71), (2, 2, 74), (4, 1, 74), (5, 1, 72), (6, 2, 71),
                (8, 1, 71), (9, 1, 67), (10, 2, 64), (12, 1, 64), (13, 1, 67), (14, 2, 72)]
CHORUS_MELODY = [(0, 2, 76), (2, 1 / 3, 74), (2 + 1 / 3, 1 / 3, 72), (2 + 2 / 3, 1 / 3, 71), (3, 1, 72),
                 (4, 2, 74), (6, 2, 71), (8, 1, 74), (9, 1, 76), (10, 2, 78),
                 (12, 1, 79), (13, 1, 78), (14, 2, 79)]

SECTIONS = [  # (이름, 마디 수, 종류, 반음 이동)
    ("Intro", 4, "intro", 0), ("Verse", 8, "verse", 0), ("Chorus", 8, "chorus", 0),
    ("Verse", 8, "verse", 0), ("Chorus", 8, "chorus", 0), ("Chorus", 8, "chorus", 1),
]


def section_starts() -> list[tuple[int, str, int]]:
    """(시작 마디 번호(0부터), 이름, 반음 이동)."""
    out, bar = [], 0
    for name, n, _, shift in SECTIONS:
        out.append((bar, name, shift))
        bar += n
    return out


def make_song(out: Path, bleed: float = 0.04) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    total_bars = sum(n for _, n, _, _ in SECTIONS)
    n = int((LEAD_IN + total_bars * 4 * BEAT + 2.0) * SR)
    names = ["vocals", "backing_vocals", "guitar", "piano", "bass", "drums"]
    stems = {k: np.zeros(n, np.float32) for k in names}
    rng = np.random.default_rng(1)
    bar = 0
    for _, n_bars, kind, shift in SECTIONS:
        chords = CHORUS_CHORDS if kind == "chorus" else VERSE_CHORDS
        melody = CHORUS_MELODY if kind == "chorus" else VERSE_MELODY
        for b in range(n_bars):
            t0 = LEAD_IN + (bar + b) * 4 * BEAT
            root, chord = chords[b % 4]
            for h in range(2):
                place(stems["bass"], t0 + h * 2 * BEAT, tone(root + shift, 2 * BEAT * 0.95, (1, .6, .3)), .5)
            for k in range(4):
                for p in chord:
                    place(stems["piano"], t0 + k * BEAT, tone(p + shift, BEAT * .9, (1, .3), decay=2.0), .22)
            if kind == "chorus":
                for k in range(8):  # 기타 8분 스트로크 (화음 위쪽 3음)
                    for p in chord:
                        place(stems["guitar"], t0 + k * BEAT / 2,
                              tone(p + 12 + shift, BEAT / 2 * .9, (1, .5, .25), decay=3), .12)
            for k in range(4):  # 드럼
                tb = t0 + k * BEAT
                if k in (0, 2):
                    place(stems["drums"], tb, tone(36, .15, (1,), decay=25) + tone(28, .15, (1,), decay=25), .9)
                else:
                    s = bandpass(rng.standard_normal(int(.12 * SR)), 300, 4000)
                    s *= np.exp(-np.arange(len(s)) / SR * 30)
                    place(stems["drums"], tb, s + tone(55, .12, (1,), decay=30), .5)
                for e in range(2):
                    hh = bandpass(rng.standard_normal(int(.04 * SR)), 7000, SR / 2)
                    hh *= np.exp(-np.arange(len(hh)) / SR * 80)
                    place(stems["drums"], tb + e * BEAT / 2, hh, .3)
        if kind != "intro":
            for rep in range(n_bars // 4):
                for sb, lb, p in melody:
                    t = LEAD_IN + (bar + rep * 4) * 4 * BEAT + sb * BEAT
                    place(stems["vocals"], t, tone(p + shift, lb * BEAT * .92, (1, .4, .2)), .4)
                    if kind == "chorus":
                        place(stems["backing_vocals"], t, tone(p - 4 + shift, lb * BEAT * .92, (1, .4, .2)), .25)
        bar += n_bars
    # 블리딩: 각 스템에 다른 악기 소리가 조금씩 섞임 (실제 분리 결과처럼)
    mix = sum(stems.values())
    paths = {}
    for k, y in stems.items():
        y = y + bleed * (mix - y)
        paths[k] = out / f"{k}.wav"
        sf.write(paths[k], y, SR)
    return paths


def truth_notes(stem: str):
    """곡 정의에서 정답 음표 목록 (시작 초, MIDI)."""
    from tests.synth import BEAT as _BEAT

    out, bar = [], 0
    for _, n_bars, kind, shift in SECTIONS:
        chords = CHORUS_CHORDS if kind == "chorus" else VERSE_CHORDS
        mel = CHORUS_MELODY if kind == "chorus" else VERSE_MELODY
        for b in range(n_bars):
            t0 = LEAD_IN + (bar + b) * 4 * _BEAT
            root, ch = chords[b % 4]
            if stem == "piano":
                out += [(t0 + k * _BEAT, p + shift, _BEAT * .9) for k in range(4) for p in ch]
            if stem == "guitar" and kind == "chorus":
                out += [(t0 + k * _BEAT / 2, p + 12 + shift, _BEAT / 2 * .9) for k in range(8) for p in ch]
            if stem == "bass":
                out += [(t0 + h * 2 * _BEAT, root + shift, 2 * _BEAT * .95) for h in range(2)]
        if kind != "intro" and stem in ("vocals", "backing_vocals"):
            if not (stem == "backing_vocals" and kind != "chorus"):
                for rep in range(n_bars // 4):
                    for sb, lb, p in mel:
                        out.append((LEAD_IN + (bar + rep * 4) * 4 * _BEAT + sb * _BEAT,
                                    p + shift - (4 if stem == "backing_vocals" else 0), lb * _BEAT * .92))
        bar += n_bars
    return out


def truth_project():
    """정답 음표로 만든 Project (오디오 없이 악보 단계 테스트용)."""
    from band2sheet.project import Note, Project, Track
    from band2sheet.theory import Key
    from tests.synth import BEAT as _BEAT

    total_bars = sum(n for _, n, _, _ in SECTIONS)
    beats = [LEAD_IN + i * _BEAT for i in range(total_bars * 4 + 4)]
    tracks = {}
    for stem in ("vocals", "backing_vocals", "guitar", "piano", "bass"):
        tracks[stem] = Track(stem, [Note(t, t + d, p, 90) for t, p, d in truth_notes(stem)])
    return Project(title="구조 테스트", source="", beat_times=beats, key=Key.parse("G"), tracks=tracks)
