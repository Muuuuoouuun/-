"""소리 품질 DSP: 뜯는 현 음정·울림, 리미터, 잔향, 마스터."""

import numpy as np
import pytest
from scipy.signal import butter, sosfiltfilt

from band2sheet.sound import eq, limit, pluck, reverb_ir

SR = 44100


def _peak_hz(y, f0):
    seg = y[int(0.05 * SR):int(1.05 * SR)]
    n = len(seg)
    spec = np.abs(np.fft.rfft(seg * np.hanning(n), 16 * n))
    f = np.fft.rfftfreq(16 * n, 1 / SR)
    band = (f > f0 * 0.94) & (f < f0 * 1.06)
    return f[np.argmax(spec * band)]


@pytest.mark.parametrize("midi", [28, 40, 55, 64, 76, 88, 96])
def test_pluck_is_in_tune_and_rings_as_asked(midi):
    f0 = 440 * 2 ** ((midi - 69) / 12)
    y = pluck(midi, 2 * SR, SR, decay=2.0, bright=0.7, pick=0.17, velocity=0.7)
    assert np.isfinite(y).all()
    assert abs(1200 * np.log2(_peak_hz(y, f0) / f0)) < 2  # 분수 지연으로 음정이 정확
    fund = sosfiltfilt(butter(2, [f0 * 0.9, f0 * 1.1], btype="band", fs=SR, output="sos"), y)

    def level(a, b):
        return np.sqrt(np.mean(fund[int(a * SR):int(b * SR)] ** 2))

    # decay=2초(-60dB) -> 0.9초 동안 -27dB. 높은 음도 금방 죽지 않는다
    assert abs(20 * np.log10(level(1.0, 1.1) / level(0.1, 0.2)) + 27) < 3


def test_pluck_fundamental_leads_and_harder_is_brighter():
    def harmonics(vel):
        y = pluck(55, SR, SR, decay=2.2, bright=0.8, pick=0.17, velocity=vel)
        f0 = 440 * 2 ** ((55 - 69) / 12)
        seg = y[int(0.02 * SR):int(0.32 * SR)]
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), 8 * len(seg)))
        f = np.fft.rfftfreq(8 * len(seg), 1 / SR)
        return np.array([spec[(f > k * f0 * 0.97) & (f < k * f0 * 1.03)].max() for k in range(1, 9)])

    soft, hard = harmonics(0.3), harmonics(0.9)
    assert soft.argmax() == 0 and hard.argmax() == 0  # 기본음이 또렷 (잡음 들뜸처럼 들쭉날쭉하지 않음)
    assert hard[3:].sum() / hard[0] > 1.3 * soft[3:].sum() / soft[0]  # 세게 뜯으면 높은 배음이 산다


def test_limiter_never_exceeds_ceiling_and_leaves_quiet_parts_alone():
    rng = np.random.default_rng(0)
    x = np.clip(rng.normal(size=(3 * SR, 2)) * 0.15, -0.5, 0.5)
    x[SR:SR + 50] *= 8
    x[2 * SR] = 3.0
    y = limit(x, SR, ceiling=0.9)
    assert np.abs(y).max() <= 0.9 + 1e-9
    assert np.allclose(y[:SR // 2], x[:SR // 2])  # 피크와 멀리 떨어진 곳은 손대지 않음
    # 파형을 깎지 않고 음량만 줄임: 피크 근처에서도 모양(상관)이 그대로
    seg = slice(SR - 100, SR + 150)
    assert np.corrcoef(x[seg, 0], y[seg, 0])[0, 1] > 0.9


def test_reverb_tail_gets_darker():
    ir = reverb_ir(SR, seconds=2.0)
    assert np.isclose(np.sum(ir ** 2) / 2, 1.0)
    assert np.corrcoef(ir[:, 0], ir[:, 1])[0, 1] < 0.3  # 좌우가 다른 꼬리 -> 넓은 공간감

    def hf_ratio(a, b):
        seg = ir[int(a * SR):int(b * SR), 0]
        spec = np.abs(np.fft.rfft(seg)) ** 2
        f = np.fft.rfftfreq(len(seg), 1 / SR)
        return spec[f > 4000].sum() / spec.sum()

    assert hf_ratio(1.0, 1.4) < 0.5 * hf_ratio(0.05, 0.45)  # 높은 소리가 먼저 사라짐


def test_eq_peak_boosts_only_its_band():
    t = np.arange(SR) / SR
    lo, hi = np.sin(2 * np.pi * 300 * t), np.sin(2 * np.pi * 5000 * t)
    y_lo, y_hi = (eq(s, SR, [(300, 6.0, 1.0)]) for s in (lo, hi))
    gain = lambda a, b: 20 * np.log10(np.std(a[SR // 2:]) / np.std(b[SR // 2:]))  # noqa: E731
    assert abs(gain(y_lo, lo) - 6.0) < 0.3 and abs(gain(y_hi, hi)) < 0.5


def test_master_is_loud_but_clean():
    from band2sheet.remix import _master

    rng = np.random.default_rng(1)
    x = rng.normal(size=(2 * SR, 2)) * 0.05
    x[SR:SR + 400] += 0.9  # 큰 순간 + 직류
    y = _master(x, sr=SR)
    assert np.abs(y).max() <= 0.96 + 1e-9
    assert abs(np.sqrt(np.mean(y ** 2)) - 0.12) < 0.03
    assert abs(y[:SR // 2].mean()) < 1e-3
