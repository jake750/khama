"""Builds the synthetic shot-boundary dataset with exact ground truth.

Each video is a random sequence of shots cut from the open clips in data/clips, joined by
hard cuts, cross-dissolves, fades through black or wipes (FFmpeg xfade), then encoded with x264
like an ordinary download. Some shots also contain a camera flash (1-2 white frames): a "hard
negative" that a detector must NOT report. The same idea is used to train/evaluate TransNet and
DeepSBD (synthetic transitions on real footage), which makes the labels exact.

    python scenes/make_dataset.py --videos 24 --seed 7

Output: data/scenes/vNN.mp4 and data/scenes/vNN.json (frame-exact transitions, 25 fps).
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA, ffmpeg, probe  # noqa: E402

FPS = 25
W, H = 640, 360
WIPES = ["wipeleft", "wiperight", "slideup", "circleopen", "smoothleft", "radial"]


CLIPS = DATA / "clips"
OUT = DATA / "scenes"


def clip_lengths() -> dict[str, float]:
    out = {}
    for p in sorted(CLIPS.glob("*.mkv")):
        out[p.stem] = float(probe(p)["format"]["duration"])
    if len(out) < 4:
        raise SystemExit("run fetch_clips.py first (need at least 4 clips in data/clips)")
    return out


def build(idx: int, rng: random.Random, clips: dict[str, float], shots: int) -> None:
    names = list(clips)
    inputs, filters = [], []
    plan = []  # per shot: dict(src, start, frames, transition-before)
    prev = None
    for s in range(shots):
        same = prev is not None and rng.random() < 0.10  # a cut inside the same clip (hard case)
        src = prev if same else rng.choice([n for n in names if n != prev])
        frames = rng.randint(30, 85)  # 1.2 - 3.4 s
        start = rng.uniform(0, max(0.0, clips[src] - frames / FPS - 0.05))
        r = rng.random()
        if s == 0:
            tr = None
        elif same or r < 0.55:
            tr = ("cut", 0)
        elif r < 0.71:
            tr = ("dissolve", rng.randint(8, 30))
        elif r < 0.85:
            tr = ("fadeblack", rng.randint(10, 30))
        else:
            tr = ("wipe", rng.randint(8, 20))
        flash = rng.random() < 0.25 and frames > 40
        plan.append(dict(src=src, start=round(start, 3), frames=frames, transition=tr,
                         flash=rng.randint(15, frames - 15) if flash else None, flash_len=rng.choice([1, 1, 2])))
        prev = src

    for i, sh in enumerate(plan):
        inputs += ["-ss", f"{sh['start']:.3f}", "-i", str(CLIPS / f"{sh['src']}.mkv")]
        chain = (f"[{i}:v]fps={FPS},scale={W}:{H}:flags=bicubic,format=yuv420p,"
                 f"trim=end_frame={sh['frames']},setpts=PTS-STARTPTS,settb=1/{FPS}")
        if sh["flash"] is not None:
            a, b = sh["flash"], sh["flash"] + sh["flash_len"] - 1
            chain += f",lutyuv=y='min(255,val+150)':u=128:v=128:enable='between(n,{a},{b})'"
        filters.append(chain + f"[s{i}]")

    # join: cuts with concat, gradual transitions with xfade; track frame-exact labels
    truth, flashes = [], []
    acc, length = "s0", plan[0]["frames"]
    if plan[0]["flash"] is not None:
        flashes.append(plan[0]["flash"])
    for i in range(1, len(plan)):
        kind, d = plan[i]["transition"]
        out = f"j{i}"
        if kind == "cut":
            filters.append(f"[{acc}][s{i}]concat=n=2:v=1:a=0,settb=1/{FPS}[{out}]")
            truth.append(dict(kind="cut", start=length - 1, end=length))
            offset_frames = length
            length += plan[i]["frames"]
        else:
            name = {"dissolve": "fade", "fadeblack": "fadeblack"}.get(kind) or random.Random(i).choice(WIPES)
            off = length - d
            filters.append(f"[{acc}][s{i}]xfade=transition={name}:duration={d / FPS:.4f}:offset={off / FPS:.4f},settb=1/{FPS}[{out}]")
            # frames off..length-1 are mixed; frame `length` is the first clean frame of the new shot
            truth.append(dict(kind="gradual", type=kind, start=off - 1, end=length))
            offset_frames = off
            length += plan[i]["frames"] - d
        if plan[i]["flash"] is not None:
            flashes.append(offset_frames + plan[i]["flash"])
        acc = out

    path = OUT / f"v{idx:02d}.mp4"
    ffmpeg(*inputs, "-filter_complex", ";".join(filters), "-map", f"[{acc}]", "-c:v", "libx264", "-preset", "medium",
           "-crf", "20", "-pix_fmt", "yuv420p", "-r", str(FPS), path)
    n = int(probe(path)["streams"][0].get("nb_frames", 0))
    meta = dict(fps=FPS, frames=n, expected_frames=length, transitions=truth, flashes=flashes, shots=plan)
    path.with_suffix(".json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(path.name, f"{n} frames (expected {length}), {len(truth)} transitions, {len(flashes)} flashes")
    if n and n != length:
        print("  warning: frame count differs from the plan; labels may be shifted", file=sys.stderr)


def main() -> None:
    global CLIPS, OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", type=int, default=24)
    ap.add_argument("--shots", type=int, default=18)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--clips", type=Path, default=CLIPS, help="folder of source clips (.mkv)")
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    CLIPS, OUT = a.clips, a.out
    OUT.mkdir(parents=True, exist_ok=True)
    clips = clip_lengths()
    rng = random.Random(a.seed)
    for i in range(a.videos):
        build(i, rng, clips, a.shots)


if __name__ == "__main__":
    main()
