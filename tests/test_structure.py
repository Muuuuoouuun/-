"""분리 정리(활동 구간·블리딩), 셋잇단, 전조, 곡 구조, 못갖춘마디, 내슈빌 넘버, PDF 테스트."""

import importlib.util

import numpy as np
import pytest

from band2sheet.chords import detect_chords
from band2sheet.pipeline import RenderOptions, bar_pitch_hists, render
from band2sheet.project import Note, TimeMap
from band2sheet.score import Grid, mono_events
from band2sheet.sections import detect_sections
from band2sheet.theory import key_segments
from band2sheet.transcribe import merge_fragments
from tests.song import truth_project


@pytest.fixture(scope="module")
def project():
    p = truth_project()
    segs = key_segments(bar_pitch_hists(p.tracks, TimeMap(p.beat_times), 0, 4))
    p.key = segs[0][1]
    p.key_changes = [(float(b * 4), k) for b, k in segs[1:]]
    return p


def test_key_change_detected(project):
    assert project.key.short_name == "G"
    assert [(b, k.short_name) for b, k in project.key_changes] == [(144.0, "Ab")]  # 37마디


def test_sections(project):
    ch = detect_chords({k: t.notes for k, t in project.tracks.items()}, TimeMap(project.beat_times),
                       project.key, 4, 0, key_at=project.key_at_beat)
    secs = detect_sections(project, ch, 44)
    assert [(s.start_bar, s.name) for s in secs] == [
        (0, "Intro"), (4, "Verse 1"), (12, "Chorus 1"), (20, "Verse 2"), (28, "Chorus 2"), (36, "Chorus 3")]


def test_triplets_quantized(project):
    grid = Grid.for_project(project)
    ev = mono_events(project.tracks["vocals"].notes, grid)
    thirds = [e for e in ev if abs(e.dur - 1 / 3) < 1e-6]
    assert len(thirds) == 18  # 후렴 6번 x 셋잇단 3음


def test_render_structure(project, tmp_path):
    res = render(project, tmp_path, RenderOptions(stems=["vocals", "bass"]), log=lambda m: None)
    assert res.key_changes == [{"bar": 37, "key": "Ab major", "key_short": "Ab"}]
    assert "[Chorus 3]  ▶ Key: Ab" in res.chord_chart
    chorus3 = res.chord_chart.split("[Chorus 3]")[1]
    assert "Db" in chorus3 and "Fm" in chorus3 and "C#" not in chorus3
    # 내슈빌 넘버: 전조해도 후렴은 같은 숫자
    n = res.nashville_chart
    first_line = lambda sec: n.split(f"[{sec}]")[1].split("\n")[1].split("|", 1)[1]  # noqa: E731
    assert first_line("Chorus 1") == first_line("Chorus 3")
    xml = (res.out_dir / "lead_sheet.musicxml").read_text(encoding="utf-8")
    assert "<fifths>-4</fifths>" in xml and "<rehearsal" in xml and "<tuplet" in xml
    assert "Chorus 3" in xml

    # 조옮김하면 전조 구간도 함께 이동 (G->A 이면 Ab->Bb)
    res2 = render(project, tmp_path, RenderOptions(target_key="A", stems=["bass"]), log=lambda m: None)
    assert res2.key_changes[0]["key_short"] == "Bb"


def test_pickup_measure(project, tmp_path):
    from music21 import converter

    p = truth_project()
    t0, per = p.beat_times[0], p.beat_times[1] - p.beat_times[0]
    p.tracks["vocals"].notes = [Note(t0 - 2 * per, t0 - 1.05 * per, 62, 90),
                                Note(t0 - per, t0 - 0.05 * per, 64, 90)] + p.tracks["vocals"].notes
    res = render(p, tmp_path, RenderOptions(stems=["vocals", "bass"]), log=lambda m: None)
    assert res.pickup_ql == 2.0
    score = converter.parse(str(res.out_dir / "full_score.musicxml"))
    first = score.parts[0].getElementsByClass("Measure").first()
    assert first.number == 0 and first.duration.quarterLength == 2.0
    assert [n.pitch.name for n in first.notes] == ["D", "E"]


def test_restrike_not_merged():
    a = [Note(0.0, 0.3, 60, 80), Note(0.3, 0.6, 60, 82)]  # 같은 음을 다시 침
    assert len(merge_fragments(a, restrike=0.7)) == 2
    b = [Note(0.0, 0.3, 60, 80), Note(0.31, 0.6, 60, 30)]  # 약하게 이어진 조각
    assert len(merge_fragments(b, restrike=0.7)) == 1
    assert len(merge_fragments(a)) == 1  # 단선율 엔진은 조각을 합친다


