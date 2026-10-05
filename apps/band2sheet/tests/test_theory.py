import pytest

from band2sheet.theory import Key, detect_key, spell_midi, transpose_target


@pytest.mark.parametrize("text,tonic,mode,fifths", [
    ("G", 7, "major", 1),
    ("Bb", 10, "major", -2),
    ("F#m", 6, "minor", 3),
    ("Ebm", 3, "minor", -6),
    ("C minor", 0, "minor", -3),
    ("Gb", 6, "major", -6),
    ("A#", 10, "major", -2),  # 조표 10개짜리 철자는 Bb 로 바꾼다
])
def test_parse(text, tonic, mode, fifths):
    k = Key.parse(text)
    assert (k.tonic, k.mode, k.fifths) == (tonic, mode, fifths)


def test_transpose_nearest_and_spelling():
    shift, dst = transpose_target(Key.parse("G"), target="Bb")
    assert shift == 3 and dst.short_name == "Bb"
    shift, dst = transpose_target(Key.parse("G"), target="E")
    assert shift == -3 and dst.short_name == "E"
    shift, dst = transpose_target(Key.parse("G"), target="E", direction="up")
    assert shift == 9
    shift, dst = transpose_target(Key.parse("D"), semitones=-1)
    assert dst.short_name == "Db"
    shift, dst = transpose_target(Key.parse("Am"), semitones=2)
    assert dst.short_name == "Bm"


def test_spell_midi_follows_key():
    assert spell_midi(70, Key.parse("F")) == ("Bb", 4)
    assert spell_midi(70, Key.parse("E")) == ("A#", 4)
    assert spell_midi(66, Key.parse("G")) == ("F#", 4)
    # 단조의 이끈음: D 단조의 C#
    assert spell_midi(61, Key.parse("Dm")) == ("C#", 4)
    # F# 장조의 E# 은 옥타브 경계를 고려
    assert spell_midi(65, Key.parse("F#")) == ("E#", 4)
    assert spell_midi(60, Key(1, "major", 7)) == ("B#", 3)  # C# 장조


def test_detect_key_major_scale():
    g_major = [67, 69, 71, 72, 74, 76, 78, 79, 71, 74, 67, 67]
    key, r = detect_key((p, 1.0) for p in g_major)
    assert key.short_name == "G" and r > 0.5


def test_detect_key_minor():
    a_minor = [57, 59, 60, 62, 64, 65, 68, 69, 57, 60, 64, 57, 69]
    key, _ = detect_key((p, 1.0) for p in a_minor)
    assert key.short_name == "Am"
