"""Contact sheets for labelling shot boundaries by hand (used for the Sintel trailer).

    python scenes/contact_sheet.py data/films/sintel_trailer.mp4 --cols 24

Writes work/sheets/<name>_NNN.png: every frame as a small thumbnail with its frame number, row by
row, so that cuts (a sudden change between two thumbnails) and gradual transitions (a run of mixed
frames) can be read off and written to data/films/<name>.json in the same format as the synthetic set:
    {"fps": 24, "transitions": [{"kind": "cut", "start": 119, "end": 120}, ...], "flashes": []}
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import WORK, ffmpeg  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--cols", type=int, default=24)
    ap.add_argument("--rows", type=int, default=12)
    ap.add_argument("--width", type=int, default=96)
    a = ap.parse_args()
    out = WORK / "sheets"
    out.mkdir(parents=True, exist_ok=True)
    pattern = out / f"{a.video.stem}_%03d.png"
    draw = ("drawtext=text='%{frame_num}':start_number=0:x=2:y=2:fontsize=12:fontcolor=yellow:"
            "box=1:boxcolor=black@0.6:fontfile='C\\:/Windows/Fonts/consola.ttf'")
    ffmpeg("-v", "error", "-i", a.video.resolve(), "-vf",
           f"scale={a.width}:-2,{draw},tile={a.cols}x{a.rows}:padding=2:color=gray", "-fps_mode", "passthrough", pattern)
    print("sheets in", out)


if __name__ == "__main__":
    main()
