"""반주 없는 노래의 템포·키·코드 추정, 코드 직접 입력, 분석 재사용."""

import numpy as np
import pytest
import soundfile as sf

from band2sheet.harmonize import estimate_tempo, harmonize, track_beats_from_notes
from band2sheet.project import Note
from band2sheet.theory import Key
from tests.vocal_songs import NAMES, SONGS, make_song

SR = 44100


def _notes(song):
    return [Note(t, t + d, m, 80) for t, d, m in song.events]


def _chord_hits(song, spans_names) -> int:
    """마디 가운데 시각에 울리는 코드가 정답과 같은 마디 수."""
    beat = 60 / song.bpm
    ok = 0
    for b, truth in enumerate(song.chords):
        mid = song.lead_in + (b + 0.5) * song.beats_per_bar * beat
        got = next((nm for (t0, t1), nm in spans_names if t0 <= mid < t1), None)
        ok += got == truth
    return ok


@pytest.mark.parametrize("i", range(len(SONGS)))
def test_tempo_key_chords_from_melody_notes(i):
    """정확한 음표가 주어졌을 때(음높이 추적 오차 없이) 멜로디만으로 템포·키·코드."""
    song = make_song(seed=100 + i, **SONGS[i])
    notes = _notes(song)
    bpm = estimate_tempo(notes)
    assert abs(bpm - song.bpm) / song.bpm < 0.04
    duration = len(song.audio) / SR
    beats = track_beats_from_notes(notes, duration, bpm)
    h = harmonize(notes, beats, song.beats_per_bar)
    assert h.key.short_name == song.key
    names = [((t0, t1), NAMES_REV[r] + q) for t0, t1, r, q in h.chords]
    assert _chord_hits(song, names) >= 6


NAMES_REV = {v: k for k, v in NAMES.items() if len(k) == 1 or k in ("C#", "F#", "Bb", "Eb", "Ab")}
NAMES_REV.update({1: "C#", 3: "Eb", 6: "F#", 8: "Ab", 10: "Bb"})


def test_harmonize_with_given_key_and_downbeat():
    song = make_song(seed=5, **SONGS[0])
    notes = _notes(song)
    beats = track_beats_from_notes(notes, len(song.audio) / SR, song.bpm)
    h = harmonize(notes, beats, 4, key=Key.parse("G"))
    assert h.key.short_name == "G" and h.chords
    assert h.chords[-1][2] == 7  # 끝은 으뜸화음


def test_parse_chord_text():
    from band2sheet.remix import parse_chord_text

    assert parse_chord_text("G C D7 Em") == [[(7, "")], [(0, "")], [(2, "7")], [(4, "m")]]
    assert parse_chord_text("G | C D | F#m7 | Bbmaj7 Asus4") == [
        [(7, "")], [(0, ""), (2, "")], [(6, "m7")], [(10, "maj7"), (9, "sus4")]]
    assert parse_chord_text("D/F# N.C. %") == [[(2, "")], [(None, "")], [(None, "")]]
    assert parse_chord_text("G | C %") == [[(7, "")], [(0, ""), (0, "")]]
    assert parse_chord_text("") == []
    with pytest.raises(ValueError, match="H7"):
        parse_chord_text("G H7")


@pytest.mark.slow
def test_vocal_only_recording_analysis(tmp_path):
    """실제 음높이 추적까지 거친 전체 분석 (반주 없는 노래 3곡: G 장조 4/4, A 단조, F 장조 3/4).

    템포·키는 곡마다 정확해야 하고, 코드는 멜로디만으로 헷갈리는 경우(F↔Dm, C↔Am)가 있어 합계로 본다.
    """
    from band2sheet.remix import RemixOptions, analyze_music, prepare

    hits = total = 0
    for i in (0, 3, 4):
        song = make_song(seed=200 + i, **SONGS[i])
        wav = tmp_path / f"song{i}.wav"
        sf.write(wav, song.audio, SR)
        opts = RemixOptions(separate=False, beats_per_bar=song.beats_per_bar)
        prep = prepare(wav, tmp_path / f"an{i}", opts, log=lambda m: None)
        a = analyze_music(prep, opts, log=lambda m: None)
        assert a.vocal_only
        assert abs(a.tempo - song.bpm) / song.bpm < 0.04, (i, a.tempo)
        assert a.key.short_name == song.key, (i, a.key.name)
        assert a.chord_text().count("|") >= 6
        hits += _chord_hits(song, [((c.start, c.end), nm) for c, nm in zip(a.spans, a.names)])
        total += len(song.chords)
    assert hits / total >= 0.65, f"{hits}/{total}"


@pytest.mark.slow
def test_analysis_reused_and_user_chords(tmp_path):
    """같은 파일을 다른 스타일로 다시 만들면 분석을 재사용하고, 직접 넣은 코드를 그대로 쓴다."""
    from band2sheet.remix import RemixOptions, remix

    song = make_song(seed=7, **SONGS[0])
    wav = tmp_path / "song.wav"
    sf.write(wav, song.audio, SR)
    logs = []
    r1 = remix(wav, tmp_path / "out", RemixOptions(separate=False), log=logs.append)
    assert not r1.reused
    text = "G | C | D | G | Em | C | D | G"
    r2 = remix(wav, tmp_path / "out", RemixOptions(separate=False, style="piano", chords=text, bpm=90),
               log=logs.append)
    assert r2.reused and any("다시 사용" in m for m in logs)
    assert r2.chord_text.replace(" ", "") == text.replace(" ", "")
    assert r2.tempo == pytest.approx(90, abs=1)
    assert "코드 진행: 직접 입력한 코드 사용" in r2.notes
    out = tmp_path / "out"
    assert (out / "piano.mid").exists() and not (out / "stems" / "harmony_up.wav").exists()  # 이전 결과 정리
    # 파일이 바뀌면 분석을 새로 한다
    sf.write(wav, np.concatenate([song.audio, np.zeros(SR)]), SR)
    r3 = remix(wav, tmp_path / "out", RemixOptions(separate=False), log=logs.append)
    assert not r3.reused
