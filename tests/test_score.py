from music21 import converter

from band2sheet.chords import detect_chords
from band2sheet.instruments import INSTRUMENTS
from band2sheet.lyrics import align_lyrics, split_syllables
from band2sheet.pipeline import RenderOptions, chord_chart, render
from band2sheet.project import Note, Project, TimeMap, Track, Word
from band2sheet.score import Grid, mono_events, poly_events
from band2sheet.theory import Key

BEAT = 0.6  # 100 BPM


def b(x):  # 박 -> 초
    return x * BEAT


def make_project() -> Project:
    beats = [b(i) for i in range(40)]
    chords = [(43, [55, 59, 62]), (38, [54, 57, 62]), (40, [55, 59, 64]), (36, [55, 60, 64])]
    piano, bass = [], []
    for bar in range(8):
        root, tones = chords[bar % 4]
        for beat in range(4):
            t = bar * 4 + beat
            piano += [Note(b(t), b(t + 0.8), p, 70) for p in tones]
        bass += [Note(b(bar * 4), b(bar * 4 + 1.9), root, 90), Note(b(bar * 4 + 2), b(bar * 4 + 3.9), root, 90)]
    melody = [(0, 1, 67), (1, 1, 71), (2, 2, 74), (4, 1, 74), (5, 1, 72), (6, 2, 71)]
    vocals = [Note(b(s), b(s + d * 0.9), p, 90) for s, d, p in melody]
    return Project(
        title="test", source="", beat_times=beats, key=Key.parse("G"),
        tracks={
            "vocals": Track("vocals", vocals, [Word(b(0), b(2.9), "주님의")]),
            "piano": Track("piano", piano),
            "bass": Track("bass", bass),
            "drums": Track("drums", [Note(b(i), b(i) + 0.1, 36 if i % 2 == 0 else 38, 100)
                                     for i in range(32)]),
        },
    )


def test_timemap_roundtrip():
    tm = TimeMap([0.5, 1.0, 1.6, 2.1])
    assert abs(float(tm.to_beats(1.3)) - 1.5) < 1e-9
    assert abs(float(tm.to_seconds(tm.to_beats(3.0))) - 3.0) < 1e-9
    assert float(tm.to_beats(0.0)) < 0


def test_mono_events_legato_and_quantize():
    p = make_project()
    grid = Grid.for_project(p)
    ev = mono_events(p.tracks["vocals"].notes, grid)
    assert [(e.offset, e.dur, e.pitches[0]) for e in ev[:3]] == [(0, 1, 67), (1, 1, 71), (2, 2, 74)]


def test_poly_events_groups_chords():
    p = make_project()
    ev = poly_events(p.tracks["piano"].notes, Grid.for_project(p))
    assert ev[0].pitches == [55, 59, 62] and ev[0].dur == 1


def test_detect_chords_progression():
    p = make_project()
    tracks = {k: t.notes for k, t in p.tracks.items()}
    ch = detect_chords(tracks, TimeMap(p.beat_times), p.key, 4, 0)
    names = [c.name(p.key) for c in ch]
    assert names[:4] == ["G", "D", "Em", "C"]
    assert ch[0].start == 0 and ch[0].end == 4


def test_lyrics_korean_syllables():
    assert split_syllables("사랑해요!") == ["사", "랑", "해", "요!"]
    assert split_syllables("Hallelujah") == ["Hallelujah"]
    notes = [Note(0, 0.5, 60), Note(0.5, 1.0, 62), Note(1.0, 1.5, 64), Note(2.0, 2.5, 65)]
    got = align_lyrics(notes, [Word(0.0, 1.5, "주님의"), Word(2.0, 2.5, "사랑")])
    assert got == {0: "주", 1: "님", 2: "의", 3: "사랑"}


