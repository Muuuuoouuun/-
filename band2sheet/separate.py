"""음원 분리.

단계별로 더 잘게 나눈다 (설치된 엔진과 옵션에 따라):

1. (고품질) BS-RoFormer 로 보컬 / 반주 분리
2. Demucs htdemucs_6s 로 반주를 드럼 / 베이스 / 기타 / 피아노 / 기타악기로 분리
3. 카라오케 모델로 보컬을 메인 보컬 / 코러스(화음)로 분리
4. DrumSep 으로 드럼을 킥 / 스네어 / 탐 / 하이햇 / 라이드 / 크래시로 분리

audio-separator 가 없거나 모델을 받지 못하면 해당 단계만 건너뛰고 계속 진행한다.
"""

from __future__ import annotations

import logging
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from .engines import available, model_dir, torch_device
from .instruments import DRUMSEP_STEMS

STEM_ORDER = ["vocals", "backing_vocals", "drums", "bass", "guitar", "piano", "other"]

MODELS = {
    "htdemucs_6s": "6 스템 (보컬, 드럼, 베이스, 기타, 피아노, 기타악기) — 기본값",
    "htdemucs": "4 스템 (보컬, 드럼, 베이스, 기타악기) — 빠름",
    "htdemucs_ft": "4 스템 고품질 (느림)",
}

# audio-separator 모델 파일 이름
ROFORMER_VOCALS = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
KARAOKE = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
DRUMSEP = "MDX23C-DrumSep-aufr33-jarredou.ckpt"

# 품질 프리셋 -> (Demucs 모델, RoFormer 보컬 사용 여부)
QUALITY = {
    "fast": ("htdemucs", False),
    "standard": ("htdemucs_6s", False),
    "high": ("htdemucs_6s", True),
}

Log = Callable[[str], None]


@dataclass
class Stems:
    stems: dict[str, Path] = field(default_factory=dict)  # vocals, backing_vocals, drums, bass ...
    drum_parts: dict[str, Path] = field(default_factory=dict)  # kick, snare, toms, hh, ride, crash
    notes: list[str] = field(default_factory=list)  # 사용한 엔진/건너뛴 단계 기록


def pick_device(device: str | None = None) -> str:
    return torch_device(device)


# ---------------------------------------------------------------------------
# Demucs
# ---------------------------------------------------------------------------

def separate(mix_path: Path, out_dir: Path, model_name: str = "htdemucs_6s",
             device: str | None = None, shifts: int = 1) -> dict[str, Path]:
    """Demucs 로 분리하고 {스템 이름: wav 경로} 를 반환."""
    try:
        import torch
        from demucs.apply import apply_model
        from demucs.audio import AudioFile
        from demucs.pretrained import get_model
    except ImportError as e:  # pragma: no cover - 설치 안내
        raise RuntimeError("음원 분리에는 demucs 가 필요합니다: pip install demucs") from e

    out_dir.mkdir(parents=True, exist_ok=True)
    device = pick_device(device)
    try:
        model = get_model(model_name)
    except Exception as e:
        raise RuntimeError(
            f"Demucs 모델({model_name})을 불러오지 못했습니다. 첫 실행 시 인터넷에서 모델을 내려받으니 "
            f"네트워크를 확인하세요. 이미 분리된 스템이 있으면 --stems-dir 을 쓰면 됩니다. ({e})"
        ) from e
    model.eval()

    wav = AudioFile(mix_path).read(streams=0, samplerate=model.samplerate,
                                   channels=model.audio_channels)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std
    with torch.no_grad():
        sources = apply_model(model, wav[None], device=device, shifts=shifts, split=True,
                              overlap=0.25, progress=True)[0]
    sources = sources * std + mean

    paths: dict[str, Path] = {}
    for audio, name in zip(sources, model.sources):
        path = out_dir / f"{name}.wav"
        sf.write(path, audio.cpu().numpy().T, model.samplerate, subtype="PCM_16")
        paths[name] = path
    return paths


# ---------------------------------------------------------------------------
# audio-separator (UVR 계열 모델)
# ---------------------------------------------------------------------------

