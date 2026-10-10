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


def _track(notes, frame=None):
    """정답을 아는 음높이 곡선: (MIDI, 초) 목록을 분석 프레임 간격으로."""
    from band2sheet.vocalfx import ANALYSIS_SR, HOP, PitchTrack

    ft = HOP / ANALYSIS_SR
    midi = np.concatenate([np.full(int(d / ft), float(m)) for m, d in notes])
    return PitchTrack(np.arange(len(midi)) * ft, midi)


def _sung(track, shift, t):
    k = int(t / track.frame_t)
    return round(float(track.midi[k] + shift[k]))


def test_harmony_styles_follow_their_character():
    from band2sheet.vocalfx import HARMONY_STYLES, harmony_shift, harmony_voices, voice_shift

    key = Key.parse("G")
    # E5·D5·C5·B4 위 C 코드 / D 코드
    tr = _track([(76, 0.5), (74, 0.5), (72, 0.5), (71, 0.5)])
    at = [0.25, 0.75, 1.25, 1.75]
    c_chord = lambda t: {0, 4, 7}  # noqa: E731
    d_chord = lambda t: {2, 6, 9}  # noqa: E731

    def sung(style, chord_at=None, parts="both"):
        return [[_sung(tr, voice_shift(tr, key, v, chord_at), t) for t in at] for v in harmony_voices(style, parts)]

    assert set(HARMONY_STYLES) == {"classic", "ballad", "trot", "ccm", "kpop", "gospel", "power", "quartal", "drone"}
    # 정석 3도는 예전 harmony_shift 와 똑같다
    for d, part in ((1, "up"), (-1, "down")):
        (v,) = harmony_voices("classic", part)
        assert np.allclose(voice_shift(tr, key, v, c_chord), harmony_shift(tr, key, d, c_chord))
    assert [v["name"] for v in harmony_voices("classic")] == ["up", "down"]
    # 발라드: 멜로디가 맨 위, C 코드면 E 아래로 C(3도)·G(6도)
    third, sixth = sung("ballad", c_chord)
    assert third[0] == 72 and sixth[0] == 67
    assert all(a < m and b < a for a, b, m in zip(third, sixth, (76, 74, 72, 71)))
    # 아이돌 훅: 옥타브 아래 더블 + 3도 위 + 옥타브 위
    below, up, above = sung("kpop", c_chord)
    assert below == [64, 62, 60, 59] and above == [88, 86, 84, 83] and up[0] == 79
    # 가스펠·재즈: C 코드면 Cmaj7 (G장조에서 C의 7음은 B), E 아래로 C·B·G 촘촘히
    assert [v[0] for v in sung("gospel", c_chord)] == [72, 71, 67]
    # D 코드는 D7 (C#이 아니라 키 안의 C): E 아래로 D·C·A
    assert [v[0] for v in sung("gospel", d_chord)] == [74, 72, 69]
    # 파워: 늘 완전4·5도, 키(G장조) 밖의 F 대신 G
    fifth, octave = sung("power")
    assert fifth == [69, 67, 67, 64] and octave == [64, 62, 60, 59]
    # 몽환 4도: 음계 안 4도 위·아래
    up4, down4 = sung("quartal")
    assert up4 == [81, 79, 78, 76] and down4 == [71, 69, 67, 66]
    # 드론: 멜로디가 움직여도 G·D 지속음은 그대로
    tonic, dominant = sung("drone")
    assert tonic == [67] * 4 and dominant == [62] * 4
    # 트로트: 3도 아래 듀엣 + 옥타브 아래 + 6도 위(= 3도 아래의 옥타브 위)
    third, octave, sixth = sung("trot", c_chord)
    assert third[0] == 72 and octave[0] == 64 and sixth[0] == 84
    # 트로트 단조: A단조 B4 위의 3도 아래는 화성단음계 G#4 (코드를 몰라도)
    am = Key.parse("Am")
    tb = _track([(71, 0.5)])
    (v3,) = [v for v in harmony_voices("trot") if v["name"] == "third_below"]
    assert _sung(tb, voice_shift(tb, am, v3), 0.25) == 68
    (b3,) = [v for v in harmony_voices("ballad") if v["name"] == "third_below"]
    assert _sung(tb, voice_shift(tb, am, b3), 0.25) == 67  # 발라드는 자연단음계 G4
    # CCM: 하이·로우 화음 사이에 멜로디 + 회중 옥타브
    high, low, congregation = sung("ccm", c_chord)
    assert all(lo < m < hi for hi, lo, m in zip(high, low, (76, 74, 72, 71)))
    assert high[0] == 79 and low[0] == 72 and congregation == [64, 62, 60, 59]
    with pytest.raises(ValueError):
        harmony_voices("없는 성격")


