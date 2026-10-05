"""band2sheet 앱 서버 (FastAPI).

  band2sheet app            # http://127.0.0.1:8765 에서 열림
"""

from __future__ import annotations

import io
import json
import os
import re
import zipfile
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__
from ..engines import has, status as engine_status, torch_device
from ..instruments import INSTRUMENTS
from ..pipeline import find_musescore
from ..playback import has_rubberband
from ..synth import available as synth_available
from .jobs import ALLOWED_EXT, JobManager

STATIC = Path(__file__).parent / "static"
SAFE = re.compile(r"^[A-Za-z0-9_.\-]+$")


def default_data_dir() -> Path:
    return Path(os.environ.get("BAND2SHEET_DATA", Path.home() / "band2sheet-data"))


class ChordEdit(BaseModel):
    bar: int  # 화면 마디 인덱스 (measures 목록 기준)
    beat: float = 0.0  # 마디 안 박 위치
    name: str = ""  # 비우면 지우기
    semitones: int = 0  # 화면의 조옮김 양
    length: float | None = None  # 박 수 (없으면 다음 코드까지)


class LyricsEdit(BaseModel):
    bar: int
    text: str = ""


class NotesEdit(BaseModel):
    notes: list[list[float]]
    semitones: int = 0


class SongPick(BaseModel):
    start: float
    end: float
    title: str | None = None
    index: int | None = None


class SongsRequest(BaseModel):
    songs: list[SongPick]


class PlaybackRequest(BaseModel):
    semitones: int = 0


class RenderRequest(BaseModel):
    target_key: str | None = None
    semitones: int | None = None
    direction: str = "nearest"
    grid: int | None = None


