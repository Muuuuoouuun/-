"""보컬 후보정 DSP: 음높이 추적, PSOLA 피치 변환, 오토튠, 자동 화음, 리버브.

PSOLA(Pitch-Synchronous Overlap-Add)는 목소리의 주기마다 잘라 붙이는 방식이라
포먼트(음색)를 지키면서 음높이만 바꾼다. 그래서 3도 위/아래 화음도 '같은 사람이 부른 것처럼'
들리고, 위상 보코더처럼 목소리가 뭉개지거나 다람쥐 소리가 되지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.signal import butter, oaconvolve, sosfiltfilt

from .chords import MAJOR_SCALE, MINOR_SCALE, QUALITIES
from .instruments import INSTRUMENTS
from .theory import Key

ANALYSIS_SR = 22050
HOP = 256  # 약 11.6 ms


@dataclass
class PitchTrack:
    times: np.ndarray  # 프레임 시각 (초)
    midi: np.ndarray  # 프레임별 MIDI 음높이 (무성 = nan)

    @property
    def frame_t(self) -> float:
        return HOP / ANALYSIS_SR

    def voiced(self) -> np.ndarray:
        return ~np.isnan(self.midi)


def track_pitch(y: np.ndarray, sr: int, engine: str = "auto") -> PitchTrack:
    """보컬 음높이 곡선. CREPE 가 있으면 CREPE, 없으면 pYIN."""
    from .engines import available
    from .transcribe import crepe_f0, pyin_f0

    spec = INSTRUMENTS["vocals"]
    ya = librosa.resample(y, orig_sr=sr, target_sr=ANALYSIS_SR) if sr != ANALYSIS_SR else y
    if engine == "auto":
        engine = "crepe" if available("crepe") else "pyin"
    if engine == "crepe":
        y16 = librosa.resample(ya, orig_sr=ANALYSIS_SR, target_sr=16000)
        m16 = crepe_f0(y16, 16000, 160, spec)  # 10 ms 간격 -> 분석 간격으로 다시 샘플링
        times = np.arange(1 + len(ya) // HOP) * HOP / ANALYSIS_SR
        midi = m16[np.clip(np.round(times / 0.01).astype(int), 0, len(m16) - 1)]
    else:
        midi = pyin_f0(ya, ANALYSIS_SR, HOP, spec)
        times = np.arange(len(midi)) * HOP / ANALYSIS_SR
    # 아주 작은 소리(숨소리, 잔향)는 무성으로
    rms = librosa.feature.rms(y=ya, frame_length=2048, hop_length=HOP)[0]
    n = min(len(midi), len(rms))
    midi, times, rms = midi[:n].copy(), times[:n], rms[:n]
    if np.any(rms > 0):
        midi[rms < np.percentile(rms[rms > 0], 95) * 0.05] = np.nan
    return PitchTrack(times, midi)


# ---------------------------------------------------------------------------
# 음계 / 코드
# ---------------------------------------------------------------------------

def scale_pcs(key: Key) -> list[int]:
    steps = MAJOR_SCALE if key.mode == "major" else MINOR_SCALE[:7]  # 화음 계산은 자연단음계 7음
    return sorted((key.tonic + s) % 12 for s in steps)


def nearest_in_scale(pitch: np.ndarray, pcs: list[int]) -> np.ndarray:
    """각 음높이(실수 MIDI)에서 가장 가까운 음계음 (정수 MIDI)."""
    pitch = np.asarray(pitch, dtype=float)
    out = np.full(pitch.shape, np.nan)
    ok = ~np.isnan(pitch)
    base = np.floor(pitch[ok] / 12.0) * 12
    cands = np.concatenate([base[:, None] + np.array(pcs)[None, :] + o for o in (-12, 0, 12)], axis=1)
    best = np.argmin(np.abs(cands - pitch[ok][:, None]), axis=1)
    out[ok] = cands[np.arange(len(best)), best]
    return out


def scale_step(note: int, steps: int, pcs: list[int]) -> int:
    """음계 위에서 steps 칸 이동 (음계 밖 음이면 가장 가까운 음계음 기준). 예: +2 = 3도 위."""
    ladder = [o * 12 + pc for o in range(-1, 11) for pc in pcs]
    i = int(np.argmin([abs(x - note) for x in ladder]))
    return ladder[int(np.clip(i + steps, 0, len(ladder) - 1))]


def chord_tones(root: int | None, quality: str) -> set[int] | None:
    if root is None:
        return None
    ivs = QUALITIES.get(quality, ((0, 4, 7), 0))[0]
    return {(root + i) % 12 for i in ivs}


# ---------------------------------------------------------------------------
# 오토튠 / 화음 곡선 (프레임별 반음 이동량)
# ---------------------------------------------------------------------------

def _reference(track: PitchTrack, window: float = 0.09) -> np.ndarray:
    """비브라토를 걸러낸 '부르려던 음' 곡선 (무성 구간 제외 중앙값 필터)."""
    midi = track.midi
    voiced = ~np.isnan(midi)
    size = max(3, int(round(window / track.frame_t)) | 1)
    filled = np.where(voiced, midi, np.interp(np.arange(len(midi)), np.flatnonzero(voiced),
                                               midi[voiced]) if voiced.any() else 0.0)
    ref = median_filter(filled, size=size, mode="nearest")
    ref[~voiced] = np.nan
    return ref


def autotune_shift(track: PitchTrack, key: Key, strength: float = 0.7, hard: bool = False,
                   speed: float = 0.04) -> np.ndarray:
    """오토튠 이동량(반음, 프레임별).

    strength: 0(그대로)~1(음계음에 정확히). hard=True 면 비브라토까지 펴서 '로봇 보이스' 느낌.
    speed: 교정이 따라붙는 시간(초) — 짧을수록 딱딱하게 붙는다.
    """
    pcs = scale_pcs(key)
    ref = _reference(track)
    target = nearest_in_scale(ref, pcs)
    base = track.midi if hard else ref
    shift = strength * (target - base)
    shift = np.where(np.isnan(shift), 0.0, shift)
    if speed > 0 and not hard:
        shift = uniform_filter1d(shift, max(1, int(round(speed / track.frame_t))), mode="nearest")
    return shift


def harmony_shift(track: PitchTrack, key: Key, direction: int, chord_at=None,
                  lead_shift: np.ndarray | None = None) -> np.ndarray:
    """화음 성부의 이동량(반음, 프레임별). direction=+1 위, -1 아래.

    가능하면 그 시각 코드의 구성음 중 3~9 반음 떨어진 가장 가까운 음을 고르고,
    코드를 모르면 음계 위 3도(위/아래)를 쓴다. 화음 성부는 항상 음계음에 맞춘다(오토튠 여부와 무관).
    """
    pcs = scale_pcs(key)
    ref = _reference(track)
    melody = nearest_in_scale(ref + (lead_shift if lead_shift is not None else 0.0), pcs)
    out = np.zeros(len(ref))
    cache: dict[tuple, int] = {}
    for i in np.flatnonzero(~np.isnan(melody)):
        q = int(melody[i])
        tones = chord_at(track.times[i]) if chord_at else None
        k = (q, tuple(sorted(tones)) if tones else None)
        if k not in cache:
            h = None
            if tones:
                rng = range(q + 3, q + 10) if direction > 0 else range(q - 3, q - 10, -1)
                h = next((p for p in rng if p % 12 in tones), None)
            if h is None:
                h = scale_step(q, 2 * direction, pcs)
            cache[k] = h
        # 실제 부른 음(비브라토 포함) -> 화음 음 + 같은 비브라토
        out[i] = cache[k] - ref[i]
    return out


# ---------------------------------------------------------------------------
# PSOLA
# ---------------------------------------------------------------------------

def _regions(mask: np.ndarray, min_len: int = 3) -> list[tuple[int, int]]:
    out, start = [], None
    for i, v in enumerate(np.append(mask, False)):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= min_len:
                out.append((start, i))
            start = None
    return out


def psola_shift(x: np.ndarray, sr: int, track: PitchTrack, shift: np.ndarray,
                voiced_only: bool = False, jitter_cents: float = 0.0, seed: int = 0) -> np.ndarray:
    """프레임별 이동량(반음)만큼 음높이를 바꾼 신호 (길이·포먼트 유지).

    voiced_only=True 면 유성음만 출력(화음 성부용, 자음·숨소리는 겹치지 않게),
    아니면 무성 구간은 원본을 그대로 이어 붙인다(오토튠용).
    """
    x = np.asarray(x, dtype=float)
    n = len(x)
    hz = librosa.midi_to_hz(track.midi)
    voiced = ~np.isnan(hz)
    ft = track.times
    out = np.zeros(n)
    rng = np.random.default_rng(seed)
    drift = None
    if jitter_cents:  # 사람마다 다른 미세한 음높이 흔들림 (천천히 변하는 잡음)
        knots = rng.normal(0, jitter_cents / 100.0, size=int(len(ft) * track.frame_t / 0.35) + 2)
        drift = np.interp(ft, np.linspace(ft[0], ft[-1] if len(ft) > 1 else 1, len(knots)), knots)

    # 마크 위치 정렬용으로 저역만 남긴 신호 (기본음 근처의 봉우리)
    sos = butter(2, 1000, btype="low", fs=sr, output="sos")
    xl = sosfiltfilt(sos, x)

    mask = np.zeros(n)
    for f0, f1 in _regions(voiced):
        s0, s1 = int(ft[f0] * sr), min(n, int((ft[f1 - 1] + track.frame_t) * sr))
        if s1 - s0 < sr // 50:
            continue
        seg_t = ft[f0:f1]
        seg_hz = np.interp(seg_t, seg_t[~np.isnan(hz[f0:f1])], hz[f0:f1][~np.isnan(hz[f0:f1])])
        seg_shift = shift[f0:f1] + (drift[f0:f1] if drift is not None else 0.0)

        def period(t: float) -> int:
            return max(16, int(round(sr / np.interp(t, seg_t, seg_hz))))

        # 1) 분석 마크: 한 주기 간격, 저역 신호의 봉우리에 맞춤
        marks = []
        t = s0 + int(np.argmax(xl[s0:s0 + period(s0 / sr)]))
        while t < s1:
            marks.append(t)
            p = period(t / sr)
            lo, hi = t + int(0.8 * p), min(s1, t + int(1.2 * p) + 1)
            if lo >= hi:
                break
            t = lo + int(np.argmax(xl[lo:hi]))
        if len(marks) < 2:
            continue
        marks = np.array(marks)

        # 2) 합성: 새 주기 간격으로 가장 가까운 분석 마크의 조각을 겹쳐 더한다
        ts = float(marks[0])
        while ts < s1:
            k = int(np.argmin(np.abs(marks - ts)))
            ma = int(marks[k])
            p = period(ma / sr)
            ratio = 2.0 ** (np.interp(ts / sr, seg_t, seg_shift) / 12.0)
            a0, a1 = ma - p, ma + p
            if a0 >= 0 and a1 <= n:
                win = np.hanning(2 * p)
                grain = x[a0:a1] * win / max(ratio, 1e-3)  # 겹침 정도(≈ratio)만큼 나눠 크기 유지
                o0 = int(round(ts)) - p
                lo, hi = max(0, o0), min(n, o0 + 2 * p)
                if lo < hi:
                    out[lo:hi] += grain[lo - o0:hi - o0]
            ts += p / ratio
        # 유성 구간 가중치 (경계는 10 ms 페이드)
        fade = min(int(0.01 * sr), (s1 - s0) // 4)
        mask[s0:s1] = 1.0
        if fade > 0:
            mask[s0:s0 + fade] = np.linspace(0, 1, fade)
            mask[s1 - fade:s1] = np.linspace(1, 0, fade)
    if voiced_only:
        return out * mask
    return out * mask + x * (1.0 - mask)


# ---------------------------------------------------------------------------
# 공간감
# ---------------------------------------------------------------------------

def reverb_ir(sr: int, seconds: float = 2.2, predelay: float = 0.02, seed: int = 7) -> np.ndarray:
    """홀 잔향 임펄스 응답 (스테레오, 지수 감쇠 잡음 + 고역 감쇠)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    t = np.arange(n) / sr
    env = np.exp(-6.9 * t / seconds)  # RT60
    ir = rng.normal(size=(n, 2)) * env[:, None]
    # 뒤로 갈수록 어둡게: 두 대역을 시간에 따라 섞음
    sos = butter(2, 3500, btype="low", fs=sr, output="sos")
    dark = sosfiltfilt(sos, ir, axis=0)
    mix = np.clip(t / (seconds * 0.4), 0, 1)[:, None]
    ir = ir * (1 - mix) + dark * mix
    ir = np.concatenate([np.zeros((int(predelay * sr), 2)), ir])
    return ir / np.sqrt(np.sum(ir ** 2) / 2)


def add_reverb(stereo: np.ndarray, sr: int, wet: float = 0.25, seconds: float = 2.2) -> np.ndarray:
    ir = reverb_ir(sr, seconds)
    # 구간별(overlap-add) 컨볼루션: 긴 곡에서도 메모리를 적게 쓰고 빠름
    w = np.stack([oaconvolve(stereo[:, c], ir[:, c])[:len(stereo)] for c in range(2)], axis=1)
    return stereo * (1 - wet) + w * wet


def pan(mono: np.ndarray, position: float) -> np.ndarray:
    """-1(왼쪽) ~ +1(오른쪽), 일정 파워 팬."""
    a = (position + 1) * np.pi / 4
    return np.stack([mono * np.cos(a), mono * np.sin(a)], axis=1)


def delay(x: np.ndarray, sr: int, seconds: float) -> np.ndarray:
    d = int(seconds * sr)
    return np.concatenate([np.zeros(d), x[:len(x) - d]]) if d > 0 else x