def run_separator(model_filename: str, input_path: Path, out_dir: Path) -> dict[str, Path]:
    """audio-separator 로 분리. 반환: {스템 이름(소문자): 경로}."""
    from audio_separator.separator import Separator

    out_dir.mkdir(parents=True, exist_ok=True)
    sep = Separator(output_dir=str(out_dir), model_file_dir=str(model_dir()),
                    log_level=logging.WARNING)
    sep.load_model(model_filename=model_filename)
    files = sep.separate(str(input_path))
    result: dict[str, Path] = {}
    for f in files:
        p = Path(f)
        if not p.is_absolute():
            p = out_dir / p
        m = re.search(r"\(([^)]+)\)", p.name)
        if m:
            result[m.group(1).strip().lower()] = p
    return result


def _pick(found: dict[str, Path], *words: str) -> Path | None:
    for name, path in found.items():
        if any(w in name for w in words):
            return path
    return None


def _move(src: Path, dst: Path) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return dst


def separate_detailed(mix_path: Path, out_dir: Path, quality: str = "standard",
                      split_vocals: bool = True, split_drums: bool = True,
                      device: str | None = None, log: Log = print) -> Stems:
    """품질 프리셋과 세부 분리 옵션에 따라 단계별로 분리한다."""
    demucs_model, use_roformer = QUALITY.get(quality, QUALITY["standard"])
    has_sep = available("audio_separator")
    result = Stems()
    work = out_dir / "_work"

    source = mix_path
    roformer_vocals: Path | None = None
    if use_roformer and has_sep:
        try:
            log("   · 보컬 분리 (BS-RoFormer)")
            found = run_separator(ROFORMER_VOCALS, mix_path, work / "roformer")
            roformer_vocals = _pick(found, "vocal")
            inst = _pick(found, "instrument", "other")
            if roformer_vocals and inst:
                source = inst
                result.notes.append("보컬: BS-RoFormer")
        except Exception as e:  # 모델 다운로드 실패 등
            log(f"   ! BS-RoFormer 생략 ({e}) — Demucs 로 계속합니다")
            roformer_vocals = None

    log(f"   · 악기 분리 (Demucs {demucs_model})")
    demucs_out = separate(source, work / "demucs", demucs_model, device)
    result.notes.append(f"악기: Demucs {demucs_model}")
    for name, path in demucs_out.items():
        if name == "vocals" and roformer_vocals is not None:
            continue
        result.stems[name] = _move(path, out_dir / f"{name}.wav")
    if roformer_vocals is not None:
        result.stems["vocals"] = _move(roformer_vocals, out_dir / "vocals.wav")

    if split_vocals and "vocals" in result.stems:
        if not has_sep:
            result.notes.append("메인/코러스 분리 생략 (audio-separator 미설치)")
        else:
            try:
                log("   · 메인 보컬 / 코러스 분리 (Mel-RoFormer Karaoke)")
                found = run_separator(KARAOKE, result.stems["vocals"], work / "karaoke")
                lead = _pick(found, "vocal", "lead")
                backing = _pick(found, "instrument", "karaoke", "back", "other")
                if lead and backing:
                    result.stems["vocals"] = _move(lead, out_dir / "vocals.wav")
                    result.stems["backing_vocals"] = _move(backing, out_dir / "backing_vocals.wav")
                    result.notes.append("메인/코러스: Mel-RoFormer Karaoke")
            except Exception as e:
                log(f"   ! 메인/코러스 분리 생략 ({e})")

    if split_drums and "drums" in result.stems:
        if not has_sep:
            result.notes.append("드럼 조각 분리 생략 (audio-separator 미설치)")
        else:
            try:
                log("   · 드럼 조각 분리 (DrumSep: 킥/스네어/탐/하이햇/라이드/크래시)")
                found = run_separator(DRUMSEP, result.stems["drums"], work / "drumsep")
                for part in DRUMSEP_STEMS:
                    p = found.get(part) or _pick(found, part)
                    if p:
                        result.drum_parts[part] = _move(p, out_dir / "drums" / f"{part}.wav")
                if result.drum_parts:
                    result.notes.append("드럼: DrumSep 6조각")
            except Exception as e:
                log(f"   ! 드럼 조각 분리 생략 ({e})")

    shutil.rmtree(work, ignore_errors=True)
    return result


# ---------------------------------------------------------------------------
# 이미 분리된 / 멀티트랙 폴더
# ---------------------------------------------------------------------------

AUDIO_EXT = (".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aiff", ".aif")

