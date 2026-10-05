"""띠 Viterbi 가 librosa 와 똑같은 경로를 내는지."""

import librosa
import numpy as np

from band2sheet import fastviterbi


def _pyin(y, sr):
    return librosa.pyin(y, fmin=float(librosa.midi_to_hz(40)), fmax=float(librosa.midi_to_hz(84)),
                        sr=sr, frame_length=2048, hop_length=256, fill_na=np.nan)


def test_pyin_identical_and_restored():
    sr = 22050
    t = np.arange(int(sr * 2.5)) / sr
    f = np.where((t * 3).astype(int) % 2 == 0, 196.0, 784.0)  # 두 옥타브씩 뛰는 음 + 끝은 무음
    y = (0.3 * np.sin(2 * np.pi * np.cumsum(f) / sr) * (t < 2.0)).astype(np.float32)
    y += np.random.default_rng(0).normal(scale=0.01, size=len(y)).astype(np.float32)
    want = _pyin(y, sr)
    with fastviterbi.fast_pyin():
        assert librosa.sequence.viterbi is fastviterbi.viterbi
        got = _pyin(y, sr)
    assert librosa.sequence.viterbi is fastviterbi._original_viterbi
    for a, b in zip(want, got):
        assert np.array_equal(a, b, equal_nan=True)


def test_banded_matches_dense_with_ties_and_jumps():
    rng = np.random.default_rng(1)
    s, width = 60, 9
    local = librosa.sequence.transition_local(s, width, window="triangle", wrap=False)
    trans = np.kron(librosa.sequence.transition_loop(2, 0.97), local)
    assert fastviterbi._band(trans) is not None
    for trial in range(20):
        prob = rng.uniform(size=(2 * s, 80))
        prob[:, rng.integers(0, 80, 10)] = 0.5  # 동점 프레임
        prob[rng.integers(0, 2 * s, 200), rng.integers(0, 80, 200)] = 0.0  # 띠 밖으로 뛰는 편이 나은 경우
        prob /= prob.sum(axis=0, keepdims=True).clip(1e-12)
        want = librosa.sequence.viterbi(prob, trans)
        got = fastviterbi.viterbi(prob, trans)
        assert np.array_equal(want, got), trial
        assert np.array_equal(librosa.sequence.viterbi(prob[None], trans), fastviterbi.viterbi(prob[None], trans))


def test_dense_transition_falls_back():
    trans = np.full((10, 10), 0.1)
    assert fastviterbi._band(trans) is None
    prob = np.random.default_rng(2).uniform(size=(10, 30))
    prob /= prob.sum(axis=0, keepdims=True)
    assert np.array_equal(fastviterbi.viterbi(prob, trans), librosa.sequence.viterbi(prob, trans))
