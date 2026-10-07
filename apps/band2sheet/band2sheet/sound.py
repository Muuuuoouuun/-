"""소리 품질용 공용 DSP: 뜯는 현(Karplus-Strong), 이퀄라이저, 잔향, 리미터.

내장 합성기(backing)와 후보정 믹스(remix)가 함께 쓴다. 외부 의존성 없이 numpy/scipy/numba 만 쓴다.
"""

from __future__ import annotations

import numpy as np
from numba import njit
from scipy.signal import butter, sosfilt, sosfiltfilt

# ---------------------------------------------------------------------------
# 필터
# ---------------------------------------------------------------------------


def peq_sos(f0: float, gain_db: float, q: float, sr: int, kind: str = "peak") -> np.ndarray:
    """RBJ 쿡북 바이쿼드 한 단 (peak | lowshelf | highshelf) -> sos."""
    a = 10 ** (gain_db / 40)
    w = 2 * np.pi * min(f0, sr * 0.45) / sr
    cw, alpha = np.cos(w), np.sin(w) / (2 * q)
    if kind == "peak":
        b = [1 + alpha * a, -2 * cw, 1 - alpha * a]
        den = [1 + alpha / a, -2 * cw, 1 - alpha / a]
    else:
        sa = 2 * np.sqrt(a) * alpha
        sign = 1 if kind == "lowshelf" else -1
        b = [a * ((a + 1) - sign * (a - 1) * cw + sa), sign * 2 * a * ((a - 1) - sign * (a + 1) * cw),
             a * ((a + 1) - sign * (a - 1) * cw - sa)]
        den = [(a + 1) + sign * (a - 1) * cw + sa, -sign * 2 * ((a - 1) + sign * (a + 1) * cw),
               (a + 1) + sign * (a - 1) * cw - sa]
    return np.array([[*(np.array(b) / den[0]), 1.0, den[1] / den[0], den[2] / den[0]]])


def eq(x: np.ndarray, sr: int, bands: list[tuple]) -> np.ndarray:
    """bands: (주파수, dB, Q[, 종류]) 목록. 시간축 0 기준으로 채널마다 적용."""
    if not bands:
        return x
    sos = np.concatenate([peq_sos(b[0], b[1], b[2], sr, b[3] if len(b) > 3 else "peak") for b in bands])
    return sosfilt(sos, x, axis=0)


def highpass(x: np.ndarray, sr: int, fc: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, fc, btype="high", fs=sr, output="sos"), x, axis=0)


def lowpass(x: np.ndarray, sr: int, fc: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, min(fc, sr * 0.45), btype="low", fs=sr, output="sos"), x, axis=0)


# ---------------------------------------------------------------------------
# 뜯는 현: Karplus-Strong (분수 지연으로 음정 정확, 밝기·울림 시간 조절)
# ---------------------------------------------------------------------------


@njit(cache=True)
def _ks_loop(n, delay, s, c, g, excite):  # pragma: no cover - numba
    out = np.zeros(n)
    buf = np.zeros(delay)
    idx = 0
    prev = 0.0
    ax1 = 0.0
    ay1 = 0.0
    m = len(excite)
    for i in range(n):
        xd = buf[idx]
        lp = (1.0 - s) * xd + s * prev  # 한 줄 지날 때마다 고역이 조금씩 줄어듦
        prev = xd
        ap = c * lp + ax1 - c * ay1  # 1차 올패스: 남은 분수 지연
        ax1 = lp
        ay1 = ap
        v = g * ap
        if i < m:
            v += excite[i]
        buf[idx] = v
        idx += 1
        if idx == delay:
            idx = 0
        out[i] = v
    return out


def pluck(midi: float, n: int, sr: int, decay: float = 2.0, bright: float = 0.6, pick: float = 0.15,
          velocity: float = 0.7, seed: int = 0) -> np.ndarray:
    """뜯는 현 한 음. decay: -60dB 까지 초(기본음 기준), bright: 0(둔탁)~1(쨍), pick: 줄 위 뜯는 위치."""
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    period = sr / f0
    s = 0.5 * (1.0 - 0.85 * float(np.clip(bright, 0, 1)))  # 고역 손실 (0.5 = 고전 KS)
    w0 = 2 * np.pi * f0 / sr
    g_target = 10 ** (-3 * period / (max(decay, 0.05) * sr))
    for _ in range(12):  # 높은 음: 루프 필터 손실이 커서 목표 울림을 못 내면 필터를 가볍게
        loss = abs((1 - s) + s * np.exp(-1j * w0))  # 저역통과가 기본음에서 매 주기 줄이는 양
        if g_target / loss <= 0.9995:
            break
        s *= 0.5
    g = min(0.9995, g_target / loss)  # 1 을 넘으면 직류가 커져 불안정
    delay = int(np.floor(period - s - 0.1))
    frac = period - s - delay  # 0.1 ~ 1.1 -> 올패스가 맡음
    c = (1 - frac) / (1 + frac)
    # 들뜸: 뜯는 위치에서 당긴 줄 모양(삼각형, 배음 ∝ sin(nπβ)/n²) — 기본음이 늘 또렷하다.
    # 밝을수록 그 기울기(배음 ∝ 1/n, 손톱·피크 느낌)를 섞고, 잡음은 질감만 조금.
    m = max(4, int(round(period)))
    x = (np.arange(m) + 0.5) / m
    beta = float(np.clip(pick, 0.05, 0.5))
    tri = np.where(x < beta, x / beta, (1 - x) / (1 - beta))
    tri -= tri.mean()
    slope = np.diff(np.concatenate([tri, tri[:1]]))
    tri /= np.abs(tri).max() or 1.0
    slope /= np.abs(slope).max() or 1.0
    b = float(np.clip(bright, 0, 1)) * (0.4 + 0.6 * velocity)
    noise = np.random.default_rng(seed).uniform(-1, 1, m)
    ex = (1 - 0.6 * b) * tri + 0.6 * b * slope + 0.06 * noise
    a = float(np.clip(0.15 + 0.85 * velocity * bright, 0.05, 1.0))  # 세게 뜯을수록 밝게
    ex = sosfilt(butter(1, min(sr * 0.45, 600 + 9000 * a), fs=sr, output="sos"), np.tile(ex, 2))[m:]
    ex -= ex.mean()
    ex /= np.abs(ex).max() or 1.0
    out = _ks_loop(n, max(delay, 2), s, c, g, ex)
    return out / (np.abs(out[: int(sr * 0.2)]).max() or 1.0)


