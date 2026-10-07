"""pYIN 의 Viterbi 를 띠(band) 구조로 빠르게.

librosa.pyin 의 전이 행렬은 kron([[1-p, p], [p, 1-p]], L) 이고, L 은 한 프레임에 몇 반음까지만
움직일 수 있는 띠 행렬이다. librosa 의 Viterbi 는 상태마다 모든 이전 상태(약 900개)를 훑어
O(T·S²) 인데, 실제로 의미 있는 전이는 띠 안의 몇십 개뿐이다.

여기서는 띠 안의 후보만 보고, 띠 밖(전이 확률 0 -> log(ε))은 '이전 값이 가장 큰 띠 밖 상태' 하나만
보면 되므로 결과(로그 확률 계산, 동점일 때 낮은 번호 우선)가 librosa 와 똑같다.
띠 구조가 아니면 원래 librosa 함수를 그대로 쓴다.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager

import librosa
import numpy as np
from numba import njit

_original_viterbi = librosa.sequence.viterbi
_lock = threading.Lock()
_active = 0


@njit(cache=True)
def _banded_viterbi(log_prob, log_trans, log_p_init, lo, hi, log_out):  # pragma: no cover - numba
    """log_prob: (T, m). 상태 j 로 오는 띠 안 후보는 lo[j]..hi[j] (양 끝 포함, 블록별로 둘)."""
    n_steps, n_states = log_prob.shape
    half = n_states // 2
    state = np.zeros(n_steps, dtype=np.uint16)
    value = np.zeros((n_steps, n_states), dtype=np.float64)
    ptr = np.zeros((n_steps, n_states), dtype=np.uint16)
    value[0] = log_prob[0] + log_p_init
    in_band = np.zeros(n_states, dtype=np.bool_)
    for t in range(1, n_steps):
        prev = value[t - 1]
        order = np.argsort(-prev, kind="mergesort")  # 큰 값 먼저, 같으면 낮은 번호 먼저
        for j in range(n_states):
            jp = j % half
            best = -np.inf
            best_i = -1
            for blk in range(2):  # 낮은 번호 블록부터 -> 동점이면 낮은 번호
                base = blk * half
                for i in range(base + lo[jp], base + hi[jp] + 1):
                    v = prev[i] + log_trans[i, j]
                    if v > best:
                        best = v
                        best_i = i
            # 띠 밖에서 가장 큰 이전 값 (전이는 모두 log(ε) 로 같음)
            for blk in range(2):
                base = blk * half
                for i in range(base + lo[jp], base + hi[jp] + 1):
                    in_band[i] = True
            for k in range(n_states):
                i = order[k]
                if not in_band[i]:
                    v = prev[i] + log_out
                    if v > best or (v == best and i < best_i):
                        best = v
                        best_i = i
                    break
            for blk in range(2):
                base = blk * half
                for i in range(base + lo[jp], base + hi[jp] + 1):
                    in_band[i] = False
            ptr[t, j] = best_i
            value[t, j] = log_prob[t, j] + best
    state[-1] = np.argmax(value[-1])
    for t in range(n_steps - 2, -1, -1):
        state[t] = ptr[t + 1, state[t + 1]]
    return state


def _band(transition: np.ndarray):
    """kron(2x2, L) 띠 구조면 (lo, hi, 띠 밖 전이 값) 을, 아니면 None."""
    m = transition.shape[0]
    if m % 2 or m < 8 or m > 65535:
        return None
    s = m // 2
    blocks = [transition[a * s:(a + 1) * s, b * s:(b + 1) * s] for a in range(2) for b in range(2)]
    nz = blocks[0] > 0
    if any(not np.array_equal(blk > 0, nz) for blk in blocks[1:]):
        return None
    lo = np.empty(s, dtype=np.int64)
    hi = np.empty(s, dtype=np.int64)
    for j in range(s):
        rows = np.flatnonzero(nz[:, j])
        if not len(rows) or rows[-1] - rows[0] + 1 != len(rows):  # 띠가 이어져 있어야 함
            return None
        lo[j], hi[j] = rows[0], rows[-1]
    if (hi - lo + 1).max() * 4 > s:  # 띠가 넓으면 이득이 없음
        return None
    return lo, hi


def viterbi(prob, transition, *, p_init=None, return_logp=False):
    """librosa.sequence.viterbi 와 같은 결과. pyin 처럼 2차원 확률 + 띠 전이일 때만 빠른 길로."""
    band = _band(transition) if prob.ndim >= 2 and prob.shape[-1] > 0 and not return_logp else None
    if band is None:
        return _original_viterbi(prob, transition, p_init=p_init, return_logp=return_logp)
    n_states = prob.shape[-2]
    if p_init is None:
        p_init = np.full(n_states, 1.0 / n_states)
    epsilon = librosa.util.tiny(prob)
    log_trans = np.log(transition + epsilon)
    log_out = float(np.log(0.0 + epsilon))
    log_init = np.log(p_init + epsilon)
    lo, hi = band
    log_prob = np.log(prob + epsilon)
    flat = log_prob.reshape(-1, *log_prob.shape[-2:])  # pyin: (1, 상태, 프레임)
    states = np.stack([_banded_viterbi(np.ascontiguousarray(lp.T), log_trans, log_init, lo, hi, log_out)
                       for lp in flat])
    return states.reshape(*prob.shape[:-2], prob.shape[-1])


@contextmanager
def fast_pyin():
    """이 안에서 부르는 librosa.pyin 이 띠 Viterbi 를 쓰게 한다 (결과는 같음)."""
    global _active
    with _lock:
        _active += 1
        librosa.sequence.viterbi = viterbi
    try:
        yield
    finally:
        with _lock:
            _active -= 1
            if not _active:
                librosa.sequence.viterbi = _original_viterbi
