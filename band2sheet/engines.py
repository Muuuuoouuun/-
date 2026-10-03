"""사용 가능한 엔진(오픈소스 모델) 확인.

각 단계는 설치된 패키지에 따라 더 좋은 엔진을 자동으로 고르고,
모델을 내려받지 못하면 기본 엔진으로 물러난다(fallback).
"""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class EngineInfo:
    key: str
    module: str
    role: str
    pip: str
    note: str


ENGINES = [
    EngineInfo("demucs", "demucs", "악기 분리 (보컬/드럼/베이스/기타/피아노/기타악기)", "demucs",
               "Meta Demucs v4 htdemucs_6s"),
    EngineInfo("audio_separator", "audio_separator",
               "고품질 보컬 분리(BS-RoFormer), 메인/코러스 분리, 드럼 6조각 분리(DrumSep)",
               "audio-separator", "UVR 커뮤니티 모델"),
    EngineInfo("basic_pitch", "basic_pitch", "다성 채보 (기타/건반/코러스)", "basic-pitch",
               "Spotify Basic Pitch"),
    EngineInfo("crepe", "torchcrepe", "보컬/베이스 음높이 추적 (딥러닝)", "torchcrepe",
               "CREPE — 모델이 패키지에 포함돼 추가 다운로드 없음"),
    EngineInfo("piano_hr", "piano_transcription_inference", "피아노 고해상도 채보 + 서스테인 페달",
               "piano-transcription-inference", "ByteDance High-resolution Piano Transcription"),
    EngineInfo("beat_this", "beat_this", "비트·마디 첫 박 인식, 박자 추정", "beat-this",
               "CPJKU Beat This! (ISMIR 2024)"),
    EngineInfo("whisper", "faster_whisper", "가사 인식", "faster-whisper", "OpenAI Whisper (CTranslate2)"),
    EngineInfo("whisperx", "whisperx", "가사 인식 + 단어 시간 정밀 정렬", "whisperx", "WhisperX"),
]


def has(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def available(key: str) -> bool:
    for e in ENGINES:
        if e.key == key:
            return has(e.module)
    return has(key)


def status() -> list[dict]:
    return [
        {"key": e.key, "role": e.role, "pip": e.pip, "note": e.note, "installed": has(e.module)}
        for e in ENGINES
    ]


def model_dir() -> Path:
    """모델 파일 저장 위치 (BAND2SHEET_MODEL_DIR 로 변경 가능)."""
    d = Path(os.environ.get("BAND2SHEET_MODEL_DIR", Path.home() / ".cache" / "band2sheet" / "models"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def torch_device(device: str | None = None) -> str:
    if device:
        return device
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"