@pytest.mark.slow
def test_remix_harmony_style_ballad(tmp_path):
    from band2sheet.remix import RemixOptions, remix
    from band2sheet.vocalfx import track_pitch

    wav = tmp_path / "v.wav"
    sf.write(wav, sing(), SR)
    opts = RemixOptions(harmony_style="ballad", separate=False, key="G", chords="G | C | D | G")
    res = remix(wav, tmp_path / "ballad", opts, log=lambda m: None)
    names = {f.name for f in res.files}
    assert {"harmony_third_below.wav", "harmony_sixth_below.wav"} <= names and "harmony_up.wav" not in names
    assert any("가요 발라드" in n for n in res.notes)
    low, _ = sf.read(tmp_path / "ballad" / "stems" / "harmony_sixth_below.wav")
    tr = track_pitch(low, SR)
    got = [pitch_at(tr, c) for m, c in note_centers()]
    # 발라드 화음은 늘 멜로디보다 아래 (멜로디가 맨 위)
    assert all(g < m - 2 for g, (m, _) in zip(got, note_centers()) if not np.isnan(g))
    meta = json.loads((tmp_path / "ballad" / "remix.json").read_text(encoding="utf-8"))
    assert meta["options"]["harmony_style"] == "ballad"
    with pytest.raises(ValueError):
        remix(wav, tmp_path / "bad", RemixOptions(harmony_style="nope", separate=False), log=lambda m: None)


def _progression():
    from band2sheet.backing import ChordSpan

    beats = list(np.arange(0, 16.5, 0.5))  # 120 BPM, 4/4, 8마디
    spans = [ChordSpan(0, 4, 7), ChordSpan(4, 8, 0), ChordSpan(8, 12, 2), ChordSpan(12, 16, 4, "m")]
    return beats, spans


NAMES = "C C# D Eb E F F# G Ab A Bb B".split()
SEGMENTS = ((0.5, 3.5), (4.5, 7.5), (8.5, 11.5), (12.5, 15.5))
TRIADS = [{"G", "B", "D"}, {"C", "E", "G"}, {"D", "F#", "A"}, {"E", "G", "B"}]
SEVENTHS = [{"G", "B", "D", "F#"}, {"C", "E", "G", "B"}, {"D", "F#", "A", "C"}, {"E", "G", "B", "D"}]


def _top_pcs(y, k):
    chroma = librosa.feature.chroma_cqt(y=y.mean(axis=1), sr=SR)
    out = []
    for a, b in SEGMENTS:
        seg = chroma[:, int(a * SR / 512):int(b * SR / 512)].mean(axis=1)
        out.append({NAMES[i] for i in np.argsort(seg)[-k:]})
    return out


@pytest.mark.parametrize("style", ["orchestra", "pad", "piano", "guitar"])
def test_backing_styles_play_the_chords(style):
    from band2sheet.backing import STYLE_REVERB, arrange, synthesize

    beats, spans = _progression()
    notes = arrange(style, spans, beats, 4, 0, 16, Key.parse("G"))
    assert notes and all(n.end > n.start for n in notes)
    wet, secs = STYLE_REVERB[style]
    y = synthesize(notes, 17, reverb=wet, reverb_seconds=secs)
    assert np.isfinite(y).all() and y.shape[1] == 2
    assert _top_pcs(y, 3) == TRIADS


