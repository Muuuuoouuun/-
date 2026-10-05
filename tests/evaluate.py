"""인식 성능 측정: 정답을 아는 합성 곡으로 박·마디·키·코드·음표를 채점한다.

    python -m tests.evaluate            # 실황 합성 곡(tests/song_live.py) 전체 파이프라인
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np

from band2sheet.project import Project, TimeMap


def note_f1(est: list[tuple[float, int]], truth: list[tuple[float, float, int]], tol: float = 0.07):
    """음 시작이 tol 초 안이고 음높이가 같으면 맞음. 반환 (정밀도, 재현율, F1)."""
    used: set[int] = set()
    tp = 0
    order = sorted(range(len(est)), key=lambda i: est[i][0])
    starts = np.array([est[i][0] for i in order]) if est else np.zeros(0)
    for s, _, p in truth:
        lo = np.searchsorted(starts, s - tol)
        for j in range(lo, len(order)):
            i = order[j]
            if est[i][0] > s + tol:
                break
            if i not in used and est[i][1] == p:
                used.add(i)
                tp += 1
                break
    prec, rec = tp / max(1, len(est)), tp / max(1, len(truth))
    return prec, rec, 2 * prec * rec / max(1e-9, prec + rec)


def beat_f1(est: list[float], truth: list[float], tol: float = 0.07) -> float:
    est_a = np.array(sorted(est))
    tp = sum(1 for t in truth if len(est_a) and np.min(np.abs(est_a - t)) < tol)
    prec, rec = tp / max(1, len(est)), tp / max(1, len(truth))
    return 2 * prec * rec / max(1e-9, prec + rec)


def chord_scores(project: Project, truth) -> dict[str, float]:
    """정답 박마다(박 가운데 시각) 인식 코드 비교: 근음 / 근음+성질 / +베이스."""
    from band2sheet.pipeline import project_chords

    tm = TimeMap(project.beat_times)
    chords = project_chords(project)
    spans = [(float(tm.to_seconds(c.start + project.downbeat)), float(tm.to_seconds(c.end + project.downbeat)), c)
             for c in chords]
    root = full = bass = 0
    simple = {"m7": "m", "7": "", "maj7": "", "sus4": "sus4", "": "", "m": "m"}
    n = len(truth.chords)
    for k, r, q, b in truth.chords:
        t = (truth.beats[k] + truth.beats[k + 1]) / 2
        c = next((c for s, e, c in spans if s <= t < e), None)
        if c is None or c.root is None:
            continue
        if c.root == r:
            root += 1
            if simple.get(c.quality, c.quality) == simple.get(q, q):
                full += 1
                if (c.bass if c.bass is not None else c.root) == (b if b is not None else r):
                    bass += 1
    return {"근음": root / n, "근음+성질": full / n, "+베이스": bass / n}


def evaluate_project(project: Project, truth) -> dict:
    tm = TimeMap(project.beat_times)
    res: dict = {"키": project.key.short_name, "박자": project.time_signature,
                 "박 F1": round(beat_f1(project.beat_times, truth.beats), 3)}
    # 마디 첫 박: 정답 첫 박(bar 1 beat 1)이 인식한 마디 첫 박과 맞는지
    first = truth.beats[0]
    b = float(tm.to_beats(first))
    res["마디 첫 박"] = bool(abs(b - round(b)) < 0.25 and (round(b) - project.downbeat) % project.beats_per_bar == 0)
    res.update({f"코드 {k}": round(v, 3) for k, v in chord_scores(project, truth).items()})
    for name, tr in truth.notes.items():
        est = [(n.start, n.pitch) for n in project.tracks[name].notes] if name in project.tracks else []
        p, r, f = note_f1(est, tr)
        res[f"{name} 음표 F1"] = round(f, 3)
        res[f"{name} P/R"] = f"{p:.2f}/{r:.2f}"
    return res


def run_live(out: Path | None = None, log=lambda m: None) -> dict:
    from band2sheet.pipeline import AnalyzeOptions, analyze
    from tests.song_live import make_live_song

    tmp = Path(out or tempfile.mkdtemp(prefix="b2s_eval_"))
    stems, truth = make_live_song(tmp / "stems")
    project = analyze("", tmp / "out", AnalyzeOptions(stems_dir=tmp / "stems", beat_engine="librosa"), log)
    return evaluate_project(project, truth)


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    for k, v in run_live(out).items():
        print(f"{k:22s} {v}")
