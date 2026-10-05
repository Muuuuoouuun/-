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
import re
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
    chords: str | None = None  # 코드 진행 직접 입력 (예: "G C D G" 또는 "G | C D | Em")
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
    tempo: float = 0.0
    chord_text: str = ""
    reused: bool = False  # 저장해 둔 분석을 다시 썼는지


def _print(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# 분석 — 한 번 해 두면 스타일·화음·오토튠을 바꿔 다시 만들 때 그대로 재사용
# ---------------------------------------------------------------------------

PREP_VERSION = 2


@dataclass
class Prep:
    """무거운 준비 단계 결과: 소리, 보컬/반주, 음높이 곡선, 멜로디 음표."""
    mix: np.ndarray  # (n, 2)
    vocal: np.ndarray  # (n,)
    backing: np.ndarray | None  # (n, 2)
    track: PitchTrack
    notes: list[Note]
    reused: bool = False

    @property
    def duration(self) -> float:
        return len(self.mix) / SR


@dataclass
class Analysis:
    key: Key
    tempo: float
    beats: list[float]
    beats_per_bar: int
    downbeat: int
    spans: list  # backing.ChordSpan
    names: list[str]
    vocal_only: bool
    chords_source: str  # auto | user
    notes: list[str] = field(default_factory=list)

    def bar_times(self) -> list[float]:
        bt, bpb = self.beats, self.beats_per_bar
        bars = [b for i, b in enumerate(bt) if (i - self.downbeat) % bpb == 0]
        period = float(np.median(np.diff(bt))) if len(bt) > 1 else 0.5
        first = self.spans[0].start if self.spans else (bars[0] if bars else 0.0)
        while bars and bars[0] > first + 1e-3:
            bars.insert(0, bars[0] - bpb * period)
        return bars

    def chord_text(self) -> str:
        """마디별 코드 진행 (예: 'G | C | D | G G/B'). 앱에서 고쳐서 다시 만들 때 씀."""
        bars = self.bar_times()
        if not self.spans or len(bars) < 2:
            return ""
        out = []
        last = self.spans[-1].end
        for a, b in zip(bars, bars[1:] + [bars[-1] + (bars[-1] - bars[-2])]):
            if a >= last - 1e-3:
                break
            names = []
            for c, nm in zip(self.spans, self.names):
                ov = min(b, c.end) - max(a, c.start)
                if ov >= 0.24 * (b - a) and (not names or names[-1] != nm):
                    names.append(nm)
            out.append(" ".join(names) or "N.C.")
        return " | ".join(out)

    def chord_list(self) -> list[dict]:
        return [{"start": round(c.start, 2), "end": round(c.end, 2), "name": nm}
                for c, nm in zip(self.spans, self.names)]


def _signature(source: Path, opts: RemixOptions) -> list:
    st = source.stat()
    return [PREP_VERSION, st.st_size, st.st_mtime_ns, bool(opts.separate)]


def prepare(source: Path, adir: Path, opts: RemixOptions, log: Log = _print,
            step: Callable[[float, str], None] | None = None) -> Prep:
    """소리 꺼내기 -> (Demucs) 분리 -> 음높이 추적. 같은 파일·설정이면 저장해 둔 결과를 불러온다."""
    step = step or (lambda f, m: log(m))
    adir.mkdir(parents=True, exist_ok=True)
    meta_path = adir / "prep.json"
    sig = _signature(source, opts)
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if meta.get("sig") == sig:
                mix, _ = sf.read(str(adir / "mix.wav"), always_2d=True)
                vocal, _ = sf.read(str(adir / "vocal.wav"))
                backing = sf.read(str(adir / "backing.wav"), always_2d=True)[0] if meta.get("backing") else None
                pz = np.load(adir / "pitch.npz")
                track = PitchTrack(pz["times"], pz["midi"])
                notes = [Note(float(a), float(b), int(p), int(v)) for a, b, p, v in pz["notes"]]
                step(0.45, "① 저장해 둔 분석 결과를 다시 사용합니다 (분리·음높이 분석 생략)")
                return Prep(mix, vocal, backing, track, notes, reused=True)
        except (OSError, ValueError, KeyError):
            pass  # 망가진 캐시는 새로 만든다

    step(0.02, "① 영상에서 소리 꺼내는 중")
    mix_path = audio_io.to_wav(source, adir / "mix.wav", sr=SR)
    mix, _ = sf.read(str(mix_path), always_2d=True)
    sep = None
    if opts.separate:
        step(0.06, "② 보컬과 반주 나누는 중")
        sep = _separate(mix_path, adir / "tmp", opts.device, log)
    if sep is not None:
        vocal, backing = sep
        n = min(len(vocal), len(mix))
        vocal, backing, mix = vocal[:n], backing[:n], mix[:n]
    else:
        vocal, backing = mix.mean(axis=1), None
    step(0.30, "③ 음높이 분석 중")
    track = track_pitch(vocal, SR)
    if not np.any(track.voiced()):
        raise RuntimeError("노래(음높이)를 찾지 못했습니다. 목소리가 들리는 영상인지 확인해 주세요.")
    notes = _melody_notes(vocal, track)

    sf.write(str(adir / "vocal.wav"), vocal, SR, subtype="FLOAT")
    if backing is not None:
        sf.write(str(adir / "backing.wav"), backing, SR, subtype="FLOAT")
    np.savez_compressed(adir / "pitch.npz", times=track.times, midi=track.midi,
                        notes=np.array([[n.start, n.end, n.pitch, n.velocity] for n in notes]).reshape(-1, 4))
    shutil.rmtree(adir / "tmp", ignore_errors=True)
    meta_path.write_text(json.dumps({"sig": sig, "backing": backing is not None}), encoding="utf-8")
    return Prep(mix, vocal, backing, track, notes)


def _melody_notes(vocal: np.ndarray, track: PitchTrack) -> list[Note]:
    """음높이 곡선 -> 멜로디 음표 (비브라토·꺾기는 한 음으로, 같은 음 반복은 음절마다 나눔)."""
    from .instruments import INSTRUMENTS
    from .transcribe import notes_from_f0
    from .vocalfx import HOP

    ya = librosa.resample(vocal, orig_sr=SR, target_sr=ANALYSIS_SR)
    notes = notes_from_f0(ya, ANALYSIS_SR, HOP, track.midi.copy(), INSTRUMENTS["vocals"])
    # 비브라토의 음량 흔들림이 '새 음 시작'으로 잘못 잡힌 조각은 다시 붙인다:
    # 같은 음이 틈 없이 이어지고 경계에서 소리가 크게 줄지 않았으면 한 음.
    rms = librosa.feature.rms(y=ya, frame_length=2048, hop_length=HOP)[0]
    ft = HOP / ANALYSIS_SR
    merged: list[Note] = []
    for n in notes:
        if merged and merged[-1].pitch == n.pitch and n.start - merged[-1].end < 0.035:
            prev = merged[-1]
            k0, kb, k1 = int(prev.start / ft), int(n.start / ft), max(int(n.end / ft), int(n.start / ft) + 1)
            dip = float(rms[max(kb - 2, 0):kb + 3].min()) if kb < len(rms) else 0.0
            ref = min(float(np.median(rms[k0:kb] if kb > k0 else rms[k0:k0 + 1])),
                      float(np.median(rms[kb:k1])) if k1 <= len(rms) else 0.0)
            if dip > 0.55 * ref:
                merged[-1] = Note(prev.start, n.end, prev.pitch, max(prev.velocity, n.velocity))
                continue
        merged.append(n)
    return merged


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


def _beats(y: np.ndarray, bpm: float | None, duration: float, log: Log) -> tuple[list[float], list[float]]:
    import tempfile

    from .rhythm import track_beats

    with tempfile.TemporaryDirectory() as td:  # 비트 추적기는 파일 경로를 받는다
        path = Path(td) / "beat.wav"
        sf.write(str(path), y, SR)
        info = track_beats(path, bpm, log=log)
    beats = list(info.beats)
    if len(beats) < 2:
        beats = list(np.arange(0.0, duration, 60.0 / (bpm or 90.0)))
    period = float(np.median(np.diff(beats)))
    while beats[-1] < duration:  # 끝까지 박 채우기
        beats.append(beats[-1] + period)
    return beats, list(info.downbeats)


CHORD_RE = re.compile(r"^([A-Ga-g])([#b♯♭]?)(maj7|M7|m7|min7|min|m|7|sus4|sus2|sus|dim|°|aug|\+)?"
                      r"(?:/[A-Ga-g][#b♯♭]?)?$")
_QMAP = {None: "", "maj7": "maj7", "M7": "maj7", "m7": "m7", "min7": "m7", "min": "m", "m": "m", "7": "7",
         "sus4": "sus4", "sus": "sus4", "sus2": "sus2", "dim": "dim", "°": "dim", "aug": "", "+": ""}
_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def parse_chord_text(text: str) -> list[list[tuple[int | None, str]]]:
    """'G C D G' (한 마디에 하나) 또는 'G | C D | Em' (마디를 | 로, 한 마디에 여러 개) -> 마디별 코드."""
    text = (text or "").strip()
    if not text:
        return []
    bars = [b.split() for b in text.split("|")] if "|" in text else [[t] for t in text.split()]
    out = []
    for bar in bars:
        cells = []
        for tok in bar:
            if tok.upper() in ("N.C.", "NC", "N", "-", "X", "%"):
                cells.append(cells[-1] if tok == "%" and cells else (None, ""))
                continue
            m = CHORD_RE.match(tok)
            if not m:
                raise ValueError(f"코드를 알아볼 수 없습니다: '{tok}' (예: G, Em, D7, Cmaj7, Bm7, Asus4, D/F#)")
            pc = (_PC[m.group(1).upper()] + {"#": 1, "♯": 1, "b": -1, "♭": -1}.get(m.group(2), 0)) % 12
            cells.append((pc, _QMAP[m.group(3)]))
        out.append(cells or [(None, "")])
    return out


def _user_spans(text: str, bars: list[float], period: float, bpb: int):
    from .backing import ChordSpan

    parsed = parse_chord_text(text)
    bars = list(bars)
    while len(bars) < len(parsed) + 1:
        bars.append(bars[-1] + bpb * period if bars else 0.0)
    spans = []
    for i, cells in enumerate(parsed):
        a, b = bars[i], bars[i + 1]
        for j, (root, q) in enumerate(cells):
            t0, t1 = a + (b - a) * j / len(cells), a + (b - a) * (j + 1) / len(cells)
            if spans and spans[-1].root == root and spans[-1].quality == q:
                spans[-1].end = t1
            else:
                spans.append(ChordSpan(t0, t1, root, q))
    return [c for c in spans if c.root is not None]


def analyze_music(prep: Prep, opts: RemixOptions, log: Log = _print) -> Analysis:
    """박·키·코드. 가볍기 때문에 (템포·키·코드를 바꿔) 다시 만들 때마다 새로 계산한다."""
    from .backing import ChordSpan
    from .harmonize import chord_name, estimate_tempo, harmonize, track_beats_from_notes
    from .rhythm import downbeat_from_model, estimate_downbeat

    bpb = opts.beats_per_bar
    duration = prep.duration
    user_key = Key.parse(opts.key) if opts.key else None
    vocal_only = prep.backing is None or _rms(prep.backing) < 0.08 * (_rms(prep.vocal) or 1.0)
    memo: list[str] = []
    if vocal_only:
        # 반주 없이 노래만: 멜로디에 사람이 반주를 붙이듯 템포·마디·키·코드를 함께 추정
        bpm = opts.bpm or estimate_tempo(prep.notes)
        beats = track_beats_from_notes(prep.notes, duration, bpm)
        h = harmonize(prep.notes, beats, bpb, user_key)
        key, downbeat = h.key, h.downbeat
        spans = [ChordSpan(max(t0, 0.0), t1, r, q) for t0, t1, r, q in h.chords if t1 > 0]
        memo.append("반주 없는 노래로 보고 멜로디에 어울리는 코드를 붙였습니다")
    else:
        beats, downbeats = _beats(prep.mix, opts.bpm, duration, log)
        timemap = TimeMap(beats)
        tracks = {"vocals": prep.notes, "piano": _chroma_notes(prep.backing.mean(axis=1), SR, beats)}
        key = user_key or detect_key((n.pitch, n.duration * (0.5 if name == "vocals" else 1.0))
                                     for name, ns in tracks.items() for n in ns)[0]
        downbeat = downbeat_from_model(beats, downbeats, bpb)
        if downbeat is None:
            downbeat = estimate_downbeat(tracks, timemap, bpb)
        events = detect_chords(tracks, timemap, key, bpb, downbeat)
        spans = [ChordSpan(float(timemap.to_seconds(e.start + downbeat)),
                           float(timemap.to_seconds(e.end + downbeat)), e.root, e.quality)
                 for e in events if e.root is not None]
    tempo = 60.0 / float(np.median(np.diff(beats)))
    a = Analysis(key, tempo, beats, bpb, downbeat, spans, [], vocal_only, "auto", memo)
    if opts.chords:
        period = 60.0 / tempo
        a.spans = _user_spans(opts.chords, a.bar_times(), period, bpb)
        a.chords_source = "user"
        memo.append("코드 진행: 직접 입력한 코드 사용")
    a.names = [chord_name(c.root, c.quality, key) for c in a.spans]
    return a


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


def _master(stereo: np.ndarray, target_rms: float = 0.12, sr: int = 44100) -> np.ndarray:
    """음량 맞추기 + 미리 보는 피크 리미터.

    예전 tanh 곡선은 큰 소리에서 파형 자체를 휘게 해 찌그러짐이 생겼다. 이제는 파형은 두고
    피크 몇 ms 전부터 음량만 부드럽게 줄인다. 20Hz 아래 울림(직류·바람 소리)도 걷어 낸다.
    """
    from .sound import highpass, limit

    y = highpass(np.asarray(stereo, dtype=float), sr, 20.0)
    rms = float(np.sqrt(np.mean(y ** 2))) or 1.0
    return limit(y * (target_rms / rms), sr, ceiling=0.96)


# ---------------------------------------------------------------------------
# 전체 흐름
# ---------------------------------------------------------------------------

def _validate(opts: RemixOptions) -> None:
    if opts.style not in STYLES:
        raise ValueError(f"스타일은 {', '.join(STYLES)} 중 하나입니다.")
    if opts.harmony not in ("both", "up", "down"):
        raise ValueError("화음은 both / up / down 중 하나입니다.")
    if opts.beats_per_bar not in (2, 3, 4, 6):
        raise ValueError("박자는 2, 3, 4, 6 박만 지원합니다.")
    if opts.chords:
        parse_chord_text(opts.chords)  # 형식 오류를 일찍 알림
    if opts.key:
        Key.parse(opts.key)


def remix(source: Path, out_dir: Path, opts: RemixOptions | None = None, log: Log = _print,
          progress: Progress | None = None, analysis_dir: Path | None = None) -> RemixResult:
    """후보정 전체. 분석 결과는 analysis_dir(기본 out_dir/analysis)에 저장해 두고 다음에 재사용한다."""
    opts = opts or RemixOptions()
    _validate(opts)
    source = Path(source).expanduser()
    if not source.exists():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {source}")
    out_dir.mkdir(parents=True, exist_ok=True)
    adir = analysis_dir or out_dir / "analysis"
    notes_log: list[str] = []

    def step(frac: float, msg: str) -> None:
        log(msg)
        if progress:
            progress(frac, msg)

    def note(msg: str) -> None:
        notes_log.append(msg)
        log("   · " + msg)

    prep = prepare(source, adir, opts, log, step)
    if prep.backing is not None:
        note("보컬/반주 분리: Demucs")
    step(0.48, "   박·키·코드 분석 중")
    an = analyze_music(prep, opts, log)
    for m in an.notes:
        note(m)
    key, spans, names, beats, bpb, downbeat = an.key, an.spans, an.names, an.beats, an.beats_per_bar, an.downbeat
    tempo, duration = an.tempo, prep.duration
    vocal, backing, mix, track = prep.vocal, prep.backing, prep.mix, prep.track
    note(f"키: {key.name}" + ("" if opts.key else " (자동)"))
    note(f"템포 약 {tempo:.0f} BPM" + ("" if opts.bpm else " (자동)") + f", {bpb}박자")
    note("코드 진행: " + (an.chord_text() or "(없음)"))
    keep_backing = opts.keep_backing if opts.keep_backing is not None else opts.style == "harmony"

    def chord_at(t: float):
        for c in spans:
            if c.start <= t < c.end:
                return chord_tones(c.root, c.quality)
        return None

    # 지난번 결과물 정리 (분석 폴더는 그대로)
    _clear_outputs(out_dir)
    stems_dir = out_dir / "stems"
    stems_dir.mkdir(exist_ok=True)
    files: list[Path] = []
    work = adir / "tmp"
    work.mkdir(exist_ok=True)
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
        # 음높이를 옮긴 목소리의 거친 고역(조각 이음 소리)과 아래 화음의 웅웅거림을 살짝 덜어 냄
        from .sound import eq, highpass

        hbus = eq(highpass(hbus, SR, 90.0), SR, [(7000, -3.0, 0.7, "highshelf"), (2800, 1.0, 1.0)])
        out = out + add_reverb(hbus, SR, wet=0.3, seconds=2.0)
    if orch is not None:
        orch = _fit(orch, n)
        level = opts.backing_level * LEVEL_OF.get(opts.style, 1.0)
        out = out + orch * (level * voiced_rms / (_rms(orch) or 1.0))
    out = _master(out, sr=SR)
    audio = _write(out_dir / "remix.wav", out)
    files.insert(0, audio)

    # 8) 영상에 입히기
    video = None
    if has_video(source):
        step(0.95, "⑧ 영상에 새 소리 입히는 중")
        video = mux_video(source, audio, out_dir / f"{audio_io.safe_name(source.stem)}_{opts.style}")
        files.insert(0, video)

    info = {"source": str(source), "options": asdict(opts), "key": key.name, "key_short": key.short_name,
            "tempo": round(tempo, 1), "beats_per_bar": bpb, "vocal_only": an.vocal_only,
            "chords_source": an.chords_source, "chord_text": an.chord_text(), "chords": an.chord_list(),
            "video": video.name if video else None, "notes": notes_log}
    (out_dir / "remix.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    shutil.rmtree(work, ignore_errors=True)
    step(1.0, "완료")
    return RemixResult(out_dir, audio, video, key.name, key.short_name, names, files, notes_log,
                       tempo=round(tempo, 1), chord_text=an.chord_text(), reused=prep.reused)


def _clear_outputs(out_dir: Path) -> None:
    """다시 만들 때 이전 결과물(영상·음원·트랙·MIDI)만 지운다."""
    old = out_dir / "remix.json"
    if old.exists():
        try:
            v = json.loads(old.read_text(encoding="utf-8")).get("video")
            if v and "/" not in v:
                (out_dir / v).unlink(missing_ok=True)
        except ValueError:
            pass
        old.unlink()
    shutil.rmtree(out_dir / "stems", ignore_errors=True)
    (out_dir / "remix.wav").unlink(missing_ok=True)
    for f in out_dir.glob("*.mid"):
        f.unlink()





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
