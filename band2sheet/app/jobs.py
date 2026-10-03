"""앱 작업(job) 관리: 업로드한 파일마다 폴더를 만들고, 백그라운드에서 분석·악보 생성."""

from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from ..audio_io import require_ffmpeg
from ..pipeline import AnalyzeOptions, RenderOptions, RenderResult, analyze, render
from ..project import Project, TimeMap

ALLOWED_EXT = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".aif", ".aiff",
               ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v",
               ".zip"}  # zip = 멀티트랙(스템) 묶음


@dataclass
class Job:
    id: str
    title: str
    filename: str
    created: float
    options: dict
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    stage: str = "대기 중"
    log: list[str] = field(default_factory=list)
    error: str | None = None
    result: dict | None = None  # 최근 렌더링 결과
    renders: dict[str, dict] = field(default_factory=dict)  # 키 -> 렌더링 결과


class JobManager:
    def __init__(self, data_dir: Path, workers: int = 1):
        self.data_dir = data_dir
        self.jobs_dir = data_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.pool = ThreadPoolExecutor(max_workers=workers)  # 모델이 무거워 기본 한 번에 하나
        self.lock = threading.Lock()
        self.jobs: dict[str, Job] = {}
        self._load()

    # ------------------------------------------------------------------ 저장/불러오기
    def _load(self) -> None:
        for d in self.jobs_dir.iterdir():
            f = d / "job.json"
            if not f.exists():
                continue
            try:
                job = Job(**json.loads(f.read_text(encoding="utf-8")))
            except (TypeError, ValueError):
                continue
            if job.status in ("queued", "running"):  # 앱이 중간에 꺼졌던 작업
                job.status, job.error = "error", "앱이 종료되어 작업이 중단되었습니다. 다시 실행해 주세요."
            self.jobs[job.id] = job

    def _save(self, job: Job) -> None:
        path = self.job_dir(job.id) / "job.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(job), ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)

    def job_dir(self, job_id: str) -> Path:
        if not job_id.isalnum():
            raise KeyError(job_id)
        return self.jobs_dir / job_id

    def get(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return job

    def list(self) -> list[Job]:
        return sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)

    def delete(self, job_id: str) -> None:
        job = self.get(job_id)
        if job.status == "running":
            raise RuntimeError("실행 중인 작업은 지울 수 없습니다.")
        with self.lock:
            self.jobs.pop(job_id, None)
        shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    # ------------------------------------------------------------------ 생성/실행
    def create(self, filename: str, data_stream, options: dict) -> Job:
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_EXT:
            raise ValueError(f"지원하지 않는 파일 형식입니다: {ext or '(확장자 없음)'}")
        job_id = uuid.uuid4().hex[:12]
        d = self.job_dir(job_id)
        d.mkdir(parents=True)
        src = d / f"input{ext}"
        with open(src, "wb") as f:
            shutil.copyfileobj(data_stream, f)
        title = (options.get("title") or Path(filename).stem).strip()[:120] or "제목 없음"
        job = Job(id=job_id, title=title, filename=Path(filename).name, created=time.time(),
                  options=options)
        with self.lock:
            self.jobs[job_id] = job
        self._save(job)
        self.pool.submit(self._run, job_id)
        return job

    def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        d = self.job_dir(job_id)
        src = next(d.glob("input.*"))
        opts = job.options
        last_save = [0.0]

        def log(msg: str) -> None:
            job.log.append(msg)
            job.log = job.log[-300:]
            if time.time() - last_save[0] > 1.0:
                last_save[0] = time.time()
                self._save(job)

        def progress(frac: float, msg: str) -> None:
            job.progress, job.stage = round(frac, 3), msg.strip()

        job.status = "running"
        self._save(job)
        try:
            a = AnalyzeOptions(
                quality=opts.get("quality", "standard"),
                split_vocals=bool(opts.get("split_vocals", True)),
                split_drums=bool(opts.get("split_drums", True)),
                stems=opts.get("stems") or None,
                bpm=float(opts["bpm"]) if opts.get("bpm") else None,
                time_signature=opts.get("time_signature") or "auto",
                lyrics=bool(opts.get("lyrics", False)),
                language=opts.get("language") or "ko",
                start=float(opts["start"]) if opts.get("start") else None,
                duration=float(opts["duration"]) if opts.get("duration") else None,
            )
            source = str(src)
            if src.suffix.lower() == ".zip":
                a.stems_dir = extract_stems_zip(src, d / "input_stems")
                source = ""
            project = analyze(source, d, a, log, progress)
            project.title = job.title
            project.save(d / "project.json")
            progress(0.96, "미리듣기 음원 만드는 중")
            make_previews(project, d)
            progress(0.98, "악보 만드는 중")
            res = render(project, d, RenderOptions(pdf=bool(opts.get("pdf"))), log)
            job.result = render_summary(res, project, d)
            job.renders[job.result["key_short"]] = job.result
            if opts.get("target_key"):
                res2 = render(project, d, RenderOptions(target_key=opts["target_key"]), log)
                job.result = render_summary(res2, project, d)
                job.renders[job.result["key_short"]] = job.result
            job.status, job.progress, job.stage = "done", 1.0, "완료"
        except Exception as e:  # 화면에 오류 표시
            job.status, job.error = "error", str(e)
            job.log.append("오류: " + str(e))
            job.log.append(traceback.format_exc(limit=3))
        finally:
            self._save(job)

    def rerender(self, job_id: str, target_key: str | None, semitones: int | None,
                 direction: str = "nearest", subdiv: int | None = None) -> dict:
        job = self.get(job_id)
        if job.status != "done":
            raise RuntimeError("분석이 끝난 뒤에 조옮김할 수 있습니다.")
        d = self.job_dir(job_id)
        project = Project.load(d / "project.json")
        res = render(project, d, RenderOptions(target_key=target_key, semitones=semitones,
                                               direction=direction, subdiv=subdiv),
                     log=lambda m: None)
        summary = render_summary(res, project, d)
        with self.lock:
            job.result = summary
            job.renders[summary["key_short"]] = summary
        self._save(job)
        return summary