# ---------------------------------------------------------------------------
# 잔향: 대역마다 다른 감쇠(높은 소리가 먼저 사라짐) + 초기 반사 + 좌우 다른 꼬리
# ---------------------------------------------------------------------------


def reverb_ir(sr: int, seconds: float = 2.2, predelay: float = 0.02, seed: int = 7) -> np.ndarray:
    """홀 잔향 임펄스 응답 (스테레오, 에너지 1 로 정규화)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * 1.15 * sr)
    t = np.arange(n) / sr
    noise = rng.normal(size=(n, 2))
    # 낮은 대역은 조금 길게, 높은 대역은 짧게 (실제 홀처럼 공기·벽이 고역을 먹음)
    bands = ((None, 400, 1.15), (400, 2500, 1.0), (2500, 6000, 0.7), (6000, None, 0.42))
    tail = np.zeros((n, 2))
    for lo, hi, rt in bands:
        if lo and hi:
            sos = butter(2, [lo, hi], btype="band", fs=sr, output="sos")
        elif hi:
            sos = butter(2, hi, btype="low", fs=sr, output="sos")
        else:
            sos = butter(2, lo, btype="high", fs=sr, output="sos")
        tail += sosfiltfilt(sos, noise, axis=0) * np.exp(-6.9 * t / (seconds * rt))[:, None]
    # 꼬리는 처음에 밀도가 차오르듯 시작 (갑자기 '쉭' 하지 않게)
    tail *= np.clip(t / 0.03, 0, 1)[:, None] ** 2
    # 초기 반사: 20~90 ms 사이 몇 개의 또렷한 반사, 좌우 다르게
    er = np.zeros((n, 2))
    for ch in range(2):
        for tt, amp in zip(np.sort(rng.uniform(0.008, 0.09, 9)), rng.uniform(0.25, 0.7, 9)):
            er[int(tt * sr), ch] += amp * rng.choice([-1, 1]) * np.exp(-tt * 12)
    er = sosfilt(butter(1, 7000, fs=sr, output="sos"), er, axis=0)
    tail /= np.sqrt(np.sum(tail ** 2) / 2)
    er /= np.sqrt(np.sum(er ** 2) / 2) or 1.0
    ir = 0.92 * tail + 0.39 * er
    ir = np.concatenate([np.zeros((int(predelay * sr), 2)), ir])
    return ir / np.sqrt(np.sum(ir ** 2) / 2)


# ---------------------------------------------------------------------------
# 마스터: 미리 보는 피크 리미터 (파형을 깎지 않고 음량만 부드럽게 줄임)
# ---------------------------------------------------------------------------


@njit(cache=True)
def _release(g, coef):  # pragma: no cover - numba
    """줄어드는 쪽은 그대로, 다시 커질 때만 천천히 (풀릴 때 '펌핑' 방지). 결과는 항상 입력 이하."""
    out = np.empty_like(g)
    cur = g[0]
    for i in range(len(g)):
        cur = g[i] if g[i] < cur else cur + (g[i] - cur) * (1.0 - coef)
        out[i] = cur
    return out


def limit(stereo: np.ndarray, sr: int, ceiling: float = 0.97, lookahead: float = 0.005,
          release: float = 0.08) -> np.ndarray:
    """피크가 ceiling 을 넘지 않게. tanh 로 파형을 깎는 대신 음량 곡선만 미리 부드럽게 줄인다.

    need = ceiling/|x| 의 '앞으로 L 샘플 최솟값'을 L 길이로 평균하면, 피크 위치의 값은
    그 피크를 포함한 최솟값들의 평균이라 need 이하가 보장된다.
    """
    from scipy.ndimage import minimum_filter1d

    x = np.asarray(stereo, dtype=float)
    peak = np.abs(x).max(axis=1) if x.ndim > 1 else np.abs(x)
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-12))
    look = max(1, int(lookahead * sr))
    # fut[i] = min(need[i .. i+look]): 창을 오른쪽(미래)으로 size//2 만큼 민다
    fut = minimum_filter1d(need, size=look + 1, origin=-((look + 1) // 2), mode="nearest")
    c = np.concatenate([[0.0], np.cumsum(fut)])
    idx = np.arange(len(fut))
    lo = np.maximum(idx - look, 0)
    box = (c[idx + 1] - c[lo]) / (idx + 1 - lo)  # 지난 L 샘플 평균 (끝 포함)
    g = _release(np.minimum(box, 1.0), float(np.exp(-1.0 / (release * sr))))
    y = x * (g[:, None] if x.ndim > 1 else g)
    return np.clip(y, -ceiling, ceiling)  # 수치 오차 안전망 (보통 아무것도 하지 않음)
