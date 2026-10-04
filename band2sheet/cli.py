"""명령줄 인터페이스.

  band2sheet fetch "https://youtu.be/..."                   # 유튜브 -> 음성(wav) (--video: 영상도)
  band2sheet run "https://youtu.be/..." -o out/song         # 유튜브 -> 악보
  band2sheet run live.mp4 --key A --lyrics                  # 파일 -> 악보 + A키로 조옮김 + 가사
  band2sheet transpose out/song/project.json --key Bb       # 분석 결과로 빠르게 조옮김
  band2sheet transpose score.musicxml -s -2                 # 기존 MusicXML 조옮김
  band2sheet remix 내노래.mp4 --autotune                    # 내 영상 후보정 (화음 + 오토튠)
  band2sheet app                                            # 악보 스튜디오 앱 실행
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__


def _stems(text: str | None) -> list[str] | None:
    if not text:
        return None
    return [s.strip() for s in text.split(",") if s.strip()]


def _add_render_args(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group("조옮김 / 악보 옵션")
    g.add_argument("-k", "--key", dest="target_key", help="이 키로 조옮김 (예: G, Bb, F#m)")
    g.add_argument("-s", "--semitones", type=int, help="반음 단위 조옮김 (예: +2, -3)")
    g.add_argument("--direction", choices=["nearest", "up", "down"], default="nearest",
                   help="--key 사용 시 올릴지/내릴지 (기본: 가까운 쪽)")
    g.add_argument("--grid", type=int, default=None,
                   help="한 박을 몇 칸으로 맞출지 (4=16분음표, 2=8분음표; 기본 4, 겹박자 6)")
    g.add_argument("--no-chords", action="store_true", help="코드 인식/표기 끄기")
    g.add_argument("--pdf", action="store_true", help="MuseScore 가 설치돼 있으면 PDF 도 만들기")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="band2sheet",
        description="유튜브/음원 -> 악기별 분리 -> 자동 채보 -> 악보(MusicXML/MIDI/코드표) + 조옮김",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    r = sub.add_parser("run", help="유튜브 링크나 오디오/영상 파일로 악보 만들기")
    r.add_argument("source", nargs="?", default="",
                   help="유튜브 URL 또는 오디오/영상 파일 (--stems-dir 사용 시 생략 가능)")
    r.add_argument("-o", "--out", type=Path, default=None, help="결과 폴더 (기본: output/<제목>)")
    r.add_argument("-q", "--quality", choices=["fast", "standard", "high"], default="standard",
                   help="분리 품질: fast(4스템) | standard(6스템, 기본) | high(BS-RoFormer 보컬 + 6스템)")
    r.add_argument("--model", help="Demucs 모델 직접 지정 (htdemucs_6s | htdemucs | htdemucs_ft)")
    r.add_argument("--no-split-vocals", action="store_true",
                   help="메인 보컬/코러스 분리 끄기 (audio-separator 필요)")
    r.add_argument("--no-split-drums", action="store_true",
                   help="드럼 조각(킥/스네어/탐/하이햇/심벌) 분리 끄기 (audio-separator 필요)")
    r.add_argument("--beat-engine", choices=["auto", "beat_this", "librosa"], default="auto",
                   help="비트 추적 엔진 (기본: Beat This! 설치 시 사용)")
    r.add_argument("--stems", help="이 스템만 채보 (예: vocals,bass,piano)")
    r.add_argument("--stems-dir", type=Path,
                   help="이미 분리된/멀티트랙 스템 폴더 (분리 단계 생략)")
    r.add_argument("--device", help="cpu | cuda | mps (기본: 자동)")
    r.add_argument("--bpm", type=float, help="템포를 직접 지정 (자동 인식이 2배/절반으로 틀릴 때)")
    r.add_argument("--time-sig", default="auto", help="박자표 (기본 auto, 예: 4/4, 3/4, 6/8)")
    r.add_argument("--downbeat", type=int,
                   help="몇 번째 비트(0부터)를 마디 첫 박으로 할지 (기본: 자동 추정)")
    r.add_argument("--lyrics", action="store_true", help="보컬에서 가사 인식 (faster-whisper 필요)")
    r.add_argument("--lang", default="ko", help="가사 언어 (기본 ko, 자동 감지는 auto)")
    r.add_argument("--whisper-model", default="small", help="Whisper 모델 크기 (기본 small)")
    r.add_argument("--vocal-engine", choices=["crepe", "pyin", "basic_pitch"],
                   help="보컬 채보 방식 (기본: crepe 설치 시 crepe, 아니면 pyin)")
    r.add_argument("--start", type=float, help="이 시각(초)부터만 사용")
    r.add_argument("--duration", type=float, help="이 길이(초)만 사용")
    _add_render_args(r)

    f = sub.add_parser("fetch", help="유튜브 음성 다운로드(선택: 영상도) + 음성 추출 (악보는 만들지 않음)")
    f.add_argument("source", help="유튜브 URL (또는 소리만 뽑을 영상 파일)")
    f.add_argument("-o", "--out", type=Path, default=None, help="저장 폴더 (기본: output/<제목>)")
    f.add_argument("-a", "--audio-format", choices=["wav", "mp3", "m4a", "flac"], default="wav",
                   help="음성 파일 형식 (기본 wav: 악보 만들기에 가장 좋음)")
    f.add_argument("--video", action="store_true", help="영상(mp4)도 받기 (기본: 음성만, 훨씬 빠름)")
    f.add_argument("--audio-only", action="store_true", help=argparse.SUPPRESS)  # 예전 옵션 (이제 기본)
    f.add_argument("--max-height", type=int, default=1080, help="--video 일 때 영상 최대 화질 (기본 1080p)")
    f.add_argument("--start", type=float, help="이 시각(초)부터만 (음성만 받을 때는 이 구간만 다운로드)")
    f.add_argument("--duration", type=float, help="이 길이(초)만")
    f.add_argument("--cookies", help="쿠키 파일 (로그인·연령 확인이 필요한 영상)")
    f.add_argument("--cookies-from-browser", help="이 브라우저의 쿠키 사용 (예: chrome, firefox, edge)")

    m = sub.add_parser("remix", help="내 노래 영상 후보정: 화음(기본)·오케스트라·재즈·아카펠라·패드·피아노·기타 + 오토튠")
    m.add_argument("source", type=Path, help="녹화한 영상 또는 음원 파일")
    m.add_argument("-o", "--out", type=Path, default=None, help="결과 폴더 (기본: output/<이름>_remix)")
    m.add_argument("--style", default="harmony",
                   choices=["harmony", "orchestra", "full", "jazz", "acappella", "pad", "piano", "guitar"],
                   help="harmony: 화음 넣기(기본) | orchestra: 오케스트라 | full: 오케스트라+화음 | "
                        "jazz: 재즈 트리오 | acappella: 아카펠라 | pad: 워십 패드 | piano: 피아노 | "
                        "guitar: 어쿠스틱 기타")
    hg = m.add_mutually_exclusive_group()
    hg.add_argument("--with-harmony", dest="with_harmony", action="store_true", default=None,
                    help="반주 스타일에도 내 목소리 화음 넣기")
    hg.add_argument("--no-harmony", dest="with_harmony", action="store_false",
                    help="화음 없이 (아카펠라·풀 스타일에서 화음 빼기)")
    m.add_argument("--harmony", choices=["both", "up", "down"], default="both",
                   help="화음 성부: 3도 위+아래(기본) | 위만 | 아래만")
    m.add_argument("--autotune", nargs="?", type=float, const=0.7, default=None, metavar="강도",
                   help="오토튠 켜기 (강도 0~1, 기본 0.7 — 1 에 가까울수록 정확히 맞춤)")
    m.add_argument("--hard-tune", action="store_true", help="비브라토까지 펴는 '로봇 보이스' 오토튠")
    m.add_argument("--key", help="키 직접 지정 (예: G, Em; 기본 자동)")
    m.add_argument("--bpm", type=float, help="템포 직접 지정 (반주 박자가 어긋날 때)")
    m.add_argument("--beats", type=int, choices=[2, 3, 4, 6], default=4, help="한 마디 박 수 (기본 4, 왈츠는 3)")
    m.add_argument("--chords", help='코드 진행 직접 입력. 마디마다 하나: "G C D G" / 마디를 | 로: "G | C D | Em | D"'),
    m.add_argument("--no-separate", action="store_true", help="보컬/반주 분리 안 함 (보컬만 녹음된 영상)")
    g = m.add_mutually_exclusive_group()
    g.add_argument("--keep-backing", dest="keep_backing", action="store_true", default=None,
                   help="원래 반주 유지 (오케스트라 스타일 기본은 원래 반주를 빼고 오케스트라로 바꿈)")
    g.add_argument("--drop-backing", dest="keep_backing", action="store_false",
                   help="원래 반주 빼기 (보컬만 남기고 새로 입힘)")
    m.add_argument("--harmony-level", type=float, default=0.5, help="화음 음량 (리드 대비, 기본 0.5)")
    m.add_argument("--backing-level", "--orchestra-level", dest="backing_level", type=float, default=0.55,
                   help="새 반주 음량 (리드 대비, 기본 0.55)")
    m.add_argument("--soundfont", help="반주 음색 .sf2 (fluidsynth 필요, 없으면 내장 합성기)")
    m.add_argument("--device", help="cpu | cuda | mps (분리용, 기본 자동)")

    t = sub.add_parser("transpose", help="분석 결과(project.json) 또는 MusicXML 조옮김")
    t.add_argument("input", type=Path, help="project.json 또는 .musicxml/.mxl/.xml 파일")
    t.add_argument("-o", "--out", type=Path, help="결과 폴더 (기본: 입력 파일 옆)")
    t.add_argument("--stems", help="이 스템만 다시 렌더링 (project.json 입력 시)")
    _add_render_args(t)

    for name in ("app", "web"):
        w = sub.add_parser(name, help="악보 스튜디오 앱 실행 (브라우저 화면)" if name == "app"
                           else "app 과 같음")
        w.add_argument("--host", default="127.0.0.1",
                       help="같은 네트워크의 다른 기기에서 쓰려면 0.0.0.0")
        w.add_argument("--port", type=int, default=8765)
        w.add_argument("--data", type=Path, help="작업 저장 폴더 (기본: ~/band2sheet-data)")
        w.add_argument("--no-browser", action="store_true", help="브라우저 자동으로 열지 않기")

    sub.add_parser("engines", help="설치된 엔진(오픈소스 모델) 확인")

    k = sub.add_parser("keys", help="키 이름 확인/조옮김 계산기 (예: band2sheet keys G -s 3)")
    k.add_argument("key", help="원래 키 (예: G, Bbm)")
    k.add_argument("-s", "--semitones", type=int, default=0)
    k.add_argument("-k", "--to", dest="target_key")
    return parser


def cmd_run(args) -> int:
    from .audio_io import is_url, safe_name
    from .pipeline import AnalyzeOptions, run

    if not args.source and not args.stems_dir:
        print("source(유튜브 URL/파일) 또는 --stems-dir 가 필요합니다.", file=sys.stderr)
        return 2
    out = args.out
    if out is None:
        if args.stems_dir:
            name = Path(args.stems_dir).name
        elif is_url(args.source):
            name = "youtube_" + safe_name(args.source.rsplit("=", 1)[-1].rsplit("/", 1)[-1], 20)
        else:
            name = safe_name(Path(args.source).stem)
        out = Path("output") / name
    a = AnalyzeOptions(
        model=args.model, quality=args.quality, split_vocals=not args.no_split_vocals,
        split_drums=not args.no_split_drums, beat_engine=args.beat_engine,
        stems=_stems(args.stems), stems_dir=args.stems_dir, device=args.device,
        bpm=args.bpm, time_signature=args.time_sig, downbeat=args.downbeat, lyrics=args.lyrics,
        language=None if args.lang == "auto" else args.lang, whisper_model=args.whisper_model,
        vocal_engine=args.vocal_engine, start=args.start, duration=args.duration,
    )
    ro = _render_opts(args)
    res = run(args.source, out, a, ro)
    _report(res, out)
    return 0


def cmd_fetch(args) -> int:
    from .audio_io import fetch, is_url, safe_name

    out = args.out
    if out is None:
        base = Path("output")
        if is_url(args.source):
            out = base / ("youtube_" + safe_name(args.source.rsplit("=", 1)[-1].rsplit("/", 1)[-1], 20))
        else:
            out = base / safe_name(Path(args.source).stem)

    last = [""]

    def progress(frac: float, msg: str) -> None:
        if msg != last[0]:
            last[0] = msg
            print(f"\r  {msg:<50}", end="", flush=True)

    res = fetch(args.source, out, audio_format=args.audio_format, keep_video=args.video,
                max_height=args.max_height, start=args.start, duration=args.duration,
                progress=progress, cookies=args.cookies, cookies_from_browser=args.cookies_from_browser)
    print()
    print(f"완료! {res.title}")
    if res.video:
        print(f"  영상: {res.video}")
    print(f"  음성: {res.audio}")
    print()
    print(f"악보 만들기: band2sheet run \"{res.audio}\" -o \"{out}\"")
    return 0


def cmd_remix(args) -> int:
    from .audio_io import safe_name
    from .remix import STYLES, RemixOptions, remix

    out = args.out or Path("output") / f"{safe_name(args.source.stem)}_remix"
    opts = RemixOptions(
        style=args.style, harmony=args.harmony, autotune=args.autotune is not None,
        autotune_strength=float(min(max(args.autotune if args.autotune is not None else 0.7, 0.0), 1.0)),
        hard_tune=args.hard_tune, key=args.key, separate=not args.no_separate,
        keep_backing=args.keep_backing, harmony_level=args.harmony_level, with_harmony=args.with_harmony,
        backing_level=args.backing_level, bpm=args.bpm, soundfont=args.soundfont,
        beats_per_bar=args.beats, chords=args.chords,
        device=args.device,
    )
    if args.hard_tune and args.autotune is None:
        opts.autotune, opts.autotune_strength = True, 1.0
    res = remix(args.source, out, opts)
    print()
    print(f"코드 진행: {res.chord_text}  (템포 {res.tempo:.0f} BPM)")
    print("  틀린 곳은 --chords \"...\" 로 고쳐 다시 실행하세요 (분석은 저장돼 있어 금방 끝납니다).")
    print(f"완료! {STYLES[opts.style]}" + (" + 오토튠" if opts.autotune else "") + f" · 키 {res.key}")
    for f in res.files:
        print("  -", f)
    return 0


def _render_opts(args):
    from .pipeline import RenderOptions

    return RenderOptions(
        semitones=args.semitones, target_key=args.target_key, direction=args.direction,
        subdiv=args.grid, stems=_stems(getattr(args, "stems", None)), pdf=args.pdf,
        chords=not args.no_chords,
    )


def _report(res, out: Path) -> None:
    print()
    print(f"완료! 키: {res.key.name}" + (f" ({res.semitones:+d} 반음)" if res.semitones else ""))
    print(f"결과 폴더: {res.out_dir}")
    for f in res.files:
        try:
            print("  -", f.relative_to(out))
        except ValueError:
            print("  -", f)
    if res.chord_chart:
        print()
        print(res.chord_chart)


def cmd_transpose(args) -> int:
    src: Path = args.input
    if src.suffix.lower() == ".json":
        from .pipeline import render
        from .project import Project

        project = Project.load(src)
        out = args.out or src.parent
        res = render(project, out, _render_opts(args))
        _report(res, out)
        return 0
    from .xml_transpose import transpose_file

    dst = transpose_file(src, args.out, args.semitones, args.target_key, args.direction)
    print(f"저장: {dst}")
    return 0


def cmd_keys(args) -> int:
    from .theory import Key, transpose_target

    src = Key.parse(args.key)
    shift, dst = transpose_target(src, args.target_key, args.semitones)
    print(f"{src.name} ({src.fifths:+d}) -> {dst.name} ({dst.fifths:+d}) : {shift:+d} 반음")
    return 0


def cmd_engines(args) -> int:
    from .engines import status

    for e in status():
        mark = "✓" if e["installed"] else "·"
        print(f" {mark} {e['key']:<16} {e['role']}")
        if not e["installed"]:
            print(f"   {'':<16} 설치: pip install {e['pip']}")
    return 0


def cmd_app(args) -> int:
    try:
        from .app.server import launch
    except ImportError as e:
        raise RuntimeError("앱 실행에는 fastapi, uvicorn 이 필요합니다: pip install 'band2sheet[app]'") from e
    launch(args.host, args.port, not args.no_browser, args.data)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return {
            "run": cmd_run, "fetch": cmd_fetch, "remix": cmd_remix, "transpose": cmd_transpose, "app": cmd_app, "web": cmd_app, "keys": cmd_keys,
            "engines": cmd_engines,
        }[args.command](args)
    except (RuntimeError, FileNotFoundError, ValueError) as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
