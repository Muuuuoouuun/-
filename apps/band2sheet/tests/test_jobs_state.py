"""Job lifecycle tests with real persistence and controlled workers, without audio models."""

import importlib.util
import io
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import pytest


@pytest.fixture
def jobs_module():
    # Only imports of the scientific pipeline are replaced. Load jobs.py itself unchanged,
    # under a private name, and restore sys.modules before running any test/worker.
    import band2sheet.audio_io  # noqa: F401: dependency-free real input helpers

    def unavailable(*args, **kwargs):
        raise AssertionError("This lifecycle test must not invoke an audio pipeline")

    pipeline = ModuleType("band2sheet.pipeline")
    pipeline.AnalyzeOptions = pipeline.RenderOptions = SimpleNamespace
    pipeline.RenderResult = object
    pipeline.analyze = pipeline.render = unavailable
    project = ModuleType("band2sheet.project")
    project.Project = object
    view = ModuleType("band2sheet.view")
    view.measure_times = unavailable
    name = "band2sheet.app._jobs_state_under_test"
    path = Path(__file__).parents[1] / "band2sheet" / "app" / "jobs.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {
        name: module,
        "band2sheet.pipeline": pipeline,
        "band2sheet.project": project,
        "band2sheet.view": view,
    }):
        spec.loader.exec_module(module)
    return module


class ControlledExecutor:
    def __init__(self, on_submit=None):
        self.calls = []
        self.on_submit = on_submit

    def submit(self, fn, *args):
        if self.on_submit:
            self.on_submit(fn, *args)
        self.calls.append((fn, args))

    def run_next(self):
        fn, args = self.calls.pop(0)
        return fn(*args)


@pytest.fixture
def manager(jobs_module, tmp_path):
    manager = jobs_module.JobManager(tmp_path)
    manager.pool.shutdown(wait=True)
    manager.pool = ControlledExecutor()
    return manager


def ready_job(manager, jobs_module):
    job = jobs_module.Job("ready1", "Synthetic", "input.wav", 0, {}, status="ready")
    manager.job_dir(job.id).mkdir()
    (manager.job_dir(job.id) / "input.wav").write_bytes(b"synthetic input")
    manager.jobs[job.id] = job
    manager._save(job)
    return job


def enqueue(manager, jobs_module, mode):
    if mode == "upload":
        return manager.create("synthetic.wav", io.BytesIO(b"synthetic input"), {})
    if mode == "url":
        return manager.create_from_url("https://example.invalid/synthetic", {})
    return manager.start_analysis(ready_job(manager, jobs_module).id, {})


def test_concurrent_analysis_is_admitted_once(manager, jobs_module, monkeypatch):
    job = ready_job(manager, jobs_module)

    class AdmissionGate:
        """Let both callers reach the admission lock before either may acquire it."""
        def __init__(self):
            self.barrier = threading.Barrier(2)
            self.lock = threading.Lock()

        def __enter__(self):
            self.barrier.wait(timeout=5)
            self.lock.acquire()

        def __exit__(self, *args):
            self.lock.release()

    manager.lock = AdmissionGate()
    # Isolate admission from the original code's second race: concurrent .tmp writes.
    monkeypatch.setattr(manager, "_save", lambda job: None)

    def start():
        try:
            manager.start_analysis(job.id, {})
            return "accepted"
        except RuntimeError:
            return "rejected"

    with ThreadPoolExecutor(max_workers=2) as callers:
        results = list(callers.map(lambda _: start(), range(2)))
    assert sorted(results) == ["accepted", "rejected"]
    assert len(manager.pool.calls) == 1


def test_queued_job_cannot_be_deleted_before_worker_runs(manager, jobs_module, monkeypatch):
    job = manager.create("synthetic.wav", io.BytesIO(b"synthetic input"), {})
    calls = []

    def fake_analyze(source, *args):
        calls.append(source)
        assert Path(source).is_file()
        raise RuntimeError("synthetic analysis failure")

    monkeypatch.setattr(jobs_module, "analyze", fake_analyze)
    with pytest.raises(RuntimeError, match="대기|실행"):
        manager.delete(job.id)
    assert manager.get(job.id) is job
    manager.pool.run_next()
    assert len(calls) == 1
    assert job.status == "error" and job.error == "synthetic analysis failure"
    manager.delete(job.id)
    assert not manager.job_dir(job.id).exists()


