"""이미 있는 MusicXML 악보(예: MuseScore 에서 손본 악보) 조옮김."""

from __future__ import annotations

from pathlib import Path

from .theory import Key, transpose_target


def transpose_file(src: Path, out: Path | None = None, semitones: int | None = None,
                   target_key: str | None = None, direction: str = "nearest") -> Path:
    from music21 import converter, interval, key as m21key

    score = converter.parse(str(src))
    found = score.recurse().getElementsByClass(m21key.KeySignature).first()
    if found is None:
        analyzed = score.analyze("key")
        fifths, mode = analyzed.sharps, analyzed.mode
    else:
        fifths = found.sharps
        mode = getattr(found, "mode", None) or "major"
        if mode not in ("major", "minor"):
            mode = "major"
    rel_major = (fifths * 7) % 12  # 조표 하나 = 완전5도(7반음)
    tonic = rel_major if mode == "major" else (rel_major - 3) % 12
    src_key = Key(tonic, mode, fifths)
    shift, dst_key = transpose_target(src_key, target_key, semitones, direction)
    if shift == 0:
        raise ValueError("조옮김할 반음 수가 0 입니다. --key 또는 --semitones 를 지정하세요.")

    # 같은 반음 수라도 음정 이름(예: 증4도/감5도)에 따라 철자가 달라지므로,
    # 으뜸음이 목표 키의 철자와 일치하는 음정을 고른다
    names = _interval_names(shift)
    iv = interval.Interval(names[0])
    for name in names:
        cand = interval.Interval(name)
        if cand.transposePitch(_pitch_of(src_key)).name.replace("-", "b") == dst_key.tonic_name:
            iv = cand
            break
    out_score = score.transpose(iv)
    for ks in out_score.recurse().getElementsByClass(m21key.KeySignature):
        ks.sharps = dst_key.fifths
    md = out_score.metadata
    if md is not None and md.movementName and src_key.name in md.movementName:
        md.movementName = md.movementName.replace(src_key.name, dst_key.name)

    out_dir = out or src.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / f"{src.stem}_{dst_key.short_name.replace('#', 's')}.musicxml"
    out_score.write("musicxml", fp=str(dst))
    return dst


def _pitch_of(key: Key):
    from music21 import pitch

    return pitch.Pitch(key.tonic_name.replace("b", "-"))


def _interval_names(shift: int) -> list[str]:
    """반음 수에 해당하는 음정 이름 후보들."""
    table = {
        0: ["P1"], 1: ["m2", "A1"], 2: ["M2", "d3"], 3: ["m3", "A2"], 4: ["M3", "d4"],
        5: ["P4", "A3"], 6: ["A4", "d5"], 7: ["P5", "d6"], 8: ["m6", "A5"], 9: ["M6", "d7"],
        10: ["m7", "A6"], 11: ["M7", "d8"],
    }
    names = table[abs(shift) % 12]
    octaves = abs(shift) // 12
    out = []
    for n in names:
        if octaves:
            # 옥타브 이상은 단순 음정 + 옥타브 수 (music21 은 'P8', 'M9' 같은 복합 음정 지원)
            num = int(n[1:]) + 7 * octaves
            n = n[0] + str(num)
        out.append(n if shift > 0 else "-" + n)
    return out
