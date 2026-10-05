"""명령줄 인터페이스.

  band2sheet fetch "https://youtu.be/..."                   # 유튜브 -> 영상(mp4) + 음성(wav)
  band2sheet run "https://youtu.be/..." -o out/song         # 유튜브 -> 악보
  band2sheet run live.mp4 --key A --lyrics                  # 파일 -> 악보 + A키로 조옮김 + 가사
  band2sheet transpose out/song/project.json --key Bb       # 분석 결과로 빠르게 조옮김
  band2sheet transpose score.musicxml -s -2                 # 기존 MusicXML 조옮김
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
    g.add_argument("--pdf", action="store_true", help="PDF 도 만들기 (MuseScore, 없으면 Verovio)")
    g.add_argument("--bars-per-line", type=int, default=4, help="한 줄에 넣을 마디 수 (0: 구간 시작에서만 줄바꿈)")
    g.add_argument("--no-simplify", action="store_true", help="반주(기타·피아노·코러스) 리듬을 8분 격자로 단순화하지 않기")


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
    r.add_argument("--song", help="곡이 여러 개 든 실황 영상: 찾은 곡 중 이 번호만 (예: 2, 1,3, all) — band2sheet scan 으로 확인")
    _add_render_args(r)

    sc = sub.add_parser("scan", help="긴 예배·공연 영상에서 곡 구간 찾기 (말씀·기도·전환 제외)")
    sc.add_argument("source", help="오디오/영상 파일")

    f = sub.add_parser("fetch", help="유튜브 영상 다운로드 + 음성 추출 (악보는 만들지 않음)")
    f.add_argument("source", help="유튜브 URL (또는 소리만 뽑을 영상 파일)")
    f.add_argument("-o", "--out", type=Path, default=None, help="저장 폴더 (기본: output/<제목>)")
    f.add_argument("-a", "--audio-format", choices=["wav", "mp3", "m4a", "flac"], default="wav",
                   help="음성 파일 형식 (기본 wav: 악보 만들기에 가장 좋음)")
    f.add_argument("--audio-only", action="store_true", help="영상은 저장하지 않고 음성만 (더 빠름)")
    f.add_argument("--max-height", type=int, default=1080, help="영상 최대 화질 (기본 1080p)")
    f.add_argument("--start", type=float, help="이 시각(초)부터만 음성 추출")
    f.add_argument("--duration", type=float, help="이 길이(초)만 음성 추출")
    f.add_argument("--cookies", help="쿠키 파일 (로그인·연령 확인이 필요한 영상)")
    f.add_argument("--cookies-from-browser", help="이 브라우저의 쿠키 사용 (예: chrome, firefox, edge)")

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
    if args.song:
        songs = _songs_in(args.source)
        if not songs:
            print("찬양(음악) 구간을 찾지 못했습니다.", file=sys.stderr)
            return 1
        picks = range(1, len(songs) + 1) if args.song == "all" else [int(x) for x in args.song.split(",")]
        for i in picks:
            if not 1 <= i <= len(songs):
                print(f"곡 번호는 1~{len(songs)} 입니다.", file=sys.stderr)
                return 2
            sg = songs[i - 1]
            print(f"\n=== {i}번째 곡: {_mmss(sg.start)} ~ {_mmss(sg.end)} ===")
            a.start, a.duration = max(0.0, sg.start - 1.0), sg.duration + 2.0
            song_out = out / f"song{i}"
            res = run(args.source, song_out, a, ro)
            _report(res, song_out)
        return 0
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

    res = fetch(args.source, out, audio_format=args.audio_format, keep_video=not args.audio_only,
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


def _render_opts(args):
    from .pipeline import RenderOptions

    return RenderOptions(
        semitones=args.semitones, target_key=args.target_key, direction=args.direction,
        subdiv=args.grid, stems=_stems(getattr(args, "stems", None)), pdf=args.pdf,
        chords=not args.no_chords, simplify=not args.no_simplify, bars_per_line=args.bars_per_line,
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


def _songs_in(source: str):
    from .audio_io import is_url
    from .segment import scan_file

    if is_url(source):
        raise ValueError("곡 나누기는 내려받은 파일로 해 주세요 (유튜브 링크는 run 으로 먼저 받기)")
    return scan_file(source)


def cmd_scan(args) -> int:
    songs = _songs_in(args.source)
    if not songs:
        print("찬양(음악) 구간을 찾지 못했습니다.")
        return 0
    print(f"곡 {len(songs)}개:")
    for i, sg in enumerate(songs, 1):
        print(f"  {i}. {_mmss(sg.start)} ~ {_mmss(sg.end)}  ({_mmss(sg.duration)})  키 {sg.key}  약 {sg.tempo:.0f} BPM")
    print("\n악보 만들기: band2sheet run <파일> --song 2   (여러 곡: --song 1,3 / 전부: --song all)")
    return 0


def _mmss(t: float) -> str:
    return f"{int(t // 60)}:{int(t % 60):02d}"


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
            "run": cmd_run, "fetch": cmd_fetch, "transpose": cmd_transpose, "app": cmd_app, "web": cmd_app,
            "keys": cmd_keys, "engines": cmd_engines, "scan": cmd_scan,
        }[args.command](args)
    except (RuntimeError, FileNotFoundError, ValueError) as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
