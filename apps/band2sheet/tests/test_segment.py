"""곡 나누기: 예배 실황(말씀-찬양-전환-찬양-기도)에서 곡 구간 찾기."""

import shutil

import pytest

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg 필요")


@pytest.fixture(scope="module")
def service(tmp_path_factory):
    from tests.song import make_song
    from tests.song_live import make_live_song
    from tests.song_service import make_service

    d = tmp_path_factory.mktemp("svc")
    make_live_song(d / "a")
    make_song(d / "b")
    return make_service(d / "service.wav", d / "a", d / "b")


@pytest.mark.slow
def test_find_songs(service):
    from band2sheet.segment import scan_file

    wav, truth = service
    songs = scan_file(wav)
    assert len(songs) == 2
    for sg, (a, b) in zip(songs, truth):
        assert abs(sg.start - a) < 5 and abs(sg.end - b) < 5
    assert [s.key for s in songs] == ["D", "G"]
    assert abs(songs[0].tempo - 74) < 6 and abs(songs[1].tempo - 100) < 6


def test_single_song_not_split(tmp_path):
    """마지막 후렴을 반음 올리는 곡(전조)도 한 곡으로."""
    import librosa

    from band2sheet.segment import SR, find_songs
    from tests.song import make_song
    from tests.song_service import load_mix

    make_song(tmp_path / "s")
    y = librosa.resample(load_mix(tmp_path / "s", 400), orig_sr=22050, target_sr=SR)
    songs = find_songs(y)
    assert len(songs) == 1 and songs[0].duration > 95
