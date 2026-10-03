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
from ..engines import status as engine_status, torch_device
from ..instruments import INSTRUMENTS
from ..pipeline import find_musescore
from .jobs import ALLOWED_EXT, JobManager

STATIC = Path(__file__).parent / "static"
SAFE = re.compile(r"^[A-Za-z0-9_.\-]+$")


def default_data_dir() -> Path:
    return Path(os.environ.get("BAND2SHEET_DATA", Path.home() / "band2sheet-data"))


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


def _quote(text: str) -> str:
    from urllib.parse import quote

    return quote(text[:60])


def _brief(job) -> dict:
    return {
        "id": job.id, "title": job.title, "filename": job.filename, "created": job.created,
        "status": job.status, "progress": job.progress, "stage": job.stage,
        "key": job.result["key_short"] if job.result else None,
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
