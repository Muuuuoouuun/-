"""앱 작업(job) 관리: 업로드한 파일마다 폴더를 만들고, 백그라운드에서 분석·악보 생성."""

from __future__ import annotations

import json
import os
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
               ".zip",  # zip = 멀티트랙(스템) 묶음
               ".mid", ".midi", ".kar", ".musicxml", ".mxl", ".xml"}  # 악보 파일 -> 변환
SCORE_OR_STEMS_EXT = {".zip", ".mid", ".midi", ".kar", ".musicxml", ".mxl", ".xml"}  # 곡 나누기 대상 아님


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
    kind: str = "score"  # score(악보) | remix(내 영상 후보정)
    source: dict | None = None  # 받은 영상·추출한 음성 정보 (파일 이름, 길이, 올린 사람 …)
    songs: list[dict] = field(default_factory=list)  # 곡 나누기: 찾은 곡 구간 (status = choose)
    children: list[str] = field(default_factory=list)  # 곡 나누기로 만든 작업들
    parent: str | None = None
    duration: float | None = None  # 곡 나누기: 원본 길이 (초)


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


class PlaybackMixin:
    """듣기용 음원(스템·원곡·반주 MR)을 키마다 만들어 둔다 (JobManager 에 섞어 쓴다)."""

    def playback_dir(self, job_id: str, semitones: int = 0) -> Path:
        d = self.job_dir(job_id) / "preview"
        return d if not semitones else d / f"k{semitones:+d}"

    def playback_tracks(self, job_id: str, semitones: int = 0) -> list[str]:
        d = self.playback_dir(job_id, semitones)
        if not d.is_dir():
            return []
        return sorted({p.stem for p in d.glob("*.*") if p.suffix in (".mp3", ".m4a")})

    def playback_ready(self, job_id: str, semitones: int = 0) -> bool:
        return (self.playback_dir(job_id, semitones) / "done.json").exists()

    def playback(self, job_id: str, semitones: int = 0, start: bool = True) -> dict:
        """상태: ready(다 만듦) | working(만드는 중) | missing(아직 안 만듦) | error."""
        semitones = max(-12, min(12, int(semitones)))
        key = (job_id, semitones)
        with self.lock:
            st = self._playback.get(key)
            if self.playback_ready(job_id, semitones):
                st = {"status": "ready", "progress": 1.0}
            elif st is None or st["status"] == "error" and start:
                if start and self.get(job_id).status == "done":
                    st = {"status": "working", "progress": 0.0}
                    self._playback[key] = st
                    self.audio_pool.submit(self._make_playback, job_id, semitones, st)
                else:
                    st = st or {"status": "missing", "progress": 0.0}
        return {"semitones": semitones, **st, "tracks": self.playback_tracks(job_id, semitones)
                if st["status"] == "ready" else []}

    def score_audio(self, job_id: str, semitones: int = 0) -> Path | None:
        """'악보 소리'(채보한 음표를 사운드폰트로 연주) — 음표를 고치면 다시 만든다."""
        from ..synth import render_score_audio

        d = self.job_dir(job_id)
        out = self.playback_dir(job_id, semitones) / "score.mp3"
        project_file = d / "project.json"
        with self._score_lock:
            if out.exists() and out.stat().st_mtime >= project_file.stat().st_mtime:
                return out
            out.parent.mkdir(parents=True, exist_ok=True)
            return render_score_audio(Project.load(project_file), out, semitones)

    def _make_playback(self, job_id: str, semitones: int, st: dict) -> None:
        from ..playback import make_playback

        try:
            d = self.job_dir(job_id)
            project = Project.load(d / "project.json")
            out = self.playback_dir(job_id, semitones)
            mix = d / "work" / "mix.wav"

            def progress(f, _msg):
                st["progress"] = round(f, 3)

            names = make_playback(project.stems, mix if mix.exists() else None, out, semitones, progress)
            (out / "done.json").write_text(json.dumps({"tracks": names, "semitones": semitones}),
                                           encoding="utf-8")
            st.update(status="ready", progress=1.0)
        except Exception as e:  # 화면에 알림
            st.update(status="error", error=str(e))


