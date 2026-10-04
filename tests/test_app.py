"""앱 서버 API 테스트: 멀티트랙 ZIP 업로드 -> 분석 -> 악보 -> 조옮김 -> 파일/음원 받기."""

import importlib.util
import io
import time
import zipfile

import pytest

pytestmark = pytest.mark.skipif(importlib.util.find_spec("fastapi") is None, reason="fastapi 미설치")


@pytest.fixture()
def client(tmp_path):
    from fastapi.testclient import TestClient

    from band2sheet.app.server import create_app

    return TestClient(create_app(tmp_path / "data"))


def _zip_stems(tmp_path) -> bytes:
    from tests.synth import make_stems

    stems = tmp_path / "stems"
    make_stems(stems, bars=4, drum_parts=True)
    (stems / "drums.wav").unlink()  # 드럼은 조각 트랙만 (멀티트랙 녹음처럼)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for f in stems.rglob("*.wav"):
            zf.write(f, f.relative_to(stems).as_posix())
    return buf.getvalue()


def test_info_and_reject_bad_file(client):
    info = client.get("/api/info").json()
    assert any(e["key"] == "demucs" for e in info["engines"])
    r = client.post("/api/jobs", files={"file": ("notes.txt", b"hello")}, data={"options": "{}"})
    assert r.status_code == 400


def test_path_traversal_blocked(client):
    assert client.get("/api/jobs/../../etc/passwd").status_code in (404, 400)
    assert client.get("/api/jobs/abc/files/sheets_G/..%2F..%2Fjob.json").status_code in (400, 404)


@pytest.mark.slow
def test_full_job_flow(client, tmp_path):
    data = _zip_stems(tmp_path)
    opts = '{"title": "테스트 곡", "stems": ["vocals", "bass", "drums"]}'
    r = client.post("/api/jobs", files={"file": ("multitrack.zip", data)}, data={"options": opts})
    assert r.status_code == 200, r.text
    job_id = r.json()["id"]
    for _ in range(600):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            break
        time.sleep(0.5)
    assert job["status"] == "done", job.get("error")
    res = job["result"]
    assert res["key_short"] == "G"
    assert {p["name"] for p in res["parts"]} == {"vocals", "bass", "drums"}
    drums = next(p for p in res["parts"] if p["name"] == "drums")
    assert {"Kick", "Snare", "Hi-hat"} <= set(drums["pieces"])
    assert "vocals" in res["stems"] and "mix" in res["stems"]
    assert len(res["measures"]) >= 4

    xml = client.get(f"/api/jobs/{job_id}/files/{res['sheet_dir']}/bass.musicxml")
    assert xml.status_code == 200 and "<staff-lines>4</staff-lines>" in xml.text
    assert client.get(f"/api/jobs/{job_id}/audio/vocals").status_code == 200
    assert "mr" in res["stems"]  # 반주(MR): 원곡 - 메인 보컬
    mr = client.get(f"/api/jobs/{job_id}/mr", params={"kind": "mr"})
    assert mr.status_code == 200 and "attachment" in mr.headers["content-disposition"]

    # 조옮김한 키로 듣기: 백그라운드에서 만들고 다 되면 ready
    st = client.post(f"/api/jobs/{job_id}/playback", json={"semitones": 2}).json()
    for _ in range(300):
        if st["status"] != "working":
            break
        time.sleep(0.5)
        st = client.get(f"/api/jobs/{job_id}/playback", params={"semitones": 2}).json()
    assert st["status"] == "ready" and {"vocals", "mix", "mr"} <= set(st["tracks"])
    assert client.get(f"/api/jobs/{job_id}/audio/bass", params={"semitones": 2}).status_code == 200

    t = client.post(f"/api/jobs/{job_id}/render", json={"target_key": "A"}).json()
    assert t["key_short"] == "A" and t["semitones"] == 2 and t["sheet_dir"] == "sheets_A"
    t = client.post(f"/api/jobs/{job_id}/render", json={"semitones": -1}).json()
    assert t["key_short"] == "F#" and t["semitones"] == -1

    # 자체 화면 데이터 + 수정
    v = client.get(f"/api/jobs/{job_id}/view", params={"semitones": 2}).json()
    assert v["key_short"] == "A" and v["bars"] and "vocals" in v["tracks"] and "vocals" in v["stems"]
    r = client.put(f"/api/jobs/{job_id}/chord", json={"bar": 1, "beat": 2, "name": "Bm", "semitones": 2})
    assert r.status_code == 200, r.text
    v = client.get(f"/api/jobs/{job_id}/view", params={"semitones": 2}).json()
    assert any(c["name"] == "Bm" and c["beat"] == 2 for c in v["bars"][1]["chords"]) and v["stale"]
    assert client.put(f"/api/jobs/{job_id}/chord", json={"bar": 1, "name": "Q#zz"}).status_code == 400
    assert client.put(f"/api/jobs/{job_id}/lyrics", json={"bar": 2, "text": "할렐루야"}).status_code == 200
    notes = v["tracks"]["bass"]["notes"][:3]
    assert client.put(f"/api/jobs/{job_id}/notes/bass", json={"notes": notes, "semitones": 2}).status_code == 200
    assert client.put(f"/api/jobs/{job_id}/notes/nope", json={"notes": []}).status_code == 404
    v = client.get(f"/api/jobs/{job_id}/view").json()
    assert v["bars"][2]["lyrics"] == "할렐루야" and len(v["tracks"]["bass"]["notes"]) == 3
    t = client.post(f"/api/jobs/{job_id}/render", json={"semitones": 2}).json()
    assert not t.get("stale") and "할렐루야" in t["chord_chart"]

    z = client.get(f"/api/jobs/{job_id}/zip/sheets_A")
    names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
    assert "lead_sheet.musicxml" in names and "chords.txt" in names

    assert job_id in [j["id"] for j in client.get("/api/jobs").json()]
    assert client.delete(f"/api/jobs/{job_id}").status_code == 200
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