STEM_ALIASES = [  # 순서 중요: 더 구체적인 이름을 먼저 검사
    ("backing_vocals", ["backing", "bgv", "chorus", "choir", "harmony", "코러스", "화음"]),
    ("vocals", ["vocal", "vox", "voice", "lead", "보컬"]),
    ("drums", ["drum", "kit", "드럼"]),
    ("bass", ["bass", "베이스"]),
    ("guitar", ["guitar", "gtr", "기타"]),
    ("piano", ["piano", "keys", "key", "피아노", "건반"]),
    ("other", ["other", "synth", "pad", "string", "organ"]),
]

DRUM_PART_ALIASES = [
    ("kick", ["kick", "bd", "킥"]),
    ("snare", ["snare", "sd", "스네어"]),
    ("hh", ["hh", "hihat", "hi-hat", "hat", "하이햇"]),
    ("ride", ["ride", "라이드"]),
    ("crash", ["crash", "크래시"]),
    ("floor", ["floor", "ftom", "플로어"]),
    ("toms", ["toms", "tom", "탐"]),
]


def _drum_part_name(stem: str) -> str | None:
    for name, words in DRUM_PART_ALIASES:
        if any(re.search(rf"(^|[^a-z]){re.escape(w)}([^a-z]|$)", stem) or (len(w) > 3 and w in stem)
               for w in words):
            return name
    return None


def load_stems_dir(stems_dir: Path, work_dir: Path | None = None) -> Stems:
    """이미 분리된(또는 멀티트랙으로 녹음된) 스템 폴더 사용.

    파일 이름으로 악기를 알아본다 (예: '01_Lead Vocal.wav', 'BGV.wav', 'Keys.wav', 'Kick In.wav').
    킥/스네어/탐/하이햇 같은 드럼 개별 트랙이나 'drums/' 하위 폴더도 인식한다.
    """
    result = Stems()
    files = sorted(p for p in stems_dir.rglob("*") if p.suffix.lower() in AUDIO_EXT)
    toms: list[Path] = []
    for path in files:
        stem = path.stem.lower()
        in_drum_dir = path.parent != stems_dir and "drum" in path.parent.name.lower()
        part = _drum_part_name(stem)
        if part and (in_drum_dir or "drum" not in stem):
            if part == "toms":
                toms.append(path)
            elif part not in result.drum_parts:
                result.drum_parts[part] = path
            continue
        for name, words in STEM_ALIASES:
            if name not in result.stems and any(w in stem for w in words):
                result.stems[name] = path
                break
    # 탐 트랙이 여러 개면 순서대로 하이/미드/플로어
    if len(toms) == 1 and "floor" not in result.drum_parts:
        result.drum_parts["toms"] = toms[0]
    else:
        for name, path in zip(("tom1", "tom2", "tom3"), toms):
            result.drum_parts[name] = path
    if result.drum_parts and "drums" not in result.stems:
        work_dir = work_dir or stems_dir
        work_dir.mkdir(parents=True, exist_ok=True)
        result.stems["drums"] = _mix_files(list(result.drum_parts.values()), work_dir / "drums_mix.wav")
    if not result.stems:
        raise RuntimeError(f"{stems_dir} 에서 스템 파일을 찾지 못했습니다 (vocals.wav, bass.wav ... 형식)")
    result.notes.append("입력: 스템 폴더")
    return result


def _mix_files(paths: list[Path], dst: Path) -> Path:
    mix = None
    sr0 = None
    for path in paths:
        audio, sr = sf.read(str(path), always_2d=True)
        audio = audio.mean(axis=1, keepdims=True)
        sr0 = sr0 or sr
        if sr != sr0:
            raise RuntimeError("드럼 트랙들의 샘플레이트가 서로 다릅니다.")
        if mix is None:
            mix = audio
        else:
            n = max(len(mix), len(audio))
            mix = np.pad(mix, ((0, n - len(mix)), (0, 0)))
            mix[: len(audio)] += audio
    assert mix is not None and sr0 is not None
    peak = np.abs(mix).max()
    if peak > 1:
        mix = mix / peak
    sf.write(str(dst), mix, sr0)
    return dst


def stem_level_db(stem: np.ndarray, mix: np.ndarray) -> float:
    """믹스 대비 스템 에너지 (dB). 거의 비어 있는 스템을 건너뛰는 데 사용."""
    s = float(np.mean(stem.astype(np.float64) ** 2)) + 1e-12
    m = float(np.mean(mix.astype(np.float64) ** 2)) + 1e-12
    return 10.0 * np.log10(s / m)
