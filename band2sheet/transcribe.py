"""채보(오디오 -> 음표): 스템마다 알맞은 엔진으로 음표를 추출한다.

- basic_pitch : Spotify Basic Pitch (다성 악기: 기타, 피아노, 건반, 베이스)
- pyin        : librosa pYIN 기본 주파수 추적 (단선율: 보컬). 추가 모델 없이 동작
- drums       : 대역별 온셋 검출로 킥/스네어/하이햇 추출
"""

from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

from .instruments import HIHAT, KICK, SNARE, InstrumentSpec
from .project import Note


# ---------------------------------------------------------------------------
# 엔진들
# ---------------------------------------------------------------------------

def basic_pitch_notes(path: Path, spec: InstrumentSpec, onset_threshold: float = 0.5,
                      frame_threshold: float = 0.3) -> list[Note]:
    try:
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import predict
    except ImportError as e:  # pragma: no cover - 설치 안내
        raise RuntimeError("다성 채보에는 basic-pitch 가 필요합니다: pip install basic-pitch") from e

    _, _, events = predict(
        str(path),
        ICASSP_2022_MODEL_PATH,
        onset_threshold=onset_threshold,
        frame_threshold=frame_threshold,
        minimum_note_length=max(spec.min_note * 1000.0, 58.0),
        minimum_frequency=float(librosa.midi_to_hz(spec.low)),
        maximum_frequency=float(librosa.midi_to_hz(spec.high)),
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    notes = [
        Note(float(s), float(e), int(p), int(np.clip(round(a * 127), 1, 127)))
        for s, e, p, a, *_ in events
    ]
    return sorted(notes, key=lambda n: (n.start, n.pitch))


def pyin_notes(path: Path, spec: InstrumentSpec, sr: int = 22050, hop: int = 256) -> list[Note]:
    """pYIN 피치 곡선을 음표로 분할한다 (보컬 멜로디용)."""
    y, sr = librosa.load(str(path), sr=sr, mono=True)
    if not np.any(y):
        return []
    fmin = float(librosa.midi_to_hz(spec.low))
    fmax = float(librosa.midi_to_hz(spec.high))
    f0, voiced, voiced_prob = librosa.pyin(
        y, fmin=fmin, fmax=fmax, sr=sr, frame_length=2048, hop_length=hop, fill_na=np.nan
    )
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    n = min(len(f0), len(rms))
    f0, voiced, voiced_prob, rms = f0[:n], voiced[:n], voiced_prob[:n], rms[:n]

    # 너무 작은 소리(블리딩/잔향)는 무성 처리
    loud = rms > (np.percentile(rms[rms > 0], 95) if np.any(rms > 0) else 0) * 0.08
    voiced = voiced & loud & (voiced_prob > 0.3)
    midi = librosa.hz_to_midi(np.where(voiced, f0, np.nan))

    # 라이브 연주는 A=440 에서 조금 벗어나 있을 수 있으므로 전체 튜닝 오프셋을 보정
    frac = midi[voiced] - np.round(midi[voiced])
    tuning = float(np.median(frac)) if frac.size else 0.0
    midi = midi - tuning

    onsets = librosa.onset.onset_detect(y=y, sr=sr, hop_length=hop, units="frames", backtrack=True)
    onset_set = set(int(o) for o in onsets)

    frame_t = hop / sr
    min_frames = max(2, int(round(spec.min_note / frame_t)))
    notes: list[Note] = []
    seg: list[int] = []

    def flush():
        if len(seg) >= min_frames:
            pitch = int(np.round(np.median(midi[seg])))
            vel = float(np.max(rms[seg]))
            notes.append(Note(seg[0] * frame_t, (seg[-1] + 1) * frame_t, pitch, vel))  # type: ignore[arg-type]
        seg.clear()

    for i in range(n):
        if not voiced[i]:
            flush()
            continue
        # 음량이 크게 꺼지는 지점(같은 음을 다시 부를 때의 틈)에서 분할
        if len(seg) >= min_frames and rms[i] < 0.35 * np.median(rms[seg]):
            flush()
            continue
        if seg:
            current = np.median(midi[seg[-min(len(seg), 8):]])
            jump = abs(midi[i] - current) > 0.6
            # 잠깐의 비브라토/꺾기는 무시: 다음 몇 프레임도 벗어나야 음 변화로 인정
            if jump:
                ahead = midi[i:i + 3]
                ahead = ahead[~np.isnan(ahead)]
                jump = ahead.size > 0 and np.all(np.abs(ahead - current) > 0.6)
            # 같은 음 반복(가사 음절)은 온셋으로 분할
            restrike = i in onset_set and len(seg) >= min_frames
            if jump or restrike:
                flush()
        seg.append(i)
    flush()

    if notes:
        peak = max(n_.velocity for n_ in notes) or 1.0
        for n_ in notes:
            n_.velocity = int(np.clip(40 + 87 * (n_.velocity / peak), 1, 127))
    return notes


def drum_hits(path: Path, sr: int = 22050, hop: int = 256, threshold: float = 0.45) -> list[Note]:
    """킥(저역) / 스네어(중역) / 하이햇(고역) 타격 검출.

    전체 대역에서 타격 시점을 찾은 뒤, 그 순간 각 대역의 에너지 증가량(스펙트럴 플럭스)을
    대역별 '전형적인 타격 세기'로 나눠 비교해 어떤 악기가 쳤는지 판단한다.
    """
    y, sr = librosa.load(str(path), sr=sr, mono=True)
    if not np.any(y):
        return []
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    bands = {KICK: (30, 120), SNARE: (150, 2000), HIHAT: (6000, sr / 2)}

    onset_env = librosa.onset.onset_strength(S=librosa.power_to_db(S, ref=np.max), sr=sr,
                                             hop_length=hop)
    frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, hop_length=hop,
                                        units="frames", backtrack=False, delta=0.05, wait=3)
    if len(frames) == 0:
        return []

    flux: dict[int, np.ndarray] = {}
    for drum, (lo, hi) in bands.items():
        band = S[(freqs >= lo) & (freqs < hi)].sum(axis=0) + 1e-10
        db = 10 * np.log10(band)
        rise = np.zeros_like(db)
        # 직전 몇 프레임 대비 직후 몇 프레임의 에너지 증가 (dB)
        for f in frames:
            before = db[max(0, f - 4):max(1, f - 1)].mean()
            after = db[f:f + 3].max() if f < len(db) else db[-1]
            # 절대 크기가 너무 작은 대역은 무시 (곡 전체 최대 대비 -40 dB 미만)
            rise[f] = max(0.0, after - before) if after > db.max() - 40 else 0.0
        flux[drum] = rise

    hits: list[Note] = []
    for drum, rise in flux.items():
        vals = rise[frames]
        if not np.any(vals > 0):
            continue
        typical = np.percentile(vals[vals > 0], 90)
        for f, v in zip(frames, vals):
            if typical <= 0 or v / typical < threshold:
                continue
            t = float(f * hop / sr)
            vel = int(np.clip(50 + 77 * min(v / typical, 1.0), 1, 127))
            hits.append(Note(t, t + 0.1, drum, vel))
    return sorted(hits, key=lambda n: (n.start, n.pitch))


