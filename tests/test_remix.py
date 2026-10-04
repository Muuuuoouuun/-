"""내 영상 후보정(remix) 테스트: 오토튠, 화음, 오케스트라 편곡, 영상 다시 입히기.

정답을 아는 합성 '노래'(포먼트가 있는 목소리, 일부러 틀린 음정, 비브라토)를 쓴다.
"""

import json
import shutil
import subprocess

import librosa
import numpy as np
import pytest
import soundfile as sf
from scipy.signal import lfilter

from band2sheet.theory import Key

SR = 44100
BEAT = 60 / 90
# G C D G 진행 위 멜로디 (MIDI, 박)
MELODY = [(71, 1), (74, 1), (72, 1), (71, 1), (72, 1), (76, 1), (74, 1), (72, 1),
          (74, 1), (78, 1), (76, 1), (74, 1), (71, 2), (67, 2)]


def sing(melody=MELODY, detune=0.35, seed=1) -> np.ndarray:
    det = np.random.default_rng(seed).uniform(-detune, detune, len(melody))
    parts, ph = [], 0.0
    for (m, b), dt in zip(melody, det):
        d = b * BEAT
        t = np.arange(int(d * SR)) / SR
        f = librosa.midi_to_hz(m + dt) * 2 ** (0.3 * np.sin(2 * np.pi * 5.5 * t) * np.clip(t / 0.3, 0, 1) / 12)
        p = ph + np.cumsum(f) / SR
        ph = p[-1]
        env = np.clip(t / 0.04, 0, 1) * np.clip((d - t) / 0.08, 0, 1)
        parts.append((2 * (p % 1) - 1) * env)
    x = np.concatenate([np.zeros(int(0.5 * SR))] + parts + [np.zeros(int(0.5 * SR))])
    for fc, bw in ((650, 100), (1100, 120), (2500, 160)):  # 모음 '아' 포먼트
        r = np.exp(-np.pi * bw / SR)
        th = 2 * np.pi * fc / SR
        x = lfilter([1 - r], [1, -2 * r * np.cos(th), r * r], x)
    return x / np.abs(x).max() * 0.5


def note_centers(melody=MELODY):
    t, out = 0.5, []
    for m, b in melody:
        out.append((m, t + b * BEAT / 2))
        t += b * BEAT
    return out


def pitch_at(track, t: float) -> float:
    k = int(t / track.frame_t)
    return float(np.nanmedian(track.midi[k - 4:k + 5]))


@pytest.fixture(scope="module")
def voice():
    from band2sheet.vocalfx import track_pitch

    x = sing()
    return x, track_pitch(x, SR)


def test_autotune_pulls_notes_into_key(voice):
    from band2sheet.vocalfx import autotune_shift, psola_shift, track_pitch

    x, tr = voice
    key = Key.parse("G")
    before = [abs(pitch_at(tr, c) - m) for m, c in note_centers()]
    y = psola_shift(x, SR, tr, autotune_shift(tr, key, strength=1.0))
    assert len(y) == len(x)  # 길이 유지
    tr2 = track_pitch(y, SR)
    after = [abs(pitch_at(tr2, c) - m) for m, c in note_centers()]
    assert np.mean(before) > 0.15
    assert np.mean(after) < 0.08 and max(after) < 0.2


def test_harmony_diatonic_and_chord_aware(voice):
    from band2sheet.vocalfx import harmony_shift, psola_shift, track_pitch

    x, tr = voice
    key = Key.parse("G")
    # 코드 정보 없음 -> 음계 위 3도 (G 장조: B->D, D->F#, C->E ...)
    up = track_pitch(psola_shift(x, SR, tr, harmony_shift(tr, key, +1), voiced_only=True), SR)
    third_up = {71: 74, 74: 78, 72: 76, 76: 79, 78: 81, 67: 71}
    got = [round(pitch_at(up, c)) for m, c in note_centers()]
    assert got == [third_up[m] for m, _ in note_centers()]
    # C 코드 위의 E(76): 아래 화음은 코드 구성음인 C(72)
    shift = harmony_shift(tr, key, -1, chord_at=lambda t: {0, 4, 7})
    m, c = note_centers()[5]
    k = int(c / tr.frame_t)
    assert m == 76 and round(float(np.nanmedian(tr.midi[k - 3:k + 3] + shift[k - 3:k + 3]))) == 72


