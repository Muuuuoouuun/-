"""웹 화면 (Gradio): 링크/파일을 넣고 버튼 한 번으로 악보 만들기, 조옮김."""

from __future__ import annotations

import tempfile
import zipfile
from pathlib import Path

from .instruments import INSTRUMENTS
from .pipeline import AnalyzeOptions, RenderOptions, analyze, render
from .project import Project

KEYS = ["(원래 키)", "C", "Db", "D", "Eb", "E", "F", "F#", "Gb", "G", "Ab", "A", "Bb", "B",
        "Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm"]
STEM_CHOICES = [f"{s} ({spec.label_ko})" for s, spec in INSTRUMENTS.items()]


def _zip(folder: Path) -> Path:
    dst = folder.with_suffix(".zip")
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in folder.rglob("*"):
            if f.is_file():
                zf.write(f, f.relative_to(folder.parent))
    return dst


def render_project(project_path: str, key_choice: str, semitones: float, grid: str,
                   logs: list[str]):
    """저장된 분석 결과로 (조옮김한) 악보를 만들고 화면에 보여줄 요약/코드표/파일 목록을 반환."""
    project = Project.load(project_path)
    ro = RenderOptions(
        target_key=None if key_choice == KEYS[0] else key_choice,
        semitones=int(semitones) if key_choice == KEYS[0] else None,
        subdiv={"16분음표": 4, "8분음표": 2, "셋잇단(8분)": 3}.get(grid),
    )
    res = render(project, Path(project_path).parent, ro, logs.append)
    files = [str(f) for f in res.files if f.suffix in (".musicxml", ".pdf", ".txt")]
    files.append(str(_zip(res.out_dir)))
    summary = (f"**키:** {project.key.name}"
               + (f" → **{res.key.name}** ({res.semitones:+d} 반음)" if res.semitones else "")
               + f"  \n**템포:** 약 {project.tempo_bpm:.0f} BPM  \n**박자:** {project.time_signature}")
    return summary, res.chord_chart, files


def build_app():
    try:
        import gradio as gr
    except ImportError as e:  # pragma: no cover - 설치 안내
        raise RuntimeError("웹 화면에는 gradio 가 필요합니다: pip install 'band2sheet[web]'") from e

    workspace = Path(tempfile.gettempdir()) / "band2sheet_web"
    workspace.mkdir(exist_ok=True)

    def run(url, upload, stems, key_choice, semitones, lyrics, lang, bpm, time_sig, grid,
            progress=gr.Progress(track_tqdm=True)):
        source = (url or "").strip() or (upload if isinstance(upload, str) else getattr(upload, "name", ""))
        if not source:
            raise gr.Error("유튜브 링크를 넣거나 오디오/영상 파일을 올려 주세요.")
        out = Path(tempfile.mkdtemp(prefix="job_", dir=workspace))
        logs: list[str] = []
        opts = AnalyzeOptions(
            stems=[s.split(" ")[0] for s in stems] or None,
            lyrics=bool(lyrics), language=lang or None,
            bpm=float(bpm) if bpm else None, time_signature=time_sig or "4/4",
        )
        try:
            analyze(source, out, opts, logs.append)
            summary, chart, files = render_project(str(out / "project.json"), key_choice, semitones, grid,
                                              logs)
        except Exception as e:  # 화면에 오류 표시
            raise gr.Error(f"처리 중 오류: {e}") from e
        return summary, chart, files, "\n".join(logs), str(out / "project.json")

    def retranspose(project_path, key_choice, semitones, grid):
        if not project_path:
            raise gr.Error("먼저 악보를 만들어 주세요.")
        logs: list[str] = []
        summary, chart, files = render_project(project_path, key_choice, semitones, grid, logs)
        return summary, chart, files

    with gr.Blocks(title="band2sheet — 자동 악보 만들기") as app:
        gr.Markdown(
            "# 🎼 band2sheet\n"
            "유튜브 링크나 음원 파일을 넣으면 **보컬·드럼·베이스·기타·피아노**로 분리해서 "
            "악기별 악보(MusicXML·MIDI)와 코드표를 만들어 드립니다. 키 변경도 바로 됩니다.\n\n"
            "결과 MusicXML 은 MuseScore(무료) 등에서 열어 보고 수정·인쇄할 수 있습니다."
        )
        project_state = gr.State("")
        with gr.Row():
            with gr.Column():
                url = gr.Textbox(label="유튜브 링크", placeholder="https://www.youtube.com/watch?v=...")
                upload = gr.File(label="또는 오디오/영상 파일", file_types=["audio", "video"],
                                 type="filepath")
                stems = gr.CheckboxGroup(STEM_CHOICES, label="악보로 만들 악기 (비우면 전부)")
                with gr.Row():
                    key_choice = gr.Dropdown(KEYS, value=KEYS[0], label="키 변경 (목표 키)")
                    semitones = gr.Slider(-6, 6, value=0, step=1, label="또는 반음 이동")
                with gr.Accordion("고급 옵션", open=False):
                    lyrics = gr.Checkbox(label="가사 인식 (faster-whisper 필요)")
                    lang = gr.Textbox(value="ko", label="가사 언어 (ko, en ...)")
                    bpm = gr.Number(value=None, label="템포 직접 지정 (BPM, 비우면 자동)")
                    time_sig = gr.Dropdown(["4/4", "3/4", "6/8", "12/8", "2/4"], value="4/4",
                                           label="박자")
                    grid = gr.Radio(["16분음표", "8분음표", "셋잇단(8분)"], value="16분음표",
                                    label="리듬 정밀도")
                go = gr.Button("악보 만들기", variant="primary")
                again = gr.Button("이 키로 다시 만들기 (분석 결과 재사용)")
            with gr.Column():
                summary = gr.Markdown()
                chart = gr.Code(label="코드표", language=None)
                files = gr.File(label="결과 파일", file_count="multiple")
                log = gr.Textbox(label="진행 기록", lines=8)

        go.click(run, [url, upload, stems, key_choice, semitones, lyrics, lang, bpm, time_sig, grid],
                 [summary, chart, files, log, project_state])
        again.click(retranspose, [project_state, key_choice, semitones, grid], [summary, chart, files])
    return app


def launch(host: str = "127.0.0.1", port: int = 7860, share: bool = False) -> None:
    build_app().queue().launch(server_name=host, server_port=port, share=share)


__all__ = ["build_app", "launch"]
