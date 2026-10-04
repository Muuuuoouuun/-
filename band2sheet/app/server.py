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


class UrlJob(BaseModel):
    url: str
    options: dict = {}


class AnalyzeRequest(BaseModel):
    options: dict = {}


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

    @app.post("/api/remix")
    def create_remix_job(file: UploadFile = File(...), options: str = Form("{}")):
        try:
            opts = json.loads(options or "{}")
            if not isinstance(opts, dict):
                raise ValueError
        except ValueError:
            raise HTTPException(400, "옵션 형식이 잘못되었습니다.")
        try:
            job = manager.create_remix(file.filename or "upload", file.file, opts)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return asdict(job)

    @app.get("/api/jobs/{job_id}/remix/{path:path}")
    def remix_file(job_id: str, path: str):
        job = job_or_404(job_id)
        parts = path.split("/")
        if any(not SAFE.match(p) or p in (".", "..") for p in parts):
            raise HTTPException(400, "잘못된 경로입니다.")
        try:
            f = manager.remix_file(job_id, path)
        except KeyError:
            raise HTTPException(404, "파일이 없습니다.")
        media = {".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm",
                 ".mkv": "video/x-matroska", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
                 ".mid": "audio/midi", ".json": "application/json"}.get(f.suffix.lower())
        r, ext = job.result, f.suffix.lower()
        if path == "original":
            name = f"{_file_title(job.title)}_원본{ext}"
        elif path in (r.get("video"), r.get("audio")):
            name = f"{_file_title(job.title)}_{r['style']}{ext}"
        else:
            name = f.name
        return FileResponse(f, media_type=media, filename=name)

    @app.post("/api/jobs/url")
    def create_url_job(req: UrlJob):
        try:
            job = manager.create_from_url(req.url, req.options)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return asdict(job)

    @app.post("/api/jobs/{job_id}/analyze")
    def analyze_job(job_id: str, req: AnalyzeRequest):
        job_or_404(job_id)
        try:
            return asdict(manager.start_analysis(job_id, req.options))
        except RuntimeError as e:
            raise HTTPException(409, str(e))

    @app.get("/api/jobs/{job_id}/source/{kind}")
    def source_file(job_id: str, kind: str):
        job = job_or_404(job_id)
        try:
            f = manager.source_file(job_id, kind)
        except KeyError:
            raise HTTPException(404, "받은 영상/음성이 없습니다.")
        f = safe_path(manager.job_dir(job_id), f.name)
        media = {".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
                 ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
                 ".flac": "audio/flac"}.get(f.suffix.lower())
        return FileResponse(f, media_type=media, filename=f"{_file_title(job.title)}{f.suffix.lower()}")

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

    @app.get("/api/jobs/{job_id}/audio/{name}")
    def audio(job_id: str, name: str):
        job_or_404(job_id)
        d = manager.job_dir(job_id)
        for ext, media in ((".mp3", "audio/mpeg"), (".m4a", "audio/mp4")):
            if (d / "preview" / f"{name}{ext}").is_file():
                return FileResponse(safe_path(d, "preview", f"{name}{ext}"), media_type=media)
        raise HTTPException(404, "음원이 없습니다.")

    @app.get("/api/jobs/{job_id}/project")
    def project_json(job_id: str):
        job_or_404(job_id)
        return FileResponse(safe_path(manager.job_dir(job_id), "project.json"),
                            media_type="application/json")

    return app


def _file_title(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", title).strip(" ._")[:80] or "band2sheet"


def _quote(text: str) -> str:
    from urllib.parse import quote

    return quote(text[:60])


def _brief(job) -> dict:
    return {
        "id": job.id, "title": job.title, "filename": job.filename, "created": job.created,
        "status": job.status, "progress": job.progress, "stage": job.stage,
        "key": job.result["key_short"] if job.result else None,
        "url": job.url, "kind": job.kind,
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
