"""인식 개선 회귀 테스트 — 실황 합성 곡(tests/song_live.py) 기준."""

import importlib.util

import numpy as np
import pytest

from band2sheet.instruments import KICK, SNARE
from band2sheet.project import Note, TimeMap
from tests.song_live import Truth, make_live_song


@pytest.fixture(scope="module")
def live(tmp_path_factory):
    return make_live_song(tmp_path_factory.mktemp("live") / "stems")


def test_tempo_octave_fix():
    from band2sheet.rhythm import fix_tempo_octave

    beat = 60 / 74
    true_beats = [1.0 + i * beat for i in range(64)]
    drums = [Note(t, t + 0.1, KICK if i % 2 == 0 else SNARE) for i, t in enumerate(true_beats)]
    vocals = [Note(t, t + 0.6, 66) for t in true_beats[::1]]
    doubled = sorted(true_beats + [t + beat / 2 for t in true_beats])  # 8분음표에 끌려 2배로 잡힌 비트
    fixed, how = fix_tempo_octave(doubled, {"drums": drums, "vocals": vocals})
    assert how.startswith("half") and abs(np.median(np.diff(fixed)) - beat) < 0.01
    assert min(abs(fixed[0] - t) for t in true_beats) < 0.01  # 올바른 위상
    same, how = fix_tempo_octave(true_beats, {"drums": drums, "vocals": vocals})
    assert how == "x1" and same == true_beats


def test_chords_live(live):
    """분산화음·7화음·sus4·슬래시 코드(A/C#, D/F#)가 섞인 진행."""
    from band2sheet.chords import detect_chords
    from band2sheet.theory import Key

    _, truth = live
    tracks = {k: [Note(s, e, p, 90) for s, e, p in v] for k, v in truth.notes.items()}
    tm = TimeMap(truth.beats)
    ch = detect_chords(tracks, tm, Key.parse("D"), 4, 0)
    root = exact = 0
    for k, r, q, b in truth.chords:
        c = next((c for c in ch if c.start <= k + 0.5 < c.end), None)
        if c and c.root == r:
            root += 1
            exact += c.quality == q and (c.bass if c.bass is not None else r) == (b if b is not None else r)
    assert root / len(truth.chords) >= 0.97
    assert exact / len(truth.chords) >= 0.9


@pytest.mark.slow
@pytest.mark.skipif(importlib.util.find_spec("torchcrepe") is None, reason="torchcrepe 미설치")
def test_vocal_onsets_live(live):
    """비브라토·포르타멘토·음절 반복이 있는 보컬: 음 시작 70ms 안, 음높이 정확."""
    from band2sheet.instruments import INSTRUMENTS
    from band2sheet.transcribe import transcribe_stem
    from tests.evaluate import note_f1

    stems, truth = live
    notes = transcribe_stem(stems["vocals"], INSTRUMENTS["vocals"], log=lambda m: None).notes
    p, r, f = note_f1([(n.start, n.pitch) for n in notes], truth.notes["vocals"], 0.07)
    assert f >= 0.95, (p, r)


def test_truth_shape(live):
    _, truth = live
    assert isinstance(truth, Truth) and len(truth.beats) == 32 * 4 + 1
    assert {q for _, _, q, _ in truth.chords} >= {"", "m7", "sus4"}
