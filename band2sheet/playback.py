"""듣기용 음원: 조옮김한 키의 고음질 스템·반주(MR).

- 음높이 바꾸기는 Rubber Band(ffmpeg 의 rubberband 필터)를 '고품질' 설정으로, 악기마다 다르게 쓴다.
  · 보컬·코러스: 포먼트(목소리 색) 보존 — 키를 올려도 '다람쥐 목소리'가 되지 않게
  · 베이스: 긴 분석 창 — 저음 음정이 흐려지지 않게
  · 기타·피아노·기타 악기: 어택(타격감)이 앞으로 번지지 않는 설정
  · 드럼: 음높이가 없는 악기라 그대로 둔다 (바꾸면 소리만 나빠진다)
  · 스템 합이 원곡과 다른 나머지 소리(잔향 등)도 따로 옮겨 빠지지 않게
- 반주(MR) = 원곡 - 보컬. 원래 키에서는 원곡에서 보컬 스템만 빼서 악기 소리를 그대로 살린다.
- 합친 소리는 찌그러지지 않게 룩어헤드 리미터를 거친다 (소리 크기는 바꾸지 않음).
ffmpeg 에 rubberband 가 없으면 librosa(위상 보코더)로 대신한다 — 품질은 조금 떨어진다.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from .audio_io import require_ffmpeg

SR = 44100
VOCALS = ("vocals", "backing_vocals")

_BASE = "pitchq=quality:channels=together:phase=laminar"
PROFILES = {
    # 목소리: 부드러운 음 시작 + 포먼트 보존
    "vocals": f"{_BASE}:transients=mixed:detector=soft:formant=preserved",
    "backing_vocals": f"{_BASE}:transients=mixed:detector=soft:formant=preserved",
    # 베이스: 긴 분석 창(저음 음정이 또렷하게) + 또렷한 어택
    "bass": f"{_BASE}:transients=crisp:window=long",
    # 피아노·기타: 어택을 번지지 않게 (mixed 는 시작이 최대 20ms 넘게 앞으로 번졌다)
    "piano": f"{_BASE}:transients=crisp:detector=compound",
    "guitar": f"{_BASE}:transients=crisp:detector=compound",
    "drums": None,  # 음높이 그대로
}
DEFAULT_PROFILE = f"{_BASE}:transients=crisp:detector=compound"


def profile_for(name: str) -> str | None:
    if name.startswith("drum"):
        return None
    return PROFILES.get(name, DEFAULT_PROFILE)


_rb_cache: dict[str, bool] = {}


def has_rubberband() -> bool:
    ffmpeg = require_ffmpeg()
    if ffmpeg not in _rb_cache:
        out = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        _rb_cache[ffmpeg] = any(line.split()[1:2] == ["rubberband"] for line in out.splitlines() if line.strip())
    return _rb_cache[ffmpeg]


def _ffmpeg(*args: str) -> None:
    subprocess.run([require_ffmpeg(), "-y", "-loglevel", "error", *args], check=True)


def prepare(src: Path | str, dst: Path, semitones: float = 0, profile: str | None = None) -> Path:
    """스템 하나를 44.1 kHz 스테레오 float WAV 로 (필요하면 음높이를 옮겨서) 저장 — 파일 단위로 처리해
    긴 곡도 메모리를 적게 쓴다. 길이와 시작 위치는 그대로 (다른 스템과 어긋나지 않게)."""
    shift = bool(semitones) and profile is not None
    if shift and has_rubberband():
        ratio = 2.0 ** (semitones / 12.0)
        _ffmpeg("-i", str(src), "-ac", "2", "-af", f"aresample={SR},rubberband=pitch={ratio:.10f}:{profile}",
                "-ar", str(SR), "-c:a", "pcm_f32le", str(dst))
        return dst
    _ffmpeg("-i", str(src), "-ac", "2", "-ar", str(SR), "-c:a", "pcm_f32le", str(dst))
    if shift:  # rubberband 가 없는 ffmpeg: librosa 위상 보코더 (품질은 조금 낮음)
        import librosa

        y, _ = sf.read(str(dst), always_2d=True, dtype="float32")
        y = np.stack([librosa.effects.pitch_shift(ch, sr=SR, n_steps=semitones, res_type="soxr_hq")
                      for ch in y.T], axis=1)
        sf.write(dst, y, SR, subtype="FLOAT")
    return dst


def as_wav44(src: Path | str, dst: Path) -> Path:
    """이미 44.1 kHz 1~2채널 WAV/FLAC 이면 그대로 쓰고(복사 안 함), 아니면 변환한다."""
    try:
        info = sf.info(str(src))
        if info.samplerate == SR and info.channels in (1, 2) and info.format in ("WAV", "FLAC", "AIFF"):
            return Path(src)
    except RuntimeError:
        pass
    return prepare(src, dst)


def mix_files(inputs: list[tuple[Path, float]], dst: Path, block: int = SR * 10) -> Path:
    """WAV 들을 가중치를 곱해 더한다 (블록 단위 — 메모리 적게). 길이가 다르면 긴 쪽에 맞춘다."""
    files = [(sf.SoundFile(str(p)), w) for p, w in inputs]
    try:
        n = max(f.frames for f, _ in files)
        with sf.SoundFile(str(dst), "w", SR, 2, subtype="FLOAT") as out:
            for start in range(0, n, block):
                m = min(block, n - start)
                acc = np.zeros((m, 2), np.float32)
                for f, w in files:
                    data = f.read(m, dtype="float32", always_2d=True)
                    if len(data):
                        acc[:len(data)] += w * (data[:, :2] if data.shape[1] > 1 else data[:, :1])
                out.write(acc)
    finally:
        for f, _ in files:
            f.close()
    return dst


def rms(path: Path) -> float:
    total, count = 0.0, 0
    for data in sf.blocks(str(path), blocksize=SR * 10, dtype="float32", always_2d=True):
        total += float(np.square(data, dtype=np.float64).sum())
        count += data.size
    return float(np.sqrt(total / max(1, count)))


def build_tracks(stems: dict[str, Path | str], mix: Path | str | None, work: Path, semitones: int = 0,
                 progress=lambda f, msg: None) -> dict[str, Path]:
    """스템(키 이동) + 원곡(mix) + 반주(mr: 메인 보컬만 뺌, inst: 보컬 모두 뺌) WAV 경로."""
    work.mkdir(parents=True, exist_ok=True)
    stems = {k: Path(p) for k, p in stems.items() if Path(p).exists()}
    if not stems:
        return {}
    has_mix = bool(mix) and Path(mix).exists()
    out: dict[str, Path] = {}
    steps = len(stems) + 2
    # 스템 합에 없는 나머지 소리(잔향·분리 잔여물) — 반주에서 빠지지 않게 따로 옮긴다
    residual = None
    if has_mix:
        progress(0.0, "residual")
        flat = {k: as_wav44(p, work / f"_flat_{k}.wav") for k, p in stems.items()}
        orig = as_wav44(mix, work / "_orig.wav")
        residual = mix_files([(orig, 1.0)] + [(f, -1.0) for f in flat.values()], work / "_residual.wav")
        if rms(residual) < 1e-4:
            residual.unlink()
            residual = None
        elif semitones:
            shifted = prepare(residual, work / "_residual_shift.wav", semitones, DEFAULT_PROFILE)
            residual.unlink()
            residual = shifted
        if semitones:  # 옮긴 스템을 새로 만들므로 임시 사본은 지운다 (원본 파일은 그대로)
            for f in flat.values():
                if f.parent == work:
                    f.unlink(missing_ok=True)
        else:
            out.update(flat)
    for i, (name, p) in enumerate(stems.items()):
        progress((i + 1) / steps, name)
        if name not in out:
            out[name] = prepare(p, work / f"{name}.wav", semitones, profile_for(name))
    progress((steps - 1) / steps, "mix")
    if not semitones and has_mix:
        out["mix"] = orig
    else:
        parts = [(p, 1.0) for p in out.values()] + ([(residual, 1.0)] if residual is not None else [])
        out["mix"] = mix_files(parts, work / "mix.wav")
    if "vocals" in out:
        out["mr"] = mix_files([(out["mix"], 1.0), (out["vocals"], -1.0)], work / "mr.wav")
        if "backing_vocals" in out:
            out["inst"] = mix_files([(out["mr"], 1.0), (out["backing_vocals"], -1.0)], work / "inst.wav")
    progress(1.0, "done")
    return out


def encode(src: Path, dst: Path, limit: bool = False, bitrate: str = "256k") -> Path:
    """MP3(안 되면 AAC) 또는 WAV 로 저장. limit: 합친 소리가 0 dBFS 를 넘지 않게 룩어헤드 리미터."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    af = ["-af", "alimiter=limit=0.944:attack=5:release=60:level=disabled"] if limit else []
    if dst.suffix == ".wav":
        _ffmpeg("-i", str(src), *af, "-c:a", "pcm_s16le", str(dst))
        return dst
    base = [require_ffmpeg(), "-y", "-loglevel", "error", "-i", str(src), *af, "-ac", "2", "-ar", str(SR)]
    if subprocess.run(base + ["-c:a", "libmp3lame", "-b:a", bitrate, str(dst.with_suffix(".mp3"))],
                      check=False).returncode == 0:
        return dst.with_suffix(".mp3")
    subprocess.run(base + ["-c:a", "aac", "-b:a", "192k", str(dst.with_suffix(".m4a"))], check=True)
    return dst.with_suffix(".m4a")


SUMMED = ("mix", "mr", "inst")


def make_playback(stems: dict[str, Path | str], mix: Path | str | None, out_dir: Path,
                  semitones: int = 0, progress=lambda f, msg: None) -> list[str]:
    """out_dir 에 듣기용 MP3 를 만든다 (스템 192k, 원곡·반주 256k). 반환: 만든 트랙 이름."""
    out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
        tracks = build_tracks(stems, mix, Path(tmp), semitones, lambda f, m: progress(0.85 * f, m))
        names = []
        for i, (name, path) in enumerate(tracks.items()):
            progress(0.85 + 0.15 * i / max(1, len(tracks)), f"encode {name}")
            if not name.replace("_", "").isalnum():
                continue
            summed = name in SUMMED
            encode(path, out_dir / f"{name}.mp3", limit=summed, bitrate="256k" if summed else "192k")
            names.append(name)
    return names
