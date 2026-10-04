"""듣기용 음원: 키 옮기기(드럼 제외), 반주(MR) = 원곡 - 보컬, 악보 소리."""

import shutil

import numpy as np
import pytest
import soundfile as sf

from band2sheet.playback import SR, build_tracks, profile_for

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg 필요")


def _tone(hz, sec=2.0, amp=0.2):
    t = np.arange(int(SR * sec)) / SR
    y = (amp * np.sin(2 * np.pi * hz * t)).astype(np.float32)
    return np.stack([y, y], 1)


def _f0(y):
    spec = np.abs(np.fft.rfft(y[SR // 2:SR // 2 + SR, 0] * np.hanning(SR)))
    return np.fft.rfftfreq(SR, 1 / SR)[np.argmax(spec)]


@pytest.fixture()
def stems(tmp_path):
    rng = np.random.default_rng(0)
    paths = {}
    for name, y in {"vocals": _tone(440), "bass": _tone(110),
                    "drums": np.repeat((rng.standard_normal((SR * 2, 1)) * 0.05).astype(np.float32), 2, 1)}.items():
        paths[name] = tmp_path / f"{name}.wav"
        sf.write(paths[name], y, SR)
    mix = sum(sf.read(p, dtype="float32")[0] for p in paths.values()) + _tone(880, amp=0.05)  # 잔향 같은 나머지
    sf.write(tmp_path / "mix.wav", mix, SR)
    return paths, tmp_path / "mix.wav"


def test_profiles():
    assert profile_for("drums") is None and profile_for("drums_kick") is None
    assert "formant=preserved" in profile_for("vocals")
    assert "window=long" in profile_for("bass")


def test_original_key_mr(stems, tmp_path):
    paths, mix = stems
    out = build_tracks(paths, mix, tmp_path / "w0", 0)
    m, _ = sf.read(out["mix"], dtype="float32")
    mr, _ = sf.read(out["mr"], dtype="float32")
    v, _ = sf.read(out["vocals"], dtype="float32")
    assert np.allclose(mr, m - v, atol=1e-4)  # 반주 = 원곡 - 보컬 (나머지 소리도 그대로)


def test_shifted_key(stems, tmp_path):
    paths, mix = stems
    out = build_tracks(paths, mix, tmp_path / "w2", 2)
    up = 2 ** (2 / 12)
    assert abs(_f0(sf.read(out["bass"], dtype="float32")[0]) - 110 * up) < 3
    assert abs(_f0(sf.read(out["vocals"], dtype="float32")[0]) - 440 * up) < 6
    d0, _ = sf.read(paths["drums"], dtype="float32")
    d2, _ = sf.read(out["drums"], dtype="float32")
    assert np.allclose(d0, d2[:len(d0)], atol=1e-4)  # 드럼은 그대로
    n = len(d0)
    for name in ("bass", "vocals", "mix", "mr"):
        assert abs(len(sf.read(out[name])[0]) - n) <= 1  # 길이 그대로 (스템끼리 어긋나지 않게)
    mr = sf.read(out["mr"], dtype="float32")[0]
    assert abs(_f0(mr) - 110 * up) < 3  # 반주에 보컬(가장 큰 소리)이 빠짐


def test_score_midi(tmp_path):
    import pretty_midi

    from band2sheet.project import Note
    from band2sheet.synth import score_midi

    mid = score_midi({"bass": [Note(0.5, 1.0, 40, 90)], "drums": [Note(0.5, 0.6, 36, 100)]},
                     tmp_path / "s.mid", semitones=3)
    pm = pretty_midi.PrettyMIDI(str(mid))
    bass = next(i for i in pm.instruments if not i.is_drum)
    drums = next(i for i in pm.instruments if i.is_drum)
    assert bass.notes[0].pitch == 43 and abs(bass.notes[0].start - 0.5) < 1e-3
    assert drums.notes[0].pitch == 36  # 드럼은 조옮김 안 함
