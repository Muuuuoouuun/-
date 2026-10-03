"""전체 흐름: 입력 -> 음원 분리 -> 채보 -> 분석(project.json) -> 악보 렌더링(조옮김 포함)."""

from __future__ import annotations

import shutil
import subprocess
import unicodedata
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from . import audio_io, rhythm
from .chords import ChordEvent, detect_chords
from .instruments import DRUM_NAMES, INSTRUMENTS, SCORE_ORDER, spec_for
from .project import Note, Project, TimeMap, Track
from .theory import Key, KeyMap, detect_key, key_segments, transpose_target

Log = Callable[[str], None]


def _print(msg: str) -> None:
    print(msg, flush=True)


Progress = Callable[[float, str], None]


@dataclass
class AnalyzeOptions:
    model: str | None = None  # Demucs 모델 직접 지정 (None = 품질 프리셋에 따름)
    quality: str = "standard"  # fast | standard | high
    split_vocals: bool = True  # 메인 보컬 / 코러스 분리 (audio-separator)
    split_drums: bool = True  # 드럼 조각 분리 (audio-separator DrumSep)
    stems: list[str] | None = None  # None = 전부
    stems_dir: Path | None = None  # 이미 분리된 스템 폴더 (분리 단계 생략)
    device: str | None = None
    bpm: float | None = None
    time_signature: str = "auto"  # auto | 4/4 | 3/4 | 6/8 ...
    downbeat: int | None = None  # None = 자동
    beat_engine: str = "auto"  # auto | beat_this | librosa
    lyrics: bool = False
    language: str | None = "ko"
    whisper_model: str = "small"
    vocal_engine: str | None = None  # crepe | pyin | basic_pitch
    start: float | None = None
    duration: float | None = None
    min_stem_db: float = -24.0  # 믹스 대비 이보다 작은 스템은 비어 있다고 보고 건너뜀
    cleanup: bool = True  # 블리딩·유령음 정리, 악기 활동 구간 분석


