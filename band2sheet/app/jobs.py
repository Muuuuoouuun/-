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

from ..audio_io import (AUDIO_CODECS, download_audio, download_video, extract_audio, is_url,
                        require_ffmpeg)
from ..pipeline import AnalyzeOptions, RenderOptions, RenderResult, analyze, render
from ..project import Project
from ..view import measure_times

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
    status: str = "queued"  # queued | running | ready(영상·음성만 받음) | done | error
    progress: float = 0.0
    stage: str = "대기 중"
    log: list[str] = field(default_factory=list)
    error: str | None = None
    result: dict | None = None  # 최근 렌더링 결과
    renders: dict[str, dict] = field(default_factory=dict)  # 키 -> 렌더링 결과
    url: str | None = None  # 링크로 만든 작업 (유튜브 등)
    source: dict | None = None  # 받은 영상·추출한 음성 정보 (파일 이름, 길이, 올린 사람 …)


class EditMixin:
    """앱 화면에서의 보기·수정 (JobManager 에 섞어 쓴다)."""

    def _project(self, job_id: str) -> Project:
        job = self.get(job_id)
        if job.status != "done":
            raise RuntimeError("분석이 끝난 뒤에 볼 수 있습니다.")
        return Project.load(self.job_dir(job_id) / "project.json")

    def view(self, job_id: str, semitones: int | None = None, target_key: str | None = None) -> dict:
        from ..view import build_view

        data = build_view(self._project(job_id), semitones, target_key)
        data["stems"] = sorted({p.stem for p in (self.job_dir(job_id) / "preview").glob("*.*")
                                if p.suffix in (".mp3", ".m4a")})
        data["stale"] = bool((self.get(job_id).result or {}).get("stale"))
        return data

    def _save_edit(self, job_id: str, project: Project) -> None:
        with self.lock:
            project.save(self.job_dir(job_id) / "project.json")
            job = self.get(job_id)
            if job.result:
                job.result["stale"] = True  # 악보 파일(MusicXML 등)을 다시 만들어야 함
            job.renders = {}
        self._save(job)

    def edit_chord(self, job_id: str, bar_index: int, beat: float, name: str, semitones: int = 0,
                   length: float | None = None) -> None:
        from ..score import Grid
        from ..view import set_chord

        project = self._project(job_id)
        grid = Grid.for_project(project)
        pos = bar_index * project.beats_per_bar + beat - grid.shift_beats
        set_chord(project, pos, name, semitones, length)
        self._save_edit(job_id, project)

    def edit_lyrics(self, job_id: str, bar_index: int, text: str) -> None:
        from ..score import Grid
        from ..view import set_bar_lyrics

        project = self._project(job_id)
        offset = Grid.for_project(project).shift_beats // project.beats_per_bar
        set_bar_lyrics(project, bar_index - offset, text)
        self._save_edit(job_id, project)

    def edit_notes(self, job_id: str, track: str, notes: list, semitones: int = 0) -> None:
        from ..view import set_track_notes

        project = self._project(job_id)
        set_track_notes(project, track, notes, semitones)
        self._save_edit(job_id, project)


