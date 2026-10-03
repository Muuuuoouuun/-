"""입력 처리: 유튜브 링크 다운로드, 로컬 오디오/영상 파일을 WAV 로 변환."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

URL_RE = re.compile(r"^https?://", re.I)


def is_url(text: str) -> bool:
    return bool(URL_RE.match(text.strip()))


def safe_name(text: str, limit: int = 80) -> str:
    text = re.sub(r"[\\/:*?\"<>|\s]+", "_", text).strip("._")
    return text[:limit] or "song"


def require_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg 가 필요합니다. https://ffmpeg.org 에서 설치해 PATH 에 추가하세요.")
    return exe


def download_youtube(url: str, out_dir: Path) -> tuple[Path, str]:
    """yt-dlp 로 오디오만 내려받는다. 반환: (오디오 파일 경로, 영상 제목)."""
    try:
        import yt_dlp
    except ImportError as e:  # pragma: no cover - 설치 안내
        raise RuntimeError("유튜브 다운로드에는 yt-dlp 가 필요합니다: pip install yt-dlp") from e

    out_dir.mkdir(parents=True, exist_ok=True)
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise RuntimeError(f"유튜브에서 오디오를 받지 못했습니다: {e}") from e
    title = info.get("title") or "youtube"
    wav = out_dir / "source.wav"
    if not wav.exists():
        candidates = sorted(out_dir.glob("source.*"))
        if not candidates:
            raise RuntimeError("유튜브 오디오 다운로드에 실패했습니다.")
        wav = candidates[0]
    return wav, title


def to_wav(src: Path, dst: Path, sr: int = 44100, start: float | None = None,
           duration: float | None = None) -> Path:
    """ffmpeg 로 임의의 오디오/영상 파일을 스테레오 WAV 로 변환 (구간 자르기 지원)."""
    ffmpeg = require_ffmpeg()
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-loglevel", "error"]
    if start:
        cmd += ["-ss", str(start)]
    cmd += ["-i", str(src)]
    if duration:
        cmd += ["-t", str(duration)]
    cmd += ["-vn", "-ac", "2", "-ar", str(sr), "-c:a", "pcm_s16le", str(dst)]
    subprocess.run(cmd, check=True)
    return dst


def prepare_input(source: str, work_dir: Path, start: float | None = None,
                  duration: float | None = None) -> tuple[Path, str]:
    """유튜브 URL 또는 파일 경로를 받아 작업 폴더에 mix.wav 를 만든다. 반환: (wav, 제목)."""
    work_dir.mkdir(parents=True, exist_ok=True)
    mix = work_dir / "mix.wav"
    if is_url(source):
        raw, title = download_youtube(source, work_dir / "download")
    else:
        raw = Path(source).expanduser()
        if not raw.exists():
            raise FileNotFoundError(f"파일을 찾을 수 없습니다: {raw}")
        title = raw.stem
    to_wav(raw, mix, start=start, duration=duration)
    return mix, title
