"""악보 소리: 채보한 음표를 실제 악기 음색(GM 사운드폰트)으로 연주한 음원.

FluidSynth 와 사운드폰트(.sf2)가 있으면 쓴다. 원곡과 같은 시간축이라 믹서에서 함께 들으며
채보가 맞는지 확인하거나, 깨끗한 악기 소리의 반주로 쓸 수 있다. 조옮김한 키로도 연주한다(드럼 제외).

사운드폰트 찾는 순서: BAND2SHEET_SOUNDFONT 환경 변수 → ~/.band2sheet/*.sf2 → 시스템 기본 위치
(Ubuntu: sudo apt install fluidsynth fluid-soundfont-gm / macOS: brew install fluid-synth + sf2 파일)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from .instruments import spec_for
from .project import Note, Project

SF2_PLACES = [
    "/usr/share/sounds/sf2/FluidR3_GM.sf2",
    "/usr/share/sounds/sf2/default-GM.sf2",
    "/usr/share/soundfonts/FluidR3_GM.sf2",
    "/usr/share/soundfonts/default.sf2",
    "/usr/local/share/soundfonts/default.sf2",
    "/opt/homebrew/share/soundfonts/default.sf2",
    "/opt/homebrew/share/fluid-synth/sf2/VintageDreamsWaves-v2.sf2",
]

# 듣기 좋은 GM 음색 (악보용 악기 번호와 따로 — 보컬 멜로디는 부드러운 리드 음색으로)
PROGRAMS = {"vocals": 73, "backing_vocals": 52, "guitar": 25, "piano": 0, "bass": 33, "other": 89}
LEVELS = {"vocals": 0.9, "backing_vocals": 0.6, "guitar": 0.75, "piano": 0.85, "bass": 0.95,
          "other": 0.6, "drums": 0.85}


def find_soundfont() -> Path | None:
    env = os.environ.get("BAND2SHEET_SOUNDFONT")
    if env and Path(env).is_file():
        return Path(env)
    home = Path.home() / ".band2sheet"
    if home.is_dir():
        found = sorted(home.glob("*.sf2"))
        if found:
            return found[0]
    for p in SF2_PLACES:
        if Path(p).is_file():
            return Path(p)
    return None


def find_fluidsynth() -> str | None:
    return shutil.which("fluidsynth")


def available() -> bool:
    return bool(find_fluidsynth() and find_soundfont())


def score_midi(tracks: dict[str, list[Note]], path: Path, semitones: int = 0) -> Path | None:
    """음표 -> GM MIDI (악기별 채널·음색·음량, 드럼은 10번 채널). 조옮김은 드럼 빼고."""
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(initial_tempo=120)
    for name, notes in tracks.items():
        if not notes:
            continue
        drums = name == "drums"
        program = PROGRAMS.get(name, spec_for(name).program)
        inst = pretty_midi.Instrument(program=0 if drums else program, is_drum=drums, name=name)
        level = LEVELS.get(name, 0.7)
        for n in notes:
            pitch = n.pitch if drums else n.pitch + semitones
            end = max(n.end, n.start + 0.05)
            if 0 <= pitch <= 127:
                vel = int(max(1, min(127, round(n.velocity * level))))
                inst.notes.append(pretty_midi.Note(vel, pitch, n.start, end))
        if inst.notes:
            pm.instruments.append(inst)
    if not pm.instruments:
        return None
    pm.write(str(path))
    return path


def render_score_audio(project: Project, dst: Path, semitones: int = 0,
                       parts: list[str] | None = None) -> Path | None:
    """악보 음표를 사운드폰트로 연주해 dst(.mp3)로 저장. FluidSynth/사운드폰트가 없으면 None."""
    from .playback import SR, encode

    fs, sf2 = find_fluidsynth(), find_soundfont()
    if not (fs and sf2):
        return None
    tracks = {k: t.notes for k, t in project.tracks.items() if parts is None or k in parts}
    with tempfile.TemporaryDirectory() as tmp:
        mid = score_midi(tracks, Path(tmp) / "score.mid", semitones)
        if mid is None:
            return None
        wav = Path(tmp) / "score.wav"
        subprocess.run([fs, "-ni", "-q", "-g", "0.9", "-r", str(SR), "-o", "synth.reverb.active=1",
                        "-o", "synth.chorus.active=0", "-T", "wav", "-F", str(wav), str(sf2), str(mid)],
                       check=True, capture_output=True, timeout=600)
        return encode(wav, dst, limit=True, bitrate="192k")