def test_orchestra_arrangement_follows_chords():
    from band2sheet.orchestra import ChordSpan, arrange, synthesize

    beats = list(np.arange(0, 16.5, 0.5))
    spans = [ChordSpan(0, 4, 7), ChordSpan(4, 8, 0), ChordSpan(8, 12, 2), ChordSpan(12, 16, 4, "m")]
    notes = arrange(spans, beats, 4, 0, 16)
    parts = {n.part for n in notes}
    assert {"strings", "cello", "contrabass", "harp", "timpani"} <= parts
    strings = [n for n in notes if n.part == "strings"]
    assert all(55 <= n.pitch <= 76 for n in strings)
    for a, b in zip(spans, spans[1:]):  # 성부 진행: 화음이 바뀔 때 크게 뛰지 않음
        va = sorted(n.pitch for n in strings if n.start == a.start)
        vb = sorted(n.pitch for n in strings if n.start == b.start)
        assert sum(abs(p - q) for p, q in zip(va, vb)) <= 12
    y = synthesize(notes, 17)
    chroma = librosa.feature.chroma_cqt(y=y.mean(axis=1), sr=SR)
    names = "C C# D Eb E F F# G Ab A Bb B".split()
    for (a, b), want in (((0.5, 3.5), {"G", "B", "D"}), ((4.5, 7.5), {"C", "E", "G"}),
                         ((8.5, 11.5), {"D", "F#", "A"}), ((12.5, 15.5), {"E", "G", "B"})):
        seg = chroma[:, int(a * SR / 512):int(b * SR / 512)].mean(axis=1)
        assert {names[i] for i in np.argsort(seg)[-3:]} == want


def _probe(path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration",
                          "-of", "json", str(path)], capture_output=True, text=True)
    return json.loads(out.stdout)


@pytest.mark.slow
@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg 미설치")
def test_remix_video_full_with_autotune(tmp_path):
    from band2sheet.remix import RemixOptions, remix

    wav, mp4 = tmp_path / "sing.wav", tmp_path / "내 노래.mp4"
    sf.write(wav, sing(), SR)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                    "testsrc=size=320x240:rate=25", "-i", str(wav), "-c:v", "libx264", "-pix_fmt",
                    "yuv420p", "-c:a", "aac", "-shortest", str(mp4)], check=True)
    res = remix(mp4, tmp_path / "out", RemixOptions(style="full", autotune=True, separate=False),
                log=lambda m: None)
    assert res.key == "G major"
    assert res.video and res.video.suffix == ".mp4" and res.video.exists()
    info = _probe(res.video)
    assert sorted(s["codec_type"] for s in info["streams"]) == ["audio", "video"]
    assert abs(float(info["format"]["duration"]) - float(_probe(mp4)["format"]["duration"])) < 0.3
    names = {f.name for f in res.files}
    assert {"remix.wav", "lead_tuned.wav", "harmony_up.wav", "harmony_down.wav", "orchestra.wav",
            "orchestra.mid"} <= names
    y, _ = sf.read(res.audio)
    assert y.ndim == 2 and np.abs(y).max() < 1.0 and np.sqrt(np.mean(y ** 2)) > 0.03
    meta = json.loads((tmp_path / "out" / "remix.json").read_text(encoding="utf-8"))
    assert meta["chords"] and meta["options"]["style"] == "full"
    assert not (tmp_path / "out" / "work").exists()


@pytest.mark.slow
def test_cli_remix_audio_file(tmp_path, capsys):
    from band2sheet.cli import main

    wav = tmp_path / "voice.wav"
    sf.write(wav, sing(), SR)
    assert main(["remix", str(wav), "-o", str(tmp_path / "o"), "--style", "orchestra", "--key", "G",
                 "--no-separate"]) == 0
    out = capsys.readouterr().out
    assert "오케스트라 반주" in out and "키 G major" in out
    assert (tmp_path / "o" / "remix.wav").exists() and (tmp_path / "o" / "orchestra.mid").exists()
    assert not list((tmp_path / "o").glob("*.mp4"))  # 음원 입력이면 영상 없음
    assert main(["remix", str(tmp_path / "없음.mp4")]) == 1