def create_app(data_dir: Path | None = None) -> FastAPI:
    manager = JobManager(data_dir or default_data_dir())
    app = FastAPI(title="band2sheet", version=__version__)
    app.state.manager = manager
    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    def job_or_404(job_id: str):
        try:
            return manager.get(job_id)
        except KeyError:
            raise HTTPException(404, "작업을 찾을 수 없습니다.")

    def safe_path(base: Path, *parts: str) -> Path:
        for p in parts:
            if not SAFE.match(p) or p in (".", ".."):
                raise HTTPException(400, "잘못된 경로입니다.")
        path = base.joinpath(*parts).resolve()
        if not str(path).startswith(str(base.resolve())) or not path.is_file():
            raise HTTPException(404, "파일이 없습니다.")
        return path

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (STATIC / "index.html").read_text(encoding="utf-8")

    @app.get("/api/info")
    def info():
        return {
            "version": __version__,
            "device": torch_device(),
            "engines": engine_status(),
            "musescore": bool(find_musescore()),
            "pdf": bool(find_musescore()) or all(has(m) for m in ("verovio", "cairosvg", "pypdf")),
            "synth": synth_available(),  # 악보 소리 (FluidSynth + 사운드폰트)
            "pitch_shift": "rubberband" if has_rubberband() else "librosa",
            "instruments": [{"name": k, "label": v.label, "label_ko": v.label_ko}
                            for k, v in INSTRUMENTS.items()],
            "extensions": sorted(ALLOWED_EXT),
        }

    @app.get("/api/jobs")
    def list_jobs():
        return [_brief(j) for j in manager.list()]

    @app.post("/api/jobs")
    def create_job(file: UploadFile = File(...), options: str = Form("{}")):
        try:
            opts = json.loads(options or "{}")
            if not isinstance(opts, dict):
                raise ValueError
        except ValueError:
            raise HTTPException(400, "옵션 형식이 잘못되었습니다.")
        try:
            job = manager.create(file.filename or "upload", file.file, opts)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return asdict(job)

    @app.get("/api/jobs/{job_id}")
    def get_job(job_id: str):
        return asdict(job_or_404(job_id))

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str):
        job_or_404(job_id)
        try:
            manager.delete(job_id)
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return {"ok": True}

    @app.post("/api/jobs/{job_id}/render")
    def rerender(job_id: str, req: RenderRequest):
        job_or_404(job_id)
        try:
            return manager.rerender(job_id, req.target_key or None, req.semitones, req.direction,
                                    req.grid)
        except (RuntimeError, ValueError) as e:
            raise HTTPException(400, str(e))

    @app.get("/api/jobs/{job_id}/view")
    def view(job_id: str, semitones: int | None = None, key: str | None = None):
        job_or_404(job_id)
        try:
            return manager.view(job_id, semitones, key or None)
        except (RuntimeError, ValueError) as e:
            raise HTTPException(400, str(e))

    @app.put("/api/jobs/{job_id}/chord")
    def edit_chord(job_id: str, req: ChordEdit):
        job_or_404(job_id)
        try:
            manager.edit_chord(job_id, req.bar, req.beat, req.name, req.semitones, req.length)
        except (RuntimeError, ValueError) as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    @app.put("/api/jobs/{job_id}/lyrics")
    def edit_lyrics(job_id: str, req: LyricsEdit):
        job_or_404(job_id)
        try:
            manager.edit_lyrics(job_id, req.bar, req.text)
        except (RuntimeError, ValueError) as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    @app.put("/api/jobs/{job_id}/notes/{track}")
    def edit_notes(job_id: str, track: str, req: NotesEdit):
        job_or_404(job_id)
        try:
            manager.edit_notes(job_id, track, req.notes, req.semitones)
        except KeyError:
            raise HTTPException(404, "악기를 찾을 수 없습니다.")
        except (RuntimeError, ValueError) as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    @app.get("/api/jobs/{job_id}/files/{sheet_dir}/{path:path}")
    def sheet_file(job_id: str, sheet_dir: str, path: str):
        job_or_404(job_id)
        if not sheet_dir.startswith("sheets_"):
            raise HTTPException(400, "잘못된 경로입니다.")
        f = safe_path(manager.job_dir(job_id), sheet_dir, *path.split("/"))
        media = {".musicxml": "application/vnd.recordare.musicxml+xml", ".mid": "audio/midi",
                 ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf"}.get(f.suffix)
        return FileResponse(f, media_type=media, filename=f.name)

    @app.get("/api/jobs/{job_id}/zip/{sheet_dir}")
    def sheet_zip(job_id: str, sheet_dir: str):
        job = job_or_404(job_id)
        if not sheet_dir.startswith("sheets_") or not SAFE.match(sheet_dir):
            raise HTTPException(400, "잘못된 경로입니다.")
        folder = manager.job_dir(job_id) / sheet_dir
        if not folder.is_dir():
            raise HTTPException(404, "악보가 없습니다.")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(folder.rglob("*")):
                if f.is_file():
                    zf.write(f, f.relative_to(folder).as_posix())
        buf.seek(0)
        name = re.sub(r"[^A-Za-z0-9_\-]+", "_", job.title).strip("_")[:60] or "band2sheet"
        return StreamingResponse(buf, media_type="application/zip", headers={
            "Content-Disposition": f'attachment; filename="{name}_{sheet_dir}.zip"; '
                                   f"filename*=UTF-8''{_quote(job.title)}_{sheet_dir}.zip"})

    def audio_file(job_id: str, name: str, semitones: int) -> tuple[Path, str]:
        job_or_404(job_id)
        semitones = max(-12, min(12, semitones))
        d = manager.playback_dir(job_id, semitones)
        if name == "score":  # 악보 소리: 필요할 때 만든다 (몇 초)
            try:
                path = manager.score_audio(job_id, semitones)
            except Exception as e:
                raise HTTPException(500, f"악보 소리를 만들지 못했습니다: {e}") from e
            if path is None:
                raise HTTPException(404, "FluidSynth 와 사운드폰트가 필요합니다.")
            return path, "audio/mpeg" if path.suffix == ".mp3" else "audio/mp4"
        for ext, media in ((".mp3", "audio/mpeg"), (".m4a", "audio/mp4")):
            if (d / f"{name}{ext}").is_file():
                return safe_path(d, f"{name}{ext}"), media
        raise HTTPException(404, "음원이 없습니다.")

    @app.get("/api/jobs/{job_id}/audio/{name}")
    def audio(job_id: str, name: str, semitones: int = 0):
        path, media = audio_file(job_id, name, semitones)
        return FileResponse(path, media_type=media)

    @app.post("/api/jobs/{job_id}/songs")
    def make_songs(job_id: str, req: SongsRequest):
        """곡 나누기: 고른 곡 구간마다 악보 작업을 새로 만든다."""
        job_or_404(job_id)
        if not req.songs:
            raise HTTPException(400, "곡을 하나 이상 고르세요.")
        ids = manager.make_songs(job_id, [p.model_dump() if hasattr(p, "model_dump") else p.dict()
                                          for p in req.songs])
        return {"jobs": ids}

    @app.get("/api/jobs/{job_id}/playback")
    def playback_status(job_id: str, semitones: int = 0):
        job_or_404(job_id)
        return manager.playback(job_id, semitones, start=False)

    @app.post("/api/jobs/{job_id}/playback")
    def playback_make(job_id: str, req: PlaybackRequest):
        job_or_404(job_id)
        return manager.playback(job_id, req.semitones, start=True)

    @app.get("/api/jobs/{job_id}/mr")
    def download_mr(job_id: str, semitones: int = 0, kind: str = "mr"):
        """반주(MR) 내려받기 — mr: 메인 보컬만 뺌, inst: 코러스까지 모두 뺌."""
        if kind not in ("mr", "inst", "mix"):
            raise HTTPException(400, "kind 는 mr, inst, mix 중 하나입니다.")
        path, media = audio_file(job_id, kind, semitones)
        job = manager.get(job_id)
        key = manager.view(job_id, semitones)["key_short"] if semitones else (job.result or {}).get(
            "original_key_short", "")
        label = {"mr": "MR", "inst": "Inst", "mix": "Full"}[kind]
        title = f"{job.title}_{label}_{key}".strip("_")
        ascii_name = re.sub(r"[^A-Za-z0-9_\-]+", "_", title).strip("_")[:60] or "band2sheet"
        return FileResponse(path, media_type=media, headers={
            "Content-Disposition": f'attachment; filename="{ascii_name}{path.suffix}"; '
                                   f"filename*=UTF-8''{_quote(title)}{path.suffix}"})

    @app.get("/api/jobs/{job_id}/project")
    def project_json(job_id: str):
        job_or_404(job_id)
        return FileResponse(safe_path(manager.job_dir(job_id), "project.json"),
                            media_type="application/json")

    return app


def _quote(text: str) -> str:
    from urllib.parse import quote

    return quote(text[:60])


def _brief(job) -> dict:
    return {
        "id": job.id, "title": job.title, "filename": job.filename, "created": job.created,
        "status": job.status, "progress": job.progress, "stage": job.stage,
        "key": job.result["key_short"] if job.result else None,
        "parent": job.parent, "songs": len(job.songs),
    }


def launch(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True,
           data_dir: Path | None = None) -> None:
    import threading
    import webbrowser

    import uvicorn

    app = create_app(data_dir)
    url = f"http://{host}:{port}"
    print(f"band2sheet 앱: {url}  (데이터 폴더: {app.state.manager.data_dir})")
    if open_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=host, port=port, log_level="warning")
