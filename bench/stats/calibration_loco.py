"""Leave-one-clip-out check of the Quick Sync calibration (review item R3-A2).

    python bench/stats/calibration_loco.py      # reads bench/results/codecs_raw.csv, needs numpy only

The calibration in codecs/analyze.py builds the table c -> q(c) from all 12 clips and then measures its
error on the same 12 clips, so the reported error is in-sample. Here each clip is held out in turn:
the table is rebuilt from the other 11 clips exactly as the app's table was built (VMAF target from the
software curve, inverse of the hardware curve, median over clips, rounded like calibrated_quality()),
and the error is measured on the held-out clip only.

Output: bench/results/stats_calibration_loco.csv (one row per encoder and CRF) and a summary on stdout.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

import numpy as np

RESULTS = Path(__file__).resolve().parents[1] / "results"
APP_CRF = {"h264_qsv": [16, 17, 18, 19, 21, 22, 23, 26, 30], "hevc_qsv": [19, 23, 28]}
REFERENCE = {"h264_qsv": "libx264", "hevc_qsv": "libx265"}


def load() -> dict:
    """curves[(clip, encoder)] = arrays q, vmaf, kbps sorted by q."""
    rows = defaultdict(list)
    with open(RESULTS / "codecs_raw.csv", newline="") as f:
        for r in csv.DictReader(f):
            rows[(r["clip"], r["encoder"])].append((float(r["q"]), float(r["vmaf"]), float(r["kbps"])))
    out = {}
    for k, v in rows.items():
        a = np.array(sorted(v))
        out[k] = {"q": a[:, 0], "vmaf": a[:, 1], "kbps": a[:, 2]}
    return out


def at(c: dict, q: float, col: str) -> float:
    return float(np.interp(q, c["q"], c[col]))


def hw_q_for(curves: dict, clip: str, hw: str, crf: int) -> float:
    """Hardware q that reaches, on this clip, the VMAF of the software encoder at this CRF."""
    s, h = curves[(clip, REFERENCE[hw])], curves[(clip, hw)]
    target = at(s, crf, "vmaf")
    return float(np.interp(target, h["vmaf"][::-1], h["q"][::-1]))  # VMAF falls with q


def main() -> None:
    curves = load()
    clips = sorted({c for c, _ in curves})
    out, pooled = [], defaultdict(list)
    for hw, crfs in APP_CRF.items():
        for crf in crfs:
            all_q = {c: hw_q_for(curves, c, hw, crf) for c in clips}
            q_in = round(float(np.median(list(all_q.values()))))
            err_in, err_loco, err_old, size_loco, q_loco_all = [], [], [], [], []
            for k in clips:
                q_loco = round(float(np.median([all_q[c] for c in clips if c != k])))
                q_loco_all.append(q_loco)
                s, h = curves[(k, REFERENCE[hw])], curves[(k, hw)]
                target = at(s, crf, "vmaf")
                err_in.append(at(h, q_in, "vmaf") - target)
                err_loco.append(at(h, q_loco, "vmaf") - target)
                err_old.append(at(h, crf + 1, "vmaf") - target)
                size_loco.append(at(h, q_loco, "kbps") / at(s, crf, "kbps"))
                for rule, q in (("old", crf + 1), ("in", q_in), ("loco", q_loco)):
                    pooled[(hw, rule)].append(at(h, q, "kbps") / at(s, crf, "kbps"))
            out.append(dict(
                encoder=hw, crf=crf, q_in_sample=q_in,
                q_loco_min=min(q_loco_all), q_loco_max=max(q_loco_all),
                old_median=np.median(err_old), in_median=np.median(err_in), loco_median=np.median(err_loco),
                old_mae=np.mean(np.abs(err_old)), in_mae=np.mean(np.abs(err_in)), loco_mae=np.mean(np.abs(err_loco)),
                loco_size_median=np.median(size_loco), clips=len(clips)))
    path = RESULTS / "stats_calibration_loco.csv"
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0]))
        w.writeheader()
        for r in out:
            w.writerow({k: (f"{v:.3f}" if isinstance(v, float) else v) for k, v in r.items()})
    print(f"wrote {path}")
    for hw in APP_CRF:
        rs = [r for r in out if r["encoder"] == hw]
        rng = lambda key: f"{min(r[key] for r in rs):+.2f} .. {max(r[key] for r in rs):+.2f}"  # noqa: E731
        print(f"{hw}: median error  old {rng('old_median')}  in-sample {rng('in_median')}  leave-one-out {rng('loco_median')}")
        print(f"{hw}: mean |error|  old {np.mean([r['old_mae'] for r in rs]):.2f}  in-sample {np.mean([r['in_mae'] for r in rs]):.2f}"
              f"  leave-one-out {np.mean([r['loco_mae'] for r in rs]):.2f}")
        print(f"{hw}: held-out q differs from the full-data q by at most "
              f"{max(max(abs(r['q_loco_min'] - r['q_in_sample']), abs(r['q_loco_max'] - r['q_in_sample'])) for r in rs)}"
              f"; median size vs software {min(r['loco_size_median'] for r in rs):.2f}..{max(r['loco_size_median'] for r in rs):.2f}")
        old, ins, loco = (float(np.median(pooled[(hw, k)])) for k in ("old", "in", "loco"))
        print(f"{hw}: size vs software, median over all clips and CRFs: old {old:.2f}x  in-sample {ins:.2f}x"
              f" ({ins / old - 1:+.0%})  leave-one-out {loco:.2f}x ({loco / old - 1:+.0%})")


if __name__ == "__main__":
    main()
