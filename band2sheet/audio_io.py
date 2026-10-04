"""입력 처리: 유튜브 링크 다운로드(영상/오디오), 음성 추출, 로컬 오디오/영상 파일을 WAV 로 변환."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

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


YTDLP_HINT = ("yt-dlp 를 최신으로 올려 보세요: pip install -U yt-dlp  "
              "(로그인/봇 확인이 필요한 영상은 --cookies-from-browser chrome 같은 쿠키 옵션을 쓰세요)")


def _ytdlp():
    try:
        import yt_dlp
    except ImportError as e:  # pragma: no cover - 설치 안내
        raise RuntimeError("유튜브 다운로드에는 yt-dlp 가 필요합니다: pip install yt-dlp") from e
    return yt_dlp


def _section(start: float | None, duration: float | None) -> tuple[float, float] | None:
    """--start/--duration -> 받을 구간 (초). 없으면 None (전체)."""
    if not start and not duration:
        return None
    s = float(start or 0.0)
    return s, (s + float(duration)) if duration else float("inf")


def _ytdlp_opts(out_dir: Path, stem: str, progress: Callable[[float, str], None] | None,
                cookies: str | None, cookies_from_browser: str | None,
                first_label: str = "영상", section: tuple[float, float] | None = None) -> dict:
    opts: dict = {
        "outtmpl": str(out_dir / f"{stem}.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "concurrent_fragment_downloads": 4,  # DASH 조각 병렬 받기
    }
    if section:
        from yt_dlp.utils import download_range_func

        # 필요한 구간만 받기 (긴 실황에서 한 곡만 쓸 때 다운로드량이 크게 줄어듦)
        opts["download_ranges"] = download_range_func(None, [section])
    if cookies:
        opts["cookiefile"] = str(Path(cookies).expanduser())
    if cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)
    if progress:
        state = {"n": 0, "file": None}

        def hook(d: dict) -> None:
            # 영상+음성 따로 받는 형식이면 파일 두 개를 차례로 받는다.
            if d.get("filename") != state["file"]:
                state["file"] = d.get("filename")
                state["n"] += 1
            what = first_label if state["n"] == 1 else "음성 트랙"
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                frac = min(1.0, d.get("downloaded_bytes", 0) / total) if total else 0.0
                mb = d.get("downloaded_bytes", 0) / 1048576
                progress(frac, f"{what} 받는 중 {frac * 100:.0f}% ({mb:.1f} MB)")
            elif d.get("status") == "finished":
                progress(1.0, f"{what} 받기 완료")

        opts["progress_hooks"] = [hook]
    return opts


def _downloaded_path(info: dict, out_dir: Path, stem: str) -> Path:
    for d in info.get("requested_downloads") or []:
        f = d.get("filepath")
        if f and Path(f).exists():
            return Path(f)
    candidates = sorted(p for p in out_dir.glob(f"{stem}.*") if p.suffix not in (".part", ".ytdl"))
    if not candidates:
        raise RuntimeError("다운로드한 파일을 찾지 못했습니다.")
    return candidates[0]


def _meta(info: dict, url: str) -> dict:
    return {
        "title": info.get("title") or "youtube",
        "url": info.get("webpage_url") or url,
        "id": info.get("id"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "width": info.get("width"),
        "height": info.get("height"),
    }


def download_video(url: str, out_dir: Path, max_height: int = 1080, stem: str = "video",
                   progress: Callable[[float, str], None] | None = None,
                   cookies: str | None = None,
                   cookies_from_browser: str | None = None) -> tuple[Path, dict]:
    """yt-dlp 로 영상(화면+소리)을 MP4 로 내려받는다. 반환: (영상 파일, 영상 정보)."""
    yt_dlp = _ytdlp()
    require_ffmpeg()  # 화면/소리 합치기에 필요
    out_dir.mkdir(parents=True, exist_ok=True)
    opts = _ytdlp_opts(out_dir, stem, progress, cookies, cookies_from_browser)
    h = int(max_height)
    # MP4(H.264+AAC) 우선 -> 어디서나 재생. 없으면 아무 형식이나 받아 MP4 컨테이너로 합친다.
    opts["format"] = (f"bv*[height<=?{h}][ext=mp4]+ba[ext=m4a]/b[height<=?{h}][ext=mp4]/"
                      f"bv*[height<=?{h}]+ba/b[height<=?{h}]/bv*+ba/b")
    opts["merge_output_format"] = "mp4"
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise RuntimeError(f"영상을 받지 못했습니다: {e}\n{YTDLP_HINT}") from e
    return _downloaded_path(info, out_dir, stem), _meta(info, url)


def download_audio(url: str, out_dir: Path, stem: str = "source",
                   progress: Callable[[float, str], None] | None = None,
                   cookies: str | None = None, cookies_from_browser: str | None = None,
                   prefer_ext: str | None = None, start: float | None = None,
                   duration: float | None = None) -> tuple[Path, dict]:
    """yt-dlp 로 소리만 내려받는다 (영상보다 훨씬 작고 빠름). 반환: (오디오 파일, 영상 정보).

    start/duration 을 주면 그 구간만 받는다 (meta["section"] 에 기록). 구간 받기가 안 되는
    사이트면 전체를 받고 meta["section"] 은 None — 이때는 호출한 쪽에서 잘라야 한다.
    prefer_ext="m4a" 면 AAC 스트림을 골라 다시 인코딩하지 않고 저장할 수 있게 한다.
    """
    yt_dlp = _ytdlp()
    out_dir.mkdir(parents=True, exist_ok=True)
    section = _section(start, duration)
    fmt = (f"bestaudio[ext={prefer_ext}]/" if prefer_ext else "") + "bestaudio/best"
    err = None
    for sec in ([section, None] if section else [None]):
        opts = _ytdlp_opts(out_dir, stem, progress, cookies, cookies_from_browser,
                           first_label="음성", section=sec)
        opts["format"] = fmt
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
            path = _downloaded_path(info, out_dir, stem)
            if sec and not _has_audio(path):
                raise RuntimeError("구간 받기 결과가 비어 있음")
        except (yt_dlp.utils.DownloadError, RuntimeError) as e:
            err = e
            for f in out_dir.glob(f"{stem}.*"):  # 실패한 구간 파일 지우고 전체 받기로 재시도
                f.unlink(missing_ok=True)
            continue
        section_info = [sec[0], None if sec[1] == float("inf") else sec[1]] if sec else None
        return path, dict(_meta(info, url), section=section_info)
    raise RuntimeError(f"유튜브에서 오디오를 받지 못했습니다: {err}\n{YTDLP_HINT}") from err


def probe_audio_codec(path: Path) -> str | None:
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    out = subprocess.run([exe, "-v", "error", "-select_streams", "a:0", "-show_entries",
                          "stream=codec_name", "-of", "default=nw=1:nk=1", str(path)],
                         capture_output=True, text=True)
    return out.stdout.strip() or None


def _has_audio(path: Path) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    return probe_audio_codec(path) is not None if shutil.which("ffprobe") else True


AUDIO_CODECS = {
    # 확장자: ffmpeg 인코딩 옵션
    "wav": ["-c:a", "pcm_s16le"],
    "flac": ["-c:a", "flac"],
    "mp3": ["-c:a", "libmp3lame", "-q:a", "0"],
    "m4a": ["-c:a", "aac", "-b:a", "256k"],
}


def extract_audio(src: Path, dst: Path, sr: int = 44100, start: float | None = None,
                  duration: float | None = None) -> Path:
    """영상/음원 파일에서 소리만 뽑아 dst 확장자(wav/flac/mp3/m4a) 형식으로 저장한다."""
    fmt = dst.suffix.lower().lstrip(".")
    if fmt not in AUDIO_CODECS:
        raise ValueError(f"지원하지 않는 음성 형식입니다: {fmt} (가능: {', '.join(AUDIO_CODECS)})")
    if not Path(src).exists():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {src}")
    ffmpeg = require_ffmpeg()
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [ffmpeg, "-y", "-loglevel", "error"]
    if start:
        cmd += ["-ss", str(start)]
    cmd += ["-i", str(src)]
    if duration:
        cmd += ["-t", str(duration)]
    if fmt == "m4a" and probe_audio_codec(src) == "aac":
        # 이미 AAC 면 다시 인코딩하지 않고 그대로 복사 (빠르고 음질 손실 없음)
        cmd += ["-vn", "-c:a", "copy", str(dst)]
    else:
        cmd += ["-vn", "-ac", "2", "-ar", str(sr), *AUDIO_CODECS[fmt], str(dst)]
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode != 0:
        msg = (done.stderr or "").strip().splitlines()
        if fmt == "mp3" and any("libmp3lame" in m or "Unknown encoder" in m for m in msg):
            raise RuntimeError("이 ffmpeg 에는 MP3 인코더가 없습니다. wav/m4a 로 받아 주세요.")
        raise RuntimeError("음성 추출에 실패했습니다: " + (msg[-1] if msg else f"ffmpeg 오류 {done.returncode}"))
    if not dst.exists() or dst.stat().st_size == 0:
        raise RuntimeError("음성 추출 결과가 비어 있습니다 (소리 트랙이 없는 영상일 수 있어요).")
    return dst


@dataclass
class FetchResult:
    title: str
    audio: Path
    video: Path | None = None
    meta: dict = field(default_factory=dict)


def fetch(source: str, out_dir: Path, audio_format: str = "wav", keep_video: bool = False,
          max_height: int = 1080, start: float | None = None, duration: float | None = None,
          progress: Callable[[float, str], None] | None = None, cookies: str | None = None,
          cookies_from_browser: str | None = None) -> FetchResult:
    """유튜브 링크(또는 영상 파일) -> 음성만 다운로드(기본, keep_video 면 영상도) -> 음성 추출.

    결과: out_dir/<제목>.<audio_format> (음성), (keep_video) out_dir/<제목>.mp4, out_dir/info.json
    음성만 받을 때 start/duration 을 주면 그 구간만 내려받는다.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    fmt = audio_format.lower().lstrip(".")
    if fmt not in AUDIO_CODECS:
        raise ValueError(f"지원하지 않는 음성 형식입니다: {fmt} (가능: {', '.join(AUDIO_CODECS)})")
    report = progress or (lambda f, m: None)
    if is_url(source):
        tmp = out_dir / ".download"
        if keep_video:
            raw, meta = download_video(source, tmp, max_height, progress=report, cookies=cookies,
                                       cookies_from_browser=cookies_from_browser)
        else:
            raw, meta = download_audio(source, tmp, progress=report, cookies=cookies,
                                       cookies_from_browser=cookies_from_browser,
                                       prefer_ext="m4a" if fmt == "m4a" else None,
                                       start=start, duration=duration)
    else:
        raw = Path(source).expanduser()
        if not raw.exists():
            raise FileNotFoundError(f"파일을 찾을 수 없습니다: {raw}")
        meta, tmp = {"title": raw.stem, "file": str(raw)}, None
    name = safe_name(meta["title"])
    video = None
    if is_url(source) and keep_video:
        video = out_dir / f"{name}{raw.suffix.lower()}"
        video.unlink(missing_ok=True)  # 같은 영상을 다시 받을 때 (Windows 는 덮어쓰기 이동 불가)
        shutil.move(str(raw), video)
        raw = video
    report(1.0, "음성 추출 중")
    cut = not meta.get("section")  # 구간만 받았으면 이미 잘려 있음
    audio = extract_audio(raw, out_dir / f"{name}.{fmt}", start=start if cut else None,
                          duration=duration if cut else None)
    if tmp is not None:
        shutil.rmtree(tmp, ignore_errors=True)
    meta = dict(meta, start=start, duration_cut=duration, video=video.name if video else None,
                audio=audio.name)
    (out_dir / "info.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return FetchResult(title=meta["title"], audio=audio, video=video, meta=meta)


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
        raw, meta = download_audio(source, work_dir / "download", start=start, duration=duration)
        title = meta["title"]
        if meta.get("section"):  # 구간만 받았으면 다시 자르지 않음
            start = duration = None
    else:
        raw = Path(source).expanduser()
        if not raw.exists():
            raise FileNotFoundError(f"파일을 찾을 수 없습니다: {raw}")
        title = raw.stem
    to_wav(raw, mix, start=start, duration=duration)
    return mix, title
