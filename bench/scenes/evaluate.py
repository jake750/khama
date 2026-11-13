"""Evaluates Khama's shot-boundary detector against FFmpeg's scene score.

    python scenes/evaluate.py                 # synthetic set in data/scenes
    python scenes/evaluate.py --data work/fake_scenes --tag smoke

Protocol
- The videos are split in two halves: parameters are tuned on "dev", numbers are reported on "test".
- A detection matches a ground-truth transition when their frame spans overlap within ±TOL frames;
  matching is one-to-one (each transition can be found once, extra detections are false positives).
- Precision P = TP / (TP + FP), Recall R = TP / (TP + FN), F1 = 2PR / (P + R).
- FFmpeg baseline: the app's previous detector, `select='gt(scene,T)'` on frames scaled to 320 px,
  i.e. every frame whose scene score exceeds T is a boundary. T is swept from 0.05 to 0.6.

Outputs (results/): scenes_grid_dev.csv, scenes_ffmpeg_dev.csv, scenes_test.csv, scenes_pr.png
"""

from __future__ import annotations

import argparse
import itertools
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pandas as pd  # noqa: E402

from common import DATA, RESULTS, WORK, bench_bin, ffmpeg  # noqa: E402

TOL = 2
FF_THRESHOLDS = [round(0.05 + 0.025 * i, 3) for i in range(23)]


def grid() -> list[dict]:
    """Parameter sets explored on the dev half (two stages folded into one grid)."""
    out = []
    for alpha, k, robust, min_score, window in itertools.product(
        [1.0, 0.5, 0.0], [3.0, 4.0, 5.0, 6.0], [True, False], [0.15, 0.22, 0.3], [12, 18, 30]
    ):
        out.append(dict(alpha=alpha, k=k, robust=robust, min_score=min_score, window=window, gradual=False))
    for alpha, k_low, grad_min, low_floor in itertools.product([1.0, 0.5, 0.0], [1.5, 2.0, 3.0], [0.25, 0.35, 0.45], [0.02, 0.03, 0.05]):
        out.append(dict(alpha=alpha, k=4.0, robust=True, min_score=0.22, window=18, gradual=True, k_low=k_low,
                        grad_min=grad_min, low_floor=low_floor))
    out.append({})  # the shipped defaults
    return out


def match(gt: list[dict], det: list[tuple[int, int]], flashes: list[int]) -> dict:
    used = [False] * len(det)
    tp = {"cut": 0, "gradual": 0}
    n = {"cut": 0, "gradual": 0}
    for g in gt:
        n[g["kind"]] += 1
        for i, (ds, de) in enumerate(det):
            if not used[i] and ds <= g["end"] + TOL and de >= g["start"] - TOL:
                used[i] = True
                tp[g["kind"]] += 1
                break
    fp = used.count(False)
    flash_fp = sum(1 for i, (ds, de) in enumerate(det) if not used[i] and any(ds - TOL <= f <= de + TOL for f in flashes))
    return dict(tp=sum(tp.values()), fp=fp, fn=len(gt) - sum(tp.values()), tp_cut=tp["cut"], n_cut=n["cut"],
                tp_grad=tp["gradual"], n_grad=n["gradual"], flash_fp=flash_fp, n_flash=len(flashes))


def prf(rows: list[dict]) -> dict:
    s = pd.DataFrame(rows).sum(numeric_only=True)
    p = s.tp / max(1, s.tp + s.fp)
    r = s.tp / max(1, s.tp + s.fn)
    return dict(P=p, R=r, F1=0 if p + r == 0 else 2 * p * r / (p + r), R_cut=s.tp_cut / max(1, s.n_cut),
                R_grad=s.tp_grad / max(1, s.n_grad), flash_fp=int(s.flash_fp), n_flash=int(s.n_flash),
                tp=int(s.tp), fp=int(s.fp), fn=int(s.fn))