def analyze(source: str, out_dir: Path, opts: AnalyzeOptions | None = None,
            log: Log = _print, progress: Progress | None = None) -> Project:
    """무거운 단계 전부 실행 후 project.json 저장."""
    from .separate import QUALITY, Stems, load_stems_dir, separate, separate_detailed, stem_level_db
    from .transcribe import transcribe_stem

    opts = opts or AnalyzeOptions()
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "work"
    stems_out = out_dir / "stems"

    def step(frac: float, msg: str) -> None:
        log(msg)
        if progress:
            progress(frac, msg)

    engines: dict[str, str] = {}
    # 1) 입력
    if opts.stems_dir:
        step(0.02, "① 스템 폴더 불러오는 중")
        sep = load_stems_dir(Path(opts.stems_dir), work)
        title = Path(source).stem if source else Path(opts.stems_dir).name
        mix_path = _mixdown(sep.stems, work / "mix.wav")
    else:
        step(0.02, "① 오디오 준비 중 (영상/음원 변환)")
        mix_path, title = audio_io.prepare_input(source, work, opts.start, opts.duration)
        # 2) 분리
        step(0.08, "② 악기별 분리 중 — 곡 길이와 장비에 따라 수 분 걸립니다")
        if opts.model:
            sep = Stems(stems=separate(mix_path, stems_out, opts.model, opts.device),
                        notes=[f"악기: Demucs {opts.model}"])
        else:
            sep = separate_detailed(mix_path, stems_out, opts.quality if opts.quality in QUALITY
                                    else "standard", opts.split_vocals, opts.split_drums,
                                    opts.device, log)
    engines["separation"] = ", ".join(sep.notes)
    stem_paths = sep.stems

    wanted = opts.stems or list(stem_paths)
    if "vocals" in wanted and "backing_vocals" in stem_paths and opts.stems:
        wanted = wanted + ["backing_vocals"]
    mix_audio, _ = sf.read(str(mix_path), always_2d=True)

    # 분리 결과 분석: 악기별 활동 구간, 블리딩 정도
    analyzer = None
    separation: dict[str, dict] = {}
    if opts.cleanup and len(stem_paths) >= 2:
        from .cleanup import SeparationAnalyzer

        step(0.42, "   · 분리 결과 점검 (악기 활동 구간, 블리딩)")
        analyzer = SeparationAnalyzer(dict(stem_paths))
        for name in stem_paths:
            separation[name] = analyzer.analyze(name).report()
            r = separation[name]
            bleed = f", 블리딩 {r['bleed_db']:.0f} dB" if r["bleed_db"] is not None else ""
            log(f"   - {name}: 연주 구간 {r['active_ratio'] * 100:.0f}%{bleed}")

    # 3) 채보
    tracks: dict[str, Track] = {}
    order = [s for s in SCORE_ORDER if s in stem_paths] + [s for s in stem_paths if s not in SCORE_ORDER]
    todo = [s for s in order if s in wanted]
    for i, name in enumerate(todo):
        if analyzer is not None and not opts.stems:
            if separation[name]["active_ratio"] < 0.02:
                log(f"   - {name}: 연주하는 구간이 없어 건너뜀")
                continue
        else:
            audio, _ = sf.read(str(stem_paths[name]), always_2d=True)
            n = min(len(audio), len(mix_audio))
            level = stem_level_db(audio[:n], mix_audio[:n]) if n else -99.0
            if level < opts.min_stem_db and not opts.stems:
                log(f"   - {name}: 소리가 거의 없어 건너뜀 ({level:.1f} dB)")
                continue
        spec = spec_for(name)
        engine = opts.vocal_engine if name == "vocals" and opts.vocal_engine else None
        step(0.45 + 0.35 * i / max(len(todo), 1), f"③ 채보 중: {spec.label_ko}")
        res = transcribe_stem(stem_paths[name], spec, engine,
                              drum_parts=sep.drum_parts if name == "drums" else None,
                              device=opts.device, log=log)
        notes = res.notes
        extra = f", 페달 {len(res.pedals)}개" if res.pedals else ""
        if analyzer is not None and notes:
            notes, removed = clean_notes(analyzer, name, notes, res.engine)
            if removed:
                extra += f", 블리딩·유령음 {removed}개 정리"
                separation[name]["removed_notes"] = removed
        tracks[name] = Track(name, notes, pedals=res.pedals, engine=res.engine)
        log(f"   - {len(notes)}개 음표 ({res.engine}{extra})")

    # 4) 가사
    if opts.lyrics and "vocals" in tracks:
        from .lyrics import transcribe_lyrics

        step(0.82, "④ 가사 인식 중 (Whisper)")
        try:
            tracks["vocals"].lyrics = transcribe_lyrics(stem_paths["vocals"], opts.language,
                                                        opts.whisper_model)
            engines["lyrics"] = "whisper"
            log(f"   - {len(tracks['vocals'].lyrics)}개 단어")
        except Exception as e:  # 모델 다운로드 실패 등은 가사만 건너뛴다
            log(f"   ! 가사 인식 생략: {e}")

    # 5) 템포/키/마디
    step(0.9, "⑤ 템포·박자·키 분석 중")
    from .engines import available

    use_model = opts.beat_engine != "librosa" and not opts.bpm and available("beat_this")
    # 딥러닝 비트 추적은 전체 믹스로, librosa 는 드럼 트랙이 있으면 드럼으로 (더 정확)
    beat_src = mix_path if use_model or "drums" not in tracks else Path(stem_paths["drums"])
    beat_info = rhythm.track_beats(beat_src, opts.bpm, opts.beat_engine, opts.device, log)
    engines["beats"] = beat_info.engine
    beats = beat_info.beats
    time_sig = opts.time_signature
    if not time_sig or time_sig == "auto":
        time_sig = rhythm.guess_meter(beats, beat_info.downbeats) or "4/4"
    key = estimate_key(tracks)
    project = Project(title=title, source=source, beat_times=beats, key=key,
                      time_signature=time_sig, tracks=tracks,
                      stems_dir=str(Path(next(iter(stem_paths.values()))).parent),
                      stems={k: str(v) for k, v in stem_paths.items()},
                      drum_parts={k: str(v) for k, v in sep.drum_parts.items()},
                      separation=separation,
                      engines=engines)
    if opts.downbeat is not None:
        project.downbeat = opts.downbeat
    else:
        db = rhythm.downbeat_from_model(beats, beat_info.downbeats, project.beats_per_bar)
        project.downbeat = db if db is not None else rhythm.estimate_downbeat(
            {k: t.notes for k, t in tracks.items()}, TimeMap(beats), project.beats_per_bar)
    # 전조: 마디별 음높이 분포로 구간별 키를 찾는다
    segs = key_segments(bar_pitch_hists(tracks, TimeMap(beats), project.downbeat,
                                        project.beats_per_bar))
    if len(segs) > 1:  # 전조가 있을 때만 구간별 키를 쓴다 (없으면 곡 전체 추정이 더 안정적)
        project.key = segs[0][1]
        project.key_changes = [(float(bar * project.beats_per_bar), k) for bar, k in segs[1:]]
    key = project.key
    mods = "".join(f" → {k.short_name}({int(b // project.beats_per_bar) + 1}마디)"
                   for b, k in project.key_changes)
    log(f"   - 템포 약 {project.tempo_bpm:.0f} BPM, {time_sig}, 키 {key.name}{mods}")

    project.save(out_dir / "project.json")
    step(0.95, "분석 완료")
    return project


