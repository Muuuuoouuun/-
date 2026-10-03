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
from .theory import Key, detect_key, transpose_target

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

    # 3) 채보
    tracks: dict[str, Track] = {}
    order = [s for s in SCORE_ORDER if s in stem_paths] + [s for s in stem_paths if s not in SCORE_ORDER]
    todo = [s for s in order if s in wanted]
    for i, name in enumerate(todo):
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
        tracks[name] = Track(name, res.notes, pedals=res.pedals, engine=res.engine)
        extra = f", 페달 {len(res.pedals)}개" if res.pedals else ""
        log(f"   - {len(res.notes)}개 음표 ({res.engine}{extra})")

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
                      engines=engines)
    if opts.downbeat is not None:
        project.downbeat = opts.downbeat
    else:
        db = rhythm.downbeat_from_model(beats, beat_info.downbeats, project.beats_per_bar)
        project.downbeat = db if db is not None else rhythm.estimate_downbeat(
            {k: t.notes for k, t in tracks.items()}, TimeMap(beats), project.beats_per_bar)
    log(f"   - 템포 약 {project.tempo_bpm:.0f} BPM, {time_sig}, 키 {key.name}")

    project.save(out_dir / "project.json")
    step(0.95, "분석 완료")
    return project


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


@dataclass
class RenderResult:
    key: Key
    semitones: int
    out_dir: Path
    files: list[Path] = field(default_factory=list)
    chord_chart: str = ""
    parts: list[dict] = field(default_factory=list)  # 악기별 요약 (앱 표시용)


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
        chord_events = [
            c.transposed(shift)
            for c in detect_chords({k: project.tracks[k].notes for k in project.tracks},
                                   grid.timemap, project.key, project.beats_per_bar,
                                   project.downbeat)
        ]
    chord_marks = sc.chord_offsets(chord_events, key, grid)

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
            parts = sc.build_pitched(spec, events, key, project, total_ql, marks or chord_marks,
                                     with_tempo=True, pedals_ql=pedals)
            full_view = sc.build_pitched(spec, events, key, project, total_ql, marks,
                                         with_tempo=not full_parts, pedals_ql=pedals,
                                         with_tab=False)
            if name == "vocals":
                lead_parts = sc.build_pitched(spec, events, key, project, total_ql,
                                              chord_marks or None, with_tempo=True,
                                              with_dynamics=False)
        full_parts.extend(full_view)
        if len(full_view) > 1:
            groups.append((full_view, "brace"))

        # 파트보 (악기별 악보)
        symbol = "bracket" if spec.tab else "brace"
        single = sc.assemble(parts, project.title, f"{spec.label} — {key.name}",
                             [(parts, symbol)] if len(parts) > 1 else None)
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
        result.files += _write(full, out_dir / "full_score", opts.pdf)
        log("   ✓ 총보 (full score)")
    if lead_parts:
        lead = sc.assemble(lead_parts, project.title, f"Lead Sheet — {key.name}")
        result.files += _write(lead, out_dir / "lead_sheet", opts.pdf)
        log("   ✓ 리드시트 (멜로디 + 코드 + 가사)")

    # MIDI (원래 연주 타이밍 그대로, 악기별 + 전체)
    result.files += write_midi(tracks, out_dir / "midi")

    # 코드표
    if chord_events:
        lyrics = project.tracks["vocals"].lyrics if "vocals" in project.tracks else []
        chart = chord_chart(chord_events, key, grid, project, lyrics)
        path = out_dir / "chords.txt"
        path.write_text(chart, encoding="utf-8")
        result.chord_chart = chart
        result.files.append(path)
        log("   ✓ 코드표 (chords.txt)")
    return result


def _write(score, base: Path, pdf: bool) -> list[Path]:
    xml = base.with_suffix(".musicxml")
    score.write("musicxml", fp=str(xml))
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
    exe = find_musescore()
    if not exe:
        return None
    pdf = xml.with_suffix(".pdf")
    try:
        subprocess.run([exe, "-o", str(pdf), str(xml)], check=True, capture_output=True, timeout=300)
    except (subprocess.SubprocessError, OSError):
        return None
    return pdf if pdf.exists() else None


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


def chord_chart(chords_: list[ChordEvent], key: Key, grid, project: Project, lyrics=(),
                bars_per_line: int = 4) -> str:
    """마디별 코드 + (있으면) 가사를 나란히 적은 텍스트 코드표."""
    bpb = grid.beats_per_bar
    shift = grid.shift_beats  # 악보의 마디 번호와 맞춘다
    n_bars = int(np.ceil((max(c.end for c in chords_) + shift) / bpb)) if chords_ else 0
    bars: list[list[str]] = [[] for _ in range(n_bars)]
    for c in chords_:
        b = int((c.start + shift) // bpb)
        if 0 <= b < n_bars:
            bars[b].append(c.name(key))
    bar_words: list[list[str]] = [[] for _ in range(n_bars)]
    for w in lyrics:
        b = int(grid.beat(w.start) // bpb)
        if 0 <= b < n_bars:
            bar_words[b].append(w.text)

    from .notation import capo_suggestion

    lines = [
        f"{project.title}",
        f"Key: {key.short_name}   Tempo: {project.tempo_bpm:.0f} BPM   Time: {project.time_signature}",
    ]
    capo = capo_suggestion(key.tonic, key.mode)
    if capo:
        lines.append(f"Guitar: Capo {capo[0]} ({capo[1]} 코드 모양으로 연주)")
    lines.append("")
    for start in range(0, n_bars, bars_per_line):
        cells_c, cells_l = [], []
        for b in range(start, min(start + bars_per_line, n_bars)):
            ctext = "  ".join(bars[b]) if bars[b] else "-"
            ltext = " ".join(bar_words[b])
            w = max(_width(ctext), _width(ltext), 6) + 2
            cells_c.append(_pad(" " + ctext, w))
            cells_l.append(_pad(" " + ltext, w))
        lines.append(f"{start + 1:>3} |" + "|".join(cells_c) + "|")
        if any(s.strip() for s in cells_l):
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
