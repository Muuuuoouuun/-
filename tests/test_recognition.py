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


# ---------------------------------------------------------------------------
# 변환: MIDI / MusicXML 입력, ChordPro
# ---------------------------------------------------------------------------

def _demo_midi(path, named_vocals=False):
    import pretty_midi

    from tests.song import LEAD_IN, truth_notes

    pm = pretty_midi.PrettyMIDI(initial_tempo=100)
    pm.time_signature_changes.append(pretty_midi.TimeSignature(4, 4, 0))
    for stem, name, prog in (("vocals", "Lead Vocal" if named_vocals else "", 73), ("piano", "Piano", 0),
                             ("bass", "", 33)):
        inst = pretty_midi.Instrument(program=prog, name=name)
        for t, p, d in truth_notes(stem):
            inst.notes.append(pretty_midi.Note(90, p, t - LEAD_IN, t - LEAD_IN + d))
        pm.instruments.append(inst)
    pm.lyrics.append(pretty_midi.Lyric("Lord", 9.6))
    pm.write(str(path))
    return path


def test_midi_import(tmp_path):
    from band2sheet.importer import import_symbolic, stem_for

    assert stem_for("Lead Vocal", 0, False) == "vocals" and stem_for("", 33, False) == "bass"
    assert stem_for("코러스", 0, False) == "backing_vocals" and stem_for("", 0, True) == "drums"
    p = import_symbolic(_demo_midi(tmp_path / "s.mid"), tmp_path / "out", log=lambda m: None)
    assert set(p.tracks) == {"vocals", "piano", "bass"}  # 이름 없는 멜로디 트랙 -> 보컬
    assert len(p.tracks["vocals"].notes) == 126 and p.tracks["vocals"].lyrics[0].text == "Lord"
    assert abs(p.tempo_bpm - 100) < 1 and p.key.short_name == "G"
    assert [(b, k.short_name) for b, k in p.key_changes] == [(144.0, "Ab")]  # 마지막 후렴 전조


def test_convert_and_chordpro(tmp_path):
    from band2sheet.pipeline import AnalyzeOptions, RenderOptions, render, run

    res = run(str(_demo_midi(tmp_path / "s.mid", True)), tmp_path / "out", AnalyzeOptions(),
              RenderOptions(target_key="A"), log=lambda m: None)
    pro = (res.out_dir / "song.chordpro").read_text(encoding="utf-8")
    assert "{key: A}" in pro and "{start_of_chorus: Chorus 1}" in pro and "{key: Bb}" in pro
    assert "[A]Lord" in pro

    # 만든 리드시트(MusicXML)를 다시 넣으면: 박 사선은 음표가 아니고, 코드 기호를 그대로 가져온다
    from band2sheet.importer import import_symbolic

    p2 = import_symbolic(res.out_dir / "lead_sheet.musicxml", tmp_path / "xml", log=lambda m: None)
    assert len(p2.tracks["vocals"].notes) == 126
    assert p2.chords and p2.engines.get("chords") == "악보의 코드 기호"
    res2 = render(p2, tmp_path / "xml", RenderOptions(), log=lambda m: None)
    assert res2.key.short_name == "A" and "Key: Bb" in res2.chord_chart
