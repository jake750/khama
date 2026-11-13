"""Downloads the open test material (only the first seconds of each Xiph clip) into bench/data.

    python fetch_clips.py            # Xiph clips + Sintel trailer
    python fetch_clips.py --seconds 4

Xiph clips are uncompressed y4m files of 0.6-10 GB; FFmpeg reads them over HTTP and stops after
--seconds, so only that part is transferred. Each clip is stored as lossless FFV1 at 1280x720
(1080p clips are downscaled with a Lanczos filter), which is the reference for every measurement.
Licences: see data/clips/LICENCES.txt (written by this script) and bench/README.md.
"""

from __future__ import annotations

import argparse
import urllib.request

from common import DATA, ffmpeg

DERF = "https://media.xiph.org/video/derf/"

# name, path under DERF, content class (for the report), licence note
CLIPS = [
    ("ducks_take_off", "y4m/ducks_take_off_420_720p50.y4m", "fast motion, water", "SVT test sequences (see SVT_MultiFormat_v10.pdf)"),
    ("crowd_run", "y4m/crowd_run_1080p50.y4m", "fast motion, dense crowd", "SVT test sequences"),
    ("parkrun", "y4m/720p50_parkrun_ter.y4m", "camera pan, fine detail", "LDV TU Munich (ReadMe_720p.txt)"),
    ("shields", "y4m/720p50_shields_ter.y4m", "camera motion, texture", "LDV TU Munich"),
    ("mobcal", "y4m/720p50_mobcal_ter.y4m", "detail, printed text (calendar)", "LDV TU Munich"),
    ("stockholm", "y4m/720p5994_stockholm_ter.y4m", "slow pan, city", "LDV TU Munich"),
    ("riverbed", "y4m/riverbed_1080p25.y4m", "water texture (hard to code)", "LDV TU Munich (ReadMe_1080p.txt)"),
    ("sunflower", "y4m/sunflower_1080p25.y4m", "low motion, close-up", "LDV TU Munich"),
    ("rush_hour", "y4m/rush_hour_1080p25.y4m", "traffic, heat haze", "LDV TU Munich"),
    ("johnny", "y4m/Johnny_1280x720_60.y4m", "talking head, static camera", "public domain"),
    ("kristen_sara", "y4m/KristenAndSara_1280x720_60.y4m", "two people, static camera", "public domain"),
    ("hearthstone", "twitch/y4m/Hearthstone.y4m", "screen content: game UI and text", "public domain (twitch/copyright.txt)"),
]

SINTEL = ("sintel_trailer", "https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4", "CC-BY 3.0, Blender Foundation")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=4.0)
    args = ap.parse_args()
    out = DATA / "clips"
    out.mkdir(parents=True, exist_ok=True)
    lic = ["Source clips used by the bench (first seconds only, re-encoded losslessly to FFV1 720p)\n"]
    for name, path, kind, licence in CLIPS:
        dst = out / f"{name}.mkv"
        lic.append(f"{name}: {DERF}{path} | {kind} | {licence}")
        if dst.exists():
            print("have", dst.name)
            continue
        print("fetching", name, "...", flush=True)
        tmp = dst.with_suffix(".part.mkv")
        ffmpeg(
            "-v", "error", "-t", str(args.seconds), "-i", DERF + path,
            "-vf", "scale=1280:720:flags=lanczos,format=yuv420p",
            "-c:v", "ffv1", "-level", "3", "-g", "1", "-an", tmp,
        )
        tmp.rename(dst)
    films = DATA / "films"
    films.mkdir(exist_ok=True)
    name, url, licence = SINTEL
    lic.append(f"{name}: {url} | animated film trailer with real editing | {licence}")
    if not (films / f"{name}.mp4").exists():
        print("fetching", name, "...", flush=True)
        urllib.request.urlretrieve(url, films / f"{name}.mp4")
    (out / "LICENCES.txt").write_text("\n".join(lic) + "\n", encoding="utf-8")
    print("done")


if __name__ == "__main__":
    main()