@pytest.mark.slow
def test_separation_cleanup(tmp_path):
    from band2sheet.cleanup import SeparationAnalyzer, remove_ghosts
    from tests.song import make_song

    stems = make_song(tmp_path / "stems")
    sa = SeparationAnalyzer(stems)
    guitar = sa.analyze("guitar").report()
    # 기타는 후렴(약 29~49초, 67초~끝)에서만 연주
    iv = guitar["intervals"]
    assert len(iv) == 2 and abs(iv[0][0] - 29.3) < 1.0 and abs(iv[1][0] - 67.7) < 1.0
    assert -33 < guitar["bleed_db"] < -24  # 실제 블리딩 -28 dB
    assert sa.analyze("piano").report()["active_ratio"] > 0.95

    # 절(기타가 쉬는 곳)에 생긴 가짜 음표는 지우고, 후렴의 진짜 음표는 남긴다
    fake = Note(15.0, 15.3, 60, 70)
    real = Note(29.32, 29.6, 67, 80)
    kept, removed = sa.verify_notes("guitar", [fake, real])
    assert kept == [real] and removed == 1
    # 옥타브 아래 유령음 (기본음 주파수에 에너지 없음)
    ghost = Note(29.32, 29.6, 55, 60)
    kept, removed = remove_ghosts(sa, "guitar", [real, ghost])
    assert kept == [real] and removed == 1


@pytest.mark.skipif(any(importlib.util.find_spec(m) is None for m in ("verovio", "cairosvg", "pypdf")),
                    reason="verovio/cairosvg/pypdf 미설치")
def test_pdf_export(project, tmp_path):
    res = render(project, tmp_path, RenderOptions(stems=["vocals"], pdf=True), log=lambda m: None)
    pdf = res.out_dir / "lead_sheet.pdf"
    assert pdf.exists() and pdf.read_bytes()[:4] == b"%PDF"


def test_activity_mask_cleanup():
    from band2sheet.cleanup import _clean_mask

    m = np.array([0, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 0], dtype=bool)
    out = _clean_mask(m, fill=1, min_len=3)
    assert out.tolist() == [False, True, True, True, True, True, True] + [False] * 6


def test_render_layout(project, tmp_path):
    """보기 좋은 악보: 4마디 줄바꿈, 리드시트 사선, 여러 마디 쉼표, 구간별 셈여림."""
    import re

    res = render(project, tmp_path, RenderOptions(stems=["vocals", "guitar"]), log=lambda m: None)
    lead = (res.out_dir / "lead_sheet.musicxml").read_text(encoding="utf-8")
    # 줄바꿈은 구간 시작(5, 13, 21 …)과 구간 안 4마디마다
    first_part = lead.split("</part>")[0]
    breaks = [int(n) for n in re.findall(r'<measure[^>]*number="(\d+)"[^>]*>\s*<print new-system="yes"', first_part)]
    assert breaks[:4] == [5, 9, 13, 17]
    # 멜로디가 쉬는 전주는 코드 사선으로
    intro = first_part.split('number="5"')[0]
    assert intro.count(">slash</notehead>") >= 12
    # 기타는 후렴에서만 연주 -> 절(8마디)은 여러 마디 쉼표로 묶임
    guitar = (res.out_dir / "guitar.musicxml").read_text(encoding="utf-8")
    rests = [int(n) for n in re.findall(r"<multiple-rest>(\d+)</multiple-rest>", guitar)]
    assert rests and max(rests) >= 4
    # 셈여림은 마디마다가 아니라 구간 단위 (6구간 이하)
    vocals = (res.out_dir / "vocals.musicxml").read_text(encoding="utf-8")
    assert 1 <= vocals.count("<dynamics") <= 6


def test_pdf_text_glyphs():
    import re

    from band2sheet.pipeline import _smufl_text

    sub = lambda s: re.sub(r'<tspan font-family="Leipzig" font-size="(\d+)px">([^<]*)</tspan>',  # noqa: E731
                           _smufl_text, s)
    assert sub('<tspan font-family="Leipzig" font-size="720px"></tspan>') == \
        '<tspan font-size="405px">♯</tspan>'
    keep = '<tspan font-family="Leipzig" font-size="720px"></tspan>'
    assert sub(keep) == keep