class JobManager(EditMixin, PlaybackMixin):
    def __init__(self, data_dir: Path, workers: int = 1):
        self.data_dir = data_dir
        self.jobs_dir = data_dir / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.pool = ThreadPoolExecutor(max_workers=workers)  # 모델이 무거워 기본 한 번에 하나
        self.audio_pool = ThreadPoolExecutor(max_workers=1)  # 키별 듣기용 음원 만들기
        self._playback: dict[tuple[str, int], dict] = {}
        self._score_lock = threading.Lock()
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
        with self.lock:
            job = self.get(job_id)
            if job.status in ("queued", "running"):
                raise RuntimeError("대기 중이거나 실행 중인 작업은 지울 수 없습니다.")
            self.jobs.pop(job_id, None)
        shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    # ------------------------------------------------------------------ 생성/실행
    def _submit_locked(self, job: Job) -> None:
        """호출자가 lock 을 잡은 채 등록·저장·제출을 마친 뒤 worker 를 시작한다."""
        self._save(job)
        try:
            self.pool.submit(self._run, job.id)
        except Exception as e:
            job.status, job.error, job.stage = "error", f"작업을 시작하지 못했습니다: {e}", "시작 실패"
            self._save(job)
            raise RuntimeError(job.error) from e

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
            self._submit_locked(job)
        return job

    def create_remix(self, filename: str, data_stream, options: dict) -> Job:
        """내 영상 후보정 작업: 화음(기본) / 오케스트라 / 오토튠."""
        from ..remix import STYLES

        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_EXT or ext == ".zip":
            raise ValueError(f"영상 또는 음원 파일을 올려 주세요: {ext or '(확장자 없음)'}")
        if options.get("style", "harmony") not in STYLES:
            raise ValueError(f"스타일은 {' / '.join(STYLES)} 중 하나입니다.")
        job_id = uuid.uuid4().hex[:12]
        d = self.job_dir(job_id)
        d.mkdir(parents=True)
        with open(d / f"input{ext}", "wb") as f:
            shutil.copyfileobj(data_stream, f)
        title = (options.get("title") or Path(filename).stem).strip()[:120] or "제목 없음"
        job = Job(id=job_id, title=title, filename=Path(filename).name, created=time.time(),
                  options=options, kind="remix")
        with self.lock:
            self.jobs[job_id] = job
            self._submit_locked(job)
        return job

    MAX_VERSIONS = 6

    def _run_remix(self, job: Job, d: Path, log, progress) -> None:
        """후보정 한 번 = 버전 하나 (remix/v<n>/). 분석은 remix/analysis/ 에 두고 버전끼리 함께 쓴다."""
        from ..remix import STYLES, RemixOptions, remix

        o = job.options
        num = lambda k: float(o[k]) if o.get(k) not in (None, "") else None  # noqa: E731
        opts = RemixOptions(
            style=o.get("style") or "harmony", harmony=o.get("harmony") or "both",
            autotune=bool(o.get("autotune")),
            autotune_strength=float(min(max(float(o.get("autotune_strength") or 0.7), 0.0), 1.0)),
            hard_tune=bool(o.get("hard_tune")), key=o.get("key") or None,
            with_harmony=o.get("with_harmony") if o.get("with_harmony") in (True, False) else None,
            keep_backing=o.get("keep_backing") if o.get("keep_backing") in (True, False) else None,
            bpm=num("bpm"), beats_per_bar=int(o.get("beats_per_bar") or 4),
            chords=(o.get("chords") or "").strip() or None,
        )
        src = next(d.glob("input.*"))
        root = d / "remix"
        prev = dict(job.result or {})
        versions = list(prev.get("versions") or [])
        n = max([v["n"] for v in versions], default=0) + 1
        out = root / f"v{n}"
        try:
            res = remix(src, out, opts, log, progress, analysis_dir=root / "analysis")
        except Exception as e:
            if not versions:
                raise
            # 다시 만들기가 실패해도 이전 버전들은 그대로 볼 수 있게
            shutil.rmtree(out, ignore_errors=True)
            job.result = dict(prev, last_error=str(e))
            log("오류: " + str(e))
            return
        rel = lambda f: f.relative_to(root).as_posix()  # noqa: E731
        version = {
            "n": n, "style": opts.style, "style_label": STYLES[opts.style], "autotune": opts.autotune,
            "with_harmony": opts.with_harmony, "key": res.key, "key_short": res.key_short,
            "tempo": res.tempo, "beats_per_bar": opts.beats_per_bar, "chord_text": res.chord_text,
            "chords_source": "user" if opts.chords else "auto", "user_key": bool(opts.key),
            "user_bpm": bool(opts.bpm), "notes": res.notes, "reused": res.reused,
            "video": rel(res.video) if res.video else None, "audio": rel(res.audio),
            "files": [rel(f) for f in res.files],
        }
        versions.append(version)
        while len(versions) > self.MAX_VERSIONS:  # 오래된 버전부터 지움
            old = versions.pop(0)
            shutil.rmtree(root / f"v{old['n']}", ignore_errors=True)
        # 화면 호환: 현재 버전의 내용을 맨 위에도 둔다
        job.result = {"kind": "remix", **version, "versions": versions, "current": n, "original": src.name}

    def remix_again(self, job_id: str, options: dict) -> Job:
        """같은 영상으로 스타일·화음·오토튠·템포·키·코드를 바꿔 새 버전 만들기 (분석 재사용)."""
        from ..remix import STYLES, parse_chord_text

        job = self.get(job_id)
        if job.kind != "remix":
            raise RuntimeError("후보정 작업이 아닙니다.")
        if options.get("style", job.options.get("style", "harmony")) not in STYLES:
            raise ValueError(f"스타일은 {' / '.join(STYLES)} 중 하나입니다.")
        if options.get("chords"):
            parse_chord_text(options["chords"])  # 형식 오류는 바로 알림
        with self.lock:
            if job.status in ("queued", "running"):
                raise RuntimeError("이미 만드는 중입니다. 끝난 뒤에 다시 시도해 주세요.")
            job.options = {**job.options, **options}
            job.status, job.error, job.progress, job.stage = "queued", None, 0.0, "대기 중"
            if job.result:
                job.result.pop("last_error", None)
            self._submit_locked(job)
        return job

    def remix_file(self, job_id: str, path: str) -> Path:
        job = self.get(job_id)
        if job.kind != "remix" or not job.result:
            raise KeyError(path)
        d = self.job_dir(job_id)
        f = (d / job.result["original"] if path == "original" else d / "remix" / path).resolve()
        if not str(f).startswith(str(d.resolve())) or not f.is_file():
            raise KeyError(path)
        return f

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
            self._submit_locked(job)
        return job

    def start_analysis(self, job_id: str, options: dict) -> Job:
        """영상·음성만 받아 둔 작업(ready)이나 실패한 작업을 이어서 악보까지 만들기."""
        with self.lock:
            job = self.get(job_id)
            if job.kind == "remix":  # 후보정 다시 시도
                if job.status != "error":
                    raise RuntimeError("실패한 후보정 작업만 다시 시도할 수 있습니다.")
                job.options = {**job.options, **options}
                job.status, job.error, job.progress, job.stage = "queued", None, 0.0, "대기 중"
                self._submit_locked(job)
                return job
            has_input = any(self.job_dir(job_id).glob("input.*"))
            if job.status not in ("ready", "error") or not (has_input or job.url):
                raise RuntimeError("영상·음성을 받아 둔 작업(또는 실패한 작업)만 이어서 악보를 만들 수 있습니다.")
            job.options = {**job.options, **options, "fetch_only": False}
            job.status, job.error, job.progress, job.stage = "queued", None, 0.0, "대기 중"
            self._submit_locked(job)
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
            fmt = str(opts.get("audio_format") or "mp3").lower()
            cut = not opts.get("fetch_only")  # 받기만 할 때는 나중에 구간을 바꿀 수 있게 전체를 받음
            raw, meta = download_audio(
                job.url, d / "download", progress=report, prefer_ext="m4a" if fmt == "m4a" else None,
                start=float(opts["start"]) if cut and opts.get("start") else None,
                duration=float(opts["duration"]) if cut and opts.get("duration") else None)
            if meta.get("section"):  # 구간만 받았으므로 분석할 때 다시 자르지 않음
                log(f"구간만 받음: {meta['section'][0]:.0f}초부터")
                opts["start"] = opts["duration"] = None
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
        with self.lock:
            job = self.get(job_id)
            job.status = "running"
            self._save(job)
        d = self.job_dir(job_id)
        opts = job.options
        last_save = [0.0]
        final_status = "error"

        def log(msg: str) -> None:
            job.log.append(msg)
            job.log = job.log[-300:]
            if time.time() - last_save[0] > 1.0:
                last_save[0] = time.time()
                self._save(job)

        def progress(frac: float, msg: str) -> None:
            job.progress, job.stage = round(frac, 3), msg.strip()

        try:
            if job.kind == "remix":
                self._run_remix(job, d, log, progress)
                final_status, job.progress, job.stage = "done", 1.0, "완료"
                return
            if job.url and not job.source:
                self._fetch(job, d, log, progress)
                if opts.get("fetch_only"):
                    final_status, job.progress, job.stage = "ready", 0.1, "영상·음성 준비 완료"
                    return
            src = next(d.glob("input.*"))
            if opts.get("split_songs") and not opts.get("start") and not opts.get("duration") \
                    and src.suffix.lower() not in SCORE_OR_STEMS_EXT:
                self._scan(job, src, log, progress)
                final_status, job.progress, job.stage = "choose", 1.0, "곡 고르기"
                return
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
            if not project.stems:  # MIDI·MusicXML: 들을 음원이 악보 소리뿐이라 미리 만들어 둔다
                try:
                    self.score_audio(job_id, 0)
                except Exception as e:  # FluidSynth 오류는 작업을 막지 않는다
                    log(f"   ! 악보 소리 생략: {e}")
            progress(0.98, "악보 만드는 중")
            res = render(project, d, RenderOptions(pdf=bool(opts.get("pdf"))), log)
            job.result = render_summary(res, project, d)
            job.renders[job.result["key_short"]] = job.result
            if opts.get("target_key"):
                res2 = render(project, d, RenderOptions(target_key=opts["target_key"],
                                                        pdf=bool(opts.get("pdf"))), log)
                job.result = render_summary(res2, project, d)
                job.renders[job.result["key_short"]] = job.result
            final_status, job.progress, job.stage = "done", 1.0, "완료"
        except Exception as e:  # 화면에 오류 표시
            job.error = str(e)
            job.log.append("오류: " + str(e))
            job.log.append(traceback.format_exc(limit=3))
        finally:
            with self.lock:
                # 최종 저장이 끝나기 전에는 삭제나 재분석을 허용하지 않는다.
                job.status = final_status
                self._save(job)

    # ------------------------------------------------------------------ 곡 나누기
    def _scan(self, job: Job, src: Path, log, progress) -> None:
        """긴 실황 영상에서 곡 구간을 찾아 고르게 한다 (호출자가 status = choose 로 마무리)."""
        from ..segment import SR, find_songs, load_mono

        d = self.job_dir(job.id)
        progress(0.1, "곡 구간 찾는 중 (말씀·기도·전환과 찬양 구분)")
        y = load_mono(src)
        songs = find_songs(y, SR)
        progress(0.8, "들어 볼 음원 만드는 중")
        preview = d / "preview"
        preview.mkdir(exist_ok=True)
        subprocess.run([require_ffmpeg(), "-y", "-loglevel", "error", "-i", str(src), "-vn", "-ac", "1",
                        "-c:a", "libmp3lame", "-b:a", "96k", str(preview / "full.mp3")], check=False)
        job.songs = [dict(sg.to_dict(), index=i) for i, sg in enumerate(songs)]
        log(f"   - 곡 {len(songs)}개를 찾았습니다" + "".join(
            f"\n     {i + 1}. {_mmss(sg.start)}~{_mmss(sg.end)} 키 {sg.key} 약 {sg.tempo:.0f} BPM"
            for i, sg in enumerate(songs)))
        job.duration = round(len(y) / SR, 1)

    def make_songs(self, job_id: str, picks: list[dict]) -> list[str]:
        """고른 곡 구간마다 새 작업을 만든다. picks: [{start, end, title?}] (초)."""
        parent = self.get(job_id)
        if parent.status != "choose":
            raise RuntimeError("곡 구간을 찾은 작업에서만 곡을 고를 수 있습니다.")
        src = next(self.job_dir(job_id).glob("input.*"))
        ids = []
        for i, pk in enumerate(picks):
            start = max(0.0, float(pk["start"]) - 1.0)  # 첫 음이 잘리지 않게 1초 앞부터
            end = float(pk["end"]) + 1.0
            if end - start < 5:
                continue
            opts = {k: v for k, v in parent.options.items() if k not in ("split_songs", "start", "duration")}
            opts.update(start=round(start, 2), duration=round(end - start, 2))
            child_id = uuid.uuid4().hex[:12]
            d = self.job_dir(child_id)
            d.mkdir(parents=True)
            dst = d / src.name
            try:
                os.link(src, dst)  # 같은 원본을 공유 (디스크 절약)
            except OSError:
                shutil.copyfile(src, dst)
            title = pk.get("title") or f"{parent.title} - {int(pk.get('index', i)) + 1}번째 곡"
            child = Job(id=child_id, title=str(title)[:120], filename=parent.filename, created=time.time(),
                        options=opts, parent=job_id)
            with self.lock:
                self.jobs[child_id] = child
                parent.children.append(child_id)
                self._submit_locked(child)
            ids.append(child_id)
        self._save(parent)
        return ids

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


def _mmss(t: float) -> str:
    return f"{int(t // 60)}:{int(t % 60):02d}"


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
    """원래 키의 듣기용 음원(스템·원곡·반주 MR)을 고음질 MP3 로 만든다."""
    from ..playback import make_playback

    out = job_dir / "preview"
    mix = job_dir / "work" / "mix.wav"
    names = make_playback(project.stems, mix if mix.exists() else None, out, 0)
    (out / "done.json").write_text(json.dumps({"tracks": names, "semitones": 0}), encoding="utf-8")