def project_chords(project: Project) -> list[ChordEvent]:
    """코드 진행 (원래 키 기준): 사용자가 고친 코드가 있으면 그것, 없으면 자동 인식."""
    if project.chords is not None:
        return [ChordEvent(float(a), float(b), None if r is None else int(r), q or "",
                           None if bs is None else int(bs)) for a, b, r, q, bs in project.chords]
    return detect_chords({k: t.notes for k, t in project.tracks.items()}, TimeMap(project.beat_times),
                         project.key, project.beats_per_bar, project.downbeat,
                         key_at=project.key_at_beat)


def clean_notes(analyzer, name: str, notes: list[Note], engine: str) -> tuple[list[Note], int]:
    """채보 결과에서 블리딩(다른 악기 소리)과 옥타브 유령음을 지운다."""
    from .cleanup import remove_ghosts

    before = len(notes)
    if engine in ("drums", "drum_parts"):
        notes, _ = analyzer.filter_hits(name, notes)
    else:
        notes, _ = analyzer.verify_notes(name, notes)
        if engine in ("basic_pitch", "piano_hr"):
            notes, _ = remove_ghosts(analyzer, name, notes)
    return notes, before - len(notes)


def _mixdown(stems: dict[str, Path], dst: Path) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    mix = None
    sr0 = None
    for path in stems.values():
        audio, sr = sf.read(str(path), always_2d=True)
        if audio.shape[1] == 1:
            audio = np.repeat(audio, 2, axis=1)
        audio = audio[:, :2]
        if sr0 is None:
            sr0 = sr
        elif sr != sr0:
            raise RuntimeError("스템 파일들의 샘플레이트가 서로 다릅니다.")
        if mix is None:
            mix = audio.copy()
        else:
            n = max(len(mix), len(audio))
            mix = np.pad(mix, ((0, n - len(mix)), (0, 0)))
            mix[: len(audio)] += audio
    assert mix is not None and sr0 is not None
    peak = np.abs(mix).max()
    if peak > 1:
        mix /= peak
    sf.write(str(dst), mix, sr0)
    return dst


