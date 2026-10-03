"""스템별 악기 설정: 음역, 단선율 여부, 보표 종류, 채보 엔진."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class InstrumentSpec:
    stem: str
    label: str  # 악보에 표시되는 이름
    label_ko: str
    program: int  # GM 프로그램 번호 (MIDI 재생용)
    low: int  # 채보 허용 최저음 (MIDI)
    high: int  # 채보 허용 최고음 (MIDI)
    mono: bool  # 단선율(한 번에 한 음)로 정리할지
    staff: str  # treble | treble8 | bass8 | grand | perc | auto
    engine: str  # basic_pitch | pyin | drums
    min_note: float = 0.08  # 최소 음 길이 (초)


INSTRUMENTS: dict[str, InstrumentSpec] = {
    "vocals": InstrumentSpec("vocals", "Vocals", "보컬", 53, 40, 84, True, "auto", "pyin", 0.10),
    "guitar": InstrumentSpec("guitar", "Guitar", "기타", 25, 40, 88, False, "treble8", "basic_pitch"),
    "piano": InstrumentSpec("piano", "Piano", "피아노", 0, 21, 108, False, "grand", "basic_pitch"),
    "other": InstrumentSpec("other", "Keys / Synth", "건반·신스 등", 89, 36, 96, False, "grand",
                            "basic_pitch"),
    "bass": InstrumentSpec("bass", "Bass", "베이스", 33, 23, 67, True, "bass8", "pyin", 0.10),
    "drums": InstrumentSpec("drums", "Drums", "드럼", 0, 35, 81, False, "perc", "drums"),
}

# 악보(총보)에 표시할 순서
SCORE_ORDER = ["vocals", "guitar", "piano", "other", "bass", "drums"]

# GM 드럼 번호
KICK, SNARE, HIHAT = 36, 38, 42
DRUM_NAMES = {KICK: "Kick", SNARE: "Snare", HIHAT: "Hi-hat"}


def spec_for(stem: str) -> InstrumentSpec:
    if stem in INSTRUMENTS:
        return INSTRUMENTS[stem]
    return InstrumentSpec(stem, stem.title(), stem, 0, 21, 108, False, "grand", "basic_pitch")
