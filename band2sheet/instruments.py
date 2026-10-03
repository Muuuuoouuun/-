"""스템별 악기 설정: 음역, 단선율 여부, 보표 종류, 채보 엔진, 드럼 키트 구성, 줄악기 조율."""

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
    engine: str  # auto | basic_pitch | pyin | crepe | piano_hr | drums
    min_note: float = 0.08  # 최소 음 길이 (초)
    tab: tuple[int, ...] | None = None  # TAB 악보 조율 (낮은 줄 -> 높은 줄, MIDI)


GUITAR_TUNING = (40, 45, 50, 55, 59, 64)  # E A D G B E
BASS_TUNING = (28, 33, 38, 43)  # E A D G

INSTRUMENTS: dict[str, InstrumentSpec] = {
    "vocals": InstrumentSpec("vocals", "Vocals", "보컬(메인)", 53, 40, 84, True, "auto", "auto", 0.10),
    "backing_vocals": InstrumentSpec("backing_vocals", "Backing Vocals", "코러스(화음)", 52, 43, 84,
                                     False, "treble", "basic_pitch", 0.12),
    "guitar": InstrumentSpec("guitar", "Guitar", "기타", 25, 40, 88, False, "treble8", "basic_pitch",
                             tab=GUITAR_TUNING),
    "piano": InstrumentSpec("piano", "Piano", "피아노", 0, 21, 108, False, "grand", "auto"),
    "other": InstrumentSpec("other", "Keys / Synth", "건반·신스 등", 89, 36, 96, False, "grand",
                            "basic_pitch"),
    "bass": InstrumentSpec("bass", "Bass", "베이스", 33, 23, 67, True, "bass8", "auto", 0.10,
                           tab=BASS_TUNING),
    "drums": InstrumentSpec("drums", "Drums", "드럼", 0, 35, 81, False, "perc", "drums"),
}

# 악보(총보)에 표시할 순서
SCORE_ORDER = ["vocals", "backing_vocals", "guitar", "piano", "other", "bass", "drums"]

# ---------------------------------------------------------------------------
# 드럼 키트 (GM 드럼 번호)
# ---------------------------------------------------------------------------
KICK, SNARE = 36, 38
HIHAT, HIHAT_OPEN = 42, 46
TOM_HIGH, TOM_MID, TOM_FLOOR = 50, 47, 43
CRASH, RIDE = 49, 51


@dataclass(frozen=True)
class DrumPiece:
    midi: int
    name: str
    name_ko: str
    display: str  # 오선 위 위치 (예: "F4")
    notehead: str  # normal | x | circle-x
    foot: bool = False  # 발로 연주(아래 성부)


DRUM_KIT: dict[int, DrumPiece] = {p.midi: p for p in [
    DrumPiece(KICK, "Kick", "킥", "F4", "normal", foot=True),
    DrumPiece(SNARE, "Snare", "스네어", "C5", "normal"),
    DrumPiece(HIHAT, "Hi-hat", "하이햇(닫힘)", "G5", "x"),
    DrumPiece(HIHAT_OPEN, "Open Hi-hat", "하이햇(열림)", "G5", "circle-x"),
    DrumPiece(TOM_HIGH, "High Tom", "하이탐", "E5", "normal"),
    DrumPiece(TOM_MID, "Mid Tom", "미드탐", "D5", "normal"),
    DrumPiece(TOM_FLOOR, "Floor Tom", "플로어탐", "A4", "normal"),
    DrumPiece(CRASH, "Crash", "크래시", "A5", "x"),
    DrumPiece(RIDE, "Ride", "라이드", "F5", "x"),
]}
DRUM_NAMES = {m: p.name for m, p in DRUM_KIT.items()}

# DrumSep(6스템) 결과 파일 이름 -> 키트 구성
DRUMSEP_STEMS = ("kick", "snare", "toms", "hh", "ride", "crash")


def spec_for(stem: str) -> InstrumentSpec:
    if stem in INSTRUMENTS:
        return INSTRUMENTS[stem]
    return InstrumentSpec(stem, stem.title(), stem, 0, 21, 108, False, "grand", "basic_pitch")