def test_real_worker_retains_input_until_analysis_finishes(manager, jobs_module, monkeypatch):
    entered = threading.Event()
    finish = threading.Event()

    def fake_analyze(source, *args):
        entered.set()
        assert finish.wait(timeout=5)
        assert Path(source).read_bytes() == b"synthetic input"
        raise RuntimeError("synthetic analysis failure")

    monkeypatch.setattr(jobs_module, "analyze", fake_analyze)
    manager.pool = ThreadPoolExecutor(max_workers=1)
    try:
        job = manager.create("synthetic.wav", io.BytesIO(b"synthetic input"), {})
        assert entered.wait(timeout=5)
        assert job.status == "running"
        with pytest.raises(RuntimeError):
            manager.delete(job.id)
        with pytest.raises(RuntimeError):
            manager.start_analysis(job.id, {})
    finally:
        finish.set()
        manager.pool.shutdown(wait=True)
    saved = json.loads((manager.job_dir(job.id) / "job.json").read_text())
    assert saved["status"] == "error" and saved["error"] == "synthetic analysis failure"
    manager.delete(job.id)
    assert not manager.job_dir(job.id).exists()


@pytest.mark.parametrize("mode", ["upload", "url", "retry"])
def test_admission_is_saved_and_submitted_under_lock(manager, jobs_module, mode):
    def on_submit(fn, job_id):
        assert manager.lock.locked()
        saved = json.loads((manager.job_dir(job_id) / "job.json").read_text())
        assert saved["status"] == "queued"
        assert manager.get(job_id).status == "queued"

    manager.pool = ControlledExecutor(on_submit)
    job = enqueue(manager, jobs_module, mode)
    assert len(manager.pool.calls) == 1
    assert job.status == "queued"


@pytest.mark.parametrize("mode", ["upload", "url", "retry"])
def test_submit_failure_is_persisted_and_can_be_retried(manager, jobs_module, mode):
    def reject(*args):
        raise RuntimeError("pool shut down")

    manager.pool = ControlledExecutor(reject)
    with pytest.raises(RuntimeError, match="pool shut down"):
        enqueue(manager, jobs_module, mode)
    job, = manager.list()
    saved = json.loads((manager.job_dir(job.id) / "job.json").read_text())
    assert job.status == saved["status"] == "error"
    assert "pool shut down" in job.error
    assert saved["error"] == job.error
    manager.pool = ControlledExecutor()
    manager.start_analysis(job.id, {})
    assert len(manager.pool.calls) == 1 and job.status == "queued"


@pytest.mark.parametrize("terminal", ["ready", "done", "error"])
def test_terminal_status_is_saved_before_deletion_is_allowed(
    manager, jobs_module, monkeypatch, terminal,
):
    if terminal == "ready":
        job = manager.create_from_url("https://example.invalid/synthetic", {"fetch_only": True})
        monkeypatch.setattr(manager, "_fetch", lambda *args: None)
    else:
        job = manager.create("synthetic.wav", io.BytesIO(b"synthetic input"), {})

    def fake_analyze(*args):
        if terminal == "error":
            raise RuntimeError("synthetic analysis failure")
        return SimpleNamespace(title="", stems=["mix"], save=lambda path: path.write_text("{}"))

    monkeypatch.setattr(jobs_module, "analyze", fake_analyze)
    monkeypatch.setattr(jobs_module, "make_previews", lambda *args: None)
    monkeypatch.setattr(jobs_module, "render", lambda *args: None)
    monkeypatch.setattr(jobs_module, "render_summary", lambda *args: {"key_short": "C"})
    save = manager._save
    terminal_saves = []

    def checked_save(job):
        if job.status in ("ready", "done", "error"):
            # A delete() request must wait until the final write is complete.
            assert manager.lock.locked()
            terminal_saves.append(job.status)
        save(job)

    monkeypatch.setattr(manager, "_save", checked_save)
    manager.pool.run_next()
    assert terminal_saves == [terminal]
    assert json.loads((manager.job_dir(job.id) / "job.json").read_text())["status"] == terminal
    manager.delete(job.id)
    assert not manager.job_dir(job.id).exists()
