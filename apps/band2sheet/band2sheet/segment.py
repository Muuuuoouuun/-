"""예배·공연 실황 영상에서 곡 구간 찾기 (곡 나누기).

긴 영상에는 찬양 여러 곡 사이에 말씀·기도·광고·박수, 건반 패드로 이어지는 전환이 섞여 있다.
초 단위로 '음악다움'을 재서 음악 구간을 찾고, 쉼 없이 이어지는 메들리는 키·템포가 바뀌는 곳에서 나눈다.

음악다움 (초마다, 앞뒤 몇 초를 보고):
- 박 규칙성: 음 시작 세기 곡선의 자기상관 — 일정한 박이 있으면 높다 (말은 낮다)
- 조성 선명도: 몇 초 동안 쌓은 음높이 분포(크로마)가 몇 음에 몰려 있으면 높다 (말은 흩어진다)
- 끊김: 말은 음절·문장 사이에 짧은 쉼이 많고, 음악은 소리가 이어진다
"""

from __future__ import annotations

import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

import librosa
import numpy as np

from .audio_io import require_ffmpeg
from .theory import Key

SR = 11025
HOP = 512


@dataclass
class SongSegment:
    start: float  # 초
    end: float
    key: str = ""  # 예: "G"
    tempo: float = 0.0
    confidence: float = 0.0  # 0~1 (음악다움 평균)

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        d = asdict(self)
        d["duration"] = round(self.duration, 1)
        return d


def load_mono(path: str | Path, sr: int = SR) -> np.ndarray:
    """영상·음원 -> 모노 (빠른 분석용 낮은 샘플레이트)."""
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "scan.wav"
        subprocess.run([require_ffmpeg(), "-y", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1",
                        "-ar", str(sr), "-c:a", "pcm_s16le", str(wav)], check=True)
        y, _ = librosa.load(str(wav), sr=sr, mono=True)
    return y


