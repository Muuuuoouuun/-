"""악보 조판 품질: 드럼 그루브 정리, TAB 리듬 표시 제거, 프레이즈 묶기, 같은 화음 같은 운지."""

from band2sheet.score import Event, regularize_drums
from band2sheet.sections import _pair_phrases


def _bar(b, kick_snare_ok=True, missing_hat=None):
    ev = []
    for k in range(8):
        pos = b * 4 + k * 0.5
        pitches = [] if missing_hat == k else [42]
        if k in (0, 4):
            pitches.append(36)
        if k in (2, 6) and kick_snare_ok:
            pitches.append(38)
        if pitches:
            ev.append(Event(pos, 0.5, sorted(pitches), 90))
    return ev


def test_regularize_drums_snaps_small_deviations_keeps_fills():
    events = []
    for b in range(8):
        if b == 7:  # 필인: 스네어 16분음표 연타
            events += [Event(b * 4 + k * 0.25, 0.25, [38], 100) for k in range(16)]
        else:
            events += _bar(b, missing_hat=(b % 3 if b in (2, 4) else None))
    out = regularize_drums(events, 4.0, [0.0], 32.0)
    bars = [sorted((round(e.offset - b * 4, 3), tuple(e.pitches)) for e in out if b * 4 <= e.offset < b * 4 + 4)
            for b in range(8)]
    assert bars[2] == bars[0] == bars[4]  # 하이햇 빠진 마디도 기본 그루브로
    assert len(bars[7]) == 16  # 필인은 그대로


def test_ostinato_completion():
    # 첫 박 하이햇이 늘 묻혀서 안 잡혀도 8분음표 하이햇으로 채운다
    events = []
    for b in range(4):
        events += _bar(b, missing_hat=0)
    out = regularize_drums(events, 4.0, [0.0], 16.0)
    first = [e for e in out if e.offset == 0.0][0]
    assert 42 in first.pitches and 36 in first.pitches


def test_pair_phrases():
    # 절(A+B)·후렴(C+D)이 늘 붙어 다니면 8마디 한 구간으로
    assert _pair_phrases(list("ABCDABCD")) == ["AB", "AB", "CD", "CD", "AB", "AB", "CD", "CD"]
    # 같은 프레이즈가 반복되는 곡은 그대로
    assert _pair_phrases(list("ABBCCBBCC")) == list("ABBCCBBCC")


def test_strip_tab_rhythm():
    from band2sheet.pipeline import strip_tab_rhythm

    mei = ('<staffDef n="1" lines="5"/><staffDef n="2" notationtype="tab.guitar" lines="6"/>'
           '<staff n="1"><layer><beam><note/><note/></beam></layer></staff>'
           '<staff n="2"><layer><beam><tabGrp><tabDurSym xml:id="a" /><note/></tabGrp></beam></layer></staff>')
    out = strip_tab_rhythm(mei)
    assert "<tabDurSym" not in out and out.count("<beam>") == 1  # 오선보의 빔은 그대로


def test_same_chord_same_fingering():
    from band2sheet.instruments import GUITAR_TUNING
    from band2sheet.notation import assign_frets

    g = [55, 59, 62, 67]
    far = [69, 74, 78, 81]  # 높은 자리 화음 사이에 끼어 있어도
    seq = [g, far, g, g, far, g]
    f = assign_frets(seq, GUITAR_TUNING)
    assert len({f[i] for i in (0, 2, 3, 5)}) == 1
