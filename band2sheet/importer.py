"""악보 파일 입력: MIDI(.mid/.midi/.kar) · MusicXML(.musicxml/.mxl/.xml) -> 프로젝트.

음원이 아니라 이미 있는 MIDI·악보 파일을 넣으면, 오디오 분석 없이 바로
코드 악보·리드시트·파트보·조옮김·악보 소리로 바꿀 수 있다.

- MIDI 트랙은 이름·악기 번호로 보컬/코러스/기타/피아노/베이스/드럼/기타 악기에 나눈다.
  보컬 트랙이 따로 없으면 가장 높은 단선율 트랙을 멜로디(보컬)로 본다.
- 템포 변화·박자표·조표·가사(카라오케 MIDI)를 그대로 가져온다.
- MusicXML 은 코드 기호(하모니)와 가사가 있으면 그것을 그대로 쓴다 (자동 인식보다 정확).
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

import numpy as np

from .project import Note, Project, Track, Word
from .theory import Key

MIDI_EXT = {".mid", ".midi", ".kar"}
MUSICXML_EXT = {".musicxml", ".mxl", ".xml"}
SYMBOLIC_EXT = MIDI_EXT | MUSICXML_EXT

NAME_RULES = [  # (정규식, 스템) — 트랙 이름으로 먼저 판단
    (r"back|choir|chorus|harmony|bgv|코러스|화음", "backing_vocals"),
    (r"vocal|voice|vox|melody|lead|sing|보컬|멜로디|노래|선율", "vocals"),
    (r"drum|perc|kit|드럼", "drums"),
    (r"bass|베이스", "bass"),
    (r"guit|gtr|기타", "guitar"),
    (r"piano|keys|keyboard|rhodes|피아노|건반", "piano"),
]

MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
MINOR_NAMES = ["Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]


def is_symbolic(path: str | Path) -> bool:
    return Path(str(path)).suffix.lower() in SYMBOLIC_EXT


def stem_for(name: str, program: int, is_drum: bool) -> str:
    if is_drum:
        return "drums"
    low = (name or "").lower()
    for pattern, stem in NAME_RULES:
        if re.search(pattern, low):
            return stem
    if 32 <= program <= 39:
        return "bass"
    if 24 <= program <= 31:
        return "guitar"
    if 0 <= program <= 7:
        return "piano"
    if 52 <= program <= 54:
        return "backing_vocals"
    return "other"


def fix_text(text: str) -> str:
    """MIDI 글자는 latin-1 로 읽힌다 — 한국 노래방 MIDI 는 대개 CP949(EUC-KR), 요즘 파일은 UTF-8."""
    try:
        raw = text.encode("latin-1")
    except UnicodeEncodeError:
        return text
    for enc in ("utf-8", "cp949"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return text


def _monophony(notes: list[Note]) -> float:
    """겹치는 음의 비율 (0 = 완전 단선율)."""
    notes = sorted(notes, key=lambda n: n.start)
    over = sum(1 for a, b in zip(notes, notes[1:]) if b.start < a.end - 0.03)
    return over / max(1, len(notes) - 1)


def _key_from_midi(pm) -> Key | None:
    if not pm.key_signature_changes:
        return None
    k = pm.key_signature_changes[0].key_number
    return Key.parse(MAJOR_NAMES[k % 12] if k < 12 else MINOR_NAMES[k % 12])


def project_from_midi(path: Path, title: str | None = None, log=print) -> Project:
    import pretty_midi

    from .pipeline import estimate_key

    pm = pretty_midi.PrettyMIDI(str(path))
    groups: dict[str, list[Note]] = {}
    candidates: list[tuple[str, list[Note]]] = []  # 멜로디 후보 (이름으로 정해지지 않은 트랙)
    for inst in pm.instruments:
        notes = [Note(float(n.start), float(n.end), int(n.pitch), int(n.velocity)) for n in inst.notes
                 if n.end > n.start]
        if not notes:
            continue
        inst.name = fix_text(inst.name or "")
        stem = stem_for(inst.name, inst.program, inst.is_drum)
        named = any(re.search(p, inst.name.lower()) for p, _ in NAME_RULES)
        if stem in ("other", "piano", "guitar") and not named:
            candidates.append((stem, notes))
        groups.setdefault(stem, []).extend(notes)
        log(f"   - 트랙 '{inst.name or '(이름 없음)'}' (악기 {inst.program}{', 드럼' if inst.is_drum else ''}) -> {stem}")

    if "vocals" not in groups:
        # 보컬 트랙이 없으면: 단선율이고 음역이 가장 높은 트랙을 멜로디로
        mono = [(float(np.mean([n.pitch for n in ns])), stem, ns) for stem, ns in candidates
                if _monophony(ns) < 0.15 and len(ns) >= 8]
        if mono:
            _, stem, ns = max(mono, key=lambda x: x[0])
            ids = {id(n) for n in ns}
            groups[stem] = [n for n in groups[stem] if id(n) not in ids]
            if not groups[stem]:
                del groups[stem]
            groups["vocals"] = ns
            log(f"   - 보컬 트랙이 없어 가장 높은 단선율 트랙({stem})을 멜로디로 씀")

    tracks = {k: Track(k, sorted(v, key=lambda n: (n.start, n.pitch)), engine="midi") for k, v in groups.items()}
    lyrics = [Word(float(ly.time), float(ly.time) + 0.3, fix_text(ly.text).strip().strip("/\\"))
              for ly in pm.lyrics if ly.text and ly.text.strip() and not ly.text.startswith(("@", "%"))]
    lyrics = [w for w in lyrics if w.text]
    if lyrics and "vocals" in tracks:
        tracks["vocals"].lyrics = lyrics

    beats = [float(b) for b in pm.get_beats()]
    end = max((n.end for t in tracks.values() for n in t.notes), default=0.0)
    while len(beats) >= 2 and beats[-1] < end + 1.0:
        beats.append(beats[-1] + (beats[-1] - beats[-2]))
    ts = pm.time_signature_changes[0] if pm.time_signature_changes else None
    time_sig = f"{ts.numerator}/{ts.denominator}" if ts else "4/4"
    downbeats = [float(d) for d in pm.get_downbeats()]
    downbeat = 0
    if downbeats and beats:
        downbeat = int(np.argmin(np.abs(np.asarray(beats) - downbeats[0])))
    key = _key_from_midi(pm) or estimate_key(tracks)
    project = Project(title=title or path.stem, source=str(path), beat_times=beats, key=key,
                      time_signature=time_sig, downbeat=downbeat, tracks=tracks,
                      engines={"input": "MIDI 파일", "transcription": "MIDI 그대로"})
    if downbeat >= project.beats_per_bar:
        project.downbeat = downbeat % project.beats_per_bar
    # 전조: 파일에 조표 변경이 여러 개 있으면 그대로, 없으면 음표로 찾는다
    if len(pm.key_signature_changes) > 1:
        from .project import TimeMap

        tm = TimeMap(beats)
        changes = []
        for ks in pm.key_signature_changes[1:]:
            b = float(tm.to_beats(ks.time)) - project.downbeat
            bar_beat = round(b / project.beats_per_bar) * project.beats_per_bar
            k = _key_from_midi(type("K", (), {"key_signature_changes": [ks]})())
            if k is not None and bar_beat > 0:
                changes.append((float(bar_beat), k))
        project.key_changes = changes
    else:
        from .pipeline import detect_modulations

        detect_modulations(project)
    return project


def project_from_musicxml(path: Path, title: str | None = None, log=print) -> Project:
    """MusicXML -> (MIDI 로 바꿔) 프로젝트. 코드 기호·가사·제목이 있으면 그대로 쓴다."""
    from music21 import converter, harmony

    score = converter.parse(str(path))
    # 코드 기호는 먼저 읽어 두고 악보에서 뺀다 (music21 은 코드 기호를 MIDI 화음으로 소리 내 버린다)
    symbols_raw = []
    for cs in list(score.recurse().getElementsByClass(harmony.ChordSymbol)):
        symbols_raw.append((float(cs.getOffsetInHierarchy(score)), cs))
        cs.activeSite.remove(cs)
    # 리드시트의 박 사선(/)은 음표가 아니라 '코드대로 연주'라는 표시 — 지운다
    for n in list(score.recurse().notes):
        if getattr(n, "notehead", None) == "slash":
            n.activeSite.remove(n)
    xml_title = None
    if score.metadata is not None:
        xml_title = score.metadata.title or score.metadata.movementName
    with tempfile.TemporaryDirectory() as tmp:
        mid = Path(tmp) / "score.mid"
        score.write("midi", fp=str(mid))
        project = project_from_midi(mid, title or xml_title or path.stem, log)
    project.source = str(path)
    project.engines["input"] = "MusicXML 파일"

    # 파트 이름으로 다시 나누기 (music21 이 쓴 MIDI 트랙 이름이 비어 있을 수 있음) — 가사는 첫 가사 파트에서
    tm_beats = np.asarray(project.beat_times)
    beat_ql = project.beat_ql

    def to_sec(offset_ql: float) -> float:
        b = offset_ql / beat_ql
        return float(np.interp(b, np.arange(len(tm_beats)), tm_beats)) if len(tm_beats) > 1 else 0.0

    words: list[Word] = []
    for part in score.parts:
        for n in part.flatten().notes:
            if n.lyric:
                s = to_sec(float(n.getOffsetInHierarchy(score)))
                words.append(Word(s, to_sec(float(n.getOffsetInHierarchy(score) + n.quarterLength)), n.lyric))
        if words:
            break
    if words and "vocals" in project.tracks:
        project.tracks["vocals"].lyrics = words

    # 코드 기호: 악보에 적힌 그대로 쓰기 (자동 인식 대신)
    symbols = []
    for offset, cs in symbols_raw:
        try:
            root = cs.root().pitchClass
        except Exception:
            continue
        quality = _quality_from_figure(cs.figure or "")
        bass = cs.bass().pitchClass if cs.bass() is not None else None
        symbols.append((offset / beat_ql, root, quality, bass if bass != root else None))
    if symbols:
        symbols.sort()
        from .project import TimeMap

        last = max((n.end for t in project.tracks.values() for n in t.notes), default=0.0)
        total = float(np.ceil(float(TimeMap(project.beat_times).to_beats(last)) - project.downbeat - 1e-6))
        chords = []
        for i, (b, root, q, bass) in enumerate(symbols):
            end = symbols[i + 1][0] if i + 1 < len(symbols) else float(total)
            if end > b:
                chords.append([b, end, root, q, bass])
        project.chords = chords
        project.engines["chords"] = "악보의 코드 기호"
        log(f"   - 코드 기호 {len(chords)}개를 악보에서 가져옴")
    return project


def _quality_from_figure(figure: str) -> str:
    """'F#m7/C#' -> 'm7' (앱이 아는 코드 종류로)."""
    body = re.sub(r"^[A-Ga-g][#b-]*", "", figure.split("/")[0])
    body = body.replace("min", "m").replace("-", "m") if not body.startswith("maj") else body
    for q in ("maj7", "m7", "7", "sus4", "sus2", "dim", "m"):
        if body.startswith(q):
            return q
    return ""


def import_symbolic(path: str | Path, out_dir: Path, title: str | None = None, log=print) -> Project:
    """MIDI/MusicXML 을 프로젝트로 바꿔 out_dir/project.json 에 저장."""
    path = Path(path).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {path}")
    out_dir.mkdir(parents=True, exist_ok=True)
    log(f"① 악보 파일 불러오는 중 ({path.suffix.lower()})")
    if path.suffix.lower() in MIDI_EXT:
        project = project_from_midi(path, title, log)
    else:
        project = project_from_musicxml(path, title, log)
    n_notes = sum(len(t.notes) for t in project.tracks.values())
    log(f"   - 파트 {len(project.tracks)}개, 음표 {n_notes}개, 템포 약 {project.tempo_bpm:.0f} BPM, "
        f"{project.time_signature}, 키 {project.key.name}")
    project.save(out_dir / "project.json")
    return project
