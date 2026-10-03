import importlib.util

import numpy as np
import pytest
import soundfile as sf

from band2sheet.separate import stem_level_db

needs_demucs = pytest.mark.skipif(importlib.util.find_spec("demucs") is None, reason="demucs 미설치")


def test_stem_level_db():
    mix = np.ones(100)
    assert abs(stem_level_db(mix * 0.1, mix) - (-20.0)) < 1e-6


@needs_demucs
@pytest.mark.slow
def test_separate_with_random_model(tmp_path, monkeypatch):
    """가중치 다운로드 없이(무작위 초기화 모델) Demucs 호출 흐름과 출력 파일을 확인."""
    import demucs.pretrained
    from demucs.htdemucs import HTDemucs

    from band2sheet import separate as sep

    sources = ["drums", "bass", "other", "vocals", "guitar", "piano"]
    monkeypatch.setattr(demucs.pretrained, "get_model",
                        lambda name: HTDemucs(sources=sources))
    sr = 44100
    t = np.arange(sr * 2) / sr
    sf.write(tmp_path / "mix.wav", np.stack([np.sin(2 * np.pi * 220 * t)] * 2, axis=1) * 0.3, sr)
    paths = sep.separate(tmp_path / "mix.wav", tmp_path / "stems", device="cpu")
    assert set(paths) == set(sources)
    audio, rate = sf.read(paths["vocals"])
    assert rate == sr and audio.shape[1] == 2 and abs(len(audio) - sr * 2) < 10