def ffmpeg_scores(video: Path, cache: Path) -> tuple[list[float], float]:
    """FFmpeg scene score of every frame, exactly as the app computed it (scaled to 320 px)."""
    if cache.exists():
        j = json.loads(cache.read_text())
        return j["scores"], j["seconds"]
    t0 = time.perf_counter()
    meta = cache.with_suffix(".txt")
    ffmpeg("-i", video.resolve(), "-map", "0:v:0", "-vf", f"scale=320:-2,select='gte(scene,0)',metadata=print:file={meta.name}",
           "-f", "null", "-", cwd=cache.parent)
    secs = time.perf_counter() - t0
    scores = [float(x) for x in re.findall(r"lavfi\.scene_score=([0-9.eE+-]+)", meta.read_text())]
    cache.write_text(json.dumps(dict(scores=scores, seconds=secs)))
    meta.unlink()
    return scores, secs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=DATA / "scenes")
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    videos = sorted(a.data.resolve().glob("v*.mp4"))
    if not videos:
        raise SystemExit("no videos: run scenes/make_dataset.py first")
    work = WORK / ("scenes" + (f"_{a.tag}" if a.tag else ""))
    work.mkdir(parents=True, exist_ok=True)
    half = len(videos) // 2 or 1
    split = {v.stem: ("dev" if i < half else "test") for i, v in enumerate(videos)}

    params = grid()
    (work / "grid.json").write_text(json.dumps(params))
    khama, ff, truth = {}, {}, {}
    for v in videos:
        truth[v.stem] = json.loads(v.with_suffix(".json").read_text())
        c = work / f"{v.stem}.khama.json"
        if not c.exists():
            c.write_text(json.dumps(bench_bin("scenes", v, "--grid", work / "grid.json")))
        khama[v.stem] = json.loads(c.read_text())
        ff[v.stem] = ffmpeg_scores(v, work / f"{v.stem}.ffmpeg.json")
        print(v.stem, split[v.stem], "ok", flush=True)

    def khama_rows(pi: int, part: str) -> list[dict]:
        rows = []
        for name, j in khama.items():
            if split[name] != part:
                continue
            det = [(b["start"], b["end"]) for b in j["results"][pi]["boundaries"]]
            rows.append(match(truth[name]["transitions"], det, truth[name]["flashes"]))
        return rows

    def ff_rows(thr: float, part: str) -> list[dict]:
        rows = []
        for name, (scores, _) in ff.items():
            if split[name] != part:
                continue
            det = [(i - 1, i) for i, s in enumerate(scores) if s > thr and i > 0]
            rows.append(match(truth[name]["transitions"], det, truth[name]["flashes"]))
        return rows

    # ---- dev: explore ----
    dev = []
    for pi, p in enumerate(params):
        full = khama[videos[0].stem]["results"][pi]["params"]
        dev.append(dict(config=pi, **{f"p_{k}": v for k, v in full.items()}, **prf(khama_rows(pi, "dev"))))
    dev = pd.DataFrame(dev).sort_values("F1", ascending=False)
    dev.to_csv(RESULTS / f"scenes_grid_dev{a.tag and '_' + a.tag}.csv", index=False, float_format="%.4f")
    ffdev = pd.DataFrame([dict(threshold=t, **prf(ff_rows(t, "dev"))) for t in FF_THRESHOLDS])
    ffdev.to_csv(RESULTS / f"scenes_ffmpeg_dev{a.tag and '_' + a.tag}.csv", index=False, float_format="%.4f")

    best = int(dev.iloc[0].config)
    best_ff = float(ffdev.sort_values("F1", ascending=False).iloc[0].threshold)
    default_cfg = len(params) - 1
    cut_only = int(dev[dev.p_gradual == False].iloc[0].config)  # noqa: E712

    # ---- test: report ----
    rows = [
        dict(method="FFmpeg scene > 0.30 (old stills)", **prf(ff_rows(0.30, "test"))),
        dict(method="FFmpeg scene > 0.32 (old detect)", **prf(ff_rows(0.32, "test"))),
        dict(method=f"FFmpeg scene > {best_ff} (best on dev)", **prf(ff_rows(best_ff, "test"))),
        dict(method="Khama, cuts only (best on dev)", config=cut_only, **prf(khama_rows(cut_only, "test"))),
        dict(method="Khama, full (best on dev)", config=best, **prf(khama_rows(best, "test"))),
        dict(method="Khama, shipped defaults", config=default_cfg, **prf(khama_rows(default_cfg, "test"))),
    ]
    test = pd.DataFrame(rows)
    test.to_csv(RESULTS / f"scenes_test{a.tag and '_' + a.tag}.csv", index=False, float_format="%.4f")
    print(test[["method", "P", "R", "F1", "R_cut", "R_grad", "flash_fp", "n_flash"]].to_string(index=False))
    print("best dev config:", json.dumps(khama[videos[0].stem]["results"][best]["params"]))

    # timing
    k_s = sum(j["decode_s"] for j in khama.values())
    f_s = sum(s for _, s in ff.values())
    frames = sum(j["frames"] for j in khama.values())
    pd.DataFrame([dict(method="khama (decode+features, 160x90)", seconds=k_s, frames=frames, fps=frames / k_s),
                  dict(method="ffmpeg scene score (320 px)", seconds=f_s, frames=frames, fps=frames / f_s)]).to_csv(
        RESULTS / f"scenes_speed{a.tag and '_' + a.tag}.csv", index=False, float_format="%.3f")

    # ---- figure: precision-recall on test ----
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fftest = pd.DataFrame([dict(threshold=t, **prf(ff_rows(t, "test"))) for t in FF_THRESHOLDS])
    fig, ax = plt.subplots(figsize=(5.2, 4.2), dpi=150)
    ax.plot(fftest.R, fftest.P, "o-", ms=3, color="#888", label="FFmpeg scene score, T = 0.05 ... 0.6")
    for t in (0.3,):
        r = fftest[fftest.threshold.round(3) == t].iloc[0]
        ax.annotate(f"T = {t}", (r.R, r.P), textcoords="offset points", xytext=(6, -10), fontsize=8, color="#555")
    for _, r in test[test.method.str.startswith("Khama")].iterrows():
        ax.plot(r.R, r.P, "*", ms=11, label=r.method)
    ax.set_xlabel("Recall")
    ax.set_ylabel("Precision")
    ax.set_xlim(0, 1.02)
    ax.set_ylim(0, 1.02)
    ax.grid(alpha=0.3)
    ax.legend(fontsize=7, loc="lower left")
    ax.set_title("Shot-boundary detection, test half", fontsize=10)
    fig.tight_layout()
    fig.savefig(RESULTS / f"scenes_pr{a.tag and '_' + a.tag}.png")


if __name__ == "__main__":
    main()
