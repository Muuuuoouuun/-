"""채보(오디오 -> 음표): 스템마다 알맞은 엔진으로 음표를 추출한다.

- basic_pitch : Spotify Basic Pitch (다성: 기타, 건반, 코러스)
- crepe       : CREPE 딥러닝 음높이 추적 (단선율: 보컬, 베이스) — torchcrepe 설치 시 기본
- pyin        : librosa pYIN 음높이 추적 (단선율, 추가 모델 없이 동작하는 대체 엔진)
- piano_hr    : ByteDance 고해상도 피아노 채보 (음 + 서스테인 페달)
- drums       : 드럼 조각(DrumSep/멀티트랙) 또는 대역 분석으로 킥·스네어·탐·하이햇·심벌 검출
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import librosa
import numpy as np

from .engines import available, torch_device
from .instruments import (
    CRASH, HIHAT, HIHAT_OPEN, KICK, RIDE, SNARE, TOM_FLOOR, TOM_HIGH, TOM_MID, InstrumentSpec,
)
from .project import Note


@dataclass
class Transcription:
    notes: list[Note]
    engine: str
    pedals: list[tuple[float, float]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 다성: Basic Pitch
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


# ---------------------------------------------------------------------------
# 피아노: ByteDance High-resolution Piano Transcription (페달 포함)
# ---------------------------------------------------------------------------

def piano_hr_notes(path: Path, device: str | None = None) -> tuple[list[Note], list[tuple[float, float]]]:
    from piano_transcription_inference import PianoTranscription, load_audio, sample_rate

    audio, _ = load_audio(str(path), sr=sample_rate, mono=True)
    pt = PianoTranscription(device=torch_device(device))
    with tempfile.TemporaryDirectory() as tmp:
        out = pt.transcribe(audio, str(Path(tmp) / "piano.mid"))

    def get(e, key, idx):
        return e[key] if isinstance(e, dict) else e[idx]

    notes = [
        Note(float(get(e, "onset_time", 0)), float(get(e, "offset_time", 1)),
             int(get(e, "midi_note", 2)), int(get(e, "velocity", 3)))
        for e in out["est_note_events"]
    ]
    pedals = [(float(get(e, "onset_time", 0)), float(get(e, "offset_time", 1)))
              for e in out.get("est_pedal_events", [])]
    return sorted(notes, key=lambda n: (n.start, n.pitch)), pedals


# ---------------------------------------------------------------------------
# 단선율: 음높이 곡선(f0) -> 음표
# ---------------------------------------------------------------------------

def pyin_f0(y: np.ndarray, sr: int, hop: int, spec: InstrumentSpec) -> np.ndarray:
    """pYIN. 반환: 프레임별 MIDI 음높이 (무성 = nan)."""
    f0, voiced, prob = librosa.pyin(
        y, fmin=float(librosa.midi_to_hz(spec.low)), fmax=float(librosa.midi_to_hz(spec.high)),
        sr=sr, frame_length=2048, hop_length=hop, fill_na=np.nan,
    )
    voiced = voiced & (prob > 0.3)
    return librosa.hz_to_midi(np.where(voiced, f0, np.nan))


def crepe_f0(y: np.ndarray, sr: int, hop: int, spec: InstrumentSpec, device: str | None = None,
             threshold: float = 0.5) -> np.ndarray:
    """CREPE (torchcrepe). GPU 가 있으면 full 모델, 없으면 tiny 모델."""
    import torch
    import torchcrepe

    device = torch_device(device)
    if device == "mps":  # torchcrepe 는 mps 에서 불안정
        device = "cpu"
    model = "full" if device == "cuda" else "tiny"
    audio = torch.tensor(y, dtype=torch.float32)[None]
    pitch, periodicity = torchcrepe.predict(
        audio, sr, hop_length=hop,
        fmin=float(max(librosa.midi_to_hz(spec.low), 32.0)),
        fmax=float(min(librosa.midi_to_hz(spec.high), 1975.0)),
        model=model, decoder=torchcrepe.decode.viterbi, return_periodicity=True,
        batch_size=512, device=device, pad=True,
    )
    periodicity = torchcrepe.filter.median(periodicity, 3)
    hz = pitch[0].cpu().numpy()
    per = periodicity[0].cpu().numpy()
    return librosa.hz_to_midi(np.where(per > threshold, hz, np.nan))


def notes_from_f0(y: np.ndarray, sr: int, hop: int, midi: np.ndarray,
                  spec: InstrumentSpec) -> list[Note]:
    """프레임별 음높이를 음표로 분할 (비브라토 무시, 음절 재발음/음량 틈에서 분할)."""
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    n = min(len(midi), len(rms))
    midi, rms = midi[:n].copy(), rms[:n]
    voiced = ~np.isnan(midi)
    # 너무 작은 소리(다른 악기 블리딩/잔향)는 무성 처리
    if np.any(rms > 0):
        voiced &= rms > np.percentile(rms[rms > 0], 95) * 0.08
    midi[~voiced] = np.nan

    # 라이브 연주는 A=440 에서 조금 벗어나 있을 수 있으므로 전체 튜닝 오프셋을 보정
    frac = midi[voiced] - np.round(midi[voiced])
    midi = midi - (float(np.median(frac)) if frac.size else 0.0)

    onsets = librosa.onset.onset_detect(y=y, sr=sr, hop_length=hop, units="frames", backtrack=True)
    # 같은 음을 다시 부른(음절) 온셋만: 그 직전에 소리가 눈에 띄게 줄었다가 다시 커져야 한다.
    # (다른 악기에서 새어 든 하이햇 같은 온셋은 이 악기의 음량을 거의 바꾸지 않는다)
    win = max(2, int(round(0.08 * sr / hop)))

    def rearticulated(o: int) -> bool:
        before = rms[max(0, o - 2 * win):max(1, o - win)]
        dip = rms[max(0, o - win // 2):o + 2]
        after = rms[o:o + win]
        if not (before.size and dip.size and after.size):
            return False
        return float(dip.min()) < 0.75 * min(float(before.max()), float(after.max()))

    onsets = np.array([o for o in onsets if o < n and rearticulated(int(o))], dtype=int)
    onset_set = set(int(o) for o in onsets)

    frame_t = hop / sr
    min_frames = max(2, int(round(spec.min_note / frame_t)))
    glide_frames = max(1, int(round(0.1 / frame_t)))
    raw: list[tuple[float, float, int, float]] = []
    seg: list[int] = []

    def flush():
        if len(seg) >= min_frames:
            pitch = int(np.round(np.median(midi[seg])))
            raw.append((seg[0] * frame_t, (seg[-1] + 1) * frame_t, pitch, float(np.max(rms[seg]))))
        seg.clear()

    def split_glide(target: float) -> list[int]:
        """음이 바뀔 때: 앞 음 끝부분 중 이미 새 음 쪽으로 미끄러지기 시작한 프레임들을 새 음으로 넘긴다
        (포르타멘토 — 음의 시작은 음높이가 움직이기 시작한 곳)."""
        base = float(np.median(midi[seg[:max(1, len(seg) - glide_frames)]]))
        direction = np.sign(target - base)
        k = len(seg)
        while k > min_frames and len(seg) - k < glide_frames:
            d = (midi[seg[k - 1]] - base) * direction
            if not d > 0.2:
                break
            k -= 1
        moved = seg[k:]
        del seg[k:]
        return moved

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
                jump = ahead.size > 0 and bool(np.all(np.abs(ahead - current) > 0.6))
            # 같은 음 반복(가사 음절)은 온셋으로 분할
            restrike = i in onset_set and len(seg) >= min_frames
            if jump:
                carried = split_glide(float(midi[i]))
                flush()
                seg.extend(carried)
            elif restrike:
                flush()
        seg.append(i)
    flush()

    # 음높이 추적이 잠깐 끊겨 생긴 조각은 합친다 — 단, 그 사이에 온셋이 있으면 같은 음을 다시 부른 것(음절)
    joined: list[tuple[float, float, int, float]] = []
    onset_all = np.asarray(sorted(onsets)) * frame_t
    for s, e, p, v in raw:
        if joined:
            ps, pe, pp, pv = joined[-1]
            restruck = np.any((onset_all > pe - 0.02) & (onset_all < s + 0.02))
            if pp == p and 0 <= s - pe <= 0.035 and not restruck:
                joined[-1] = (ps, e, p, max(pv, v))
                continue
        joined.append((s, e, p, v))
    raw = joined

    # 음 시작을 실제 소리 시작(자음·어택)으로 당긴다: 음높이는 소리가 난 뒤 조금 지나야 잡히므로
    # (되짚기 없는 온셋 — 되짚으면 앞 음이 잦아드는 곳까지 너무 앞당겨진다)
    peaks = librosa.onset.onset_detect(y=y, sr=sr, hop_length=hop, units="frames", backtrack=False)
    onset_t = np.asarray(sorted(peaks)) * frame_t
    refined: list[tuple[float, float, int, float]] = []
    for s, e, p, v in raw:
        prev_end = refined[-1][1] if refined else -1.0
        cand = onset_t[(onset_t >= s - 0.12) & (onset_t <= s + 0.01) & (onset_t >= prev_end + 0.025)]
        if cand.size and cand[-1] < s:
            # 다른 악기에서 새어 든 작은 소리의 온셋이 아니라, 이 음의 소리(자음·어택)가 시작된 곳이어야 한다
            # 음높이가 잡히기 전 구간(온셋 ~ 시작 15ms 전)에 이미 이 음의 소리가 있어야 한다
            # 그리고 거기서부터 소리가 커져야 한다 (앞 음이 잦아드는 곳의 온셋은 제외)
            f0, f1 = int(cand[-1] / frame_t), int((s - 0.015) / frame_t)
            fs = int(s / frame_t)
            rising = float(np.max(rms[fs:fs + 4])) >= 1.3 * float(rms[f0]) if fs < len(rms) else False
            # 사이에 다른 음이 또렷이 울리면(놓친 짧은 음) 건너뛰지 않는다.
            # 이 음으로 미끄러져 오는 중(포르타멘토)이면 괜찮다.
            between = midi[f0:fs]
            between = between[~np.isnan(between)]
            distinct = False
            if between.size >= 2 and abs(float(np.median(between)) - p) > 0.6:
                glide = abs(between[-1] - p) < abs(between[0] - p) - 0.3
                distinct = not glide
            if f1 > f0 and rising and not distinct and float(np.median(rms[f0:f1])) >= 0.12 * v:
                s = float(cand[-1])
        refined.append((min(s, e - frame_t), e, p, v))

    peak = max((r[3] for r in refined), default=1.0) or 1.0
    return [Note(s, e, p, int(np.clip(40 + 87 * (v / peak), 1, 127))) for s, e, p, v in refined]


def mono_notes(path: Path, spec: InstrumentSpec, engine: str, device: str | None = None) -> list[Note]:
    if engine == "crepe":
        sr, hop = 16000, 160
        y, _ = librosa.load(str(path), sr=sr, mono=True)
        if not np.any(y):
            return []
        midi = crepe_f0(y, sr, hop, spec, device)
    else:
        sr, hop = 22050, 256
        y, _ = librosa.load(str(path), sr=sr, mono=True)
        if not np.any(y):
            return []
        midi = pyin_f0(y, sr, hop, spec)
    return notes_from_f0(y, sr, hop, midi, spec)


def pyin_notes(path: Path, spec: InstrumentSpec) -> list[Note]:
    return mono_notes(path, spec, "pyin")


# ---------------------------------------------------------------------------
# 드럼
# ---------------------------------------------------------------------------

def _decay_time(env_db: np.ndarray, f: int, frame_t: float, drop_db: float = 20.0) -> float:
    """타격 후 에너지가 drop_db 만큼 줄어들 때까지 걸린 시간(초)."""
    peak_i = f + int(np.argmax(env_db[f:f + 4])) if f < len(env_db) else len(env_db) - 1
    peak = env_db[peak_i]
    tail = env_db[peak_i:]
    below = np.nonzero(tail < peak - drop_db)[0]
    return (below[0] if below.size else len(tail)) * frame_t


def drum_hits(path: Path, sr: int = 22050, hop: int = 256, threshold: float = 0.45) -> list[Note]:
    """드럼 스템 하나에서 킥 / 스네어 / 하이햇(열림·닫힘) / 크래시 검출 (조각 분리가 없을 때).

    전체 대역에서 타격 시점을 찾은 뒤, 그 순간 각 대역의 에너지 증가량(스펙트럴 플럭스)을
    대역별 '전형적인 타격 세기'로 나눠 비교해 어떤 악기가 쳤는지 판단한다.
    고역 타격은 울림 길이로 닫힌 하이햇 / 열린 하이햇 / 크래시를 구분한다.
    """
    y, sr = librosa.load(str(path), sr=sr, mono=True)
    if not np.any(y):
        return []
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    bands = {KICK: (30, 120), SNARE: (150, 2000), HIHAT: (6000, sr / 2)}
    frame_t = hop / sr

    onset_env = librosa.onset.onset_strength(S=librosa.power_to_db(S, ref=np.max), sr=sr,
                                             hop_length=hop)
    frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, hop_length=hop,
                                        units="frames", backtrack=False, delta=0.05, wait=3)
    if len(frames) == 0:
        return []

    hits: list[Note] = []
    for drum, (lo, hi) in bands.items():
        band = S[(freqs >= lo) & (freqs < hi)].sum(axis=0) + 1e-10
        db = 10 * np.log10(band)
        rise = np.zeros(len(frames))
        for k, f in enumerate(frames):
            before = db[max(0, f - 4):max(1, f - 1)].mean()
            after = db[f:f + 3].max() if f < len(db) else db[-1]
            # 절대 크기가 너무 작은 대역은 무시 (곡 전체 최대 대비 -40 dB 미만)
            rise[k] = max(0.0, after - before) if after > db.max() - 40 else 0.0
        if not np.any(rise > 0):
            continue
        typical = np.percentile(rise[rise > 0], 90)
        for f, v in zip(frames, rise):
            if typical <= 0 or v / typical < threshold:
                continue
            piece = drum
            if drum == HIHAT:
                decay = _decay_time(db, int(f), frame_t)
                if decay > 0.6:
                    piece = CRASH
                elif decay > 0.18:
                    piece = HIHAT_OPEN
            t = float(f * frame_t)
            vel = int(np.clip(50 + 77 * min(v / typical, 1.0), 1, 127))
            hits.append(Note(t, t + 0.1, piece, vel))
    return sorted(hits, key=lambda n: (n.start, n.pitch))


def part_onsets(path: Path, sr: int = 22050, hop: int = 256,
                gate: float = 0.12) -> tuple[list[tuple[float, int, int]], np.ndarray, float]:
    """드럼 조각 트랙 하나의 타격 목록 [(시각, 프레임, 세기)] 과 dB 엔벌로프."""
    y, sr = librosa.load(str(path), sr=sr, mono=True)
    if not np.any(y):
        return [], np.zeros(1), hop / sr
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=hop, units="frames",
                                        backtrack=False, delta=0.08, wait=3)
    ref = np.percentile(rms, 99.5) or 1.0
    out = []
    for f in frames:
        peak = float(rms[f:f + 4].max()) if f < len(rms) else 0.0
        # 다른 조각에서 새어 들어온 작은 소리는 버린다
        if peak < gate * ref:
            continue
        # 울림(심벌 꼬리 등) 속의 흔들림이 아니라 실제로 소리가 커지는 타격만
        before = rms[max(f - 6, 0):max(f - 2, 1)]
        if before.size and peak < 1.4 * float(before.min()):
            continue
        vel = int(np.clip(45 + 82 * min(peak / ref, 1.0), 1, 127))
        out.append((float(f * hop / sr), int(f), vel))
    return out, 20 * np.log10(rms + 1e-10), hop / sr


def _tom_pitch(path: Path, times: list[float], sr: int = 22050) -> list[float]:
    """탐 타격마다 기본 주파수(60~400Hz 스펙트럼 피크) 추정."""
    y, sr = librosa.load(str(path), sr=sr, mono=True)
    out = []
    win = int(0.12 * sr)
    for t in times:
        i = int(t * sr)
        seg = y[i:i + win]
        if len(seg) < 256:
            out.append(np.nan)
            continue
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n=8192))
        f = np.fft.rfftfreq(8192, 1 / sr)
        mask = (f >= 60) & (f <= 400)
        out.append(float(f[mask][np.argmax(spec[mask])]))
    return out


def classify_toms(freqs: list[float]) -> list[int]:
    """탐 음높이를 하이/미드/플로어로 묶는다 (로그 주파수 1차원 군집)."""
    valid = [f for f in freqs if not np.isnan(f)]
    if not valid:
        return [TOM_MID] * len(freqs)
    logs = np.log2(np.asarray(valid))
    # 반음 2개(약 12%) 이상 떨어진 값들로 군집 경계 찾기
    order = np.sort(logs)
    gaps = np.diff(order)
    cut_idx = np.argsort(gaps)[::-1][:2]
    cuts = sorted(order[i] + gaps[i] / 2 for i in cut_idx if gaps[i] > 2 / 12)
    n_groups = len(cuts) + 1
    names = {1: [TOM_MID], 2: [TOM_FLOOR, TOM_HIGH], 3: [TOM_FLOOR, TOM_MID, TOM_HIGH]}[n_groups]
    out = []
    for f in freqs:
        if np.isnan(f):
            out.append(TOM_MID)
            continue
        g = int(np.searchsorted(cuts, np.log2(f)))
        out.append(names[g])
    return out


def drum_hits_from_parts(parts: dict[str, Path]) -> list[Note]:
    """드럼 조각별 트랙(DrumSep 결과 또는 멀티트랙)에서 키트 전체 채보."""
    fixed = {"kick": KICK, "snare": SNARE, "ride": RIDE, "crash": CRASH,
             "tom1": TOM_HIGH, "tom2": TOM_MID, "tom3": TOM_FLOOR, "floor": TOM_FLOOR}
    hits: list[Note] = []
    for part, path in parts.items():
        onsets, env_db, frame_t = part_onsets(path)
        if not onsets:
            continue
        if part == "hh":
            for t, f, vel in onsets:
                piece = HIHAT_OPEN if _decay_time(env_db, f, frame_t) > 0.2 else HIHAT
                hits.append(Note(t, t + 0.1, piece, vel))
        elif part == "toms":
            pieces = classify_toms(_tom_pitch(path, [t for t, _, _ in onsets]))
            hits += [Note(t, t + 0.1, p, vel) for (t, _, vel), p in zip(onsets, pieces)]
        elif part in fixed:
            hits += [Note(t, t + 0.1, fixed[part], vel) for t, _, vel in onsets]
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


def merge_fragments(notes: list[Note], gap: float = 0.035, restrike: float | None = None) -> list[Note]:
    """같은 음이 아주 짧은 틈으로 끊긴 경우 하나로 합친다.

    restrike 를 주면, 뒤 음이 앞 음 세기의 restrike 배 이상일 때는 같은 음을 다시 친 것
    (반복 스트로크·화음)으로 보고 합치지 않는다. 다성 엔진(Basic Pitch)은 음마다 타격을 검출하므로
    이 값을 쓰고, 단선율 엔진(음높이 곡선 분할)은 조각을 모두 합친다.
    """
    out: list[Note] = []
    last_by_pitch: dict[int, Note] = {}
    for n in sorted(notes, key=lambda n: n.start):
        prev = last_by_pitch.get(n.pitch)
        if prev is not None and 0 <= n.start - prev.end <= gap and \
                (restrike is None or n.velocity < restrike * prev.velocity):
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


def resolve_engine(spec: InstrumentSpec, engine: str | None = None) -> str:
    """'auto' 를 설치 상태에 맞는 실제 엔진 이름으로 바꾼다."""
    engine = engine or spec.engine
    if engine != "auto":
        return engine
    if spec.stem == "piano":
        return "piano_hr" if available("piano_hr") else "basic_pitch"
    if spec.mono:
        return "crepe" if available("crepe") else "pyin"
    return "basic_pitch"


def transcribe_stem(path: Path, spec: InstrumentSpec, engine: str | None = None,
                    drum_parts: dict[str, Path] | None = None, device: str | None = None,
                    log=print, restrike_by_attack: bool = False) -> Transcription:
    """restrike_by_attack: 다성 엔진에서 같은 음 조각을 세기로 합치지 않고 남겨 둔다
    (뒤에서 스펙트럼의 어택으로 '다시 친 음'과 '끊긴 조각'을 가린다 — cleanup.remove_unstruck)."""
    engine = resolve_engine(spec, engine)
    pedals: list[tuple[float, float]] = []
    if engine == "drums":
        if drum_parts:
            return Transcription(drum_hits_from_parts(drum_parts), "drum_parts")
        return Transcription(drum_hits(path), "drums")
    if engine == "piano_hr":
        try:
            notes, pedals = piano_hr_notes(path, device)
        except Exception as e:  # 체크포인트 다운로드 실패 등
            log(f"   ! 피아노 고해상도 채보 생략 ({e}) — Basic Pitch 사용")
            engine, notes = "basic_pitch", basic_pitch_notes(path, spec)
    elif engine in ("crepe", "pyin"):
        try:
            notes = mono_notes(path, spec, engine, device)
        except Exception as e:
            if engine != "crepe":
                raise
            log(f"   ! CREPE 생략 ({e}) — pYIN 사용")
            engine, notes = "pyin", mono_notes(path, spec, "pyin")
    elif engine == "basic_pitch":
        notes = basic_pitch_notes(path, spec)
    else:
        raise ValueError(f"알 수 없는 채보 엔진: {engine}")
    poly = engine in ("basic_pitch", "piano_hr")
    notes = filter_notes(notes, spec)
    # 단선율 엔진은 notes_from_f0 안에서 (온셋을 보고) 조각을 합친다
    if poly and not restrike_by_attack:
        notes = merge_fragments(notes, restrike=0.7)
    if spec.mono:
        notes = make_monophonic(notes, prefer_low=spec.stem == "bass")
    return Transcription(notes, engine, pedals)