def _smooth(x: np.ndarray, n: int) -> np.ndarray:
    if n <= 1 or len(x) == 0:
        return x
    k = np.ones(n) / n
    return np.convolve(np.pad(x, (n // 2, n - 1 - n // 2), mode="edge"), k, mode="valid")


def chromas(y: np.ndarray, sr: int = SR, chunk_sec: float = 60.0) -> tuple[np.ndarray, np.ndarray]:
    """(전체 크로마, 저음(300Hz 아래) 크로마) — 긴 녹음도 메모리를 적게 쓰도록 1분씩 나눠 계산."""
    n_fft = 4096
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    low_mask = (freqs < 300)[:, None]
    step = int(chunk_sec * sr) // HOP * HOP
    full, low = [], []
    for start in range(0, len(y), step):
        seg = y[start:start + step + n_fft]
        if len(seg) < n_fft:
            break
        S = np.abs(librosa.stft(seg, n_fft=n_fft, hop_length=HOP, center=False)) ** 2
        n_frames = min(S.shape[1], step // HOP)
        S = S[:, :n_frames]
        full.append(librosa.feature.chroma_stft(S=S, sr=sr, n_fft=n_fft))
        low.append(librosa.feature.chroma_stft(S=S * low_mask, sr=sr, n_fft=n_fft))
    if not full:
        z = np.zeros((12, 1))
        return z, z
    return np.concatenate(full, axis=1), np.concatenate(low, axis=1)


def music_curve(y: np.ndarray, sr: int = SR, chroma: np.ndarray | None = None) -> dict[str, np.ndarray]:
    """초마다 음악다움 지표들 (0~1 근처)."""
    fps = sr / HOP
    n_sec = int(len(y) / sr)
    if n_sec < 4:
        z = np.zeros(max(n_sec, 1))
        return {"music": z, "rhythm": z, "tonal": z, "continuity": z, "rms_db": z}
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=HOP)[0]
    rms_db = 20 * np.log10(rms + 1e-6)
    loud_ref = float(np.percentile(rms_db, 95))
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    if chroma is None:
        chroma = chromas(y, sr)[0]

    win = int(6 * fps)  # 6초 창
    lag_lo, lag_hi = int(0.3 * fps), int(1.6 * fps)  # 37~200 BPM
    rhythm = np.zeros(n_sec)
    tonal = np.zeros(n_sec)
    cont = np.zeros(n_sec)
    level = np.zeros(n_sec)
    tempo = np.zeros(n_sec)
    for s in range(n_sec):
        c = int(s * fps)
        a, b = max(0, c - win // 2), min(len(onset), c + win // 2)
        o = onset[a:b] - np.mean(onset[a:b])
        if len(o) > lag_hi + 4 and np.any(o):
            ac = np.correlate(o, o, mode="full")[len(o) - 1:]
            ac = ac / (ac[0] + 1e-9)
            seg = ac[lag_lo:lag_hi]
            rhythm[s] = max(0.0, float(seg.max()))
            tempo[s] = 60.0 * fps / (lag_lo + int(np.argmax(seg)))
        ch = chroma[:, a:b].sum(axis=1)
        if ch.sum() > 0:
            p = ch / ch.sum()
            ent = -float(np.sum(p * np.log(p + 1e-12))) / np.log(12)
            tonal[s] = 1.0 - ent  # 몇 음에 몰릴수록 큼
        r = rms_db[a:b]
        level[s] = float(np.median(r)) - loud_ref
        cont[s] = float(np.mean(r > loud_ref - 30))  # 짧은 쉼(말 사이)이 많으면 작아짐
    # 조성 선명도는 곡마다 다르므로 전체 분포로 0~1 로 맞춘다
    t_lo, t_hi = np.percentile(tonal, 10), np.percentile(tonal, 90)
    tonal_n = np.clip((tonal - t_lo) / (t_hi - t_lo + 1e-9), 0, 1)
    music = 0.45 * np.clip(rhythm / 0.5, 0, 1) + 0.3 * tonal_n + 0.25 * np.clip((cont - 0.6) / 0.35, 0, 1)
    music = np.where(level < -35, 0.0, music)  # 거의 무음
    return {"music": _smooth(music, 5), "rhythm": rhythm, "tonal": tonal_n, "continuity": cont,
            "rms_db": level, "tempo": tempo}


def _key_of(chroma_sum: np.ndarray) -> Key:
    from .theory import detect_key

    return detect_key((pc, float(w)) for pc, w in enumerate(chroma_sum))[0]


def find_songs(y: np.ndarray, sr: int = SR, threshold: float = 0.5, min_song: float = 45.0,
               max_gap: float = 8.0) -> list[SongSegment]:
    """음악 구간 -> 곡 목록. 메들리는 키가 바뀌는 곳에서 나눈다."""
    chroma, low_chroma = chromas(y, sr)
    curves = music_curve(y, sr, chroma)
    music = curves["music"]
    is_music = music > threshold
    # 구간 만들기 (짧은 끊김은 메운다)
    segs: list[list[int]] = []
    for s, m in enumerate(is_music):
        if not m:
            continue
        if segs and s - segs[-1][1] <= max_gap:
            segs[-1][1] = s + 1
        else:
            segs.append([s, s + 1])
    fps = sr / HOP
    out: list[SongSegment] = []
    rhythm = _smooth(curves["rhythm"], 5)
    for a, b in segs:
        parts = _split_medley(chroma, fps, a, b, curves["tempo"], rhythm)
        # 너무 짧은 조각은 이웃에 다시 붙인다 (곡 안의 전조·간주를 곡 경계로 오해했을 때)
        merged: list[tuple[int, int]] = []
        for a2, b2 in parts:
            if merged and (b2 - a2 < min_song or merged[-1][1] - merged[-1][0] < min_song):
                merged[-1] = (merged[-1][0], b2)
            else:
                merged.append((a2, b2))
        parts = merged
        # 메들리 경계: 키가 바뀐 곳 근처에 박이 약해지는 전환(패드·간주)이 있으면 그 앞뒤로 나눈다
        refined = []
        for j, (a2, b2) in enumerate(parts):
            if j > 0:
                cut = a2
                lo, hi = max(parts[j - 1][0], cut - 15), min(b2, cut + 6)
                window = rhythm[lo:hi]
                if window.size and window.min() < 0.45:
                    trough = np.where(window < max(0.45, float(window.min()) + 0.1))[0] + lo
                    # 가장 깊은 곳을 포함하는 연속 구간
                    deepest = lo + int(np.argmin(window))
                    t0 = t1 = deepest
                    while t0 - 1 in trough:
                        t0 -= 1
                    while t1 + 1 in trough:
                        t1 += 1
                    refined[-1] = (refined[-1][0], int(t0))
                    a2 = int(t1 + 1)
            refined.append((a2, b2))
        for a2, b2 in refined:
            a2, b2 = _trim_beatless(rhythm, a2, b2)
            if b2 - a2 < min_song:
                continue
            # 키: 멜로디가 많은 전체 크로마만 보면 3도 위 단조(D -> F#m)로 틀리기 쉬워 저음 쪽을 같이 본다
            ch = chroma[:, int(a2 * fps):int(b2 * fps)].sum(axis=1)
            lo = low_chroma[:, int(a2 * fps):int(b2 * fps)].sum(axis=1)
            key = _key_of(ch / (ch.sum() + 1e-9) + lo / (lo.sum() + 1e-9))
            tempos = curves["tempo"][a2:b2]
            tempos = tempos[tempos > 0]
            bpm = float(np.median(tempos)) if tempos.size else 0.0
            while 0 < bpm < 62:  # 자기상관은 두 박 간격을 고르기도 한다 — 보통 템포 범위로
                bpm *= 2
            while bpm > 150:
                bpm /= 2
            out.append(SongSegment(float(a2), float(b2), key.short_name, round(bpm, 1),
                                   round(float(np.mean(music[a2:b2])), 2)))
    return out


def _trim_beatless(rhythm: np.ndarray, a: int, b: int, low: float = 0.35, run: int = 6) -> tuple[int, int]:
    """곡 앞뒤에 붙은 박 없는 부분(건반 패드 전환, 박수 끝자락)을 잘라낸다 — 박 없는 구간이 run 초 이상일 때만."""
    def beatless_run(idx):
        k = 0
        for i in idx:
            if rhythm[i] >= low:
                break
            k += 1
        return k
    head = beatless_run(range(a, b))
    if head >= run:
        a += head
    tail = beatless_run(range(b - 1, a - 1, -1))
    if tail >= run:
        b -= tail
    return a, b


def _split_medley(chroma: np.ndarray, fps: float, a: int, b: int, tempo: np.ndarray,
                  rhythm: np.ndarray | None = None, block: int = 4, half: int = 8) -> list[tuple[int, int]]:
    """한 음악 구간 안에서 키가 바뀌는 곳(곡이 바뀐 곳)을 찾아 나눈다.

    block 초 단위 크로마로 체커보드 커널(앞 half 블록 vs 뒤 half 블록) 새로움 곡선을 만들고,
    양쪽의 키가 다르고 새로움이 뚜렷한 곳에서 자른다."""
    n_blocks = (b - a) // block
    if n_blocks < 2 * half + 2:
        return [(a, b)]
    feats = []
    for i in range(n_blocks):
        s0 = int((a + i * block) * fps)
        s1 = int((a + (i + 1) * block) * fps)
        v = chroma[:, s0:s1].mean(axis=1)
        feats.append(v / (np.linalg.norm(v) + 1e-9))
    F = np.array(feats)
    nov = np.zeros(n_blocks)
    for i in range(half, n_blocks - half):
        left = F[i - half:i].mean(axis=0)
        right = F[i:i + half].mean(axis=0)
        nov[i] = 1.0 - float(left @ right / (np.linalg.norm(left) * np.linalg.norm(right) + 1e-9))
    cuts = []
    thr = max(0.08, float(np.mean(nov[nov > 0]) + 2 * np.std(nov[nov > 0]))) if np.any(nov > 0) else 1.0
    i = half
    while i < n_blocks - half:
        if nov[i] >= thr and nov[i] == nov[max(0, i - half):i + half].max():
            sec = a + i * block
            kl = _key_of(chroma[:, int((sec - half * block) * fps):int(sec * fps)].sum(axis=1))
            kr = _key_of(chroma[:, int(sec * fps):int((sec + half * block) * fps)].sum(axis=1))
            tl = np.median(tempo[max(a, sec - 30):sec]) if sec > a else 0
            tr = np.median(tempo[sec:min(b, sec + 30)])
            tempo_jump = tl > 0 and tr > 0 and abs(np.log2(tr / tl)) > 0.08
            # 곡 안에서 마지막 후렴을 올리는 전조도 흔하다 — 키만 바뀌고 박이 끊기지 않으면 같은 곡
            trough = rhythm is not None and float(rhythm[max(a, sec - 15):min(b, sec + 6)].min()) < 0.4
            if tempo_jump or ((kl.tonic, kl.mode) != (kr.tonic, kr.mode) and trough):
                cuts.append(sec)
                i += half
                continue
        i += 1
    bounds = [a] + cuts + [b]
    return [(bounds[j], bounds[j + 1]) for j in range(len(bounds) - 1)]


def scan_file(path: str | Path, **kw) -> list[SongSegment]:
    return find_songs(load_mono(path), SR, **kw)