def test_orchestra_voice_leading():
    from band2sheet.backing import arrange

    beats, spans = _progression()
    notes = arrange("orchestra", spans, beats, 4, 0, 16)
    assert {"strings", "cello", "contrabass", "harp", "timpani"} <= {n.part for n in notes}
    strings = [n for n in notes if n.part == "strings"]
    assert all(55 <= n.pitch <= 76 for n in strings)
    for a, b in zip(spans, spans[1:]):  # 화음이 바뀔 때 성부가 크게 뛰지 않음
        va = sorted(n.pitch for n in strings if n.start == a.start)
        vb = sorted(n.pitch for n in strings if n.start == b.start)
        assert sum(abs(p - q) for p, q in zip(va, vb)) <= 12


def test_jazz_trio():
    from band2sheet.backing import arrange, synthesize

    beats, spans = _progression()
    notes = arrange("jazz", spans, beats, 4, 0, 16, Key.parse("G"))
    bass = [n for n in notes if n.part == "upright_bass"]
    assert len(bass) == 32  # 워킹 베이스: 박마다 한 음
    assert [n.pitch % 12 for n in bass if n.start in (0.0, 4.0, 8.0, 12.0)] == [7, 0, 2, 4]  # 코드 첫 박 = 근음
    assert bass[7].pitch % 12 in (11, 1)  # 다음 코드(C) 근음으로 반음 접근 (B 또는 C#)
    rides = sorted(n.start for n in notes if n.part == "ride")
    assert any(abs(t - (0.5 + 2 / 3 * 0.5)) < 1e-6 for t in rides)  # 스윙 8분음표 (2박의 2/3 지점)
    assert {"brush", "hihat", "kick", "piano"} <= {n.part for n in notes}
    y = synthesize(notes, 17, reverb=0.14, reverb_seconds=1.2)
    assert _top_pcs(y, 4) == SEVENTHS  # 장3화음 -> maj7, 딸림화음 D -> D7, 단3화음 -> m7


def test_acappella_bass_and_beatbox():
    from band2sheet.backing import arrange, synthesize

    beats, spans = _progression()
    notes = arrange("acappella", spans, beats, 4, 0, 16)
    vox = [n for n in notes if n.part == "bass_vox"]
    assert vox and all(40 <= n.pitch <= 57 for n in vox)
    assert [n.pitch % 12 for n in vox if n.start in (0.0, 4.0, 8.0, 12.0)] == [7, 0, 2, 4]
    kicks = {n.start for n in notes if n.part == "bb_kick"}
    snares = {n.start for n in notes if n.part == "bb_snare"}
    assert 0.0 in kicks and 1.0 in kicks and 0.5 in snares and 1.5 in snares  # 킥 1·3박, 스네어 2·4박
    assert np.isfinite(synthesize(notes, 17)).all()


