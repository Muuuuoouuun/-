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
    """정석 3도 화음 성부의 이동량(반음, 프레임별). direction=+1 위, -1 아래.

    가능하면 그 시각 코드의 구성음 중 3~9 반음 떨어진 가장 가까운 음을 고르고,
    코드를 모르면 음계 위 3도(위/아래)를 쓴다. 화음 성부는 항상 음계음에 맞춘다(오토튠 여부와 무관).
    """
    voice = harmony_voices("classic", "up" if direction > 0 else "down")[0]
    return voice_shift(track, key, voice, chord_at, lead_shift)


# ---------------------------------------------------------------------------
# 화음 성격: 같은 멜로디라도 어떤 음을 쌓을지 (AirChoir core/dsp.js 의 HARMONY_STYLES 와 같은 이름·생각).
# 영상 후보정은 코드를 알고 있으므로 가능한 한 그 시각 코드의 구성음에 맞춘다.
#
# 성부 하나는 아래 중 하나:
#   chord=(가까운, 먼): 멜로디에서 그 반음 범위(+위, -아래) 안의 가장 가까운 코드 구성음. 없으면 steps(음계 칸)
#   steps=n: 음계 위 n칸 (2 = 3도, -5 = 6도 아래)
#   semis=n: 반음 n개 고정 (-12 = 옥타브 아래)
#   perfect=n: 완전4도(±3)·완전5도(±4). 키 밖으로 나가면 같은 방향의 다른 완전음정으로
#   close=k: 멜로디 바로 아래 k번째 '색깔 음'(코드 구성음 + 7음). 가스펠·재즈 4성 밀집 화음
#   pedal=d: 음계 d번째 음(0 = 으뜸음, 4 = 딸림음)을 멜로디 아래에 길게. octave 로 옥타브 이동
# ---------------------------------------------------------------------------

HARMONY_STYLES: dict[str, dict] = {
    "classic": {
        "label": "정석 3도", "desc": "3도 위 + 아래 (코드 구성음에 맞춤)",
        "voices": [{"chord": (3, 9), "steps": 2, "pan": -0.45, "name": "up"},
                   {"chord": (-3, -9), "steps": -2, "pan": 0.45, "name": "down"}],
    },
    "ballad": {
        "label": "가요 발라드", "desc": "멜로디는 맨 위, 3도·6도 아래에서 따뜻하게",
        "voices": [{"chord": (-3, -5), "steps": -2, "pan": -0.4, "name": "third_below"},
                   {"chord": (-7, -10), "steps": -5, "pan": 0.4, "name": "sixth_below", "gain": 0.85}],
    },
    "kpop": {
        "label": "아이돌 훅", "desc": "옥타브로 겹쳐 두껍게 + 3도 위",
        "voices": [{"semis": -12, "pan": 0.15, "name": "octave_below", "gain": 0.8},
                   {"chord": (3, 9), "steps": 2, "pan": -0.45, "name": "third_up"},
                   {"semis": 12, "pan": 0.45, "name": "octave_up", "gain": 0.45}],
    },
    "gospel": {
        "label": "가스펠·재즈", "desc": "멜로디 아래로 7화음을 촘촘히 (2도가 부딪히는 텐션)",
        "voices": [{"close": 1, "steps": -1, "pan": -0.4, "name": "close1"},
                   {"close": 2, "steps": -3, "pan": 0.4, "name": "close2"},
                   {"close": 3, "steps": -5, "pan": 0.0, "name": "close3", "gain": 0.85}],
    },
    "power": {
        "label": "파워 5도", "desc": "3도 없이 5도·옥타브 (락·영화 음악처럼 웅장하게)",
        "voices": [{"perfect": -4, "pan": -0.35, "name": "fifth_below"},
                   {"semis": -12, "pan": 0.35, "name": "octave_below", "gain": 0.85}],
    },
    "quartal": {
        "label": "몽환 4도", "desc": "4도 위·아래로 쌓은 모던한 울림",
        "voices": [{"steps": 3, "pan": -0.45, "name": "fourth_up"},
                   {"steps": -3, "pan": 0.45, "name": "fourth_below"}],
    },
    "drone": {
        "label": "드론", "desc": "으뜸음·딸림음을 길게 깔아 몽환적으로 (워십·앰비언트)",
        "voices": [{"pedal": 0, "pan": -0.3, "name": "tonic", "gain": 0.8},
                   {"pedal": 4, "pan": 0.3, "name": "fifth", "gain": 0.7}],
    },
}
# 정석 3도의 화음 성부 선택 (위 + 아래 / 위만 / 아래만)
CLASSIC_PARTS = {"both": ("up", "down"), "up": ("up",), "down": ("down",)}


