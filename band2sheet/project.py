"""분석 결과(프로젝트) 데이터 구조와 JSON 저장/불러오기.

무거운 단계(다운로드·분리·채보)의 결과를 project.json 에 저장해 두면,
조옮김이나 악보 옵션 변경은 이 파일만으로 몇 초 안에 다시 렌더링할 수 있다.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from .theory import Key

PROJECT_VERSION = 1


@dataclass
class Note:
    start: float  # 초
    end: float  # 초
    pitch: int  # MIDI 번호 (드럼은 GM 드럼 번호)
    velocity: int = 80

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Track:
    name: str  # 스템 이름: vocals, bass, guitar, piano, other, drums
    notes: list[Note] = field(default_factory=list)
    lyrics: list[Word] = field(default_factory=list)
    pedals: list[tuple[float, float]] = field(default_factory=list)  # 서스테인 페달 (초)
    engine: str = ""  # 채보에 쓴 엔진


@dataclass
class Project:
    title: str
    source: str
    beat_times: list[float]
    key: Key
    time_signature: str = "4/4"
    downbeat: int = 0  # 몇 번째 비트(0부터)가 마디 첫 박인지
    tracks: dict[str, Track] = field(default_factory=dict)
    stems_dir: str | None = None
    stems: dict[str, str] = field(default_factory=dict)  # 스템 이름 -> 오디오 경로 (재생/믹서용)
    drum_parts: dict[str, str] = field(default_factory=dict)  # 드럼 조각 이름 -> 오디오 경로
    engines: dict[str, str] = field(default_factory=dict)  # 단계 -> 사용한 엔진
    separation: dict[str, dict] = field(default_factory=dict)  # 스템별 분리 리포트 (활동 구간 등)
    key_changes: list[tuple[float, Key]] = field(default_factory=list)  # (마디 첫 박 기준 박 위치, 새 키)

    @property
    def tempo_bpm(self) -> float:
        if len(self.beat_times) < 2:
            return 120.0
        return float(60.0 / np.median(np.diff(self.beat_times)))

    def key_at_beat(self, beat: float) -> Key:
        """마디 첫 박 기준 박 위치에서의 키 (전조 반영)."""
        key = self.key
        for b, k in self.key_changes:
            if b <= beat + 1e-6:
                key = k
        return key

    @property
    def compound(self) -> bool:
        """6/8, 9/8, 12/8 같은 겹박자 여부 (한 박 = 점4분음표)."""
        num, den = (int(x) for x in self.time_signature.split("/"))
        return den == 8 and num % 3 == 0 and num > 3

    @property
    def beats_per_bar(self) -> int:
        """마디당 비트 수 (비트 트래커가 찾는 박 기준)."""
        num = int(self.time_signature.split("/")[0])
        return num // 3 if self.compound else num

    @property
    def beat_ql(self) -> float:
        """한 비트의 길이 (4분음표 = 1.0)."""
        den = int(self.time_signature.split("/")[1])
        return 1.5 if self.compound else 4.0 / den

    def save(self, path: str | Path) -> None:
        data = {
            "version": PROJECT_VERSION,
            "title": self.title,
            "source": self.source,
            "beat_times": [round(t, 4) for t in self.beat_times],
            "key": self.key.to_dict(),
            "time_signature": self.time_signature,
            "downbeat": self.downbeat,
            "stems_dir": self.stems_dir,
            "stems": self.stems,
            "drum_parts": self.drum_parts,
            "engines": self.engines,
            "separation": self.separation,
            "key_changes": [{"beat": b, "key": k.to_dict()} for b, k in self.key_changes],
            "tracks": {
                name: {
                    "notes": [
                        [round(n.start, 4), round(n.end, 4), n.pitch, n.velocity]
                        for n in t.notes
                    ],
                    "lyrics": [asdict(w) for w in t.lyrics],
                    "pedals": [[round(a, 4), round(b, 4)] for a, b in t.pedals],
                    "engine": t.engine,
                }
                for name, t in self.tracks.items()
            },
        }
        Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path) -> "Project":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        tracks = {}
        for name, t in data.get("tracks", {}).items():
            tracks[name] = Track(
                name=name,
                notes=[Note(float(s), float(e), int(p), int(v)) for s, e, p, v in t["notes"]],
                lyrics=[Word(**w) for w in t.get("lyrics", [])],
                pedals=[(float(a), float(b)) for a, b in t.get("pedals", [])],
                engine=t.get("engine", ""),
            )
        return cls(
            title=data["title"],
            source=data.get("source", ""),
            beat_times=[float(x) for x in data["beat_times"]],
            key=Key.from_dict(data["key"]),
            time_signature=data.get("time_signature", "4/4"),
            downbeat=int(data.get("downbeat", 0)),
            tracks=tracks,
            stems_dir=data.get("stems_dir"),
            stems=data.get("stems", {}),
            drum_parts=data.get("drum_parts", {}),
            engines=data.get("engines", {}),
            separation=data.get("separation", {}),
            key_changes=[(float(c["beat"]), Key.from_dict(c["key"])) for c in data.get("key_changes", [])],
        )


class TimeMap:
    """초 <-> 박(beat) 변환. 비트 트래킹 결과를 이용해 라이브 연주의 템포 흔들림을 흡수한다."""

    def __init__(self, beat_times: list[float]):
        bt = np.asarray(sorted(beat_times), dtype=float)
        if len(bt) < 2:
            bt = np.array([0.0, 0.5])
        self.bt = bt
        periods = np.diff(bt)
        self.period = float(np.median(periods))

    def to_beats(self, t: float | np.ndarray) -> np.ndarray:
        t = np.asarray(t, dtype=float)
        idx = np.arange(len(self.bt), dtype=float)
        out = np.interp(t, self.bt, idx)
        before = t < self.bt[0]
        after = t > self.bt[-1]
        out = np.where(before, (t - self.bt[0]) / self.period, out)
        out = np.where(after, idx[-1] + (t - self.bt[-1]) / self.period, out)
        return out

    def to_seconds(self, b: float | np.ndarray) -> np.ndarray:
        b = np.asarray(b, dtype=float)
        idx = np.arange(len(self.bt), dtype=float)
        out = np.interp(b, idx, self.bt)
        out = np.where(b < 0, self.bt[0] + b * self.period, out)
        out = np.where(b > idx[-1], self.bt[-1] + (b - idx[-1]) * self.period, out)
        return out