def test_arrangement_midi(tmp_path):
    import pretty_midi

    from band2sheet.backing import arrange, write_arrangement_midi

    beats, spans = _progression()
    path = write_arrangement_midi(arrange("jazz", spans, beats, 4, 0, 16), tmp_path / "jazz.mid", 120)
    pm = pretty_midi.PrettyMIDI(str(path))
    progs = {(i.program, i.is_drum) for i in pm.instruments}
    assert (0, False) in progs and (32, False) in progs and any(d for _, d in progs)
    drums = next(i for i in pm.instruments if i.is_drum)
    assert {51, 44, 40, 36} <= {n.pitch for n in drums.notes}  # 라이드, 하이햇 페달, 브러시, 킥


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
    assert "orchestra.wav" in stems and "harmony_up.wav" not in stems  # 반주 스타일은 기본 화음 없음


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
    assert client.post("/api/remix", files={"file": ("a.mp4", data)},
                       data={"options": '{"harmony_style": "polka"}'}).status_code == 400

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
    assert res["video"].endswith(".mp4") and "v1/stems/harmony_up.wav" in res["files"]
    assert res["harmony_style"] == "classic" and res["harmony"] == "up"
    assert any("오토튠" in n for n in res["notes"])
    listed = client.get("/api/jobs").json()[0]
    assert listed["kind"] == "remix" and listed["key"] == "G"

    v = client.get(f"/api/jobs/{job_id}/remix/{res['video']}")
    assert v.status_code == 200 and v.headers["content-type"] == "video/mp4"
    assert "harmony.mp4" in v.headers["content-disposition"]
    o = client.get(f"/api/jobs/{job_id}/remix/original")
    assert o.status_code == 200 and o.content == data
    assert client.get(f"/api/jobs/{job_id}/remix/v1/stems/harmony_up.wav").status_code == 200
    assert client.get(f"/api/jobs/{job_id}/remix/../job.json").status_code in (400, 404)
    assert client.get(f"/api/jobs/{job_id}/remix/nothing.wav").status_code == 404
    assert res["versions"][0]["n"] == 1 and res["current"] == 1 and res["chord_text"]

    # 다른 스타일 + 직접 고친 코드로 다시 만들기 -> 새 버전 (분석 재사용), 이전 버전도 그대로
    bad = client.post(f"/api/jobs/{job_id}/remix", json={"options": {"chords": "G | Q7"}})
    assert bad.status_code == 400 and "Q7" in bad.json()["detail"]
    r = client.post(f"/api/jobs/{job_id}/remix", json={"options": {
        "style": "jazz", "with_harmony": False, "autotune": False, "chords": "G | C | D | G", "bpm": 90}})
    assert r.status_code == 200, r.text
    for _ in range(400):
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            break
        time.sleep(0.25)
    assert job["status"] == "done", job.get("error")
    res2 = job["result"]
    assert [v["n"] for v in res2["versions"]] == [1, 2] and res2["current"] == 2
    v2 = res2["versions"][1]
    assert v2["style"] == "jazz" and v2["chords_source"] == "user" and v2["reused"]
    assert v2["chord_text"].replace(" ", "") == "G|C|D|G" and v2["video"].startswith("v2/")
    assert "v2/jazz.mid" in v2["files"] and not any("harmony" in f for f in v2["files"])
    assert client.get(f"/api/jobs/{job_id}/remix/{v2['video']}").status_code == 200
    assert client.get(f"/api/jobs/{job_id}/remix/{res['video']}").status_code == 200  # v1 도 남아 있음
    d = client.get(f"/api/jobs/{job_id}/remix/{v2['video']}")
    assert "jazz.mp4" in d.headers["content-disposition"]


@pytest.mark.slow
@pytest.mark.parametrize("style,harmony", [("jazz", False), ("acappella", True), ("piano", True)])
def test_remix_new_styles(tmp_path, style, harmony):
    from band2sheet.remix import RemixOptions, remix

    wav = tmp_path / "v.wav"
    sf.write(wav, sing(), SR)
    opts = RemixOptions(style=style, separate=False, key="G", with_harmony=True if style == "piano" else None)
    res = remix(wav, tmp_path / style, opts, log=lambda m: None)
    names = {f.name for f in res.files}
    assert f"{style}.mid" in names and f"{style}.wav" in names
    assert ("harmony_up.wav" in names) == harmony
    y, _ = sf.read(res.audio)
    assert np.isfinite(y).all() and np.abs(y).max() < 1.0 and np.sqrt(np.mean(y ** 2)) > 0.03


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg 미설치")
def test_mux_preserves_full_video_when_replacement_audio_is_short(tmp_path):
    from band2sheet.remix import mux_video

    video, audio = tmp_path / "source.mp4", tmp_path / "short.wav"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                    "testsrc=size=160x120:rate=25:duration=2", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", str(video)], check=True)
    sf.write(audio, np.zeros(int(.4 * SR)), SR)
    result = mux_video(video, audio, tmp_path / "output")
    assert abs(float(_probe(result)["format"]["duration"]) - 2) < .1

    def frames(path):
        return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0",
                               "-f", "framemd5", "-"], check=True, capture_output=True).stdout

    assert frames(result) == frames(video), "All original video frames must remain unchanged"