@pytest.mark.slow
def test_remix_with_separated_backing(tmp_path, monkeypatch):
    """Demucs 분리 경로: 보컬만 화음/오토튠, 원래 반주는 화음 스타일에서 유지·오케스트라에서 교체."""
    import band2sheet.remix as rm
    import band2sheet.separate as sep

    voice = sing()
    t = np.arange(len(voice)) / SR
    backing = 0.15 * np.sin(2 * np.pi * 98.0 * t)  # G2 지속음 (반주 흉내)
    mix = np.stack([voice + backing, voice + backing], axis=1)
    wav = tmp_path / "band.wav"
    sf.write(wav, mix, SR)

    def fake_separate(mix_path, out_dir, model_name="htdemucs", device=None, shifts=1):
        out_dir.mkdir(parents=True, exist_ok=True)
        paths = {}
        for name, y in (("vocals", voice), ("bass", backing), ("drums", 0 * voice), ("other", 0 * voice)):
            paths[name] = out_dir / f"{name}.wav"
            sf.write(paths[name], np.stack([y, y], axis=1), SR)
        return paths

    monkeypatch.setattr(rm, "available", lambda key: True)
    monkeypatch.setattr(sep, "separate", fake_separate)
    logs = []
    res = rm.remix(wav, tmp_path / "h", rm.RemixOptions(harmony="up"), log=logs.append)
    assert "보컬/반주 분리: Demucs" in res.notes and res.video is None
    y, _ = sf.read(res.audio)
    spec = np.abs(np.fft.rfft(y.mean(axis=1)))
    f = np.fft.rfftfreq(len(y), 1 / SR)
    assert spec[(f > 95) & (f < 101)].max() > 5 * np.median(spec[(f > 60) & (f < 400)])  # 반주 유지

    res = rm.remix(wav, tmp_path / "o", rm.RemixOptions(style="orchestra"), log=logs.append)
    y, _ = sf.read(res.audio)
    stems = {p.name for p in res.files}
    assert "orchestra.wav" in stems and "harmony_up.wav" not in stems


@pytest.mark.slow
@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg 미설치")
def test_app_remix_job(tmp_path):
    import importlib.util
    import time

    if importlib.util.find_spec("fastapi") is None:
        pytest.skip("fastapi 미설치")
    from fastapi.testclient import TestClient

    from band2sheet.app.server import create_app

    wav, mp4 = tmp_path / "s.wav", tmp_path / "s.mp4"
    sf.write(wav, sing(), SR)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                    "testsrc=size=160x120:rate=15", "-i", str(wav), "-c:v", "libx264", "-pix_fmt",
                    "yuv420p", "-c:a", "aac", "-shortest", str(mp4)], check=True)
    client = TestClient(create_app(tmp_path / "data"))
    data = mp4.read_bytes()
    assert client.post("/api/remix", files={"file": ("a.zip", b"x")}).status_code == 400
    assert client.post("/api/remix", files={"file": ("a.mp4", data)},
                       data={"options": '{"style": "rock"}'}).status_code == 400

    opts = json.dumps({"style": "harmony", "harmony": "up", "autotune": True, "autotune_strength": 0.9,
                       "title": "주일 찬양"})
    r = client.post("/api/remix", files={"file": ("my song.mp4", data)}, data={"options": opts})
    assert r.status_code == 200, r.text
    job_id = r.json()["id"]
    for _ in range(400):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            break
        time.sleep(0.25)
    assert job["status"] == "done", job.get("error")
    res = job["result"]
    assert job["kind"] == "remix" and res["kind"] == "remix" and res["key_short"] == "G"
    assert res["video"].endswith(".mp4") and "stems/harmony_up.wav" in res["files"]
    assert any("오토튠" in n for n in res["notes"])
    listed = client.get("/api/jobs").json()[0]
    assert listed["kind"] == "remix" and listed["key"] == "G"

    v = client.get(f"/api/jobs/{job_id}/remix/{res['video']}")
    assert v.status_code == 200 and v.headers["content-type"] == "video/mp4"
    assert "harmony.mp4" in v.headers["content-disposition"]
    o = client.get(f"/api/jobs/{job_id}/remix/original")
    assert o.status_code == 200 and o.content == data
    assert client.get(f"/api/jobs/{job_id}/remix/stems/harmony_up.wav").status_code == 200
    assert client.get(f"/api/jobs/{job_id}/remix/../job.json").status_code in (400, 404)
    assert client.get(f"/api/jobs/{job_id}/remix/nothing.wav").status_code == 404
