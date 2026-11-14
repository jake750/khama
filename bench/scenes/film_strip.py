"""Visual check of the detector on a hand-labelled film: one row per labelled transition, with the frames
around it and whether Khama's detector (shipped defaults) and FFmpeg's old `scene > 0.3` found it, followed
by each method's false alarms.

    python scenes/film_strip.py scenes/labels/sintel_trailer.json

Writes results/scenes_film_strip.png (needs a run of scenes/evaluate.py first for the FFmpeg scores cache).
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import RESULTS, WORK, bench_bin, ffmpeg  # noqa: E402

TW, TH = 208, 88          # thumbnail
PAD, GAPX = 14, 6
BG, CARD, LINE = (10, 18, 19), (16, 27, 28), (36, 54, 54)
TEXT, DIM = (230, 242, 239), (138, 159, 156)
OK, MISS, ACC = (61, 211, 196), (255, 138, 130), (61, 211, 196)


def font(size: int, bold: bool = False):
    for name in (("segoeuib.ttf" if bold else "segoeui.ttf"), "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def frames(video: Path, numbers: list[int]) -> dict[int, Image.Image]:
    numbers = sorted(set(numbers))
    sel = "+".join(f"eq(n\\,{n})" for n in numbers)
    with tempfile.TemporaryDirectory() as d:
        ffmpeg("-v", "error", "-i", video, "-vf", f"select='{sel}',scale={TW}:{TH}:force_original_aspect_ratio=increase,crop={TW}:{TH}",
               "-fps_mode", "passthrough", Path(d) / "f%04d.png")
        files = sorted(Path(d).glob("f*.png"))
        assert len(files) == len(numbers), (len(files), len(numbers))
        return {n: Image.open(f).convert("RGB").copy() for n, f in zip(numbers, files)}


def overlaps(a: tuple[int, int], b: tuple[int, int], tol: int = 2) -> bool:
    return a[0] - tol <= b[1] and b[0] - tol <= a[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("labels", type=Path)
    a = ap.parse_args()
    L = json.loads(a.labels.read_text(encoding="utf-8"))
    root = Path(__file__).resolve().parents[1]
    video = (root / L["video"]).resolve()
    fps = L["fps"]
    gt = [(t["start"], t["end"], t["kind"], t.get("type", "cut")) for t in L["transitions"]]
    ign = [(i["start"], i["end"]) for i in L.get("ignore", [])]

    kj = bench_bin("scenes", video)  # shipped defaults
    khama = [(b["start"], b["end"]) for b in kj["results"][0]["boundaries"]]
    cache = WORK / "scenes" / f"{a.labels.stem}.ffmpeg.json"
    scores = json.loads(cache.read_text())["scores"]
    ff = [(i - 1, i) for i, s in enumerate(scores) if s > 0.30 and i > 0]

    def assign(det):
        """Same rule as scenes/evaluate.py match(): ignore spans dropped, then one-to-one, ±2 frames, in label order."""
        det = [d for d in det if not any(d[0] <= ie and d[1] >= isx for isx, ie in ign)]
        used = [False] * len(det)
        found = []
        for s, e, *_ in gt:
            hit = False
            for i, d in enumerate(det):
                if not used[i] and overlaps(d, (s, e)):
                    used[i] = hit = True
                    break
            found.append(hit)
        return found, [d for i, d in enumerate(det) if not used[i]]

    k_found, k_fa = assign(khama)
    f_found, f_fa = assign(ff)
    fa = [("Khama", d) for d in k_fa] + [("FFmpeg 0.3", d) for d in f_fa]

    def shots(s: int, e: int) -> list[int]:
        return [max(0, s - 1), (s + e) // 2, e + 1] if e - s > 2 else [max(0, s - 1), e]

    want = [n for s, e, *_ in gt for n in shots(s, e)] + [n for _, (s, e) in fa for n in shots(s, e)]
    img = frames(video, want)

    f_t, f_b, f_s = font(15, True), font(14), font(12)
    cols = 3
    left = cols * TW + (cols - 1) * GAPX
    W = PAD * 2 + left + 16 + 300
    rows = len(gt) + (1 + len(fa) if fa else 0)
    H = PAD * 2 + 64 + rows * (TH + 10) + (24 if fa else 0)
    out = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(out)
    found_k, found_f = sum(k_found), sum(f_found)
    dr.text((PAD, PAD), f"{video.stem}: {len(gt)} hand-labelled transitions", font=font(19, True), fill=TEXT)
    dr.text((PAD, PAD + 28), f"Found by Khama {found_k}/{len(gt)} (false alarms {len(k_fa)})    "
            f"FFmpeg scene > 0.3 {found_f}/{len(gt)} (false alarms {len(f_fa)})", font=f_b, fill=DIM)
    y = PAD + 64

    def badge(x, yy, label, ok):
        col = OK if ok else MISS
        txt = f"{label}  {'found' if ok else 'missed'}"
        w = dr.textlength(txt, font=f_s) + 16
        dr.rounded_rectangle((x, yy, x + w, yy + 22), radius=11, outline=col, width=1, fill=CARD)
        dr.text((x + 8, yy + 3), txt, font=f_s, fill=col)
        return x + w + 8

    def row(nums, title, sub):
        nonlocal y
        dr.rounded_rectangle((PAD - 6, y - 5, W - PAD + 6, y + TH + 5), radius=10, fill=CARD)
        x = PAD
        for i, n in enumerate(nums):
            out.paste(img[n], (x, y))
            dr.text((x + 4, y + TH - 18), f"#{n}", font=f_s, fill=(255, 255, 255))
            x += TW + GAPX
        tx = PAD + left + 16
        dr.text((tx, y + 2), title, font=f_t, fill=TEXT)
        dr.text((tx, y + 24), sub, font=f_s, fill=DIM)
        return tx, y + 52

    for j, (s, e, kind, typ) in enumerate(gt):
        tx, by = row(shots(s, e), ("Cut" if kind == "cut" else f"Gradual: {typ}"),
                     f"frames {s}-{e}  ·  {s / fps:.1f} s" + (f"  ·  {(e - s) / fps:.1f} s long" if kind != "cut" else ""))
        x = badge(tx, by, "Khama", k_found[j])
        badge(x, by, "FFmpeg 0.3", f_found[j])
        y += TH + 10
    if fa:
        y += 8
        dr.text((PAD, y), "False alarms (reported, but not a shot change)", font=font(16, True), fill=TEXT)
        y += 30
        for who, (s, e) in fa:
            row(shots(s, e), f"{who}: false alarm", f"frames {s}-{e}  ·  {s / fps:.1f} s")
            y += TH + 10
    out = out.crop((0, 0, W, y + PAD))
    dest = RESULTS / f"scenes_film_strip{'' if a.labels.stem == 'sintel_trailer' else '_' + a.labels.stem}.png"
    out.save(dest, optimize=True)
    print(dest, found_k, found_f, len(k_fa), len(f_fa))


if __name__ == "__main__":
    main()