def harmony_voices(style: str = "classic", parts: str = "both") -> list[dict]:
    """화음 성격의 성부 목록. 정석 3도만 parts(both/up/down)로 위·아래를 고른다."""
    if style not in HARMONY_STYLES:
        raise ValueError(f"화음 성격은 {', '.join(HARMONY_STYLES)} 중 하나입니다.")
    voices = HARMONY_STYLES[style]["voices"]
    if style == "classic":
        keep = CLASSIC_PARTS.get(parts, CLASSIC_PARTS["both"])
        voices = [v for v in voices if v["name"] in keep]
    return [dict(v) for v in voices]


def _chord_root(tones: set[int]) -> int | None:
    """코드 구성음 집합의 근음 (3도 + 5도가 있는 음)."""
    for r in sorted(tones):
        if ((r + 3) % 12 in tones or (r + 4) % 12 in tones) and any((r + f) % 12 in tones for f in (6, 7, 8)):
            return r
    return None


def _color_tones(tones: set[int], pcs: list[int]) -> set[int]:
    """코드 구성음 + 그 코드의 7음(음계 안의 장7도 또는 단7도). 가스펠·재즈 밀집 화음의 재료."""
    root = _chord_root(tones)
    if root is None or len(tones) >= 4:
        return set(tones)
    seventh = (root + 11) % 12 if (root + 11) % 12 in pcs else (root + 10) % 12
    return set(tones) | {seventh}


def _perfect(note: int, steps: int, pcs: list[int]) -> int:
    size = 5 if abs(steps) % 7 == 3 else 7
    sign = 1 if steps > 0 else -1
    pure = note + sign * size
    if pure % 12 in pcs or note % 12 not in pcs:
        return pure
    other = note + sign * (12 - size)
    return other if other % 12 in pcs else pure


def _pedal(note: int, pc: int, prev: int | None) -> int:
    """멜로디 아래 지속음. 앞 자리가 아직 멜로디 아래 한 옥타브 반 안이면 그대로 (옥타브를 자주 뛰지 않게)."""
    if prev is not None and note - 17 <= prev <= note:
        return prev
    return note - 3 - ((note - 3 - pc) % 12)


def _voice_note(q: int, voice: dict, tones: set[int] | None, pcs: list[int]) -> int:
    if "semis" in voice:
        return q + voice["semis"]
    if "perfect" in voice:
        return _perfect(q, voice["perfect"], pcs)
    if tones and "chord" in voice:
        near, far = voice["chord"]
        step = 1 if far > near else -1
        for p in range(q + near, q + far + step, step):
            if p % 12 in tones:
                return p
    if tones and "close" in voice:
        color = _color_tones(tones, pcs)
        below = [p for p in range(q - 1, q - 15, -1) if p % 12 in color]
        if len(below) >= voice["close"]:
            return below[voice["close"] - 1]
    return scale_step(q, voice.get("steps", 0), pcs)


def voice_shift(track: PitchTrack, key: Key, voice: dict, chord_at=None,
                lead_shift: np.ndarray | None = None) -> np.ndarray:
    """화음 성격의 성부 하나의 이동량(반음, 프레임별). 화음 음은 늘 음계·코드에 맞추고, 부른 비브라토는 그대로 따라간다."""
    pcs = scale_pcs(key)
    ref = _reference(track)
    melody = nearest_in_scale(ref + (lead_shift if lead_shift is not None else 0.0), pcs)
    out = np.zeros(len(ref))
    cache: dict[tuple, int] = {}
    held = None
    if "pedal" in voice:
        steps = MAJOR_SCALE if key.mode == "major" else MINOR_SCALE[:7]
        pedal_pc = (key.tonic + steps[voice["pedal"] % 7]) % 12
    for i in np.flatnonzero(~np.isnan(melody)):
        q = int(melody[i])
        if "pedal" in voice:
            held = _pedal(q, pedal_pc, held)
            h = held + 12 * voice.get("octave", 0)
        else:
            tones = chord_at(track.times[i]) if chord_at else None
            k = (q, tuple(sorted(tones)) if tones else None)
            if k not in cache:
                cache[k] = _voice_note(q, voice, tones, pcs)
            h = cache[k]
        out[i] = h - ref[i]
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
    """홀 잔향 임펄스 응답 (스테레오). 대역별 감쇠·초기 반사는 sound.reverb_ir 참고."""
    from .sound import reverb_ir as _ir

    return _ir(sr, seconds, predelay, seed)


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
