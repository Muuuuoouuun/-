"""음악 이론 유틸리티: 키 감지, 음 이름 표기(철자), 조옮김 계산."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

PITCH_CLASSES = {
    "C": 0, "B#": 0,
    "C#": 1, "DB": 1,
    "D": 2,
    "D#": 3, "EB": 3,
    "E": 4, "FB": 4,
    "F": 5, "E#": 5,
    "F#": 6, "GB": 6,
    "G": 7,
    "G#": 8, "AB": 8,
    "A": 9,
    "A#": 10, "BB": 10,
    "B": 11, "CB": 11,
}

# 장조 으뜸음(pitch class) -> 조표 (양수 = 샵 개수, 음수 = 플랫 개수)
MAJOR_FIFTHS = {0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1}

LETTERS = "CDEFGAB"
LETTER_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# 오도권 순서로 샵/플랫이 붙는 글자
SHARP_ORDER = "FCGDAEB"
FLAT_ORDER = "BEADGCF"

# Krumhansl-Kessler 키 프로파일
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


@dataclass(frozen=True)
class Key:
    tonic: int  # pitch class 0-11
    mode: str  # "major" | "minor"
    fifths: int  # 조표: +샵 / -플랫

    @classmethod
    def from_tonic(cls, tonic: int, mode: str = "major", prefer: int | None = None) -> "Key":
        """으뜸음과 조성으로 Key 생성. 이명동음 조(F#/Gb 등)는 조표가 적은 쪽을 선택."""
        mode = mode.lower()
        if mode not in ("major", "minor"):
            raise ValueError(f"알 수 없는 조성: {mode}")
        tonic %= 12
        rel_major = tonic if mode == "major" else (tonic + 3) % 12
        fifths = MAJOR_FIFTHS[rel_major]
        if abs(fifths) == 6:
            # F#/Gb 장조, D#/Eb 단조: 장조는 F#, 단조는 Eb 를 기본으로
            fifths = 6 if mode == "major" else -6
            if prefer is not None:
                fifths = 6 if prefer >= 0 else -6
        return cls(tonic, mode, fifths)

    @classmethod
    def parse(cls, text: str, default_mode: str = "major") -> "Key":
        """'G', 'Bb', 'F#m', 'C# minor', 'Eb major', 'Am' 같은 문자열 파싱."""
        m = re.fullmatch(
            r"\s*([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major|M)?\s*", text
        )
        if not m:
            raise ValueError(f"키 형식을 이해할 수 없습니다: {text!r} (예: G, Bb, F#m, C minor)")
        letter, acc, mode_txt = m.groups()
        acc = {"♯": "#", "♭": "b"}.get(acc, acc)
        name = letter.upper() + acc.upper()
        tonic = PITCH_CLASSES[name]
        if mode_txt in ("m", "min", "minor"):
            mode = "minor"
        elif mode_txt in ("maj", "major", "M"):
            mode = "major"
        else:
            mode = default_mode
        # 사용자가 쓴 철자(샵/플랫)를 존중하되, 조표가 7개를 넘으면 이명동음 조로 바꾼다
        fifths = _fifths_for_spelling(letter.upper() + acc, mode)
        if abs(fifths) > 7:
            return cls.from_tonic(tonic, mode)
        return cls(tonic, mode, fifths)

    @property
    def tonic_name(self) -> str:
        return spell_pc(self.tonic, self.fifths)

    @property
    def name(self) -> str:
        return f"{self.tonic_name} {self.mode}"

    @property
    def short_name(self) -> str:
        return self.tonic_name + ("m" if self.mode == "minor" else "")

    def transposed(self, semitones: int) -> "Key":
        return Key.from_tonic(self.tonic + semitones, self.mode)

    def to_dict(self) -> dict:
        return {"tonic": self.tonic, "mode": self.mode, "fifths": self.fifths, "name": self.name}

    @classmethod
    def from_dict(cls, d: dict) -> "Key":
        return cls(int(d["tonic"]), d["mode"], int(d["fifths"]))


def _fifths_for_spelling(name: str, mode: str) -> int:
    """'Gb' 장조 -> -6, 'D#' 단조 -> 6 처럼 철자 그대로의 조표 수 계산."""
    letter = name[0].upper()
    alter = name.count("#") - name.count("b")
    # C 장조 기준으로 각 글자의 조표 수
    base_major = {"C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F": -1}
    base_minor = {"A": 0, "E": 1, "B": 2, "F": -4, "C": -3, "G": -2, "D": -1}
    base = (base_major if mode == "major" else base_minor)[letter]
    return base + 7 * alter


def key_signature_spelling(fifths: int) -> dict[str, int]:
    """조표에 의해 변화되는 글자 -> alter (+1/-1)."""
    if fifths >= 0:
        return {ch: 1 for ch in SHARP_ORDER[:fifths]}
    return {ch: -1 for ch in FLAT_ORDER[: -fifths]}


def _name(letter: str, alter: int) -> str:
    return letter + ("#" * alter if alter > 0 else "b" * (-alter))


def spelling_table(fifths: int, mode: str = "major", tonic: int | None = None) -> dict[int, str]:
    """pitch class -> 조에 맞는 음 이름 (예: Bb 장조에서 pc 3 -> 'Eb')."""
    sig = key_signature_spelling(fifths)
    table: dict[int, str] = {}
    for letter in LETTERS:
        alter = sig.get(letter, 0)
        table[(LETTER_PC[letter] + alter) % 12] = _name(letter, alter)
    if mode == "minor" and tonic is not None:
        # 화성/가락 단음계의 올린 6, 7음은 해당 음도 글자에 샵(또는 제자리)을 붙여 표기
        tonic_name = table[tonic % 12]
        t_idx = LETTERS.index(tonic_name[0])
        for degree, interval in ((5, 9), (6, 11)):
            letter = LETTERS[(t_idx + degree) % 7]
            pc = (tonic + interval) % 12
            if pc not in table:
                alter = sig.get(letter, 0) + 1
                table[pc] = _name(letter, alter)
    # 나머지 반음계 음: 샵 조는 샵, 플랫 조는 플랫으로
    for pc in range(12):
        if pc not in table:
            table[pc] = _plain_sharp(pc) if fifths >= 0 else _plain_flat(pc)
    return table


_SHARPS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def _plain_sharp(pc: int) -> str:
    return _SHARPS[pc % 12]


def _plain_flat(pc: int) -> str:
    return _FLATS[pc % 12]


def spell_pc(pc: int, fifths: int, mode: str = "major", tonic: int | None = None) -> str:
    return spelling_table(fifths, mode, tonic)[pc % 12]


def spell_midi(midi: int, key: Key) -> tuple[str, int]:
    """MIDI 번호를 (음이름, 옥타브)로. 옥타브는 B#/Cb 경계를 고려한 과학적 표기."""
    name = spell_pc(midi % 12, key.fifths, key.mode, key.tonic)
    octave = midi // 12 - 1
    letter_pc = LETTER_PC[name[0]]
    alter = name.count("#") - name.count("b")
    # 예: B#3 은 MIDI 60 (C4) 과 같은 소리 -> 글자 기준 옥타브는 하나 낮음
    if letter_pc + alter >= 12:
        octave -= 1
    elif letter_pc + alter < 0:
        octave += 1
    return name, octave


def detect_key(
    notes: Iterable[tuple[int, float]],
) -> tuple[Key, float]:
    """(midi pitch, weight) 목록으로 Krumhansl-Schmuckler 키 감지.

    반환: (Key, 상관계수)
    """
    hist = np.zeros(12)
    for pitch, weight in notes:
        hist[int(pitch) % 12] += weight
    if hist.sum() <= 0:
        return Key.from_tonic(0, "major"), 0.0
    best = (-2.0, 0, "major")
    for tonic in range(12):
        for mode, profile in (("major", KK_MAJOR), ("minor", KK_MINOR)):
            r = np.corrcoef(hist, np.roll(profile, tonic))[0, 1]
            if np.isnan(r):
                continue
            if r > best[0]:
                best = (r, tonic, mode)
    r, tonic, mode = best
    return Key.from_tonic(tonic, mode), float(r)


def semitones_between(src: Key, dst_tonic: int, direction: str = "nearest") -> int:
    """src 키에서 dst 으뜸음으로 가는 반음 수.

    direction: 'nearest'(-6..+5), 'up'(0..11), 'down'(-11..0)
    """
    diff = (dst_tonic - src.tonic) % 12
    if direction == "up":
        return diff
    if direction == "down":
        return diff - 12 if diff else 0
    return diff - 12 if diff > 6 else diff


def transpose_target(src: Key, target: str | None = None, semitones: int | None = None,
                     direction: str = "nearest") -> tuple[int, Key]:
    """조옮김 반음 수와 결과 키 계산.

    target 이 주어지면 그 키로, 아니면 semitones 만큼 이동.
    """
    if target:
        dst = Key.parse(target, default_mode=src.mode)
        if dst.mode != src.mode:
            # 'Am' 같이 다른 조성을 줬을 때: 같은 조성의 같은 으뜸음으로 맞춘다
            dst = Key.from_tonic(dst.tonic, src.mode)
        shift = semitones_between(src, dst.tonic, direction)
        return shift, dst
    shift = int(semitones or 0)
    return shift, src.transposed(shift)


def chord_tone_names(root_pc: int, intervals: Sequence[int], key: Key) -> list[str]:
    return [spell_pc((root_pc + i) % 12, key.fifths, key.mode, key.tonic) for i in intervals]
