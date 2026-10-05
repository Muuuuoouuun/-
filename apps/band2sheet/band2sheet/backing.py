"""반주 스타일: 코드 진행 -> 스타일별 편곡 -> MIDI 저장 + 소리 합성.

스타일
  orchestra  오케스트라   현악 4성부·첼로/콘트라베이스·호른·하프·팀파니
  jazz       재즈 트리오  피아노 컴핑(루트리스 보이싱, 찰스턴 리듬)·워킹 베이스·브러시 드럼 스윙
  pad        워십 패드    길게 깔리는 패드(근음·5도·옥타브 + 높은 3도) + 서브 베이스, 긴 잔향
  piano      피아노 반주  왼손 근음 옥타브 + 오른손 분산화음 -> 후반에 화음 반주로 빌드업
  guitar     어쿠스틱 기타 아르페지오(핑거피킹) -> 후반 스트로크(D DU UDU)
  acappella  아카펠라     베이스 보컬('둠 둠') + 비트박스 (화음은 remix 에서 내 목소리로)

편곡은 MIDI 로도 저장하므로 DAW 에서 원하는 음색으로 바꿀 수 있다.
사운드폰트(.sf2)와 fluidsynth 가 있으면 그 음색으로, 없으면 내장 합성기로 소리를 만든다.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
from scipy.signal import butter, lfilter, sosfilt

from .sound import eq, pluck
from .theory import Key
from .vocalfx import add_reverb, chord_tones, pan

STYLE_DESC = {
    "orchestra": "현악·첼로/콘트라베이스·호른·하프·팀파니",
    "jazz": "피아노 컴핑·워킹 베이스·브러시 드럼 스윙",
    "pad": "앰비언트 패드 + 서브 베이스",
    "piano": "왼손 옥타브 + 오른손 분산화음, 후반 화음 반주",
    "guitar": "핑거피킹 -> 스트로크",
    "acappella": "베이스 보컬 + 비트박스",
}
# 스타일별 잔향 (섞는 양, 길이 초)
STYLE_REVERB = {"orchestra": (0.30, 2.6), "jazz": (0.14, 1.2), "pad": (0.45, 4.0),
                "piano": (0.24, 2.2), "guitar": (0.18, 1.5), "acappella": (0.20, 1.8)}


@dataclass
class ChordSpan:
    start: float  # 초
    end: float
    root: int | None
    quality: str = ""


@dataclass
class ONote:
    part: str
    start: float
    end: float
    pitch: int  # 드럼 파트는 GM 드럼 번호
    velocity: int


# ---------------------------------------------------------------------------
# 파트(악기) 정의
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Part:
    label: str
    program: int  # GM 프로그램 번호 (drum=True 면 GM 드럼 채널)
    kind: str  # osc | pluck | piano | drum | vox
    gain: float
    pan: float | str = 0.0  # 숫자=고정 위치, "spread"=음높이 따라 좌우, "wide"=저역/고역 좌우로 펼침
    lowpass: float | None = None
    drum: bool = False
    p: tuple = ()  # 합성 파라미터


PARTS: dict[str, Part] = {
    # osc p = (파형, 겹칠 소리 수, 디튠 센트, 비브라토 센트, 어택 초, 릴리즈 초)
    "strings": Part("Strings", 48, "osc", 0.136, "wide", 4500, p=("saw", 3, 9.0, 12.0, 0.35, 0.45)),
    "cello": Part("Cello", 42, "osc", 0.18, 0.35, 2200, p=("warm", 2, 6.0, 10.0, 0.12, 0.3)),
    "contrabass": Part("Contrabass", 43, "osc", 0.215, 0.0, 900, p=("warm", 2, 5.0, 6.0, 0.1, 0.3)),
    "horn": Part("French Horn", 60, "osc", 0.13, -0.35, 1800, p=("horn", 2, 5.0, 4.0, 0.25, 0.4)),
    "pad": Part("Warm Pad", 89, "osc", 0.097, "wide", 2400, p=("saw", 5, 14.0, 0.0, 1.1, 1.6)),
    "pad_sub": Part("Pad Bass", 38, "osc", 0.21, 0.0, 260, p=("warm", 1, 0.0, 0.0, 0.6, 1.2)),
    # pluck: Karplus-Strong 현 (울림·밝기·뜯는 위치는 PLUCK 표)
    "harp": Part("Harp", 46, "pluck", 0.57, -0.45, 5000),  # 소리는 PLUCK 표
    "guitar": Part("Acoustic Guitar", 25, "pluck", 0.59, "spread", 7000),
    "upright_bass": Part("Acoustic Bass", 32, "pluck", 0.94, 0.1, 1200),
    "piano": Part("Piano", 0, "piano", 0.60, "spread"),
    "timpani": Part("Timpani", 47, "drum", 0.35, 0.0, p=("timpani",)),
    "kick": Part("Kick", 36, "drum", 0.45, 0.0, drum=True, p=("kick",)),
    "brush": Part("Brush Snare", 40, "drum", 0.22, -0.15, drum=True, p=("brush",)),
    "ride": Part("Ride", 51, "drum", 0.16, 0.35, drum=True, p=("ride",)),
    "hihat": Part("Hi-hat Pedal", 44, "drum", 0.14, -0.3, drum=True, p=("hat",)),
    "bass_vox": Part("Bass Vocal", 53, "vox", 0.51, 0.0, p=("oo",)),
    "bb_kick": Part("Beatbox Kick", 36, "drum", 0.55, 0.0, drum=True, p=("bb_kick",)),
    "bb_snare": Part("Beatbox Snare", 38, "drum", 0.32, 0.05, drum=True, p=("bb_snare",)),
    "bb_hat": Part("Beatbox Hat", 42, "drum", 0.16, -0.1, drum=True, p=("bb_hat",)),
}


# ---------------------------------------------------------------------------
# 편곡 공통
# ---------------------------------------------------------------------------

def _voicing(tones: list[int], prev: list[int] | None, low: int = 55, high: int = 76,
             double_root: bool = True) -> list[int]:
    """코드 구성음을 low~high 안에 쌓되, 앞 화음에서 가장 적게 움직이는 자리바꿈을 고른다."""
    cands = []
    for base in range(low, low + 12):
        v, p = [], base
        for pc in sorted(tones, key=lambda pc: (pc - base) % 12):
            while p % 12 != pc:
                p += 1
            v.append(p)
        if len(v) == 3 and double_root:  # 근음을 한 옥타브 위에 겹쳐 4성부
            v.append(v[0] + 12)
        if v[-1] <= high:
            cands.append(sorted(v))
    if not cands:
        cands = [sorted(low + ((pc - low) % 12) for pc in tones)]
    if prev is None:
        return min(cands, key=lambda v: abs(np.mean(v) - (low + high) / 2))
    return min(cands, key=lambda v: sum(abs(a - b) for a, b in zip(v, prev)))


def _in_range(pc: int, low: int, high: int) -> int:
    p = low + ((pc - low) % 12)
    return p if p <= high else p - 12


class _Ctx:
    """편곡에 필요한 시간 정보: 박, 마디 첫 박, 코드 찾기, 셈여림 곡선."""

    def __init__(self, chords: list[ChordSpan], beats: list[float], bpb: int, downbeat: int,
                 end_time: float | None):
        self.spans = [c for c in chords if c.root is not None and c.end - c.start > 0.15]
        self.beats = sorted(beats)
        self.bpb = max(1, bpb)
        self.period = float(np.median(np.diff(self.beats))) if len(self.beats) > 1 else 0.5
        self.start = self.spans[0].start if self.spans else 0.0
        self.end = end_time or (self.spans[-1].end if self.spans else 0.0)
        self.bar_starts = [b for i, b in enumerate(self.beats) if (i - downbeat) % self.bpb == 0]
        while self.bar_starts and self.bar_starts[0] > self.start + 1e-3:  # 못갖춘마디 앞부분도 덮기
            self.bar_starts.insert(0, self.bar_starts[0] - self.bpb * self.period)
        self.total = max(self.end - self.start, 1e-3)

    def dyn(self, t: float) -> float:  # 0.55 -> 1.0 (곡 60% 지점까지 점점 크게)
        return 0.55 + 0.45 * min(1.0, max(0.0, (t - self.start) / (0.6 * self.total)))

    def chord_at(self, t: float) -> ChordSpan | None:
        for c in self.spans:
            if c.start - 1e-3 <= t < c.end:
                return c
        return None

    def bars(self):
        """(마디 시작, 마디 끝) — 코드가 있는 범위만."""
        bs = self.bar_starts
        if not bs:
            return
        for a, b in zip(bs, bs[1:] + [bs[-1] + self.bpb * self.period]):
            if b > self.start and a < self.end:
                yield a, b

    def beat_times(self):
        return [b for b in self.beats if self.start - 1e-3 <= b < self.end]

    def tones(self, c: ChordSpan) -> list[int]:
        return sorted(chord_tones(c.root, c.quality) or [])


def _pattern(positions: list[float], bpb: int) -> list[float]:
    """4/4 기준 리듬을 박자에 맞게 (3/4 면 3박 넘는 위치는 뺌)."""
    return [p for p in positions if p < bpb]


# ---------------------------------------------------------------------------
# 스타일별 편곡
# ---------------------------------------------------------------------------

def arrange_orchestra(x: _Ctx, key: Key | None = None) -> list[ONote]:
    notes: list[ONote] = []
    prev = None
    for c in x.spans:
        tones = x.tones(c)
        v = _voicing(tones, prev)
        prev = v
        d = x.dyn(c.start)
        rel = min(0.35, 0.5 * (c.end - c.start))
        for p in v:  # 현악 (지속음)
            notes.append(ONote("strings", c.start, c.end + rel, p, int(70 * d + 20)))
        # 저음: 마디 첫 박마다 다시 그음 (긴 코드에서도 리듬이 살게)
        cuts = [c.start] + [b for b in x.bar_starts if c.start + 0.2 < b < c.end - 0.2] + [c.end]
        for a, b in zip(cuts[:-1], cuts[1:]):
            notes.append(ONote("cello", a, b + 0.1, _in_range(c.root, 48, 59), int(72 * d + 18)))
            notes.append(ONote("contrabass", a, b + 0.1, _in_range(c.root, 36, 47), int(70 * d + 15)))
        if c.end - c.start >= 1.8 * x.period and d > 0.7:  # 호른: 곡 중반부터 근음+5도
            for iv in (0, 7):
                notes.append(ONote("horn", c.start, c.end + rel, _in_range(c.root + iv, 53, 67),
                                   int(60 * d)))
        arp = sorted({_in_range(pc, 48, 59) for pc in tones} | {_in_range(pc, 60, 71) for pc in tones})
        arp = arp + arp[-2:0:-1]
        t, i = c.start, 0
        while t < c.end - 0.05:  # 하프: 8분음표 분산화음
            notes.append(ONote("harp", t, t + 1.2, arp[i % len(arp)], int(50 + 25 * d)))
            t += x.period / 2
            i += 1
    for k, (b, _) in enumerate(x.bars()):  # 팀파니: 4마디마다
        c = x.chord_at(b)
        if k % 4 == 0 and c:
            notes.append(ONote("timpani", b, b + 1.5, _in_range(c.root, 41, 52), int(55 + 40 * x.dyn(b))))
    last = x.spans[-1]
    notes.append(ONote("timpani", last.start, last.start + 2.0, _in_range(last.root, 41, 52), 100))
    return notes


def jazz_intervals(c: ChordSpan, key: Key | None) -> tuple[int, ...]:
    """재즈 코드로 확장: 장3화음 -> maj7 (딸림화음이면 7), 단3화음 -> m7, dim -> m7b5, sus4 -> 7sus4."""
    q = c.quality
    dominant = key is not None and (c.root - key.tonic) % 12 == 7
    return {"": (0, 4, 7, 10) if dominant else (0, 4, 7, 11), "m": (0, 3, 7, 10), "7": (0, 4, 7, 10),
            "maj7": (0, 4, 7, 11), "m7": (0, 3, 7, 10), "dim": (0, 3, 6, 10),
            "sus4": (0, 5, 7, 10), "sus2": (0, 2, 7, 11)}.get(q, (0, 4, 7, 10))


def arrange_jazz(x: _Ctx, key: Key | None = None) -> list[ONote]:
    rng = np.random.default_rng(3)
    notes: list[ONote] = []
    swing = 2.0 / 3.0  # 스윙 8분음표: 박의 2/3 지점
    # 피아노 컴핑: 루트리스 보이싱(3·5·7·9), 찰스턴 리듬 (1박, 2박 뒤 '앤')
    prev = None
    for a, _ in x.bars():
        for pos, length in ((0.0, 0.55), (1.0 + swing, 1.2)):
            if pos >= x.bpb:
                continue
            t = a + pos * x.period
            c = x.chord_at(t)
            if c is None:
                continue
            ivs = jazz_intervals(c, key)
            pcs = [(c.root + i) % 12 for i in ivs[1:]] + [(c.root + 2) % 12]  # 3 5 7 + 9
            v = _voicing(pcs, prev, 52, 72, double_root=False)
            prev = v
            vel = int((55 + 20 * x.dyn(t)) * rng.uniform(0.9, 1.05))
            for p in v:
                notes.append(ONote("piano", t + rng.uniform(0, 0.012), t + length * x.period, p, vel))
    # 워킹 베이스: 한 박에 한 음 — 근음, 코드음, 다음 코드 근음으로 반음 접근
    prev_b = None
    beats = x.beat_times()
    for i, t in enumerate(beats):
        c = x.chord_at(t)
        if c is None:
            continue
        nxt = x.chord_at(t + x.period)
        ivs = jazz_intervals(c, key)
        first = i == 0 or x.chord_at(beats[i - 1]) is not c or any(abs(t - b) < 1e-3 for b in x.bar_starts)
        if nxt is not None and nxt is not c and nxt.root != c.root:
            target = _in_range(nxt.root, 31, 50)
            pc = (target + (1 if prev_b is not None and prev_b > target else -1)) % 12
        elif first:
            pc = c.root
        else:
            pc = (c.root + [ivs[2], ivs[1], ivs[3], ivs[2]][i % 4]) % 12  # 5도, 3도, 7도, 5도
        cands = [p for p in range(31, 52) if p % 12 == pc]
        p = min(cands, key=lambda q: abs(q - prev_b)) if prev_b is not None else _in_range(pc, 33, 45)
        prev_b = p
        notes.append(ONote("upright_bass", t, t + x.period * 0.95, p, int(80 + 15 * x.dyn(t))))
    # 브러시 드럼: 라이드 스윙(딩 딩-가 딩 딩-가), 하이햇 페달 2·4박, 브러시 휘젓기, 킥 살짝
    for i, t in enumerate(beats):
        k = int(round((t - x.bar_starts[0]) / x.period)) % x.bpb if x.bar_starts else i % x.bpb
        notes.append(ONote("ride", t, t + 1.0, 51, 85 if k % 2 == 1 else 70))
        if k % 2 == 1:
            notes.append(ONote("ride", t + swing * x.period, t + 1.0, 51, 55))
            notes.append(ONote("hihat", t, t + 0.1, 44, 70))
        notes.append(ONote("brush", t, t + x.period, 40, int(40 + 20 * x.dyn(t))))
        if k == 0:
            notes.append(ONote("kick", t, t + 0.3, 36, 35))
    return notes


def arrange_pad(x: _Ctx, key: Key | None = None) -> list[ONote]:
    notes: list[ONote] = []
    for c in x.spans:
        d = x.dyn(c.start)
        tail = 0.9  # 다음 화음과 겹쳐 자연스럽게 넘어감
        r = _in_range(c.root, 48, 59)
        for p, vel in ((r, 70), (r + 7, 62), (r + 12, 58)):  # 근음·5도·옥타브 (어떤 코드에도 맞음)
            notes.append(ONote("pad", c.start, c.end + tail, p, int(vel * (0.6 + 0.4 * d) + 20)))
        tones = x.tones(c)
        third = next((pc for pc in tones if pc != c.root and (pc - c.root) % 12 in (3, 4, 2, 5)), None)
        if third is not None:  # 높은 3도가 반짝이듯 (장/단 색깔)
            notes.append(ONote("pad", c.start, c.end + tail, _in_range(third, 67, 79), int(40 + 25 * d)))
        notes.append(ONote("pad_sub", c.start, c.end + 0.3, _in_range(c.root, 36, 47), int(60 + 30 * d)))
    return notes


def arrange_piano(x: _Ctx, key: Key | None = None) -> list[ONote]:
    notes: list[ONote] = []
    prev = None
    for c in x.spans:
        tones = x.tones(c)
        v = _voicing(tones, prev, 60, 79)
        prev = v
        d = x.dyn(c.start)
        # 왼손: 근음 옥타브, 마디마다 다시 침
        cuts = [c.start] + [b for b in x.bar_starts if c.start + 0.2 < b < c.end - 0.2] + [c.end]
        for a, b in zip(cuts[:-1], cuts[1:]):
            lo = _in_range(c.root, 36, 47)
            for p in (lo, lo + 12):
                notes.append(ONote("piano", a, b + 0.05, p, int(55 + 25 * d)))
        # 오른손: 앞부분은 8분음표 분산화음, 후반(셈여림이 커지면)은 박마다 화음
        t = c.start
        if d < 0.8:
            order = [0, 1, 2, 3, 2, 1]
            i = 0
            while t < c.end - 0.05:
                p = v[order[i % len(order)] % len(v)]
                notes.append(ONote("piano", t, min(t + 1.5 * x.period, c.end + 0.2), p, int(45 + 25 * d)))
                t += x.period / 2
                i += 1
        else:
            while t < c.end - 0.05:
                for p in v[1:] + [v[-1] + 12]:
                    notes.append(ONote("piano", t, t + 0.9 * x.period, p, int(50 + 30 * d)))
                t += x.period
    return notes


def _guitar_voicing(c: ChordSpan, tones: list[int]) -> list[int]:
    """기타 6줄: 근음 베이스(E2~E3) + 위로 코드음을 쌓아 5~6음."""
    bass = _in_range(c.root, 40, 51)
    out, p = [bass], bass + 1
    order = sorted(tones, key=lambda pc: (pc - bass) % 12)
    while len(out) < 6 and p <= 71:
        if p % 12 in order and p - out[-1] >= 3:
            out.append(p)
        p += 1
    return out


def arrange_guitar(x: _Ctx, key: Key | None = None) -> list[ONote]:
    notes: list[ONote] = []
    strum = _pattern([0.0, 1.0, 1.5, 2.5, 3.0, 3.5], x.bpb)  # D  D U  U D U
    downs = {0.0, 1.0, 3.0}
    for a, b in x.bars():
        d = x.dyn(a)
        if d < 0.7:  # 핑거피킹: 베이스 - 3 - 2 - 1 - 5도 베이스 - 2 - 3 - 2
            for k in range(2 * x.bpb):
                t = a + k * x.period / 2
                c = x.chord_at(t)
                if c is None or t >= x.end:
                    continue
                v = _guitar_voicing(c, x.tones(c))
                top = v[1:] or v
                if k % 4 == 0:
                    p = v[0] if k % 8 == 0 else _in_range(c.root + 7, 40, 52)
                else:
                    p = top[[1, 2, 3, 2][k % 4] % len(top)]
                notes.append(ONote("guitar", t, t + 1.2 * x.period, p, int(60 + 25 * d)))
        else:  # 스트로크
            times = [a + pos * x.period for pos in strum] + [b]
            for pos, t, t_next in zip(strum, times[:-1], times[1:]):
                c = x.chord_at(t)
                if c is None or t >= x.end:
                    continue
                v = _guitar_voicing(c, x.tones(c))
                down = pos in downs
                order = v if down else v[::-1][:4]  # 업 스트로크는 높은 줄 4개만, 위에서 아래로
                for j, p in enumerate(order):
                    s = t + j * 0.012
                    notes.append(ONote("guitar", s, t_next + 0.05, p, int((85 if down else 62) * (0.7 + 0.3 * d))))
    return notes


def arrange_acappella(x: _Ctx, key: Key | None = None) -> list[ONote]:
    notes: list[ONote] = []
    bass_pat = _pattern([0.0, 1.5, 2.0, 3.5], x.bpb)  # 둠 - 두 둠 - 두
    for a, _ in x.bars():
        d = x.dyn(a)
        for pos in bass_pat:
            t = a + pos * x.period
            c = x.chord_at(t)
            if c is None or t >= x.end:
                continue
            root = _in_range(c.root, 40, 51)
            p = root if pos in (0.0, 2.0) else (root + 7 if pos == 1.5 else min(root + 12, 57))
            length = 0.9 if pos in (0.0, 2.0) else 0.4
            notes.append(ONote("bass_vox", t, t + length * x.period, p, int(75 + 20 * d)))
        # 비트박스: 킥 1·3박, 스네어 2·4박, 하이햇 8분음표
        for k in range(2 * x.bpb):
            t = a + k * x.period / 2
            if t >= x.end or x.chord_at(t) is None:
                continue
            beat = k / 2
            if beat in (0.0, 2.0) or (x.bpb == 3 and beat == 0.0):
                notes.append(ONote("bb_kick", t, t + 0.2, 36, int(80 + 20 * d)))
            elif beat in (1.0, 3.0) and x.bpb != 3:
                notes.append(ONote("bb_snare", t, t + 0.2, 38, int(70 + 25 * d)))
            if d > 0.65:
                notes.append(ONote("bb_hat", t, t + 0.05, 42, 60 if k % 2 == 0 else 40))
    return notes


ARRANGERS = {"orchestra": arrange_orchestra, "jazz": arrange_jazz, "pad": arrange_pad,
             "piano": arrange_piano, "guitar": arrange_guitar, "acappella": arrange_acappella}


def arrange(style: str, chords: list[ChordSpan], beats: list[float], beats_per_bar: int = 4,
            downbeat: int = 0, end_time: float | None = None, key: Key | None = None) -> list[ONote]:
    if style not in ARRANGERS:
        raise ValueError(f"반주 스타일은 {', '.join(ARRANGERS)} 중 하나입니다.")
    x = _Ctx(chords, beats, beats_per_bar, downbeat, end_time)
    if not x.spans or not x.beats:
        return []
    return sorted(ARRANGERS[style](x, key), key=lambda n: (n.start, n.part, n.pitch))


def write_arrangement_midi(notes: list[ONote], path: Path, tempo: float = 120.0) -> Path:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    insts: dict[str, pretty_midi.Instrument] = {}
    for n in notes:
        part = PARTS[n.part]
        key = "drums" if part.drum else n.part
        if key not in insts:
            insts[key] = pretty_midi.Instrument(program=0 if part.drum else part.program,
                                                is_drum=part.drum, name="Drums" if part.drum else part.label)
        pitch = part.program if part.drum else n.pitch
        insts[key].notes.append(pretty_midi.Note(int(np.clip(n.velocity, 1, 127)), int(pitch),
                                                 float(n.start), float(max(n.end, n.start + 0.01))))
    pm.instruments.extend(insts.values())
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))
    return path


# ---------------------------------------------------------------------------
# 내장 합성기
# ---------------------------------------------------------------------------
# 음색 원칙
#   - 지속음(현악·호른·패드): 대역 제한 파형(보간 읽기) 여러 겹 + 겹마다 다른 느린 음정 흔들림.
#     활·입김이 닿는 순간만 밝았다가(bite) 차분해지거나, 소리가 커지며 밝아짐(swell).
#   - 뜯는 현(기타·하프·베이스): Karplus-Strong 물리 모델 + 울림통 이퀄라이저.
#   - 피아노: 비조화 배음 + 세게 칠수록 밝음 + 두 단계 감쇠(잔향음) + 세 줄 맥놀이.
#   - 모든 음은 몇 ms 씩 사람처럼 어긋나게 연주한다 (드럼은 더 작게).

_TABLES: dict[tuple[str, int], np.ndarray] = {}
TABLE = 4096


def _table(kind: str, midi: int, sr: int) -> np.ndarray:
    """대역 제한 파형 한 주기 (나이퀴스트를 넘는 배음은 뺌). 보간용으로 첫 샘플을 끝에 한 번 더 붙인다."""
    key = (kind, midi)
    if key not in _TABLES:
        f0 = librosa.midi_to_hz(midi)
        n_h = int(min(48, (sr / 2) / (f0 * 1.03) * 0.9))  # 비브라토로 올라가도 넘지 않게 여유
        ph = np.arange(TABLE) / TABLE * 2 * np.pi
        slope = {"saw": 1.0, "warm": 1.25, "horn": 1.7}[kind]
        w = sum(np.sin(k * ph) / k ** slope for k in range(1, max(n_h, 1) + 1))
        w = w / np.abs(w).max()
        _TABLES[key] = np.append(w, w[0])
    return _TABLES[key]


def _osc(kind: str, midi: int, n: int, sr: int, detune_cents: float = 0.0, vib_cents: float = 0.0,
         seed: int = 0, drift_cents: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(n) / sr
    cents = np.full(n, detune_cents)
    if vib_cents:
        onset = np.clip(t / 0.4, 0, 1)  # 비브라토는 음이 시작되고 조금 뒤부터
        cents = cents + vib_cents * onset * np.sin(2 * np.pi * rng.uniform(4.8, 5.8) * t + rng.uniform(0, 6.3))
    if drift_cents and n > 1:  # 연주자마다 다른 느린 음정 흔들림 (합주가 기계처럼 딱 맞지 않게)
        knots = rng.normal(0, drift_cents, int(n / sr / 0.6) + 3)
        cents = cents + np.interp(t, np.linspace(0, n / sr, len(knots)), knots)
    f = librosa.midi_to_hz(midi) * 2 ** (cents / 1200)
    phase = (rng.uniform() + np.cumsum(f) / sr) % 1.0
    pos = phase * TABLE
    i = pos.astype(np.int64)
    frac = pos - i
    tab = _table(kind, midi, sr)
    return tab[i] * (1 - frac) + tab[i + 1] * frac  # 선형 보간 (정수 자르기 잡음 제거)


def _env(n: int, sr: int, attack: float, release: float) -> np.ndarray:
    t = np.arange(n) / sr
    a = np.clip(t / max(attack, 1e-3), 0, 1)
    r = np.clip((n / sr - t) / max(release, 1e-3), 0, 1)
    return (a * a * (3 - 2 * a)) * (r * r * (3 - 2 * r))  # 부드러운 S 곡선 (시작·끝 딸깍 방지)


# 지속음 색: (기본 밝기 0~1, 방식 bite|swell, 시간 초, 활·숨 잡음 양)
OSC_COLOR = {
    "strings": (0.45, "bite", 0.22, 0.035),
    "cello": (0.5, "bite", 0.18, 0.03),
    "contrabass": (0.6, "bite", 0.15, 0.02),
    "horn": (0.35, "swell", 0.3, 0.012),
    "pad": (0.55, "swell", 1.2, 0.0),
    "pad_sub": (1.0, "swell", 0.5, 0.0),
}
# 뜯는 현: (울림 초, 밝기, 뜯는 위치)
PLUCK = {
    "harp": (2.4, 0.7, 0.45),
    "guitar": (2.2, 0.95, 0.17),
    "upright_bass": (2.6, 0.5, 0.3),
}
# 파트별 울림통·공간 이퀄라이저 (주파수, dB, Q[, 종류])
PART_EQ = {
    "strings": [(280, 2.5, 1.0), (1300, -1.5, 1.2), (3000, 2.0, 1.1), (8000, -4.0, 0.7, "highshelf")],
    "cello": [(220, 2.0, 1.0), (2500, 1.5, 1.0)],
    "horn": [(450, 2.0, 0.9), (3500, -2.0, 0.8, "highshelf")],
    "guitar": [(100, 4.0, 2.2), (205, 3.0, 2.0), (2600, 2.0, 1.0), (9000, -3.0, 0.7, "highshelf")],
    "harp": [(180, 2.0, 1.2), (4500, 1.5, 1.0)],
    "upright_bass": [(85, 3.0, 1.4), (700, -2.0, 1.0), (1800, 1.0, 1.5)],
    "piano": [(110, 1.5, 0.8), (600, -1.0, 1.0), (3200, 1.5, 1.0), (10000, -2.5, 0.7, "highshelf")],
    "pad": [(250, -2.0, 0.8)],
    "bass_vox": [(120, 2.0, 1.0)],
}


def _decaying_partials(freqs, amps, decays, n: int, sr: int, seed: int = 0) -> np.ndarray:
    t = np.arange(n) / sr
    ph = np.random.default_rng(seed).uniform(0, 2 * np.pi, len(freqs))
    out = np.zeros(n)
    for f, a, dk, p in zip(freqs, amps, decays, ph):
        if f < sr * 0.45:
            out += a * np.sin(2 * np.pi * f * t + p) * np.exp(-dk * t)
    return out


def _piano(midi: int, n: int, sr: int, vel: float = 0.6) -> np.ndarray:
    """vel: 0~1. 세게 칠수록 높은 배음이 살아나고 해머 소리가 커진다."""
    f0 = float(librosa.midi_to_hz(midi))
    tau = float(np.clip(3.2 - (midi - 21) * 0.035, 0.5, 3.2))
    big_b = 0.00008 * 2 ** ((midi - 48) / 18)  # 높은 음일수록 현이 짧고 굵어 비조화성 증가
    k_max = int(min(48, 0.45 * sr / f0))
    ks = np.arange(1, k_max + 1)
    freqs = ks * f0 * np.sqrt(1 + big_b * ks ** 2)
    tilt = 1.9 - 0.9 * vel
    amps = (1.0 / ks ** tilt) * (0.35 + 0.65 * np.abs(np.sin(np.pi * ks * 0.118)))  # 해머 위치(약 1/8.5)
    rates = (1 + 0.45 * (ks - 1) ** 1.15) / tau
    rng = np.random.default_rng(midi * 131 + int(vel * 100))
    ph, ph2 = rng.uniform(0, 2 * np.pi, k_max), rng.uniform(0, 2 * np.pi, k_max)
    t_all = np.arange(n) / sr
    out = np.zeros(n)
    for k in range(k_max):
        if freqs[k] >= sr * 0.45:
            break
        # 이 배음이 -100dB 아래로 내려가는 데까지만 계산 (높은 배음은 금방 사라짐)
        m = min(n, int(np.log(max(amps[k], 1e-9) / 1e-5) / (rates[k] * 0.22) * sr) + 1)
        if m <= 0:
            continue
        t = t_all[:m]
        env = 0.72 * np.exp(-rates[k] * t) + 0.28 * np.exp(-rates[k] * 0.22 * t)  # 두 단계 감쇠
        beat = 1 - 0.16 * (1 - np.cos(2 * np.pi * freqs[k] * 0.0006 * t + ph2[k]))  # 세 줄 맥놀이
        out[:m] += amps[k] * np.sin(2 * np.pi * freqs[k] * t + ph[k]) * env * beat
    h = min(n, int(0.03 * sr))
    hammer = rng.normal(size=h) * np.exp(-t_all[:h] * (450 - 150 * vel))
    hammer = sosfilt(butter(2, 1200 + 4000 * vel, fs=sr, output="sos"), hammer)
    out[:h] += hammer * (0.04 + 0.08 * vel) * (np.abs(out[:h]).max() or 1.0)
    out *= np.clip(t_all / 0.0015, 0, 1)
    return out / (np.abs(out).max() or 1.0)


def _noise_band(n: int, sr: int, lo: float | None, hi: float | None, seed: int) -> np.ndarray:
    x = np.random.default_rng(seed).normal(size=n)
    if lo and hi:
        return sosfilt(butter(2, [lo, hi], btype="band", fs=sr, output="sos"), x)
    if hi:
        return sosfilt(butter(2, hi, btype="low", fs=sr, output="sos"), x)
    return sosfilt(butter(2, lo, btype="high", fs=sr, output="sos"), x)


def _drum(kind: str, midi: int, sr: int) -> np.ndarray:
    length = {"kick": 0.45, "brush": 0.35, "ride": 1.6, "hat": 0.12, "timpani": 2.5,
              "bb_kick": 0.3, "bb_snare": 0.22, "bb_hat": 0.09}[kind]
    n = int(length * sr)
    t = np.arange(n) / sr
    if kind == "kick":
        f = 48 + 70 * np.exp(-t * 28)
        return np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 7) + \
            _noise_band(n, sr, None, 3000, 1) * np.exp(-t * 300) * 0.3
    if kind == "brush":  # 브러시로 스네어를 쓸어내리는 소리
        return _noise_band(n, sr, 1500, 7500, 2) * np.clip(t / 0.03, 0, 1) * np.exp(-t * 9) * 0.6
    if kind == "ride":  # 높은 대역의 비조화 배음 여러 개 -> 특정 음으로 들리지 않는 금속성 울림
        rng = np.random.default_rng(4)
        partials = np.sort(rng.uniform(2800, 9500, 14))
        ring = _decaying_partials(partials, rng.uniform(0.3, 1.0, 14), rng.uniform(2.0, 4.5, 14), n, sr, 4)
        return 0.12 * ring + _noise_band(n, sr, 5000, None, 3) * np.exp(-t * 5) * 0.45
    if kind == "hat":
        return _noise_band(n, sr, 7000, None, 5) * np.exp(-t * 60)
    if kind == "timpani":
        f0 = librosa.midi_to_hz(midi)
        body = _decaying_partials([f0, 1.5 * f0, 1.99 * f0, 2.44 * f0], [1, 0.5, 0.35, 0.2],
                                  [2.2, 3, 3.5, 4.5], n, sr, 6)
        return body + _noise_band(n, sr, None, 600, 6) * np.exp(-t * 40) * 0.4
    # 비트박스 — 입으로 내는 소리처럼 거칠고 짧게
    if kind == "bb_kick":  # '붐'
        f = 55 + 45 * np.exp(-t * 20)
        return np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 12) + \
            _noise_band(n, sr, 80, 600, 7) * np.exp(-t * 60) * 0.5
    if kind == "bb_snare":  # '프크'
        return _noise_band(n, sr, 900, 5000, 8) * np.exp(-t * 22) * 0.8 + \
            _noise_band(n, sr, 2000, 4000, 9) * np.exp(-t * 300) * 0.6
    return _noise_band(n, sr, 5000, 11000, 10) * np.clip(t / 0.004, 0, 1) * np.exp(-t * 45)  # '츠'


def _vox(midi: int, n: int, sr: int) -> np.ndarray:
    """베이스 보컬 '둠': 성대 펄스(톱니, 미세한 떨림) + 숨소리 + '우' 모음 포먼트."""
    src = _osc("saw", midi, n, sr, 0.0, 8.0, seed=midi, drift_cents=4.0)
    src = src + 0.05 * np.random.default_rng(midi).normal(size=n)  # 숨소리도 같은 포먼트를 지남
    for fc, bw in ((320, 90), (800, 110), (2300, 160)):
        r = np.exp(-np.pi * bw / sr)
        th = 2 * np.pi * fc / sr
        src = lfilter([1 - r], [1, -2 * r * np.cos(th), r * r], src)
    t = np.arange(n) / sr
    env = np.clip(t / 0.025, 0, 1) * (0.55 + 0.45 * np.exp(-t * 8)) * np.clip((n / sr - t) / 0.06, 0, 1)
    return src / (np.abs(src).max() or 1.0) * env


def _vel_bin(velocity: int) -> float:
    """세기를 몇 단계로 묶어 같은 음은 한 번만 합성 (0~1)."""
    return round(float(np.clip(velocity, 1, 127)) / 127 * 6) / 6


def _sustain_raw(name: str, part: Part, pitch: int, n: int, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """지속음의 밝은 소리와 어두운 소리 (음 길이와 무관 -> 음높이마다 한 번)."""
    wave, voices, det, vib, _, _ = part.p
    sig = sum(_osc(wave, pitch, n, sr, det * (v - (voices - 1) / 2), vib, seed=pitch * 17 + v,
                   drift_cents=3.0 + det * 0.25)
              for v in range(voices)) / np.sqrt(voices)  # 겹친 소리는 서로 무관해 √N 으로 나눠야 크기가 같다
    dark = sosfilt(butter(1, min(sr * 0.45, 2.2 * librosa.midi_to_hz(pitch) + 300), fs=sr, output="sos"), sig)
    return sig, dark


def _sustain_note(name: str, part: Part, raw: tuple[np.ndarray, np.ndarray], n: int, sr: int,
                  noise: np.ndarray | None, seed: int) -> np.ndarray:
    bright_sig, dark = raw[0][:n], raw[1][:n]
    *_, att, rel = part.p
    base, mode, tau, nz = OSC_COLOR.get(name, (1.0, "bite", 0.2, 0.0))
    t = np.arange(n) / sr
    env = _env(n, sr, att, rel)
    if mode == "bite":  # 활이 닿는 순간 밝았다가 차분해짐
        b = base + (1 - base) * np.exp(-t / tau)
    else:  # 소리가 커지며 밝아짐 (호른·패드)
        b = base + (1 - base) * 0.8 * np.clip(t / tau, 0, 1)
    sig = dark + (bright_sig - dark) * b
    if nz and noise is not None:  # 활·숨 잡음: 시작에 조금 더
        off = (seed * 7919) % max(1, len(noise) - n)
        sig = sig + noise[off:off + n] * nz * (1 + 2.5 * np.exp(-t / 0.08))
    return sig * env


def _ring(part: Part, name: str, pitch: int, n: int, sr: int, vel: float) -> np.ndarray:
    """울리고 사라지는 소리 (피아노·뜯는 현) — 음 길이와 무관하게 끝까지."""
    if part.kind == "piano":
        return _piano(pitch, n, sr, vel)
    decay, bright, pick = PLUCK.get(name, (1.5, 0.6, 0.15))
    decay *= float(np.clip(1.5 - (pitch - 40) / 60, 0.5, 1.6))  # 낮은 줄이 더 오래 울림
    return pluck(pitch, n, sr, decay=decay, bright=bright * (0.7 + 0.5 * vel), pick=pick,
                 velocity=vel, seed=pitch)


def _render_note(name: str, part: Part, pitch: int, dur: float, sr: int, seed: int,
                 velocity: int = 80) -> np.ndarray:
    """음 하나 (테스트·외부용). synthesize 는 같은 음을 묶어 더 빠르게 만든다."""
    n = max(1, int(dur * sr))
    if part.kind == "osc":
        return _sustain_note(name, part, _sustain_raw(name, part, pitch, n, sr), n, sr, None, seed)
    if part.kind == "drum":
        return _drum(part.p[0], pitch, sr)
    if part.kind == "vox":
        return _vox(pitch, n, sr)
    damp = 0.12
    m = max(1, int((dur + damp) * sr))
    sig = _ring(part, name, pitch, m, sr, _vel_bin(velocity)).copy()
    fade = min(m, int(damp * sr))
    sig[-fade:] *= np.linspace(1, 0, fade) ** 2
    return sig


def _humanize(i: int, part: Part) -> float:
    """음마다 정해진(재현 가능한) 몇 ms 의 어긋남."""
    r = np.random.default_rng(1_000_003 * (i + 1)).uniform(-1, 1)
    return r * (0.0025 if part.drum or part.kind == "drum" else 0.006)


def synthesize(notes: list[ONote], duration: float, sr: int = 44100, reverb: float = 0.3,
               reverb_seconds: float = 2.4) -> np.ndarray:
    """편곡을 스테레오 음원으로 (내장 합성기). 파트별로 처리해 긴 곡도 메모리를 적게 쓴다."""
    total = int(duration * sr) + 1
    out = np.zeros((total, 2), dtype=np.float32)
    by_part: dict[str, list[ONote]] = {}
    for nt in notes:
        by_part.setdefault(nt.part, []).append(nt)
    for name, pnotes in by_part.items():
        part = PARTS[name]
        stereo = part.pan == "spread"
        bus = np.zeros((total, 2) if stereo else total, dtype=np.float32)
        damp = 0.12 if part.kind in ("piano", "pluck") else 0.0
        # 같은 음(울리는 악기는 같은 세기까지)은 가장 긴 길이로 한 번만 합성해 잘라 쓴다
        longest: dict[tuple, int] = {}
        for nt in pnotes:
            k = (nt.pitch, _vel_bin(nt.velocity) if part.kind in ("piano", "pluck") else 0)
            longest[k] = max(longest.get(k, 0), int((max(nt.end - nt.start, 0.02) + damp) * sr) + 1)
        noise = None
        if part.kind == "osc" and OSC_COLOR.get(name, (0, 0, 0, 0))[3]:
            noise = _noise_band(min(total, int(12 * sr)) + max(longest.values()), sr, 1200, 6500, 11)
            noise = (noise / (np.std(noise) or 1.0)).astype(np.float32)
        cache: dict[tuple, object] = {}
        for i, nt in enumerate(pnotes):
            start = nt.start + _humanize(i, part)
            s0 = int(round(start * sr))
            if s0 >= total:
                continue
            dur = max(nt.end - nt.start, 0.02)
            n = max(1, int(dur * sr))
            if part.kind == "osc":
                k = (nt.pitch, 0)
                if k not in cache:
                    cache[k] = _sustain_raw(name, part, nt.pitch, longest[k], sr)
                sig = _sustain_note(name, part, cache[k], n, sr, noise, i)
            elif part.kind in ("piano", "pluck"):
                k = (nt.pitch, _vel_bin(nt.velocity))
                if k not in cache:
                    cache[k] = _ring(part, name, nt.pitch, longest[k], sr, k[1]).astype(np.float32)
                m = min(len(cache[k]), int((dur + damp) * sr))
                sig = cache[k][:m].copy()
                fade = min(m, int(damp * sr))
                sig[m - fade:] *= np.linspace(1, 0, fade) ** 2  # 손을 떼면 짧게 잦아듦 (댐퍼)
            elif part.kind == "drum":
                k = ("d", nt.pitch)
                if k not in cache:
                    cache[k] = _drum(part.p[0], nt.pitch, sr).astype(np.float32)
                sig = cache[k]
            else:
                k = (nt.pitch, round(dur * 20))
                if k not in cache:
                    cache[k] = _vox(nt.pitch, n, sr).astype(np.float32)
                sig = cache[k]
            if s0 < 0:  # 곡 시작 전에 시작한 음은 앞부분을 잘라 냄
                sig, s0 = sig[-s0:], 0
            sig = sig[:total - s0] * (nt.velocity / 127.0) ** 1.6
            if stereo:
                a = (float(np.clip((nt.pitch - 62) / 30, -0.6, 0.6)) + 1) * np.pi / 4
                bus[s0:s0 + len(sig), 0] += sig * np.cos(a)
                bus[s0:s0 + len(sig), 1] += sig * np.sin(a)
            else:
                bus[s0:s0 + len(sig)] += sig
        if part.lowpass:
            bus = sosfilt(butter(2, part.lowpass, btype="low", fs=sr, output="sos"), bus, axis=0)
        if name in PART_EQ:
            bus = eq(bus, sr, PART_EQ[name])
        bus = bus * part.gain
        if stereo:
            out += bus.astype(np.float32)
        elif part.pan == "wide":  # 저역은 오른쪽, 고역은 왼쪽으로 넓게
            hp = sosfilt(butter(2, 900, btype="high", fs=sr, output="sos"), bus)
            out += (pan(bus - hp, 0.4) + pan(hp, -0.4)).astype(np.float32)
        else:
            out += pan(bus, float(part.pan)).astype(np.float32)
        del bus
    out = out.astype(float)
    if reverb > 0:
        out = add_reverb(out, sr, wet=reverb, seconds=reverb_seconds)
    return out


def render_soundfont(midi_path: Path, wav_path: Path, soundfont: str | None, sr: int = 44100) -> Path | None:
    """fluidsynth + 사운드폰트로 MIDI 를 음원으로. 둘 중 하나라도 없으면 None."""
    sf2 = soundfont or os.environ.get("BAND2SHEET_SOUNDFONT")
    exe = shutil.which("fluidsynth")
    if not sf2 or not exe or not Path(sf2).expanduser().exists():
        return None
    cmd = [exe, "-ni", "-g", "0.8", "-r", str(sr), "-F", str(wav_path), str(Path(sf2).expanduser()),
           str(midi_path)]
    if subprocess.run(cmd, capture_output=True).returncode != 0 or not wav_path.exists():
        return None
    return wav_path
