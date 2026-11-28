"""Keystroke-Level Model (KLM) of objective O1 (review item R3-A29).

    python bench/stats/klm.py      # standard library only

Task: from a YouTube video open in the browser to a 20-second part (1:10-1:30) saved as an H.264 file with
a constant frame rate that Premiere reads without conversion. Three ways:
  A. Khama: paste, "Download only a part", type the two times, Download (the default preset is editor-ready).
  B. Command line: yt-dlp with --download-sections and an H.264 format sort, then FFmpeg to a constant rate.
  C. A download website, then HandBrake for the range and the constant frame rate.

Operators and times from Card, Moran and Newell (1980): K keystroke or mouse-button press (0.28 s, average
non-secretarial typist; 0.20 s for a skilled typist as a sensitivity check), P point with the mouse (1.1 s),
H move the hand between keyboard and mouse (0.4 s), M mental preparation (1.35 s). Shifted characters count
as two keystrokes. One M is placed before each command or argument the user must recall (heuristic rule 0
of the KLM paper). System response time (probing, downloading, encoding) is left out: it is the machine
waiting, measured separately in section 6.3, and it does not change with the interface. Path B is an
expert who knows every flag by heart, so it is a lower bound for most editors.

Output: bench/results/stats_klm.csv and a summary on stdout.
"""

from __future__ import annotations

import csv
from pathlib import Path

RESULTS = Path(__file__).resolve().parents[1] / "results"
TIMES = {"K": 0.28, "P": 1.1, "H": 0.4, "M": 1.35}
SHIFTED = set('~!@#$%^&*()_+{}|:"<>?') | set("ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def typed(text: str) -> str:
    return "".join("KK" if c in SHIFTED else "K" for c in text)


def command(tokens: list[str]) -> str:
    """A shell command typed by heart: M before each token, a space after each, Enter at the end."""
    return "".join("M" + typed(t) + "K" for t in tokens)


COPY_URL = "MPK" + "H" + "KK"  # click the address bar (the URL is selected), Ctrl+C

PATHS = {
    "A. Khama": [
        ("copy the URL in the browser", COPY_URL),
        ("Alt+Tab to Khama", "MKK"),
        ("Ctrl+V anywhere in the window (the preview opens)", "MKK"),
        ("turn on 'Download only a part'", "HMPK"),
        ("start field: click, Ctrl+A, type 1:10", "MPK" + "HKK" + "M" + typed("1:10")),
        ("Tab to the end field (selects it), type 1:30, Enter", "K" + "M" + typed("1:30") + "K"),
        ("click Download (MP4 1080p editor-ready is the default)", "HMPK"),
    ],
    "B. yt-dlp + FFmpeg": [
        ("copy the URL in the browser", COPY_URL),
        ("Alt+Tab to the terminal", "MKK"),
        ("yt-dlp with the part and an H.264 format sort, then paste the URL and Enter",
         command(["yt-dlp", "--download-sections", '"*1:10-1:30"', "-S", "res:1080,vcodec:h264,acodec:aac", "-o", "clip.mp4"])
         + "MKK" + "K"),
        ("read the output to see it finished", "M"),
        ("FFmpeg to a constant frame rate",
         command(["ffmpeg", "-i", "clip.mp4", "-c:v", "libx264", "-crf", "18", "-r", "30", "-c:a", "aac", "clip-cfr.mp4"])),
    ],
    "C. website + HandBrake": [
        ("copy the URL in the browser", COPY_URL),
        ("Ctrl+T, type a 12-letter site name, Enter", "MKK" + "M" + typed("downloadsite") + "K"),
        ("click the site's field, Ctrl+V, Enter", "HMPK" + "HMKK" + "K"),
        ("pick MP4 1080p in the list of formats", "HMPK"),
        ("confirm the download", "MPK"),
        ("open HandBrake from the Start menu", "HMK" + "M" + typed("handbrake") + "K"),
        ("Open Source, Downloads, double-click the file", "HMPK" + "MPK" + "MPKK"),
        ("Range: choose Seconds", "MPK" + "PK"),
        ("start: click, Ctrl+A, type 00:01:10", "MPK" + "HKK" + "M" + typed("00:01:10")),
        ("Tab to the end, type 00:01:30", "K" + "M" + typed("00:01:30")),
        ("Video tab, Constant Framerate", "HMPK" + "MPK"),
        ("Start Encode", "MPK"),
    ],
}


def total(ops: str, k: float = TIMES["K"]) -> float:
    t = dict(TIMES, K=k)
    return sum(t[o] for o in ops)


def main() -> None:
    rows = []
    for name, steps in PATHS.items():
        ops = "".join(s for _, s in steps)
        rows.append(dict(path=name, steps=len(steps), K=ops.count("K"), P=ops.count("P"), H=ops.count("H"), M=ops.count("M"),
                         seconds_k028=round(total(ops), 1), seconds_k020=round(total(ops, 0.20), 1),
                         seconds_without_m=round(total(ops.replace("M", "")), 1)))
    path = RESULTS / "stats_klm.csv"
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {path}")
    for r in rows:
        print(f"  {r['path']:24s} {r['steps']:2d} steps  K {r['K']:3d}  P {r['P']:2d}  H {r['H']:2d}  M {r['M']:2d}  "
              f"-> {r['seconds_k028']:5.1f} s (K = 0.20: {r['seconds_k020']:5.1f} s; without M: {r['seconds_without_m']:5.1f} s)")


if __name__ == "__main__":
    main()
