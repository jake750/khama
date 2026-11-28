"""Uncertainty and significance for the numbers in chapter 6 of the report (review items R3-A9, R3-A31).

    python bench/stats/report_stats.py      # reads bench/results/*.csv, needs numpy and scipy

Everything is computed from the CSV files already in bench/results; nothing is re-measured.

1. Shot boundaries (scenes_test.csv, scenes_ablation.csv): only pooled counts (tp, fp, fn) are stored, not
   per-video results, so a video-level bootstrap is not possible from the repository. Instead:
   - Wilson 95 % intervals for P = tp/(tp+fp) and R = tp/(tp+fn);
   - a 95 % interval for F1 from a bootstrap over the pooled detection events (tp, fp, fn);
   - McNemar's exact test on recall against the full detector. Which transitions each method found is
     not stored either, so the test is run for every pairing consistent with the counts and the range
     of p-values is reported: if even the largest p is below 0.05 the difference is significant
     whatever the pairing, if even the smallest p is above 0.05 it is not.
   Events from the same video are not independent, so these intervals are narrower than a video-level
   bootstrap would give. evaluate.py would need to save per-video results to remove that limit.
2. Separation (separation_tracks.csv): per configuration against the default, on the 50 songs: median
   paired difference of SDR, Wilcoxon signed-rank test, matched-pairs rank-biserial correlation (effect
   size), and Holm's correction over the 10 configurations compared with the default.
3. BD-rate (codecs_bdrate.csv): per encoder and metric over the 12 clips: median, quartiles, range, mean,
   and a bootstrap 95 % interval of the median.
4. Size estimate by formula (estimate_formula.csv, the per-clip table of appendix D): mean absolute error
   per preset with a bootstrap 95 % interval over the 8 clips.

Outputs: bench/results/stats_scenes.csv, stats_separation.csv, stats_bdrate.csv, stats_estimate.csv.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import stats

RESULTS = Path(__file__).resolve().parents[1] / "results"
RNG = np.random.default_rng(2026)
B = 10_000


def read(name: str) -> list[dict]:
    with open(RESULTS / name, newline="") as f:
        return list(csv.DictReader(f))


def write(name: str, rows: list[dict]) -> None:
    with open(RESULTS / name, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: (f"{v:.4g}" if isinstance(v, float) else v) for k, v in r.items()})
    print(f"wrote {RESULTS / name}")


def wilson(k: int, n: int, z: float = 1.959964) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def f1_interval(tp: int, fp: int, fn: int) -> tuple[float, float]:
    n = tp + fp + fn
    draws = RNG.multinomial(n, [tp / n, fp / n, fn / n], size=B)
    f1 = 2 * draws[:, 0] / (2 * draws[:, 0] + draws[:, 1] + draws[:, 2])
    return tuple(np.percentile(f1, [2.5, 97.5]))


def mcnemar_range(tp_a: int, fn_a: int, tp_b: int, fn_b: int) -> tuple[float, float]:
    """Range of exact McNemar p-values on recall over every pairing consistent with the counts."""
    if tp_a < tp_b:
        tp_a, fn_a, tp_b, fn_b = tp_b, fn_b, tp_a, fn_a
    d = tp_a - tp_b  # b - c, with b = found by A only, c = found by B only
    c_max = min(fn_a, tp_b, min(tp_a, fn_b) - d)
    ps = [stats.binomtest(c, 2 * c + d, 0.5).pvalue if 2 * c + d else 1.0 for c in range(0, c_max + 1)]
    return (min(ps), max(ps))


def scenes() -> None:
    rows = []
    full = next(r for r in read("scenes_ablation.csv") if r["variant"] == "full detector")
    ftp, ffn = int(full["tp"]), int(full["fn"])
    for src, key in (("scenes_test.csv", "method"), ("scenes_ablation.csv", "variant")):
        for r in read(src):
            tp, fp, fn = int(r["tp"]), int(r["fp"]), int(r["fn"])
            p_lo, p_hi = wilson(tp, tp + fp)
            r_lo, r_hi = wilson(tp, tp + fn)
            f_lo, f_hi = f1_interval(tp, fp, fn)
            mc_lo, mc_hi = mcnemar_range(ftp, ffn, tp, fn)
            rows.append(dict(source=src, method=r[key], tp=tp, fp=fp, fn=fn,
                             P=tp / (tp + fp), P_lo=p_lo, P_hi=p_hi, R=tp / (tp + fn), R_lo=r_lo, R_hi=r_hi,
                             F1=2 * tp / (2 * tp + fp + fn), F1_lo=f_lo, F1_hi=f_hi,
                             recall_vs_full_p_min=mc_lo, recall_vs_full_p_max=mc_hi))
    write("stats_scenes.csv", rows)
    for r in rows:
        print(f"  {r['method'][:40]:40s} F1 {r['F1']:.3f} [{r['F1_lo']:.3f}, {r['F1_hi']:.3f}]  "
              f"P [{r['P_lo']:.3f}, {r['P_hi']:.3f}]  R [{r['R_lo']:.3f}, {r['R_hi']:.3f}]  "
              f"McNemar recall vs full p in [{r['recall_vs_full_p_min']:.2g}, {r['recall_vs_full_p_max']:.2g}]")


def holm(ps: list[float]) -> list[float]:
    order = np.argsort(ps)
    m = len(ps)
    adj, running = [0.0] * m, 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * ps[i]))
        adj[i] = running
    return adj


def separation() -> None:
    by = defaultdict(dict)
    for r in read("separation_tracks.csv"):
        by[r["config"]][r["track"]] = r
    base = by["default"]
    tracks = sorted(base)
    rows = []
    for metric in ("sdr_vocals", "sdr_accomp", "join_snr_vocals"):
        block = []
        for cfg in by:
            if cfg == "default":
                continue
            d = np.array([float(by[cfg][t][metric]) - float(base[t][metric]) for t in tracks])
            nz = d[d != 0]
            if len(nz):
                w = stats.wilcoxon(nz)
                ranks = stats.rankdata(np.abs(nz))
                rbc = (ranks[nz > 0].sum() - ranks[nz < 0].sum()) / ranks.sum()
                p = float(w.pvalue)
            else:
                rbc, p = 0.0, 1.0
            q1, q3 = np.percentile(d, [25, 75])
            block.append(dict(metric=metric, config=cfg, n=len(d), median_diff=float(np.median(d)),
                              q1_diff=float(q1), q3_diff=float(q3), songs_better=int((d > 0).sum()),
                              songs_worse=int((d < 0).sum()), wilcoxon_p=p, rank_biserial=float(rbc)))
        for r, a in zip(block, holm([r["wilcoxon_p"] for r in block])):
            r["holm_p"] = a
        rows += block
    for cfg in by:
        v = np.array([float(by[cfg][t]["sdr_vocals"]) for t in tracks])
        q1, q3 = np.percentile(v, [25, 75])
        print(f"  {cfg:18s} vocals SDR median {np.median(v):.2f} dB, IQR [{q1:.2f}, {q3:.2f}]")
    write("stats_separation.csv", rows)
    for r in rows:
        if r["metric"] == "sdr_vocals":
            print(f"  {r['config']:18s} dSDR median {r['median_diff']:+.3f} dB  p {r['wilcoxon_p']:.2g}  Holm {r['holm_p']:.2g}  "
                  f"r {r['rank_biserial']:+.2f}  better/worse {r['songs_better']}/{r['songs_worse']}")


def boot_median(v: np.ndarray) -> tuple[float, float]:
    meds = np.median(RNG.choice(v, size=(B, len(v)), replace=True), axis=1)
    return tuple(np.percentile(meds, [2.5, 97.5]))


def bdrate() -> None:
    groups = defaultdict(list)
    for r in read("codecs_bdrate.csv"):
        if r["clip"] != "MEAN":
            groups[(r["metric"], r["encoder"])].append(float(r["bd_rate"]))
    rows = []
    for (metric, enc), v in sorted(groups.items()):
        v = np.array(v)
        lo, hi = boot_median(v)
        q1, q3 = np.percentile(v, [25, 75])
        rows.append(dict(metric=metric, encoder=enc, clips=len(v), median=float(np.median(v)), q1=float(q1), q3=float(q3),
                         min=float(v.min()), max=float(v.max()), mean=float(v.mean()), median_lo=lo, median_hi=hi))
    write("stats_bdrate.csv", rows)
    for r in rows:
        print(f"  {r['metric']:8s} {r['encoder']:10s} median {r['median']:+.1f}% [{r['median_lo']:+.1f}, {r['median_hi']:+.1f}]"
              f"  IQR [{r['q1']:+.1f}, {r['q3']:+.1f}]  mean {r['mean']:+.1f}%")


def estimate() -> None:
    groups = defaultdict(list)
    for r in read("estimate_formula.csv"):
        groups[(r["preset"], r["quality"])].append(abs(float(r["error_pct"])))
    rows = []
    for (preset, quality), v in groups.items():
        v = np.array(v)
        means = RNG.choice(v, size=(B, len(v)), replace=True).mean(axis=1)
        lo, hi = np.percentile(means, [2.5, 97.5])
        rows.append(dict(preset=preset, quality=quality, clips=len(v), mean_abs_error=float(v.mean()),
                         ci_lo=float(lo), ci_hi=float(hi), median_abs_error=float(np.median(v))))
    write("stats_estimate.csv", rows)
    for r in rows:
        print(f"  {r['preset']:13s} {r['quality']:9s} mean |error| {r['mean_abs_error']:.0f}% [{r['ci_lo']:.0f}, {r['ci_hi']:.0f}]"
              f"  median {r['median_abs_error']:.0f}%  (n={r['clips']})")
    # hypothesis H3: the formula lands within +-50 % of the real size for most content
    crf = {"edit_h264", "youtube", "whatsapp", "h265", "av1", "webm", "proxy"}  # ProRes and DNxHR: fixed bitrate
    all_v = [(p, v) for (p, _), vs in groups.items() for v in vs]
    for name, sel in (("all presets", all_v), ("constant-quality presets (CRF)", [x for x in all_v if x[0] in crf]),
                      ("constant-bitrate presets", [x for x in all_v if x[0] not in crf])):
        within = sum(1 for _, v in sel if v <= 50)
        print(f"  H3, {name}: {within}/{len(sel)} conversions within +-50 % ({within / len(sel):.0%})")


if __name__ == "__main__":
    print("shot boundaries")
    scenes()
    print("separation")
    separation()
    print("BD-rate")
    bdrate()
    print("size estimate (formula)")
    estimate()
