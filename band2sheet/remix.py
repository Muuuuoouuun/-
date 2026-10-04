"""내 영상 후보정: 녹화한 노래 영상에 화음·오케스트라 반주·오토튠을 입혀 다시 영상으로.

  band2sheet remix 내노래.mp4                          # 화음 넣기 (기본: 3도 위 + 아래)
  band2sheet remix 내노래.mp4 --style orchestra        # 오케스트라 반주
  band2sheet remix 내노래.mp4 --style full --autotune  # 오케스트라 + 화음 + 오토튠
  band2sheet remix 내노래.mp4 --style jazz             # 재즈 트리오 (acappella/pad/piano/guitar 도)

흐름: 음성 추출 -> (Demucs 있으면) 보컬/반주 분리 -> 음높이·박·키·코드 분석
     -> 오토튠 / 화음(PSOLA) / 오케스트라 편곡·합성 -> 믹스 -> 원래 영상에 새 소리를 입힘
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
import soundfile as sf

from . import audio_io
from .chords import detect_chords
from .engines import available
from .project import Note, TimeMap
from .theory import Key, detect_key
from .vocalfx import (ANALYSIS_SR, PitchTrack, add_reverb, autotune_shift, chord_tones, delay,
                      harmony_shift, pan, psola_shift, track_pitch)

STYLES = {
    "harmony": "화음 넣기 (기본)",
    "orchestra": "오케스트라 반주",
    "full": "오케스트라 + 화음",
    "jazz": "재즈 트리오",
    "acappella": "아카펠라",
    "pad": "워십 패드",
    "piano": "피아노 반주",
    "guitar": "어쿠스틱 기타",
}
# 스타일 -> 반주 편곡 스타일 (backing.py). harmony 는 반주 없이 화음만.
BACKING_OF = {"orchestra": "orchestra", "full": "orchestra", "jazz": "jazz", "acappella": "acappella",
              "pad": "pad", "piano": "piano", "guitar": "guitar"}
# 기본으로 내 목소리 화음을 넣는 스타일 (나머지는 with_harmony=True 로 추가)
HARMONY_BY_DEFAULT = {"harmony", "full", "acappella"}
# 스타일별 반주 음량 보정 (패드는 뒤에 은은하게)
LEVEL_OF = {"pad": 0.8}
SR = 44100

Log = Callable[[str], None]
Progress = Callable[[float, str], None]


@dataclass
class RemixOptions:
    style: str = "harmony"  # STYLES 중 하나
    harmony: str = "both"  # both | up | down
    with_harmony: bool | None = None  # 내 목소리 화음 넣기 (기본: 화음·풀·아카펠라 스타일만)
    autotune: bool = False
    autotune_strength: float = 0.7  # 0~1
    hard_tune: bool = False  # 비브라토까지 펴는 '로봇 보이스'
    key: str | None = None  # 키 직접 지정 (기본 자동)
    separate: bool = True  # Demucs 가 있으면 보컬/반주 분리
    keep_backing: bool | None = None  # 원래 반주 유지 (기본: 화음=유지, 반주 스타일=빼고 바꿈)
    harmony_level: float = 0.5  # 화음 성부 음량 (리드 대비)
    backing_level: float = 0.55  # 새 반주 음량 (리드 대비)
    bpm: float | None = None
    beats_per_bar: int = 4
    soundfont: str | None = None  # .sf2 (fluidsynth 필요) — 없으면 내장 합성기
    device: str | None = None


@dataclass
class RemixResult:
    out_dir: Path
    audio: Path
    video: Path | None
    key: str
    key_short: str
    chords: list[str]
    files: list[Path] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _print(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# 분석 보조
# ---------------------------------------------------------------------------

def _separate(mix: Path, work: Path, device: str | None, log: Log) -> tuple[np.ndarray, np.ndarray] | None:
    """Demucs 로 (보컬 모노, 반주 스테레오). 설치돼 있지 않거나 실패하면 None."""
    if not available("demucs"):
        log("   · Demucs 가 없어 분리 없이 진행합니다 (보컬만 녹음된 영상에서 가장 좋습니다). "
            "반주가 섞여 있으면: pip install demucs")
        return None
    from .separate import separate

    try:
        stems = separate(mix, work / "stems", "htdemucs", device)
    except Exception as e:  # 모델 다운로드 실패 등
        log(f"   ! 분리 생략 ({e})")
        return None
    voc, _ = sf.read(str(stems["vocals"]), always_2d=True)
    rest = [sf.read(str(p), always_2d=True)[0] for n, p in stems.items() if n != "vocals"]
    backing = np.sum(rest, axis=0) if rest else np.zeros_like(voc)
    return voc.mean(axis=1), backing


def _notes_from_track(track: PitchTrack) -> list[Note]:
    """음높이 곡선 -> 대략의 음표 (키·코드 추정용)."""
    notes, start, cur = [], None, None
    for i, m in enumerate(np.append(track.midi, np.nan)):
        q = None if np.isnan(m) else int(round(m))
        if q != cur:
            if cur is not None and i - start >= 4:
                notes.append(Note(track.times[start], track.times[start] + (i - start) * track.frame_t, cur, 80))
            start, cur = i, q
    return notes


def _chroma_notes(y: np.ndarray, sr: int, beats: list[float]) -> list[Note]:
    """반주 음원의 박별 크로마 -> 가짜 음표 (코드 인식에 쓰기 위함)."""
    ya = librosa.resample(y, orig_sr=sr, target_sr=ANALYSIS_SR)
    chroma = librosa.feature.chroma_cqt(y=ya, sr=ANALYSIS_SR, hop_length=512)
    ft = np.arange(chroma.shape[1]) * 512 / ANALYSIS_SR
    rms = librosa.feature.rms(y=ya, hop_length=512)[0][:chroma.shape[1]]
    loud = np.percentile(rms, 90) if rms.size else 1.0
    out = []
    for a, b in zip(beats[:-1], beats[1:]):
        sel = (ft >= a) & (ft < b)
        if not sel.any() or rms[sel].mean() < 0.05 * loud:
            continue
        c = chroma[:, sel].mean(axis=1)
        for pc in np.flatnonzero(c >= 0.6 * c.max()):
            out.append(Note(a, b, 48 + int(pc), int(40 + 80 * c[pc] / c.max())))
    return out


def _beats(path: Path, bpm: float | None, duration: float, log: Log) -> tuple[list[float], list[float]]:
    from .rhythm import track_beats

    info = track_beats(path, bpm, log=log)
    beats = list(info.beats)
    if len(beats) < 2:
        beats = list(np.arange(0.0, duration, 60.0 / (bpm or 90.0)))
    period = float(np.median(np.diff(beats)))
    while beats[-1] < duration:  # 끝까지 박 채우기
        beats.append(beats[-1] + period)
    return beats, list(info.downbeats)


# ---------------------------------------------------------------------------
# 영상에 소리 입히기
# ---------------------------------------------------------------------------

def has_video(path: Path) -> bool:
    exe = shutil.which("ffprobe")
    if not exe:
        return path.suffix.lower() in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v")
    out = subprocess.run([exe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=codec_type", "-of", "default=nw=1:nk=1", str(path)],
                         capture_output=True, text=True)
    return "video" in out.stdout


def mux_video(video: Path, audio: Path, dst_stem: Path) -> Path:
    """원래 영상 화면 + 새 소리. 화면은 다시 인코딩하지 않는다(화질 그대로, 빠름)."""
    ffmpeg = audio_io.require_ffmpeg()
    ext = video.suffix.lower()
    if ext == ".webm":
        dst, acodec = dst_stem.with_suffix(".webm"), ["-c:a", "libopus", "-b:a", "192k"]
    elif ext in (".mp4", ".m4v", ".mov"):
        dst, acodec = dst_stem.with_suffix(ext), ["-c:a", "aac", "-b:a", "256k"]
    else:
        dst, acodec = dst_stem.with_suffix(".mkv"), ["-c:a", "aac", "-b:a", "256k"]
    base = [ffmpeg, "-y", "-loglevel", "error", "-i", str(video), "-i", str(audio),
            "-map", "0:v:0", "-map", "1:a:0"]
    tail = [*acodec, "-shortest"] + (["-movflags", "+faststart"] if dst.suffix in (".mp4", ".mov", ".m4v") else [])
    if subprocess.run(base + ["-c:v", "copy", *tail, str(dst)], capture_output=True).returncode != 0:
        dst = dst_stem.with_suffix(".mp4")  # 화면 코덱을 그대로 담을 수 없으면 H.264 로
        subprocess.run(base + ["-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
                               "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart",
                               str(dst)], check=True, capture_output=True)
    return dst


def _master(stereo: np.ndarray, target_rms: float = 0.12) -> np.ndarray:
    """음량 맞추기 + 부드러운 리미터 (찌그러짐 방지)."""
    rms = float(np.sqrt(np.mean(stereo ** 2))) or 1.0
    y = stereo * (target_rms / rms)
    knee = 0.8
    a = np.abs(y)
    over = a > knee
    y[over] = np.sign(y[over]) * (knee + (1 - knee) * np.tanh((a[over] - knee) / (1 - knee)))
    return y * 0.98


# ---------------------------------------------------------------------------
# 전체 흐름
# ---------------------------------------------------------------------------

def remix(source: Path, out_dir: Path, opts: RemixOptions | None = None, log: Log = _print,
          progress: Progress | None = None) -> RemixResult:
    opts = opts or RemixOptions()
    if opts.style not in STYLES:
        raise ValueError(f"스타일은 {', '.join(STYLES)} 중 하나입니다.")
    if opts.harmony not in ("both", "up", "down"):
        raise ValueError("화음은 both / up / down 중 하나입니다.")
    source = Path(source).expanduser()
    if not source.exists():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {source}")
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "work"
    notes_log: list[str] = []

    def step(frac: float, msg: str) -> None:
        log(msg)
        if progress:
            progress(frac, msg)

    def note(msg: str) -> None:
        notes_log.append(msg)
        log("   · " + msg)

    # 1) 소리 꺼내기
    step(0.02, "① 영상에서 소리 꺼내는 중")
    mix_path = audio_io.to_wav(source, work / "mix.wav", sr=SR)
    mix, _ = sf.read(str(mix_path), always_2d=True)
    duration = len(mix) / SR

    # 2) 보컬 / 반주 분리
    sep = None
    if opts.separate:
        step(0.06, "② 보컬과 반주 나누는 중")
        sep = _separate(mix_path, work, opts.device, log)
    if sep is not None:
        vocal, backing = sep
        n = min(len(vocal), len(mix))
        vocal, backing, mix = vocal[:n], backing[:n], mix[:n]
        note("보컬/반주 분리: Demucs")
    else:
        vocal, backing = mix.mean(axis=1), None
    keep_backing = opts.keep_backing if opts.keep_backing is not None else opts.style == "harmony"

    # 3) 분석: 음높이, 박, 키, 코드
    step(0.30, "③ 음높이 분석 중")
    track = track_pitch(vocal, SR)
    if not np.any(track.voiced()):
        raise RuntimeError("노래(음높이)를 찾지 못했습니다. 목소리가 들리는 영상인지 확인해 주세요.")
    vnotes = _notes_from_track(track)
    step(0.45, "   박·키·코드 분석 중")
    beats, downbeats = _beats(mix_path, opts.bpm, duration, log)
    timemap = TimeMap(beats)
    tracks: dict[str, list[Note]] = {"vocals": vnotes}
    if backing is not None and np.any(backing):
        tracks["piano"] = _chroma_notes(backing.mean(axis=1), SR, beats)
    if opts.key:
        key = Key.parse(opts.key)
    else:
        key, _ = detect_key((n.pitch, n.duration * (0.5 if name == "vocals" else 1.0))
                            for name, ns in tracks.items() for n in ns)
    note(f"키: {key.name}" + ("" if opts.key else " (자동)"))
    from .rhythm import downbeat_from_model, estimate_downbeat

    bpb = opts.beats_per_bar
    downbeat = downbeat_from_model(beats, downbeats, bpb)
    if downbeat is None:
        downbeat = estimate_downbeat(tracks, timemap, bpb)
    events = detect_chords(tracks, timemap, key, bpb, downbeat)
    from .backing import ChordSpan

    spans = [ChordSpan(float(timemap.to_seconds(e.start + downbeat)),
                       float(timemap.to_seconds(e.end + downbeat)), e.root, e.quality) for e in events]
    names = [e.name(key) for e in events]
    tempo = 60.0 / float(np.median(np.diff(beats)))
    note(f"템포 약 {tempo:.0f} BPM, 코드 {len([e for e in events if e.root is not None])}개: "
         + " ".join(dict.fromkeys(n for n in names if n != "N.C.")))

    def chord_at(t: float):
        for c in spans:
            if c.start <= t < c.end:
                return chord_tones(c.root, c.quality)
        return None

    stems_dir = out_dir / "stems"
    stems_dir.mkdir(exist_ok=True)
    files: list[Path] = []

    # 4) 오토튠 (리드 보컬)
    lead = vocal
    lead_shift = None
    if opts.autotune:
        step(0.55, "④ 오토튠 적용 중")
        lead_shift = autotune_shift(track, key, opts.autotune_strength, opts.hard_tune)
        lead = psola_shift(vocal, SR, track, lead_shift)
        note(f"오토튠: 강도 {opts.autotune_strength:.0%}" + (" (하드 튠)" if opts.hard_tune else ""))
        files.append(_write(stems_dir / "lead_tuned.wav", lead))

    # 5) 화음
    harmonies: list[np.ndarray] = []
    with_harmony = opts.with_harmony if opts.with_harmony is not None else opts.style in HARMONY_BY_DEFAULT
    if with_harmony:
        step(0.62, "⑤ 화음 만드는 중")
        dirs = {"both": (1, -1), "up": (1,), "down": (-1,)}[opts.harmony]
        for i, d in enumerate(dirs):
            hs = harmony_shift(track, key, d, chord_at, lead_shift)
            h = psola_shift(vocal, SR, track, hs, voiced_only=True, jitter_cents=6.0, seed=i + 1)
            h = delay(h, SR, 0.022 + 0.009 * i)  # 다른 사람이 함께 부르는 듯한 미세한 시차
            harmonies.append(pan(h, -0.45 if d > 0 else 0.45))
            files.append(_write(stems_dir / f"harmony_{'up' if d > 0 else 'down'}.wav", h))
        note("화음: " + {"both": "3도 위 + 아래", "up": "3도 위", "down": "3도 아래"}[opts.harmony]
             + " (코드 구성음에 맞춤)")

    # 6) 새 반주
    orch = None
    bstyle = BACKING_OF.get(opts.style)
    if bstyle:
        label = STYLES[bstyle] if bstyle != "orchestra" else "오케스트라"
        step(0.72, f"⑥ {label} 편곡·연주 중")
        from .backing import (STYLE_DESC, STYLE_REVERB, arrange, render_soundfont, synthesize,
                              write_arrangement_midi)

        onotes = arrange(bstyle, spans, beats, bpb, downbeat, duration, key)
        if not onotes:
            note("코드를 찾지 못해 반주를 만들지 못했습니다")
        else:
            midi_path = write_arrangement_midi(onotes, out_dir / f"{bstyle}.mid", tempo)
            files.append(midi_path)
            wet, secs = STYLE_REVERB[bstyle]
            sf_wav = render_soundfont(midi_path, work / f"{bstyle}_sf.wav", opts.soundfont, SR)
            if sf_wav:
                orch, _ = sf.read(str(sf_wav), always_2d=True)
                orch = add_reverb(orch, SR, wet=wet * 0.7, seconds=secs)
                note(f"반주: {label} — {STYLE_DESC[bstyle]} (사운드폰트)")
            else:
                orch = synthesize(onotes, duration, SR, reverb=wet, reverb_seconds=secs)
                note(f"반주: {label} — {STYLE_DESC[bstyle]} (내장 합성기, --soundfont 로 더 실감 나게)")
            files.append(_write(stems_dir / f"{bstyle}.wav", orch))

    # 7) 믹스
    step(0.88, "⑦ 믹스·마스터링 중")
    n = len(vocal)
    voiced_rms = _rms(lead)
    if backing is None and not opts.autotune:
        out = mix[:n].copy()  # 분리 없이: 원본(스테레오) 그대로 위에 더함
    else:
        out = add_reverb(pan(lead, 0.0), SR, wet=0.12, seconds=1.6)
        if backing is not None and keep_backing:
            out = out + backing[:n]
    if harmonies:
        hbus = sum(_fit(h, n) for h in harmonies) * opts.harmony_level
        out = out + add_reverb(hbus, SR, wet=0.3, seconds=2.0)
    if orch is not None:
        orch = _fit(orch, n)
        level = opts.backing_level * LEVEL_OF.get(opts.style, 1.0)
        out = out + orch * (level * voiced_rms / (_rms(orch) or 1.0))
    out = _master(out)
    audio = _write(out_dir / "remix.wav", out)
    files.insert(0, audio)

    # 8) 영상에 입히기
    video = None
    if has_video(source):
        step(0.95, "⑧ 영상에 새 소리 입히는 중")
        video = mux_video(source, audio, out_dir / f"{audio_io.safe_name(source.stem)}_{opts.style}")
        files.insert(0, video)

    info = {"source": str(source), "options": asdict(opts), "key": key.name, "tempo": round(tempo, 1),
            "chords": [{"start": round(c.start, 2), "end": round(c.end, 2), "name": nm}
                       for c, nm in zip(spans, names)],
            "notes": notes_log}
    (out_dir / "remix.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    shutil.rmtree(work, ignore_errors=True)
    step(1.0, "완료")
    return RemixResult(out_dir, audio, video, key.name, key.short_name, names, files, notes_log)


def _rms(x: np.ndarray) -> float:
    x = np.asarray(x)
    a = np.abs(x if x.ndim == 1 else x.mean(axis=1))
    loud = a[a > 0.1 * a.max()] if a.size and a.max() > 0 else a
    return float(np.sqrt(np.mean(loud ** 2))) if loud.size else 0.0


def _fit(x: np.ndarray, n: int) -> np.ndarray:
    x = x if x.ndim == 2 else np.stack([x, x], axis=1)
    return np.pad(x, ((0, max(0, n - len(x))), (0, 0)))[:n]


def _write(path: Path, y: np.ndarray) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.abs(y).max()) if y.size else 0.0
    sf.write(str(path), y / peak * 0.98 if peak > 1.0 else y, SR, subtype="PCM_16")
    return path