def bar_pitch_hists(tracks: dict[str, Track], timemap: TimeMap, downbeat: int,
                    beats_per_bar: int) -> np.ndarray:
    """마디별 음높이 분포 (마디 수 x 12), 길이·세기 가중."""
    weights = {"bass": 1.5, "piano": 1.0, "guitar": 1.0, "other": 0.8, "vocals": 1.0,
               "backing_vocals": 0.5}
    rows: dict[int, np.ndarray] = {}
    for name, t in tracks.items():
        w = weights.get(name)
        if not w:
            continue
        for n in t.notes:
            b = int((float(timemap.to_beats(n.start)) - downbeat) // beats_per_bar)
            if b >= 0:
                rows.setdefault(b, np.zeros(12))[n.pitch % 12] += n.duration * n.velocity / 127 * w
    if not rows:
        return np.zeros((0, 12))
    out = np.zeros((max(rows) + 1, 12))
    for b, h in rows.items():
        out[b] = h
    return out


def estimate_key(tracks: dict[str, Track]) -> Key:
    weights = {"bass": 1.5, "piano": 1.0, "guitar": 1.0, "other": 0.8, "vocals": 1.0,
               "backing_vocals": 0.5}
    pairs = [
        (n.pitch, n.duration * (n.velocity / 127.0) * w)
        for name, t in tracks.items() if (w := weights.get(name))
        for n in t.notes
    ]
    key, _ = detect_key(pairs)
    return key


# ---------------------------------------------------------------------------
# 렌더링
# ---------------------------------------------------------------------------

@dataclass
class RenderOptions:
    semitones: int | None = None
    target_key: str | None = None
    direction: str = "nearest"  # nearest | up | down
    subdiv: int | None = None  # 한 박 분할 (4 = 16분음표)
    stems: list[str] | None = None
    pdf: bool = False
    chords: bool = True
    sections: bool = True  # 곡 구조 인식 + 리허설 마크
    pickup: bool = True  # 못갖춘마디 자동 처리


@dataclass
class RenderResult:
    key: Key
    semitones: int
    out_dir: Path
    files: list[Path] = field(default_factory=list)
    chord_chart: str = ""
    parts: list[dict] = field(default_factory=list)  # 악기별 요약 (앱 표시용)
    key_changes: list[dict] = field(default_factory=list)  # 전조 [{bar, key}]
    sections: list[dict] = field(default_factory=list)  # 곡 구조
    nashville_chart: str = ""
    pickup_ql: float = 0.0  # 못갖춘마디 길이를 뺀 앞부분 (0 이면 없음)


def transpose_notes(notes: list[Note], semitones: int) -> list[Note]:
    return [Note(n.start, n.end, n.pitch + semitones, n.velocity) for n in notes]


def render(project: Project, out_root: Path, opts: RenderOptions | None = None,
           log: Log = _print) -> RenderResult:
    """project 에서 악보/MIDI/코드표를 만든다. 조옮김은 여기서 적용."""
    from music21 import stream

    from . import score as sc
    from .lyrics import align_lyrics

    opts = opts or RenderOptions()
    shift, key = transpose_target(project.key, opts.target_key, opts.semitones, opts.direction)
    out_dir = out_root / f"sheets_{key.short_name.replace('#', 's')}"
    out_dir.mkdir(parents=True, exist_ok=True)
    result = RenderResult(key, shift, out_dir)
    if shift:
        log(f"조옮김: {project.key.name} -> {key.name} ({shift:+d} 반음)")

    grid = sc.Grid.for_project(project, opts.subdiv)
    # 전조 지점 (악보 위치) -> 조옮김한 키
    key_map = KeyMap([(0.0, key)] + [((b + grid.shift_beats) * grid.beat_ql, k.transposed(shift))
                                     for b, k in project.key_changes])
    result.key_changes = [{"bar": int(off // grid.bar_ql) + 1, "key": k.name, "key_short": k.short_name}
                          for off, k in key_map.changes()]
    names = [n for n in SCORE_ORDER if n in project.tracks] + \
            [n for n in project.tracks if n not in SCORE_ORDER]
    if opts.stems:
        names = [n for n in names if n in opts.stems]

    tracks = {
        name: (project.tracks[name].notes if name == "drums"
               else transpose_notes(project.tracks[name].notes, shift))
        for name in names
    }

    # 코드 진행 (원래 키에서 인식 후 조옮김 — 결과는 같고 철자만 새 키 기준)
    chord_events: list[ChordEvent] = []
    if opts.chords:
        chord_events = [c.transposed(shift) for c in project_chords(project)]
    chord_marks = sc.chord_offsets(chord_events, key_map, grid)

    # 1차: 트랙별 악보 이벤트 계산
    events_by: dict[str, list[sc.Event]] = {}
    for name in names:
        notes = tracks[name]
        if not notes:
            continue
        spec = spec_for(name)
        if name == "drums":
            events = sc.drum_events(notes, grid)
        else:
            events = sc.mono_events(notes, grid) if spec.mono else sc.poly_events(notes, grid)
        if name == "vocals" and project.tracks[name].lyrics:
            lyric_map = align_lyrics(notes, project.tracks[name].lyrics)
            for e in events:
                syl = [lyric_map[i] for i in e.sources if i in lyric_map]
                if syl:
                    e.lyric = "".join(syl)
        if events:
            events_by[name] = events

    # 모든 파트를 같은 마디 수로 맞춘다
    ends = [e.offset + e.dur for evs in events_by.values() for e in evs]
    if chord_events:
        ends.append((chord_events[-1].end + grid.shift_beats) * grid.beat_ql)
    total_ql = max(ends, default=grid.bar_ql)
    total_ql = float(max(grid.bar_ql, np.ceil(total_ql / grid.bar_ql - 1e-6) * grid.bar_ql))

    # 곡 구조: 악보 마디 번호(1부터) -> 구간 이름
    sections = []
    if opts.sections:
        from .sections import detect_sections

        n_bars = int(round(total_ql / grid.bar_ql)) - grid.shift_beats // grid.beats_per_bar
        sections = detect_sections(project, chord_events, max(n_bars, 1))
    bar_offset = grid.shift_beats // grid.beats_per_bar

    # 못갖춘마디: 첫 마디 앞쪽이 비어 있으면(첫 음이 마디 중간) 짧은 0번 마디로 만든다
    starts = [e.offset for evs in events_by.values() for e in evs]
    first_on = min(starts, default=0.0)
    pickup_ql = first_on if (opts.pickup and 0 < first_on < grid.bar_ql and
                             (first_on / grid.beat_ql) >= 1 - 1e-6) else 0.0
    number_shift = -1 if pickup_ql else 0  # 못갖춘마디가 있으면 마디 번호가 하나씩 당겨짐
    result.pickup_ql = pickup_ql

    rehearsal = [(s.start_bar + bar_offset + 1 + number_shift, s.name)
                 for s in sections] if len(sections) > 1 else []

    def finish_score(score) -> None:
        """못갖춘마디 적용 + 구간 표시 (못갖춘마디를 못 만들면 마디 번호를 원래대로)."""
        marks = rehearsal
        if pickup_ql and not sc.make_pickup(score, pickup_ql):
            marks = [(n - number_shift, name) for n, name in rehearsal]
        sc.add_section_marks(score, marks)
    result.sections = [dict(s.to_dict(), start_measure=s.start_bar + bar_offset + 1 + number_shift,
                            end_measure=s.end_bar + bar_offset + number_shift) for s in sections]

    # 2차: music21 파트 생성
    full_parts: list[stream.Part] = []
    groups: list[tuple[list[stream.Part], str]] = []
    lead_parts: list[stream.Part] = []
    chords_on = None  # 첫 선율/화성 악기 파트 위에 코드 표시
    for name, events in events_by.items():
        spec = spec_for(name)
        track = project.tracks[name]
        if name == "drums":
            parts = [sc.build_drums(events, project, total_ql, with_tempo=True)]
            full_view = [sc.build_drums(events, project, total_ql, with_tempo=not full_parts)]
        else:
            marks = None
            if chord_marks and chords_on is None and name != "backing_vocals":
                marks, chords_on = chord_marks, name
            pedals = [(grid.ql(a), grid.ql(b)) for a, b in track.pedals]
            # 파트보: TAB 포함 / 총보: 오선보만 (총보를 간결하게)
            parts = sc.build_pitched(spec, events, key_map, project, total_ql, marks or chord_marks,
                                     with_tempo=True, pedals_ql=pedals)
            full_view = sc.build_pitched(spec, events, key_map, project, total_ql, marks,
                                         with_tempo=not full_parts, pedals_ql=pedals,
                                         with_tab=False)
            if name == "vocals":
                lead_parts = sc.build_pitched(spec, events, key_map, project, total_ql,
                                              chord_marks or None, with_tempo=True,
                                              with_dynamics=False)
        full_parts.extend(full_view)
        if len(full_view) > 1:
            groups.append((full_view, "brace"))

        # 파트보 (악기별 악보)
        symbol = "bracket" if spec.tab else "brace"
        single = sc.assemble(parts, project.title, f"{spec.label} — {key.name}",
                             [(parts, symbol)] if len(parts) > 1 else None)
        finish_score(single)
        files = _write(single, out_dir / f"{name}", opts.pdf)
        result.files += files
        pitches = [p for e in events for p in e.pitches]
        result.parts.append({
            "name": name, "label": spec.label, "label_ko": spec.label_ko,
            "file": files[0].name, "engine": track.engine, "events": len(events),
            "notes": len(track.notes), "tab": bool(spec.tab), "pedals": len(track.pedals),
            "range": [min(pitches), max(pitches)] if pitches and name != "drums" else None,
            "pieces": sorted({DRUM_NAMES.get(p, str(p)) for p in pitches}) if name == "drums" else None,
        })
        log(f"   ✓ {spec.label_ko} 악보" + (" (+TAB)" if spec.tab else ""))

    if full_parts:
        full = sc.assemble(full_parts, project.title, f"Full Score — {key.name}", groups)
        finish_score(full)
        result.files += _write(full, out_dir / "full_score", opts.pdf)
        log("   ✓ 총보 (full score)")
    if lead_parts:
        lead = sc.assemble(lead_parts, project.title, f"Lead Sheet — {key.name}")
        finish_score(lead)
        result.files += _write(lead, out_dir / "lead_sheet", opts.pdf)
        log("   ✓ 리드시트 (멜로디 + 코드 + 가사)")

    # MIDI (원래 연주 타이밍 그대로, 악기별 + 전체)
    result.files += write_midi(tracks, out_dir / "midi")

    # 코드표
    if chord_events:
        lyrics = project.tracks["vocals"].lyrics if "vocals" in project.tracks else []
        chart = chord_chart(chord_events, key_map, grid, project, lyrics, sections=sections,
                            number_shift=number_shift)
        numbers = chord_chart(chord_events, key_map, grid, project, lyrics, sections=sections,
                              numbers=True, number_shift=number_shift)
        for fname, text in (("chords.txt", chart), ("chords_nashville.txt", numbers)):
            path = out_dir / fname
            path.write_text(text, encoding="utf-8")
            result.files.append(path)
        result.chord_chart, result.nashville_chart = chart, numbers
        log("   ✓ 코드표 (chords.txt, 내슈빌 넘버 chords_nashville.txt)")
    return result


def _write(score, base: Path, pdf: bool) -> list[Path]:
    xml = base.with_suffix(".musicxml")
    score.write("musicxml", fp=str(xml))
    from .notation import add_tab_details

    add_tab_details(xml)
    files = [xml]
    if pdf:
        out = export_pdf(xml)
        if out:
            files.append(out)
    return files


MUSESCORE_CANDIDATES = [
    "mscore", "mscore4", "musescore", "musescore4", "mscore3", "MuseScore4", "MuseScore3",
    "/Applications/MuseScore 4.app/Contents/MacOS/mscore",
    r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe",
]


def find_musescore() -> str | None:
    for c in MUSESCORE_CANDIDATES:
        exe = shutil.which(c) or (c if Path(c).exists() else None)
        if exe:
            return exe
    return None


def export_pdf(xml: Path) -> Path | None:
    """PDF 악보: MuseScore 가 있으면 MuseScore 로(가장 깔끔), 없으면 Verovio 로 그린다."""
    pdf = xml.with_suffix(".pdf")
    exe = find_musescore()
    if exe:
        try:
            subprocess.run([exe, "-o", str(pdf), str(xml)], check=True, capture_output=True, timeout=300)
            if pdf.exists():
                return pdf
        except (subprocess.SubprocessError, OSError):
            pass
    return export_pdf_verovio(xml, pdf)


def export_pdf_verovio(xml: Path, pdf: Path) -> Path | None:
    """Verovio(악보 조판) -> SVG -> PDF. 필요: pip install verovio cairosvg pypdf"""
    try:
        import io

        import cairosvg
        import verovio
        from pypdf import PdfReader, PdfWriter
    except ImportError:
        return None
    try:
        tk = verovio.toolkit()
        # A4 세로, 보기 좋은 크기
        tk.setOptions({"pageWidth": 2100, "pageHeight": 2970, "pageMarginLeft": 80,
                       "pageMarginRight": 80, "pageMarginTop": 60, "pageMarginBottom": 60,
                       "scale": 42, "footer": "none", "breaks": "auto"})
        if not tk.loadFile(str(xml)):
            return None
        writer = PdfWriter()
        for page in range(1, tk.getPageCount() + 1):
            data = cairosvg.svg2pdf(bytestring=tk.renderToSVG(page).encode("utf-8"))
            for p in PdfReader(io.BytesIO(data)).pages:
                writer.add_page(p)
        with open(pdf, "wb") as f:
            writer.write(f)
        return pdf
    except Exception:
        return None


def write_midi(tracks: dict[str, list[Note]], out_dir: Path) -> list[Path]:
    import pretty_midi

    out_dir.mkdir(parents=True, exist_ok=True)
    files = []
    full = pretty_midi.PrettyMIDI()
    for name, notes in tracks.items():
        if not notes:
            continue
        spec = spec_for(name)
        is_drum = name == "drums"
        inst = pretty_midi.Instrument(program=spec.program, is_drum=is_drum, name=spec.label)
        for n in notes:
            if 0 <= n.pitch <= 127 and n.end > n.start:
                inst.notes.append(pretty_midi.Note(n.velocity, n.pitch, n.start, n.end))
        single = pretty_midi.PrettyMIDI()
        single.instruments.append(inst)
        path = out_dir / f"{name}.mid"
        single.write(str(path))
        files.append(path)
        full.instruments.append(inst)
    if full.instruments:
        path = out_dir / "all.mid"
        full.write(str(path))
        files.append(path)
    return files


# ---------------------------------------------------------------------------
# 코드표 (텍스트)
# ---------------------------------------------------------------------------

def _width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def _pad(text: str, width: int) -> str:
    return text + " " * max(0, width - _width(text))


def chord_chart(chords_: list[ChordEvent], key: Key | KeyMap, grid, project: Project, lyrics=(),
                bars_per_line: int = 4, sections=None, numbers: bool = False,
                number_shift: int = 0) -> str:
    """구간(섹션)별·마디별 코드 + (있으면) 가사를 적은 텍스트 코드표.

    numbers=True 면 내슈빌 넘버(1, 4, 5, 6m …)로 적는다. 전조된 곳에는 새 키를 표시한다.
    """
    from .notation import capo_suggestion

    km = key if isinstance(key, KeyMap) else KeyMap([(0.0, key)])
    bpb = grid.beats_per_bar
    shift = grid.shift_beats  # 악보의 마디 번호와 맞춘다
    n_bars = int(np.ceil((max(c.end for c in chords_) + shift) / bpb)) if chords_ else 0

    def label(c: ChordEvent, bar: int) -> str:
        k = km.at(bar * grid.bar_ql)
        return c.number(k) if numbers else c.name(k)

    bars: list[list[str]] = [[] for _ in range(n_bars)]
    for c in chords_:
        b = int((c.start + shift) // bpb)
        if 0 <= b < n_bars:
            bars[b].append(label(c, b))
        # 여러 마디 이어지는 코드는 각 마디 첫머리에 다시 적는다 (읽기 쉽게)
        for b2 in range(b + 1, int(np.ceil((c.end + shift) / bpb - 1e-6))):
            if 0 <= b2 < n_bars and not bars[b2]:
                bars[b2].append(label(c, b2))
    bar_words: list[list[str]] = [[] for _ in range(n_bars)]
    for w in lyrics:
        b = int(grid.beat(w.start) // bpb)
        if 0 <= b < n_bars:
            bar_words[b].append(w.text)
    # 앱에서 직접 입력한 마디 가사가 있으면 그것을 쓴다
    for k, text in project.bar_lyrics.items():
        b = int(k) + shift // bpb
        if 0 <= b < n_bars:
            bar_words[b] = [text] if text else []

    first = km.first
    head = f"Key: {first.short_name}   Tempo: {project.tempo_bpm:.0f} BPM   Time: {project.time_signature}"
    if numbers:
        head += "   (내슈빌 넘버: 1 = 으뜸음)"
    lines = [f"{project.title}", head]
    capo = capo_suggestion(first.tonic, first.mode)
    if capo and not numbers:
        lines.append(f"Guitar: Capo {capo[0]} ({capo[1]} 코드 모양으로 연주)")
    # 구간: 악보 마디 번호 기준으로 바꿔 둔다
    secs = [(s.start_bar + shift // bpb, s.end_bar + shift // bpb, s) for s in (sections or [])]
    if secs:
        lines.append("구조: " + " - ".join(s.name for _, _, s in secs))
    else:
        secs = [(0, n_bars, None)]
    lines.append("")
    changes = {int(off // grid.bar_ql): k for off, k in km.changes()}
    for s0, s1, sec in secs:
        s1 = min(s1, n_bars)
        if s0 >= s1:
            continue
        if sec is not None:
            title = f"[{sec.name}]"
            mods = [k for b, k in changes.items() if s0 <= b < s1]
            if mods:
                title += f"  ▶ Key: {mods[0].short_name}"
            lines.append(title)
        for start in range(s0, s1, bars_per_line):
            cells_c, cells_l = [], []
            for b in range(start, min(start + bars_per_line, s1)):
                ctext = "  ".join(bars[b]) if bars[b] else "-"
                ltext = " ".join(bar_words[b])
                w = max(_width(ctext), _width(ltext), 6) + 2
                cells_c.append(_pad(" " + ctext, w))
                cells_l.append(_pad(" " + ltext, w))
            lines.append(f"{start + 1 + number_shift:>3} |" + "|".join(cells_c) + "|")
            if any(x.strip() for x in cells_l):
                lines.append("    " + " " + " ".join(cells_l))
        lines.append("")
    return "\n".join(lines)


def run(source: str, out_dir: Path, analyze_opts: AnalyzeOptions | None = None,
        render_opts: RenderOptions | None = None, log: Log = _print) -> RenderResult:
    """분석 후 원래 키 악보를 만들고, 조옮김을 요청했으면 바뀐 키 악보도 추가로 만든다."""
    project = analyze(source, out_dir, analyze_opts, log)
    render_opts = render_opts or RenderOptions()
    log("⑥ 악보 만드는 중...")
    original = render(project, out_dir, replace(render_opts, semitones=None, target_key=None), log)
    if render_opts.semitones or render_opts.target_key:
        return render(project, out_dir, render_opts, log)
    return original


__all__ = [
    "AnalyzeOptions", "RenderOptions", "RenderResult", "analyze", "render", "run", "INSTRUMENTS",
]