# ---------------------------------------------------------------------------
# 후처리
# ---------------------------------------------------------------------------

def filter_notes(notes: list[Note], spec: InstrumentSpec, min_velocity: int = 20) -> list[Note]:
    return [
        n for n in notes
        if spec.low <= n.pitch <= spec.high and n.duration >= spec.min_note * 0.9
        and n.velocity >= min_velocity
    ]


def merge_fragments(notes: list[Note], gap: float = 0.035) -> list[Note]:
    """같은 음이 아주 짧은 틈으로 끊긴 경우 하나로 합친다."""
    out: list[Note] = []
    last_by_pitch: dict[int, Note] = {}
    for n in sorted(notes, key=lambda n: n.start):
        prev = last_by_pitch.get(n.pitch)
        if prev is not None and 0 <= n.start - prev.end <= gap:
            prev.end = max(prev.end, n.end)
            prev.velocity = max(prev.velocity, n.velocity)
            continue
        new = Note(n.start, n.end, n.pitch, n.velocity)
        out.append(new)
        last_by_pitch[n.pitch] = new
    return out


def make_monophonic(notes: list[Note], prefer_low: bool = False, together: float = 0.04) -> list[Note]:
    """한 번에 한 음만 남긴다. 동시에 시작한 음 중에서는 (베이스면 낮은 음, 아니면 큰 음) 선택."""
    notes = sorted(notes, key=lambda n: n.start)
    groups: list[list[Note]] = []
    for n in notes:
        if groups and n.start - groups[-1][0].start <= together:
            groups[-1].append(n)
        else:
            groups.append([n])
    picked: list[Note] = []
    for g in groups:
        if prefer_low:
            # 옥타브 오검출 대비: 충분히 큰 음 중 가장 낮은 음
            loud = max(x.velocity for x in g)
            cand = [x for x in g if x.velocity >= 0.6 * loud]
            best = min(cand, key=lambda x: x.pitch)
        else:
            best = max(g, key=lambda x: (x.velocity * x.duration, x.velocity))
        picked.append(Note(best.start, best.end, best.pitch, best.velocity))
    for a, b in zip(picked, picked[1:]):
        if a.end > b.start:
            a.end = b.start
    return [n for n in picked if n.duration > 0.02]


def transcribe_stem(path: Path, spec: InstrumentSpec, engine: str | None = None) -> list[Note]:
    engine = engine or spec.engine
    if engine == "drums":
        return drum_hits(path)
    if engine == "pyin":
        notes = pyin_notes(path, spec)
    elif engine == "basic_pitch":
        notes = basic_pitch_notes(path, spec)
    else:
        raise ValueError(f"알 수 없는 채보 엔진: {engine}")
    notes = merge_fragments(filter_notes(notes, spec))
    if spec.mono:
        notes = make_monophonic(notes, prefer_low=spec.stem == "bass")
    return notes