def test_render_and_transpose(tmp_path):
    p = make_project()
    res = render(p, tmp_path, RenderOptions(target_key="Bb"), log=lambda m: None)
    assert res.key.short_name == "Bb" and res.semitones == 3
    names = {f.name for f in res.files}
    for expected in ("vocals.musicxml", "piano.musicxml", "bass.musicxml", "drums.musicxml",
                     "full_score.musicxml", "lead_sheet.musicxml", "chords.txt", "all.mid"):
        assert expected in names
    assert "| Bb" in res.chord_chart and "Gm" in res.chord_chart and "Eb" in res.chord_chart

    lead = converter.parse(str(res.out_dir / "lead_sheet.musicxml"))
    ks = lead.recurse().getElementsByClass("KeySignature").first()
    assert ks.sharps == -2
    first = [n for n in lead.recurse().notes if not n.isChord][:3]
    assert [n.pitch.nameWithOctave for n in first] == ["B-4", "D5", "F5"]
    assert first[0].lyric == "주"
    full = converter.parse(str(res.out_dir / "full_score.musicxml"))
    # grand staff 피아노 2단 + 보컬 + 베이스 + 드럼
    assert len(full.parts) == 5
    lengths = {round(part.highestTime, 3) for part in full.parts}
    assert len(lengths) == 1  # 모든 파트 마디 수 동일


def test_chord_chart_layout():
    p = make_project()
    grid = Grid.for_project(p)
    tracks = {k: t.notes for k, t in p.tracks.items()}
    ch = detect_chords(tracks, grid.timemap, p.key, 4, 0)
    text = chord_chart(ch, p.key, grid, p, p.tracks["vocals"].lyrics)
    assert "Key: G" in text and "주님의" in text


def test_project_roundtrip(tmp_path):
    p = make_project()
    p.save(tmp_path / "project.json")
    q = Project.load(tmp_path / "project.json")
    assert q.key == p.key and len(q.tracks["piano"].notes) == len(p.tracks["piano"].notes)
    assert q.tracks["vocals"].lyrics[0].text == "주님의"


def test_instrument_table():
    assert INSTRUMENTS["bass"].mono and INSTRUMENTS["vocals"].mono
    assert not INSTRUMENTS["piano"].mono


def test_tab_fingering_and_playable():
    from band2sheet.instruments import BASS_TUNING, GUITAR_TUNING
    from band2sheet.notation import assign_frets, capo_suggestion, playable_subset

    # G 코드 (G2 B2 D3 G3 B3 G4) -> 개방현 위주의 1~3프렛 운지
    fing = assign_frets([[43, 47, 50, 55, 59, 67]], GUITAR_TUNING)[0]
    assert fing is not None and max(f for _, f in fing.frets) <= 3
    # 같은 음이라도 앞뒤 손 위치를 따라간다: 높은 포지션 다음의 A4 는 개방현이 아닌 프렛으로
    seq = assign_frets([[74], [76], [69]], GUITAR_TUNING)
    assert all(f is not None for f in seq)
    assert playable_subset(list(range(40, 52)), GUITAR_TUNING, 17)  # 12음 -> 6음 이하로 줄임
    assert len(playable_subset(list(range(40, 52)), GUITAR_TUNING, 17)) <= 6
    assert assign_frets([[28], [33]], BASS_TUNING)[0].frets == ((0, 0),)
    assert capo_suggestion(8, "major") == (1, "G")  # Ab -> 카포 1, G 모양
    assert capo_suggestion(7, "major") is None


def test_split_hands_follows_position():
    from band2sheet.notation import split_hands
    from band2sheet.score import Event

    up, low = split_hands([Event(0, 1, [43, 50, 59, 62, 67], 80), Event(1, 1, [36, 48, 64, 67, 72], 80)])
    assert low[0].pitches == [43, 50] and up[0].pitches == [59, 62, 67]
    assert 36 in low[1].pitches and 72 in up[1].pitches


def test_drum_parts_transcription(tmp_path):
    from collections import Counter

    from band2sheet.instruments import CRASH, HIHAT, HIHAT_OPEN, KICK, SNARE, TOM_FLOOR, TOM_HIGH
    from band2sheet.transcribe import drum_hits_from_parts
    from tests.synth import make_stems

    make_stems(tmp_path, bars=4, drum_parts=True)
    parts = {p.stem: p for p in (tmp_path / "drums").glob("*.wav")}
    c = Counter(n.pitch for n in drum_hits_from_parts(parts))
    assert c[KICK] == 8 and c[SNARE] == 7  # 4마디 x 2, 필인 마디는 스네어 1개 적음
    assert c[HIHAT] >= 20 and c[HIHAT_OPEN] >= 2
    assert c[CRASH] == 1 and c[TOM_HIGH] >= 1 and c[TOM_FLOOR] >= 1