class JobManager(EditMixin):
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

    def create_from_url(self, url: str, options: dict) -> Job:
        """유튜브 등 영상 링크로 작업 만들기: 음성만 받아 바로 악보 (기본).

        keep_video: 영상도 받기, fetch_only: 받기·추출까지만 하고 '준비됨' 에서 멈춤.
        """
        url = (url or "").strip()
        if not is_url(url) or len(url) > 2000 or any(c.isspace() for c in url):
            raise ValueError("http:// 또는 https:// 로 시작하는 영상 링크를 넣어 주세요.")
        fmt = str(options.get("audio_format") or "mp3").lower()
        if fmt not in AUDIO_CODECS:
            raise ValueError(f"지원하지 않는 음성 형식입니다: {fmt}")
        job_id = uuid.uuid4().hex[:12]
        self.job_dir(job_id).mkdir(parents=True)
        title = (options.get("title") or "").strip()[:120] or "링크에서 받는 중…"
        job = Job(id=job_id, title=title, filename=url, created=time.time(), options=options, url=url)
        with self.lock:
            self.jobs[job_id] = job
        self._save(job)
        self.pool.submit(self._run, job_id)
        return job

    def start_analysis(self, job_id: str, options: dict) -> Job:
        """영상·음성만 받아 둔 작업(ready)이나 실패한 작업을 이어서 악보까지 만들기."""
        job = self.get(job_id)
        has_input = any(self.job_dir(job_id).glob("input.*"))
        if job.status not in ("ready", "error") or not (has_input or job.url):
            raise RuntimeError("영상·음성을 받아 둔 작업(또는 실패한 작업)만 이어서 악보를 만들 수 있습니다.")
        with self.lock:
            job.options = {**job.options, **options, "fetch_only": False}
            job.status, job.error, job.progress, job.stage = "queued", None, 0.0, "대기 중"
        self._save(job)
        self.pool.submit(self._run, job_id)
        return job

    def source_file(self, job_id: str, kind: str) -> Path:
        job = self.get(job_id)
        name = (job.source or {}).get(kind)
        if kind not in ("video", "audio") or not name:
            raise KeyError(kind)
        return self.job_dir(job_id) / name

    def _fetch(self, job: Job, d: Path, log, progress) -> None:
        """링크 작업: 음성만(기본) 또는 영상 다운로드 -> input.<ext> 로 저장 -> 음성 추출."""
        opts = job.options
        keep_video = bool(opts.get("keep_video"))
        progress(0.0, "링크 정보 확인 중")
        log(f"{'영상' if keep_video else '음성'} 받기: {job.url}")
        report = lambda f, m: progress(0.08 * f, m)  # noqa: E731
        if keep_video:
            raw, meta = download_video(job.url, d / "download",
                                       max_height=int(opts.get("max_height") or 720), progress=report)
        else:
            raw, meta = download_audio(job.url, d / "download", progress=report)
        src = d / f"input{raw.suffix.lower()}"
        shutil.move(str(raw), src)
        shutil.rmtree(d / "download", ignore_errors=True)
        log(f"{'영상' if keep_video else '음성'} 저장: {meta['title']} ({src.stat().st_size / 1048576:.1f} MB)")
        if not (opts.get("title") or "").strip():
            job.title = meta["title"][:120]
        fmt = str(opts.get("audio_format") or "mp3").lower()
        progress(0.09, "음성 추출 중")
        try:
            audio = extract_audio(src, d / f"source_audio.{fmt}")
        except RuntimeError:
            if fmt != "mp3":
                raise
            audio = extract_audio(src, d / "source_audio.m4a")  # MP3 인코더 없는 ffmpeg
        log(f"음성 추출: {audio.name} ({audio.stat().st_size / 1048576:.1f} MB)")
        job.source = dict(meta, video=src.name if keep_video else None, audio=audio.name)

    def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        d = self.job_dir(job_id)
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
            if job.url and not job.source:
                self._fetch(job, d, log, progress)
                if opts.get("fetch_only"):
                    job.status, job.progress, job.stage = "ready", 0.1, "영상·음성 준비 완료"
                    return
            src = next(d.glob("input.*"))
            a = AnalyzeOptions(
                quality=opts.get("quality", "standard"),
                split_vocals=bool(opts.get("split_vocals", True)),
                split_drums=bool(opts.get("split_drums", True)),
                cleanup=bool(opts.get("cleanup", True)),
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
                res2 = render(project, d, RenderOptions(target_key=opts["target_key"],
                                                        pdf=bool(opts.get("pdf"))), log)
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
                                               direction=direction, subdiv=subdiv,
                                               pdf=bool(job.options.get("pdf"))),
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
        "nashville_chart": res.nashville_chart,
        "key_changes": res.key_changes,
        "pickup": res.pickup_ql > 0,
        # 구간 시작 마디 -> 재생 위치 목록(measures)의 인덱스 (못갖춘마디가 있으면 0번 마디가 있음)
        "sections": [dict(sec, index=sec["start_measure"] - (0 if res.pickup_ql > 0 else 1))
                     for sec in res.sections],
        "separation": project.separation,
        "duration": round(max((n.end for t in project.tracks.values() for n in t.notes), default=0.0), 2),
    }


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
