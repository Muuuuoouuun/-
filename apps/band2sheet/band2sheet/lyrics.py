"""가사 인식(음성 인식): 분리된 보컬 트랙에서 Whisper 로 단어와 시간을 뽑고 음표에 붙인다."""

from __future__ import annotations

import re
from pathlib import Path

from .project import Note, Word

HANGUL = re.compile(r"[가-힣]")


def transcribe_lyrics(vocals_path: Path, language: str | None = "ko",
                      model_size: str = "small") -> list[Word]:
    """WhisperX(정밀 정렬) > faster-whisper > openai-whisper 순으로 단어 단위 타임스탬프를 얻는다."""
    try:
        import whisperx

        from .engines import torch_device

        device = "cuda" if torch_device() == "cuda" else "cpu"
        audio = whisperx.load_audio(str(vocals_path))
        model = whisperx.load_model(model_size, device, compute_type="int8", language=language)
        result = model.transcribe(audio, language=language)
        align_model, meta = whisperx.load_align_model(language_code=result["language"], device=device)
        aligned = whisperx.align(result["segments"], align_model, meta, audio, device)
        return [
            Word(float(w["start"]), float(w["end"]), w["word"].strip())
            for seg in aligned["segments"] for w in seg.get("words", [])
            if w.get("word", "").strip() and "start" in w
        ]
    except ImportError:
        pass
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(model_size, device="auto", compute_type="int8")
        segments, _ = model.transcribe(str(vocals_path), language=language, word_timestamps=True,
                                       vad_filter=True)
        return [
            Word(float(w.start), float(w.end), w.word.strip())
            for seg in segments for w in (seg.words or []) if w.word.strip()
        ]
    except ImportError:
        pass
    try:
        import whisper
    except ImportError as e:
        raise RuntimeError(
            "가사 인식에는 faster-whisper 가 필요합니다: pip install faster-whisper"
        ) from e
    model = whisper.load_model(model_size)
    result = model.transcribe(str(vocals_path), language=language, word_timestamps=True)
    return [
        Word(float(w["start"]), float(w["end"]), w["word"].strip())
        for seg in result["segments"] for w in seg.get("words", []) if w["word"].strip()
    ]


def split_syllables(word: str) -> list[str]:
    """한국어는 글자(음절) 단위로, 그 외 언어는 단어 그대로."""
    if HANGUL.search(word):
        sylls = [ch for ch in word if not ch.isspace()]
        # 문장부호는 앞 음절에 붙인다
        out: list[str] = []
        for ch in sylls:
            if out and not (HANGUL.match(ch) or ch.isalnum()):
                out[-1] += ch
            else:
                out.append(ch)
        return out
    return [word]


def align_lyrics(notes: list[Note], words: list[Word], tolerance: float = 0.2) -> dict[int, str]:
    """가사를 음표에 배치. 반환: {음표 인덱스: 음절}.

    한국어는 단어 시간 범위 안의 음표들에 음절을 하나씩 나눠 붙이고,
    음표가 모자라면 남은 음절은 마지막 음표에 몰아서 붙인다.
    """
    assigned: dict[int, str] = {}
    starts = [n.start for n in notes]
    for w in words:
        idx = [i for i, s in enumerate(starts)
               if w.start - tolerance <= s < w.end and i not in assigned]
        if not idx:
            # 가장 가까운 빈 음표
            free = [i for i in range(len(notes)) if i not in assigned]
            if not free:
                continue
            nearest = min(free, key=lambda i: abs(starts[i] - w.start))
            if abs(starts[nearest] - w.start) > 1.0:
                continue
            idx = [nearest]
        sylls = split_syllables(w.text)
        if len(sylls) <= len(idx):
            for i, syl in zip(idx, sylls):
                assigned[i] = syl
        else:
            for i, syl in zip(idx[:-1], sylls):
                assigned[i] = syl
            assigned[idx[-1]] = "".join(sylls[len(idx) - 1:])
    return assigned
