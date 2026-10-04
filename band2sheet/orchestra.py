"""오케스트라 반주: 코드 진행 -> 편곡(현악·첼로/콘트라베이스·호른·하프·팀파니) -> 소리 합성.

편곡 결과는 MIDI 로도 저장하므로 DAW 에서 원하는 음색으로 바꿀 수 있다.
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
from scipy.signal import butter, sosfilt

from .vocalfx import add_reverb, chord_tones, pan

PROGRAMS = {"strings": 48, "cello": 42, "contrabass": 43, "horn": 60, "harp": 46, "timpani": 47}
LABELS = {"strings": "Strings", "cello": "Cello", "contrabass": "Contrabass", "horn": "French Horn",
          "harp": "Harp", "timpani": "Timpani"}


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
    pitch: int
    velocity: int


# ---------------------------------------------------------------------------
# 편곡
# ---------------------------------------------------------------------------

def _voicing(tones: list[int], prev: list[int] | None, low: int = 55, high: int = 76) -> list[int]:
    """코드 구성음을 low~high 안에 4성부로 쌓되, 앞 화음에서 가장 적게 움직이는 자리바꿈을 고른다."""
    cands = []
    for base in range(low, low + 12):
        v, p = [], base
        order = sorted(tones, key=lambda pc: (pc - base) % 12)
        for pc in order:
            while p % 12 != pc:
                p += 1
            v.append(p)
        if len(v) == 3:  # 근음을 한 옥타브 위에 겹쳐 4성부
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


def arrange(chords: list[ChordSpan], beats: list[float], beats_per_bar: int = 4,
            downbeat: int = 0, end_time: float | None = None) -> list[ONote]:
    """코드 진행으로 오케스트라 편곡. 곡이 진행될수록 조금씩 커지는 셈여림(빌드업)을 넣는다."""
    spans = [c for c in chords if c.root is not None and c.end - c.start > 0.15]
    if not spans:
        return []
    end_time = end_time or spans[-1].end
    beats = sorted(beats)
    period = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.5
    bar_starts = [b for i, b in enumerate(beats) if (i - downbeat) % beats_per_bar == 0]
    total = max(end_time - spans[0].start, 1e-3)

    def dyn(t: float) -> float:  # 0.55 -> 1.0 (곡 60% 지점까지 점점 크게)
        return 0.55 + 0.45 * min(1.0, max(0.0, (t - spans[0].start) / (0.6 * total)))

    notes: list[ONote] = []
    prev = None
    for c in spans:
        tones = sorted(chord_tones(c.root, c.quality) or [])
        v = _voicing(tones, prev)
        prev = v
        d = dyn(c.start)
        rel = min(0.35, 0.5 * (c.end - c.start))
        for p in v:  # 현악 (지속음)
            notes.append(ONote("strings", c.start, c.end + rel, p, int(70 * d + 20)))
        # 저음: 마디 첫 박마다 다시 그음 (긴 코드에서도 리듬이 살게)
        cuts = [c.start] + [b for b in bar_starts if c.start + 0.2 < b < c.end - 0.2] + [c.end]
        for a, b in zip(cuts[:-1], cuts[1:]):
            notes.append(ONote("cello", a, b + 0.1, _in_range(c.root, 48, 59), int(72 * d + 18)))
            notes.append(ONote("contrabass", a, b + 0.1, _in_range(c.root, 36, 47), int(70 * d + 15)))
        # 호른: 2박 이상 이어지는 코드에 근음+5도, 곡 중반부터
        if c.end - c.start >= 1.8 * period and d > 0.7:
            for iv in (0, 7):
                notes.append(ONote("horn", c.start, c.end + rel, _in_range(c.root + iv, 53, 67),
                                   int(60 * d)))
        # 하프: 8분음표 분산화음 (올라갔다 내려옴)
        arp = sorted({_in_range(pc, 48, 59) for pc in tones} | {_in_range(pc, 60, 71) for pc in tones})
        arp = arp + arp[-2:0:-1]
        step = period / 2
        t, i = c.start, 0
        while t < c.end - 0.05:
            notes.append(ONote("harp", t, t + 1.2, arp[i % len(arp)], int(50 + 25 * d)))
            t += step
            i += 1
    # 팀파니: 4마디마다 첫 박 + 마지막 화음
    for k, b in enumerate(bar_starts):
        if k % 4 == 0 and spans[0].start <= b < end_time:
            c = next((s for s in spans if s.start <= b < s.end), None)
            if c:
                notes.append(ONote("timpani", b, b + 1.5, _in_range(c.root, 41, 52), int(55 + 40 * dyn(b))))
    last = spans[-1]
    notes.append(ONote("timpani", last.start, last.start + 2.0, _in_range(last.root, 41, 52), 100))
    return notes


def write_arrangement_midi(notes: list[ONote], path: Path, tempo: float = 120.0) -> Path:
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    for part, prog in PROGRAMS.items():
        inst = pretty_midi.Instrument(program=prog, name=LABELS[part])
        for n in notes:
            if n.part == part:
                inst.notes.append(pretty_midi.Note(int(np.clip(n.velocity, 1, 127)), int(n.pitch),
                                                   float(n.start), float(n.end)))
        if inst.notes:
            pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))
    return path


# ---------------------------------------------------------------------------
# 내장 합성기
# ---------------------------------------------------------------------------

_TABLES: dict[tuple[str, int], np.ndarray] = {}
TABLE = 4096


def _table(kind: str, midi: int, sr: int) -> np.ndarray:
    """대역 제한 파형 한 주기 (나이퀴스트를 넘는 배음은 뺌)."""
    key = (kind, midi)
    if key not in _TABLES:
        f0 = librosa.midi_to_hz(midi)
        n_h = int(min(48, (sr / 2) / f0 * 0.9))
        ph = np.arange(TABLE) / TABLE * 2 * np.pi
        slope = {"saw": 1.0, "warm": 1.25, "horn": 1.7}[kind]
        w = sum(np.sin(k * ph) / k ** slope for k in range(1, max(n_h, 1) + 1))
        _TABLES[key] = w / np.abs(w).max()
    return _TABLES[key]


def _osc(kind: str, midi: int, n: int, sr: int, detune_cents: float = 0.0, vib_cents: float = 0.0,
         seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = np.arange(n) / sr
    f = librosa.midi_to_hz(midi) * 2 ** (detune_cents / 1200)
    if vib_cents:
        onset = np.clip(t / 0.4, 0, 1)  # 비브라토는 음이 시작되고 조금 뒤부터
        f = f * 2 ** (vib_cents / 1200 * onset * np.sin(2 * np.pi * rng.uniform(4.8, 5.8) * t))
    phase = (rng.uniform() + np.cumsum(np.broadcast_to(f, t.shape)) / sr) % 1.0
    tab = _table(kind, midi, sr)
    return tab[(phase * TABLE).astype(int) % TABLE]


def _env(n: int, sr: int, attack: float, release: float, sustain_len: int) -> np.ndarray:
    t = np.arange(n) / sr
    a = np.clip(t / max(attack, 1e-3), 0, 1)
    r = np.clip((n / sr - t) / max(release, 1e-3), 0, 1) if n > sustain_len else 1.0
    return a * r


PART_SYNTH = {
    # 파형, 겹칠 소리 수(앙상블), 디튠(센트), 비브라토(센트), 어택, 릴리즈, 음량, 팬, 저역통과(Hz)
    "strings": ("saw", 3, 9.0, 12.0, 0.35, 0.45, 0.16, 0.0, 4500),
    "cello": ("warm", 2, 6.0, 10.0, 0.12, 0.3, 0.28, 0.35, 2200),
    "contrabass": ("warm", 2, 5.0, 6.0, 0.1, 0.3, 0.30, 0.0, 900),
    "horn": ("horn", 2, 5.0, 4.0, 0.25, 0.4, 0.18, -0.35, 1800),
}


def _pluck(midi: int, n: int, sr: int) -> np.ndarray:
    t = np.arange(n) / sr
    f0 = librosa.midi_to_hz(midi)
    out = np.zeros(n)
    for k in range(1, 7):
        if k * f0 < sr / 2:
            out += np.sin(2 * np.pi * k * f0 * t) * np.exp(-t * (1.8 + 1.1 * k)) / k ** 1.3
    return out * np.clip(t / 0.003, 0, 1)


def _timpani(midi: int, n: int, sr: int, seed: int = 0) -> np.ndarray:
    t = np.arange(n) / sr
    f0 = librosa.midi_to_hz(midi)
    out = sum(a * np.sin(2 * np.pi * f0 * r * t) * np.exp(-t * d)
              for r, a, d in ((1.0, 1.0, 2.2), (1.5, 0.5, 3.0), (1.99, 0.35, 3.5), (2.44, 0.2, 4.5)))
    noise = np.random.default_rng(seed).normal(size=n) * np.exp(-t * 40) * 0.4
    sos = butter(2, 600, btype="low", fs=sr, output="sos")
    return out + sosfilt(sos, noise)


def synthesize(notes: list[ONote], duration: float, sr: int = 44100, reverb: float = 0.3) -> np.ndarray:
    """편곡을 스테레오 음원으로 (내장 합성기)."""
    total = int(duration * sr) + 1
    buses = {p: np.zeros(total) for p in PROGRAMS}
    for i, nt in enumerate(notes):
        s0 = int(nt.start * sr)
        if s0 >= total:
            continue
        vel = (nt.velocity / 127.0) ** 1.6
        if nt.part in PART_SYNTH:
            kind, voices, det, vib, att, rel, _, _, _ = PART_SYNTH[nt.part]
            n = min(int((nt.end - nt.start) * sr), total - s0)
            if n <= 0:
                continue
            sig = sum(_osc(kind, nt.pitch, n, sr, det * (v - (voices - 1) / 2), vib, seed=i * 7 + v)
                      for v in range(voices)) / voices
            sig = sig * _env(n, sr, att, rel, 0)
        elif nt.part == "harp":
            n = min(int(1.6 * sr), total - s0)
            sig = _pluck(nt.pitch, n, sr)
        else:  # timpani
            n = min(int(2.5 * sr), total - s0)
            sig = _timpani(nt.pitch, n, sr, seed=i)
        buses[nt.part][s0:s0 + n] += sig * vel

    out = np.zeros((total, 2))
    for part, sig in buses.items():
        if not np.any(sig):
            continue
        if part in PART_SYNTH:
            *_, gain, position, lp = PART_SYNTH[part]
            sig = sosfilt(butter(2, lp, btype="low", fs=sr, output="sos"), sig) * gain
        else:
            gain, position = (0.22, -0.45) if part == "harp" else (0.35, 0.0)
            sig = sig * gain
        if part == "strings":  # 현악은 좌우로 넓게 (왼쪽=바이올린, 오른쪽=비올라 느낌)
            hp = sosfilt(butter(2, 900, btype="high", fs=sr, output="sos"), sig)
            out += pan(sig - hp, 0.4) + pan(hp, -0.4)
        else:
            out += pan(sig, position)
    if reverb > 0:
        out = add_reverb(out, sr, wet=reverb, seconds=2.6)
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
