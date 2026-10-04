"""앱 자체 화면 데이터(build_view)와 코드·가사·음표 수정 테스트."""

import pytest

from band2sheet.pipeline import RenderOptions, render
from band2sheet.view import build_view, parse_chord, set_bar_lyrics, set_chord, set_track_notes
from tests.song import truth_project


@pytest.fixture()
def project():
    return truth_project()


def chords_of(view, bar):
    return [(c["beat"], c["name"]) for c in view["bars"][bar]["chords"] if not c["held"]]


@pytest.mark.parametrize("text,expected", [
    ("G", (7, "", None)), ("F#m7", (6, "m7", None)), ("D/F#", (2, "", 6)), ("Bbmaj7", (10, "maj7", None)),
    ("Ebsus4", (3, "sus4", None)), ("C#m7b5", (1, "m7b5", None)), ("N.C.", (None, "", None)), ("", (None, "", None)),
    ("AM7", (9, "maj7", None)),
])
def test_parse_chord(text, expected):
    assert parse_chord(text) == expected


def test_parse_chord_rejects_unknown():
    with pytest.raises(ValueError):
        parse_chord("Gxyz")


def test_build_view_basics(project):
    v = build_view(project)
    assert v["key_short"] == "G" and v["semitones"] == 0
    assert len(v["bars"]) >= 44
    assert [s["name"] for s in v["sections"]][:3] == ["Intro", "Verse 1", "Chorus 1"]
    assert chords_of(v, 0) == [(0.0, "G")] and chords_of(v, 13) == [(0.0, "G")]
    assert v["bars"][12]["chords"][0]["held"] and v["bars"][12]["chords"][0]["name"] == "C"
    starts = [b["start"] for b in v["bars"]]
    assert starts == sorted(starts)
    assert v["tracks"]["bass"]["kind"] == "pitched" and v["tracks"]["bass"]["tab"] == [28, 33, 38, 43]
    a = build_view(project, semitones=2)
    assert a["key_short"] == "A" and chords_of(a, 0) == [(0.0, "A")]
    assert a["tracks"]["bass"]["notes"][0][2] == project.tracks["bass"].notes[0].pitch + 2
    assert chords_of(a, 0)[0][1] == "A" and a["bars"][0]["chords"][0]["number"] == "1"


def test_edit_chord_in_transposed_view(project):
    # A 키 화면에서 2마디 3박부터 Bm 으로 고치면 원래 키(G)로는 Am 으로 저장
    set_chord(project, 1 * 4 + 2, "Bm", semitones=2)
    g = build_view(project)
    assert chords_of(g, 1) == [(0.0, "D"), (2.0, "Am")]
    assert chords_of(build_view(project, semitones=2), 1) == [(0.0, "E"), (2.0, "Bm")]
    # 지우면 앞 코드(D)가 마디 끝까지 이어짐
    set_chord(project, 1 * 4 + 2, "")
    assert chords_of(build_view(project), 1) == [(0.0, "D")]


def test_edit_chord_render(project, tmp_path):
    set_chord(project, 0, "Gmaj7")
    res = render(project, tmp_path, RenderOptions(stems=["bass"]), log=lambda m: None)
    assert "Gmaj7" in res.chord_chart.split("[Intro]")[1].split("\n")[1]


def test_bar_lyrics(project, tmp_path):
    set_bar_lyrics(project, 4, "주님의 사랑")
    v = build_view(project)
    assert v["bars"][4]["lyrics"] == "주님의 사랑" and v["bars"][4]["lyrics_edited"]
    res = render(project, tmp_path, RenderOptions(stems=["bass"]), log=lambda m: None)
    assert "주님의 사랑" in res.chord_chart
    set_bar_lyrics(project, 4, "")
    assert build_view(project)["bars"][4]["lyrics"] == ""


def test_edit_notes(project):
    first = project.tracks["bass"].notes[0]
    rows = [[first.start, first.end, first.pitch + 2 + 1, 100]]  # A 키 화면에서 반음 올림
    set_track_notes(project, "bass", rows, semitones=2)
    assert [(n.pitch, n.velocity) for n in project.tracks["bass"].notes] == [(first.pitch + 1, 100)]
    with pytest.raises(KeyError):
        set_track_notes(project, "trumpet", [], 0)
