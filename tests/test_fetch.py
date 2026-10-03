"""영상 링크 -> 영상 다운로드 -> 음성 추출 테스트.

유튜브 대신 로컬 HTTP 서버에 올린 MP4 를 yt-dlp 로 받는다 (네트워크 없이 같은 흐름 검증).
"""

import functools
import importlib.util
import json
import shutil
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest

pytestmark = [
    pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg 미설치"),
    pytest.mark.skipif(importlib.util.find_spec("yt_dlp") is None, reason="yt-dlp 미설치"),
]


def _duration(path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
    return float(out.stdout.strip())


@pytest.fixture(scope="module")
def video_url(tmp_path_factory):
    root = tmp_path_factory.mktemp("srv")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                    "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                    "-shortest", str(root / "live_clip.mp4")], check=True)

    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/live_clip.mp4"
    server.shutdown()


def test_fetch_video_and_audio(video_url, tmp_path):
    from band2sheet.audio_io import fetch

    steps = []
    res = fetch(video_url, tmp_path / "out", audio_format="wav", progress=lambda f, m: steps.append(m))
    assert res.video and res.video.suffix == ".mp4" and res.video.exists()
    assert res.audio.name == "live_clip.wav"
    assert abs(_duration(res.audio) - 4.0) < 0.3
    info = json.loads((tmp_path / "out" / "info.json").read_text(encoding="utf-8"))
    assert info["video"] == res.video.name and info["audio"] == res.audio.name
    assert any("받는 중" in m for m in steps) and "음성 추출 중" in steps
    assert not (tmp_path / "out" / ".download").exists()  # 임시 폴더 정리


def test_fetch_audio_only_with_cut(video_url, tmp_path):
    from band2sheet.audio_io import fetch

    res = fetch(video_url, tmp_path, audio_format="m4a", keep_video=False, start=1, duration=2)
    assert res.video is None and not list(tmp_path.glob("*.mp4"))
    assert res.audio.suffix == ".m4a" and abs(_duration(res.audio) - 2.0) < 0.3


def test_extract_audio_from_local_video(video_url, tmp_path):
    from band2sheet.audio_io import extract_audio, fetch

    with pytest.raises(ValueError):
        extract_audio(tmp_path / "x.mp4", tmp_path / "x.ogg")
    res = fetch(video_url, tmp_path / "dl", audio_format="wav")
    local = fetch(str(res.video), tmp_path / "local", audio_format="flac")  # 링크 대신 영상 파일
    assert local.video is None and local.audio.suffix == ".flac" and local.audio.exists()


def test_cli_fetch(video_url, tmp_path, capsys):
    from band2sheet.cli import main

    assert main(["fetch", video_url, "-o", str(tmp_path), "-a", "wav"]) == 0
    assert (tmp_path / "live_clip.mp4").exists() and (tmp_path / "live_clip.wav").exists()
    assert "band2sheet run" in capsys.readouterr().out
    assert main(["fetch", "http://127.0.0.1:1/none.mp4", "-o", str(tmp_path / "bad")]) == 1


def test_prepare_input_from_link(video_url, tmp_path):
    from band2sheet.audio_io import prepare_input

    mix, title = prepare_input(video_url, tmp_path / "work", duration=3)
    assert title == "live_clip" and mix.name == "mix.wav"
    assert abs(_duration(mix) - 3.0) < 0.3


@pytest.mark.skipif(importlib.util.find_spec("fastapi") is None, reason="fastapi 미설치")
def test_app_url_job_fetch_only(video_url, tmp_path):
    from fastapi.testclient import TestClient

    from band2sheet.app.server import create_app

    client = TestClient(create_app(tmp_path / "data"))
    assert client.post("/api/jobs/url", json={"url": "youtube.com/watch?v=x"}).status_code == 400
    assert client.post("/api/jobs/url", json={"url": video_url,
                                              "options": {"audio_format": "ogg"}}).status_code == 400

    r = client.post("/api/jobs/url", json={"url": video_url, "options": {
        "fetch_only": True, "audio_format": "wav", "max_height": 480}})
    assert r.status_code == 200, r.text
    job_id = r.json()["id"]
    for _ in range(120):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("ready", "done", "error"):
            break
        time.sleep(0.25)
    assert job["status"] == "ready", job.get("error")
    assert job["title"] == "live_clip"
    assert job["source"]["video"] == "input.mp4" and job["source"]["audio"] == "source_audio.wav"

    v = client.get(f"/api/jobs/{job_id}/source/video")
    assert v.status_code == 200 and v.headers["content-type"] == "video/mp4"
    assert "live_clip.mp4" in v.headers["content-disposition"]
    a = client.get(f"/api/jobs/{job_id}/source/audio")
    assert a.status_code == 200 and a.content[:4] == b"RIFF"
    assert client.get(f"/api/jobs/{job_id}/source/other").status_code == 404
    listed = client.get("/api/jobs").json()
    assert listed[0]["url"] == video_url and listed[0]["status"] == "ready"

    # 앱을 다시 켜도 '준비됨' 상태는 유지
    again = TestClient(create_app(tmp_path / "data"))
    assert again.get(f"/api/jobs/{job_id}").json()["status"] == "ready"

    # 분석 중/완료된 작업에는 이어서 악보 만들기를 할 수 없다
    client.app.state.manager.get(job_id).status = "running"
    assert client.post(f"/api/jobs/{job_id}/analyze", json={"options": {}}).status_code == 409
