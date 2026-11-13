"""Encodes every reference clip with every encoder over a grid of quality settings and measures it.

    python codecs/run_bench.py                    # all clips in data/clips
    python codecs/run_bench.py --clips mobcal johnny --encoders libx264 h264_qsv

For every (clip, encoder, setting) it records: file size, bitrate, encoding time and speed (fps),
and the quality against the lossless reference: VMAF (model vmaf_v0.6.1), PSNR (Y and mean YUV)
and SSIM, all computed in one pass by FFmpeg's libvmaf filter. Results are appended to
results/codecs_raw.csv (one row per encode), so the script can be interrupted and resumed.

The encoder arguments are the ones Khama uses in convert.rs (codec_args), only the quality value varies.
Encoders that do not work on this machine are probed once and listed in results/codecs_hw.csv.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA, RESULTS, WORK, ffmpeg, probe, run, FFMPEG  # noqa: E402

# encoder -> (quality values, function returning FFmpeg arguments, quality parameter name)
ENCODERS = {
    "libx264": (list(range(14, 35, 2)), lambda q: ["-c:v", "libx264", "-preset", "fast", "-crf", str(q), "-profile:v", "high", "-pix_fmt", "yuv420p"], "crf"),
    "libx265": ([16, 19, 22, 25, 28, 31, 34, 37], lambda q: ["-c:v", "libx265", "-preset", "fast", "-crf", str(q), "-pix_fmt", "yuv420p", "-x265-params", "log-level=error"], "crf"),
    "libsvtav1": ([20, 24, 28, 32, 36, 40, 44, 48, 52], lambda q: ["-c:v", "libsvtav1", "-preset", "8", "-crf", str(q), "-pix_fmt", "yuv420p"], "crf"),
    "h264_qsv": (list(range(14, 37, 2)), lambda q: ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", str(q), "-pix_fmt", "nv12"], "global_quality"),
    "hevc_qsv": (list(range(14, 39, 2)), lambda q: ["-c:v", "hevc_qsv", "-preset", "medium", "-global_quality", str(q), "-pix_fmt", "nv12"], "global_quality"),
    "h264_nvenc": (list(range(14, 37, 2)), lambda q: ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", str(q), "-b:v", "0", "-pix_fmt", "yuv420p"], "cq"),
    "hevc_nvenc": (list(range(14, 39, 2)), lambda q: ["-c:v", "hevc_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", str(q), "-b:v", "0", "-pix_fmt", "yuv420p"], "cq"),
    "av1_qsv": (list(range(20, 53, 4)), lambda q: ["-c:v", "av1_qsv", "-preset", "medium", "-global_quality", str(q), "-pix_fmt", "nv12"], "global_quality"),
}

FIELDS = ["clip", "encoder", "param", "q", "frames", "fps_src", "width", "height", "bytes", "kbps", "encode_s",
          "encode_fps", "vmaf", "vmaf_p5", "psnr_y", "psnr_yuv", "ssim"]


def works(enc: str) -> tuple[bool, str]:
    """Tries the encoder on one second of a test pattern."""
    args = ENCODERS[enc][1](ENCODERS[enc][0][len(ENCODERS[enc][0]) // 2])
    try:
        ffmpeg("-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=25:d=1", *args, "-f", "null", "-")
        return True, ""
    except RuntimeError as e:
        return False, str(e)[:200]


def quality(dist: Path, ref: Path, threads: int) -> dict:
    """VMAF, PSNR and SSIM of `dist` against `ref` in one libvmaf pass."""
    log = dist.with_suffix(".vmaf.json")
    graph = (
        "[0:v]format=yuv420p,setpts=PTS-STARTPTS[d];[1:v]format=yuv420p,setpts=PTS-STARTPTS[r];"
        f"[d][r]libvmaf=log_fmt=json:log_path={log.name}:n_threads={threads}:feature=name=psnr|name=float_ssim"
    )
    ffmpeg("-v", "error", "-i", dist.name, "-i", ref, "-lavfi", graph, "-f", "null", "-", cwd=dist.parent)
    j = json.loads(log.read_text())
    pooled = j["pooled_metrics"]
    frames = j["frames"]
    v = sorted(f["metrics"]["vmaf"] for f in frames)
    log.unlink()
    psnr_y = pooled["psnr_y"]["mean"]
    psnr_yuv = (4 * psnr_y + pooled["psnr_cb"]["mean"] + pooled["psnr_cr"]["mean"]) / 6  # 4:2:0 weighting
    return dict(vmaf=pooled["vmaf"]["mean"], vmaf_p5=v[max(0, int(0.05 * len(v)) - 1)], psnr_y=psnr_y,
                psnr_yuv=psnr_yuv, ssim=pooled["float_ssim"]["mean"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", nargs="*")
    ap.add_argument("--encoders", nargs="*", default=list(ENCODERS))
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    a = ap.parse_args()

    clips = sorted((DATA / "clips").glob("*.mkv"))
    if a.clips:
        clips = [c for c in clips if c.stem in a.clips]
    if not clips:
        raise SystemExit("no clips: run fetch_clips.py first")

    hw_rows, encoders = [], []
    for e in a.encoders:
        ok, why = works(e)
        hw_rows.append(dict(encoder=e, works=ok, error=why))
        if ok:
            encoders.append(e)
        print(f"{e}: {'ok' if ok else 'not available'}", flush=True)
    with open(RESULTS / "codecs_hw.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["encoder", "works", "error"])
        w.writeheader()
        w.writerows(hw_rows)

    out = RESULTS / "codecs_raw.csv"
    done = set()
    if out.exists():
        with open(out, encoding="utf-8") as f:
            done = {(r["clip"], r["encoder"], r["q"]) for r in csv.DictReader(f)}
    new = not out.exists()
    work = WORK / "codecs"
    work.mkdir(parents=True, exist_ok=True)
    with open(out, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        for clip in clips:
            s = probe(clip)["streams"][0]
            num, den = map(int, s["r_frame_rate"].split("/"))
            fps = num / den
            for e in encoders:
                qs, args, pname = ENCODERS[e]
                for q in qs:
                    if (clip.stem, e, str(q)) in done:
                        continue
                    dist = work / f"{clip.stem}.{e}.{q}.mkv"
                    t0 = time.perf_counter()
                    ffmpeg("-v", "error", "-i", clip, *args(q), "-an", dist)
                    secs = time.perf_counter() - t0
                    frames = int(probe(dist)["streams"][0].get("nb_frames") or 0) or None
                    if frames is None:
                        frames = int(run([FFMPEG.with_name(FFMPEG.name.replace("ffmpeg", "ffprobe")), "-v", "error", "-count_frames",
                                          "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", dist]).stdout.strip())
                    size = dist.stat().st_size
                    m = quality(dist, clip.resolve(), a.threads)
                    row = dict(clip=clip.stem, encoder=e, param=pname, q=q, frames=frames, fps_src=round(fps, 3),
                               width=s["width"], height=s["height"], bytes=size, kbps=size * 8 / (frames / fps) / 1000,
                               encode_s=secs, encode_fps=frames / secs, **m)
                    w.writerow(row)
                    f.flush()
                    dist.unlink()
                    print(f"{clip.stem:14s} {e:10s} {pname}={q:<3} {row['kbps']:8.0f} kb/s  VMAF {m['vmaf']:6.2f}  "
                          f"PSNR {m['psnr_y']:5.2f}  {row['encode_fps']:6.1f} fps", flush=True)


if __name__ == "__main__":
    main()
