"""Rate-distortion curves, BD-rate and the calibration of the hardware encoders.

    python codecs/analyze.py            # reads results/codecs_raw.csv

1. RD curves: quality (VMAF, PSNR, SSIM) against bitrate, per clip and averaged.
2. BD-rate (Bjontegaard delta rate) of each encoder against libx264: for each clip, log(bitrate)
   is interpolated as a function of quality with a monotone cubic (PCHIP) on both curves, the
   difference is averaged over the overlapping quality range, and
        BD-rate = exp( mean_q [ log R_test(q) - log R_ref(q) ] ) - 1
   (negative = fewer bits for the same quality). Reported per clip and as the mean over clips.
3. Calibration: Khama's presets use x264 CRF values (and x265 for HEVC). For each such CRF and each
   clip we find the hardware quality value that gives the SAME VMAF (linear interpolation of the
   monotone VMAF(q) curve), then take the median over clips. This table replaces `crf + 1`.

Outputs: results/codecs_summary.csv, results/codecs_bdrate.csv, results/codecs_calibration.csv,
         results/codecs_rd_*.png, results/codecs_calibration.png
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy.interpolate import PchipInterpolator  # noqa: E402

from common import RESULTS  # noqa: E402

# CRF values that Khama's presets pass to codec_args (convert.rs)
APP_CRF_H264 = [16, 17, 18, 19, 21, 22, 23, 26, 30]
APP_CRF_HEVC = [19, 23, 28]
# hardware encoder -> software encoder whose quality it must match
CALIBRATE = {"h264_qsv": "libx264", "hevc_qsv": "libx265", "h264_nvenc": "libx264", "hevc_nvenc": "libx265"}
COLORS = {"libx264": "#1f77b4", "libx265": "#2ca02c", "libsvtav1": "#9467bd", "h264_qsv": "#ff7f0e",
          "hevc_qsv": "#d62728", "h264_nvenc": "#8c564b", "hevc_nvenc": "#e377c2", "av1_qsv": "#7f7f7f"}


def bd_rate(ref: pd.DataFrame, test: pd.DataFrame, metric: str) -> float | None:
    """Bjontegaard delta rate (%) of `test` vs `ref`, PCHIP interpolation of log-rate over quality."""
    curves = []
    for d in (ref, test):
        d = d.sort_values(metric).drop_duplicates(metric)
        if len(d) < 4:
            return None
        curves.append((d[metric].to_numpy(), np.log(d.kbps.to_numpy())))
    lo = max(curves[0][0].min(), curves[1][0].min())
    hi = min(curves[0][0].max(), curves[1][0].max())
    if hi - lo < 1e-6:
        return None
    q = np.linspace(lo, hi, 200)
    # log-rate must be monotone in quality for PCHIP to be meaningful: enforce with a running max
    vals = []
    for x, y in curves:
        y = np.maximum.accumulate(y)
        vals.append(PchipInterpolator(x, y)(q))
    return float((np.exp(np.trapezoid(vals[1] - vals[0], q) / (hi - lo)) - 1) * 100)


def calibrate(raw: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for hw, sw in CALIBRATE.items():
        if hw not in set(raw.encoder):
            continue
        crfs = APP_CRF_H264 if sw == "libx264" else APP_CRF_HEVC
        for crf in crfs:
            targets, values = [], []
            for clip, g in raw.groupby("clip"):
                s = g[g.encoder == sw].sort_values("q")
                h = g[g.encoder == hw].sort_values("q")
                if len(s) < 2 or len(h) < 2:
                    continue
                target = float(np.interp(crf, s.q, s.vmaf))  # VMAF of the software encoder at this CRF
                # VMAF decreases with q: interpolate q on the reversed (increasing) curve
                hq = np.interp(target, h.vmaf.to_numpy()[::-1], h.q.to_numpy()[::-1])
                targets.append(target)
                values.append(hq)
            if values:
                rows.append(dict(encoder=hw, reference=sw, crf=crf, vmaf_target=np.mean(targets),
                                 q_median=np.median(values), q_mean=np.mean(values), q_min=np.min(values),
                                 q_max=np.max(values), clips=len(values), q_old=crf + 1, q_new=int(round(np.median(values)))))
    return pd.DataFrame(rows)


def check_calibration(raw: pd.DataFrame, cal: pd.DataFrame) -> pd.DataFrame:
    """Per clip: VMAF error and size ratio vs the software encoder, for the old rule (crf + 1) and the table."""
    def at(enc, clip, q, col):
        d = raw[(raw.encoder == enc) & (raw["clip"] == clip)].sort_values("q")
        return float(np.interp(q, d.q, d[col]))

    rows = []
    for _, x in cal.iterrows():
        for clip in raw["clip"].unique():
            t, tb = at(x.reference, clip, x.crf, "vmaf"), at(x.reference, clip, x.crf, "kbps")
            rows.append(dict(enc=x.encoder, crf=x.crf,
                             old=at(x.encoder, clip, x.q_old, "vmaf") - t, new=at(x.encoder, clip, x.q_new, "vmaf") - t,
                             bo=at(x.encoder, clip, x.q_old, "kbps") / tb, bn=at(x.encoder, clip, x.q_new, "kbps") / tb))
    d = pd.DataFrame(rows)
    return d.groupby(["enc", "crf"]).agg(
        old_med=("old", "median"), new_med=("new", "median"),
        old_abs=("old", lambda v: v.abs().mean()), new_abs=("new", lambda v: v.abs().mean()),
        size_old=("bo", "median"), size_new=("bn", "median"))


def main() -> None:
    raw = pd.read_csv(RESULTS / "codecs_raw.csv")
    encoders = [e for e in COLORS if e in set(raw.encoder)]

    # ---- summary per encoder ----
    summ = raw.groupby("encoder").agg(encodes=("vmaf", "size"), clips=("clip", "nunique"), encode_fps=("encode_fps", "median"),
                                      vmaf_min=("vmaf", "min"), vmaf_max=("vmaf", "max")).reset_index()
    summ.to_csv(RESULTS / "codecs_summary.csv", index=False, float_format="%.2f")

    # ---- BD-rate vs libx264 ----
    rows = []
    for metric in ("vmaf", "psnr_yuv", "ssim"):
        for e in encoders:
            if e == "libx264":
                continue
            per = []
            for clip, g in raw.groupby("clip"):
                v = bd_rate(g[g.encoder == "libx264"], g[g.encoder == e], metric)
                if v is not None:
                    per.append(v)
                    rows.append(dict(metric=metric, encoder=e, clip=clip, bd_rate=v))
            if per:
                rows.append(dict(metric=metric, encoder=e, clip="MEAN", bd_rate=float(np.mean(per))))
    bd = pd.DataFrame(rows)
    bd.to_csv(RESULTS / "codecs_bdrate.csv", index=False, float_format="%.2f")
    if not bd.empty:
        print(bd[bd["clip"] == "MEAN"].pivot(index="encoder", columns="metric", values="bd_rate").round(1).to_string())

    # ---- calibration ----
    cal = calibrate(raw)
    cal.to_csv(RESULTS / "codecs_calibration.csv", index=False, float_format="%.2f")
    check_calibration(raw, cal).to_csv(RESULTS / "codecs_calibration_check.csv", float_format="%.3f")
    if not cal.empty:
        print(cal[["encoder", "crf", "vmaf_target", "q_old", "q_new", "q_min", "q_max"]].round(2).to_string(index=False))

    # ---- figures ----
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    for metric, label in (("vmaf", "VMAF"), ("psnr_yuv", "PSNR-YUV (dB)"), ("ssim", "SSIM")):
        clips = sorted(raw["clip"].unique())
        cols = 4
        rows_n = (len(clips) + cols - 1) // cols
        fig, axes = plt.subplots(rows_n, cols, figsize=(3.2 * cols, 2.6 * rows_n), dpi=120, squeeze=False)
        for ax, clip in zip(axes.flat, clips):
            g = raw[raw["clip"] == clip]
            for e in encoders:
                d = g[g.encoder == e].sort_values("kbps")
                ax.plot(d.kbps, d[metric], "o-", ms=2.5, lw=1.2, color=COLORS[e], label=e)
            ax.set_xscale("log")
            ax.set_title(clip, fontsize=9)
            ax.grid(alpha=0.3, which="both")
            ax.tick_params(labelsize=7)
        for ax in list(axes.flat)[len(clips):]:
            ax.axis("off")
        axes.flat[0].legend(fontsize=6)
        fig.supxlabel("bitrate (kb/s, log scale)")
        fig.supylabel(label)
        fig.tight_layout()
        fig.savefig(RESULTS / f"codecs_rd_{metric}.png")
        plt.close(fig)

    if not cal.empty:
        fig, ax = plt.subplots(figsize=(5, 4), dpi=150)
        for hw, g in cal.groupby("encoder"):
            ax.errorbar(g.crf, g.q_median, yerr=[g.q_median - g.q_min, g.q_max - g.q_median], fmt="o-", capsize=3,
                        color=COLORS.get(hw), label=f"{hw}: measured (median, min-max over clips)")
            ax.plot(g.crf, g.q_old, "--", color=COLORS.get(hw), alpha=0.5, label=f"{hw}: old rule q = crf + 1")
        ax.set_xlabel("software CRF used by the preset (x264 / x265)")
        ax.set_ylabel("hardware quality value with the same VMAF")
        ax.grid(alpha=0.3)
        ax.legend(fontsize=7)
        fig.tight_layout()
        fig.savefig(RESULTS / "codecs_calibration.png")


if __name__ == "__main__":
    main()
