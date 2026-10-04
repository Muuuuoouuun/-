from pathlib import Path

import pytest

from band2sheet.cli import main
from band2sheet.separate import load_stems_dir

HERE = Path(__file__).parent


def test_keys_command(capsys):
    assert main(["keys", "G", "-k", "Bb"]) == 0
    assert "+3" in capsys.readouterr().out


def test_stems_dir_aliases(tmp_path):
    for name in ("01_Lead Vocal.wav", "BGV.wav", "Kick+Snare drums.wav", "BassDI.wav", "Keys.wav",
                 "notes.txt"):
        (tmp_path / name).write_bytes(b"")
    found = load_stems_dir(tmp_path)
    assert set(found.stems) == {"vocals", "backing_vocals", "drums", "bass", "piano"}


def test_stems_dir_drum_multitrack(tmp_path):
    import numpy as np
    import soundfile as sf

    for name in ("Kick In.wav", "Snare Top.wav", "HiHat.wav", "Tom 1.wav", "Tom 2.wav", "Floor Tom.wav",
                 "Vox.wav"):
        sf.write(tmp_path / name, np.zeros(1000), 22050)
    found = load_stems_dir(tmp_path, tmp_path / "work")
    assert set(found.drum_parts) == {"kick", "snare", "hh", "tom1", "tom2", "floor"}
    assert "drums" in found.stems and "vocals" in found.stems


def test_xml_transpose(tmp_path):
    from band2sheet.pipeline import RenderOptions, render
    from tests.test_score import make_project

    res = render(make_project(), tmp_path, RenderOptions(stems=["vocals"]), log=lambda m: None)
    src = res.out_dir / "vocals.musicxml"
    assert main(["transpose", str(src), "-k", "Eb", "-o", str(tmp_path / "x")]) == 0
    from music21 import converter

    out = converter.parse(str(tmp_path / "x" / "vocals_Eb.musicxml"))
    assert out.recurse().getElementsByClass("KeySignature").first().sharps == -3
    assert out.recurse().getElementsByClass("Note").first().pitch.name == "E-"


@pytest.mark.slow
def test_end_to_end_synthetic(tmp_path):
    """합성 음원(G장조 G-D-Em-C)으로 분석~렌더링 전체 흐름 확인 (pYIN 엔진만 사용)."""
    from tests.synth import make_stems

    stems = tmp_path / "stems"
    make_stems(stems)
    out = tmp_path / "out"
    code = main(["run", "--stems-dir", str(stems), "-o", str(out), "--stems", "vocals,bass,drums"])
    assert code == 0
    from band2sheet.project import Project

    p = Project.load(out / "project.json")
    assert p.key.short_name == "G"
    assert 95 <= p.tempo_bpm <= 105
    bass = [n.pitch for n in p.tracks["bass"].notes]
    assert bass[:8] == [43, 43, 38, 38, 40, 40, 36, 36]
    chart = (out / "sheets_G" / "chords.txt").read_text(encoding="utf-8")
    # 베이스+보컬만으로도 근음 진행은 잡혀야 한다
    assert "G" in chart and "D" in chart
