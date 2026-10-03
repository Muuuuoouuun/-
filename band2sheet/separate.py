"""음원 분리: Demucs 로 보컬/드럼/베이스/기타/피아노/기타악기 스템을 만든다."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"]

MODELS = {
    "htdemucs_6s": "6 스템 (보컬, 드럼, 베이스, 기타, 피아노, 기타악기) — 기본값",
    "htdemucs": "4 스템 (보컬, 드럼, 베이스, 기타악기) — 빠름",
    "htdemucs_ft": "4 스템 고품질 (느림)",
}


def pick_device(device: str | None = None) -> str:
    if device:
        return device
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


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


def load_stems_dir(stems_dir: Path) -> dict[str, Path]:
    """이미 분리된(또는 멀티트랙으로 녹음된) 스템 폴더 사용.

    파일 이름에 vocals/drums/bass/guitar/piano/other 가 들어 있으면 해당 스템으로 인식한다.
    (예: '01_Vocals.wav', 'keys.wav' -> piano, 'synth.wav' -> other)
    """
    aliases = {
        "vocals": ["vocal", "vox", "voice", "보컬"],
        "drums": ["drum", "kit", "드럼"],
        "bass": ["bass", "베이스"],
        "guitar": ["guitar", "gtr", "기타"],
        "piano": ["piano", "keys", "key", "피아노", "건반"],
        "other": ["other", "synth", "pad", "string", "organ"],
    }
    found: dict[str, Path] = {}
    for path in sorted(stems_dir.iterdir()):
        if path.suffix.lower() not in (".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aiff", ".aif"):
            continue
        stem = path.stem.lower()
        for name, words in aliases.items():
            if name in found:
                continue
            if any(w in stem for w in words):
                found[name] = path
                break
    if not found:
        raise RuntimeError(f"{stems_dir} 에서 스템 파일을 찾지 못했습니다 (vocals.wav, bass.wav ... 형식)")
    return found


def stem_level_db(stem: np.ndarray, mix: np.ndarray) -> float:
    """믹스 대비 스템 에너지 (dB). 거의 비어 있는 스템을 건너뛰는 데 사용."""
    s = float(np.mean(stem.astype(np.float64) ** 2)) + 1e-12
    m = float(np.mean(mix.astype(np.float64) ** 2)) + 1e-12
    return 10.0 * np.log10(s / m)