def extract_stems_zip(src: Path, dst: Path) -> Path:
    """멀티트랙 ZIP 을 안전하게 풀기 (오디오 파일만, 경로 탈출 방지)."""
    import zipfile

    from ..separate import AUDIO_EXT

    dst.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(src) as zf:
        for info in zf.infolist():
            name = Path(info.filename)
            if info.is_dir() or name.suffix.lower() not in AUDIO_EXT or name.name.startswith("."):
                continue
            if any(part in ("..", "") for part in name.parts) or name.is_absolute():
                continue
            if "__MACOSX" in name.parts:
                continue
            target = dst.joinpath(*name.parts[-2:]) if len(name.parts) > 1 and \
                "drum" in name.parts[-2].lower() else dst / name.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as fsrc, open(target, "wb") as fdst:
                shutil.copyfileobj(fsrc, fdst)
            count += 1
    if not count:
        raise ValueError("ZIP 안에 오디오 파일이 없습니다.")
    return dst


def render_summary(res: RenderResult, project: Project, job_dir: Path) -> dict:
    """화면에 보낼 렌더링 결과 요약."""
    sheet_dir = res.out_dir.name
    files = sorted(f.relative_to(res.out_dir).as_posix() for f in res.files)
    return {
        "key": res.key.name,
        "key_short": res.key.short_name,
        "original_key": project.key.name,
        "original_key_short": project.key.short_name,
        "semitones": res.semitones,
        "sheet_dir": sheet_dir,
        "files": files,
        "parts": res.parts,
        "chord_chart": res.chord_chart,
        "tempo": round(project.tempo_bpm, 1),
        "time_signature": project.time_signature,
        "engines": project.engines,
        "measures": measure_times(project),
        "stems": sorted({p.stem for p in (job_dir / "preview").glob("*.*")
                         if p.suffix in (".mp3", ".m4a")}),
    }


def measure_times(project: Project) -> list[float]:
    """악보 마디마다 시작 시각(초). 재생 위치에 맞춰 현재 마디를 표시하는 데 쓴다."""
    from ..score import Grid

    grid = Grid.for_project(project)
    tm: TimeMap = grid.timemap
    bpb = project.beats_per_bar
    last_beat = float(tm.to_beats(max((n.end for t in project.tracks.values() for n in t.notes),
                                      default=project.beat_times[-1])))
    n_bars = int((last_beat - project.downbeat + grid.shift_beats) // bpb) + 2
    return [round(float(tm.to_seconds(m * bpb + project.downbeat - grid.shift_beats)), 3)
            for m in range(max(n_bars, 1))]


def make_previews(project: Project, job_dir: Path) -> None:
    """스템을 가벼운 MP3 로 변환해 브라우저 믹서에서 바로 재생할 수 있게 한다."""
    ffmpeg = require_ffmpeg()
    out = job_dir / "preview"
    out.mkdir(exist_ok=True)
    sources = dict(project.stems)
    mix = job_dir / "work" / "mix.wav"
    if mix.exists():
        sources["mix"] = str(mix)
    for name, path in sources.items():
        if not Path(path).exists() or not name.replace("_", "").isalnum():
            continue
        # MP3 는 모든 브라우저에서 재생된다. ffmpeg 에 MP3 인코더가 없으면 AAC(m4a)로.
        base = [ffmpeg, "-y", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "2", "-ar", "44100"]
        done = subprocess.run(base + ["-c:a", "libmp3lame", "-b:a", "160k", str(out / f"{name}.mp3")],
                              check=False).returncode == 0
        if not done:
            subprocess.run(base + ["-c:a", "aac", "-b:a", "128k", str(out / f"{name}.m4a")], check=False)
