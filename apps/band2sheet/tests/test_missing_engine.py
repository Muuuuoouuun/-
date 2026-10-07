"""선택 설치 채보 엔진이 없을 때: 그 악기만 빼고 나머지 악보는 만든다."""

import pytest

from band2sheet import transcribe
from band2sheet.pipeline import AnalyzeOptions, analyze


def _no_engine(*args, **kwargs):
    raise transcribe.MissingEngine("다성 채보에는 basic-pitch 가 필요합니다: pip install basic-pitch")


def test_missing_polyphonic_engine_skips_only_that_part(tmp_path, monkeypatch):
    from tests.synth import make_stems

    make_stems(tmp_path / "stems", bars=2)
    monkeypatch.setattr(transcribe, "basic_pitch_notes", _no_engine)
    logs = []
    project = analyze("", tmp_path / "out", AnalyzeOptions(stems_dir=tmp_path / "stems", stems=["vocals", "piano"],
                                                           beat_engine="librosa"), logs.append)
    assert set(project.tracks) == {"vocals"}
    assert any("건너뜀" in m and "basic-pitch" in m for m in logs)


def test_missing_engine_for_every_part_is_an_error(tmp_path, monkeypatch):
    from tests.synth import make_stems

    make_stems(tmp_path / "stems", bars=2)
    monkeypatch.setattr(transcribe, "basic_pitch_notes", _no_engine)
    with pytest.raises(transcribe.MissingEngine):
        analyze("", tmp_path / "out", AnalyzeOptions(stems_dir=tmp_path / "stems", stems=["piano"],
                                                     beat_engine="librosa"), lambda m: None)
