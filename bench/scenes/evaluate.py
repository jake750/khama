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


def stage1() -> list[dict]:
    """Stage 1, hard cuts only (gradual off): colour signal alone, then colour + structural signal."""
    out = []
    for alpha, k, robust, min_score, window in itertools.product(
        [1.0, 0.5, 0.0], [3.0, 4.0, 5.0, 6.0], [True, False], [0.15, 0.22, 0.3], [12, 18, 30]
    ):
        out.append(dict(alpha=alpha, k=k, robust=robust, min_score=min_score, window=window, gradual=False, pixel=False))
    for alpha, k, min_score, k_pix, min_pix in itertools.product(
        [0.5, 0.0], [4.0, 5.0], [0.22, 0.3], [4.0, 6.0, 8.0, 10.0], [0.04, 0.06, 0.08, 0.12]
    ):
        out.append(dict(alpha=alpha, k=k, robust=True, min_score=min_score, window=18, gradual=False, pixel=True,
                        k_pix=k_pix, min_pix=min_pix))
    return out


def stage2(cut: dict) -> list[dict]:
    """Stage 2: gradual transitions on top of the best cut settings."""
    return [dict(cut, gradual=True, k_low=k_low, grad_min=grad_min, low_floor=low_floor)
            for k_low, grad_min, low_floor in itertools.product([1.5, 2.0, 3.0], [0.25, 0.35, 0.45], [0.02, 0.03, 0.05])]


def match(gt: list[dict], det: list[tuple[int, int]], flashes: list[int], ignore: list[dict] | None = None) -> dict:
    # detections inside an "ignore" span (ambiguous parts of a hand-labelled film) count neither way
    if ignore:
        det = [(ds, de) for ds, de in det if not any(ds <= z["end"] and de >= z["start"] for z in ignore)]
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

    khama, ff, truth = {}, {}, {}
    for v in videos:
        truth[v.stem] = json.loads(v.with_suffix(".json").read_text())
        ff[v.stem] = ffmpeg_scores(v, work / f"{v.stem}.ffmpeg.json")

    def run_grid(stage: str, grid: list[dict]) -> int:
        """Runs khama-bench on every video with `grid` (cached); returns the index of the first new config."""
        (work / f"{stage}.json").write_text(json.dumps(grid))
        first = len(next(iter(khama.values()))["results"]) if khama else 0
        for v in videos:
            c = work / f"{v.stem}.{stage}.json"
            if not c.exists() or json.loads(c.read_text()).get("grid") != grid:
                j = bench_bin("scenes", v, "--grid", work / f"{stage}.json")
                j["grid"] = grid
                c.write_text(json.dumps(j))
            j = json.loads(c.read_text())
            if v.stem in khama:
                khama[v.stem]["results"] += j["results"]
            else:
                khama[v.stem] = j
            print(stage, v.stem, split[v.stem], "ok", flush=True)
        return first

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

    def table(lo: int, hi: int) -> pd.DataFrame:
        rows = []
        for pi in range(lo, hi):
            full = khama[videos[0].stem]["results"][pi]["params"]
            rows.append(dict(config=pi, **{f"p_{k}": v for k, v in full.items()}, **prf(khama_rows(pi, "dev"))))
        return pd.DataFrame(rows).sort_values("F1", ascending=False)

    # ---- stage 1 (dev): cut settings ----
    g1 = stage1()
    s1 = run_grid("stage1", g1)
    dev1 = table(s1, s1 + len(g1))
    cut_only = int(dev1.iloc[0].config)
    cut_hist = int(dev1[dev1.p_pixel == False].iloc[0].config)  # noqa: E712
    best_cut = g1[cut_only - s1]

    # ---- stage 2 (dev): gradual settings + ablations of the final detector ----
    g2 = stage2(best_cut)
    s2 = run_grid("stage2", g2 + [{}])
    dev2 = table(s2, s2 + len(g2))
    best = int(dev2.iloc[0].config)
    best_p = g2[best - s2]
    default_cfg = s2 + len(g2)
    ablations = {
        "without structural signal": dict(best_p, pixel=False),
        "without flash rejection": dict(best_p, flash=False),
        "mean/std instead of median/MAD": dict(best_p, robust=False),
        "global histogram only (alpha = 1)": dict(best_p, alpha=1.0),
        "fixed thresholds (k = 0)": dict(best_p, k=0.0, k_pix=0.0, k_low=0.0),
    }
    s3 = run_grid("ablation", list(ablations.values()))

    dev = pd.concat([dev1, dev2]).sort_values("F1", ascending=False)
    dev.to_csv(RESULTS / f"scenes_grid_dev{a.tag and '_' + a.tag}.csv", index=False, float_format="%.4f")
    ffdev = pd.DataFrame([dict(threshold=t, **prf(ff_rows(t, "dev"))) for t in FF_THRESHOLDS])
    ffdev.to_csv(RESULTS / f"scenes_ffmpeg_dev{a.tag and '_' + a.tag}.csv", index=False, float_format="%.4f")
    best_ff = float(ffdev.sort_values("F1", ascending=False).iloc[0].threshold)

    # ---- test: report ----
    rows = [
        dict(method="FFmpeg scene > 0.30 (old stills)", **prf(ff_rows(0.30, "test"))),
        dict(method="FFmpeg scene > 0.32 (old detect)", **prf(ff_rows(0.32, "test"))),
        dict(method=f"FFmpeg scene > {best_ff} (best on dev)", **prf(ff_rows(best_ff, "test"))),
        dict(method="Khama, colour only, cuts only", config=cut_hist, **prf(khama_rows(cut_hist, "test"))),
        dict(method="Khama, colour + structure, cuts only", config=cut_only, **prf(khama_rows(cut_only, "test"))),
        dict(method="Khama, full (best on dev)", config=best, **prf(khama_rows(best, "test"))),
        dict(method="Khama, previous defaults", config=default_cfg, **prf(khama_rows(default_cfg, "test"))),
    ]
    test = pd.DataFrame(rows)
    test.to_csv(RESULTS / f"scenes_test{a.tag and '_' + a.tag}.csv", index=False, float_format="%.4f")
    print(test[["method", "P", "R", "F1", "R_cut", "R_grad", "flash_fp", "n_flash"]].to_string(index=False))
    print("best dev config:", json.dumps(khama[videos[0].stem]["results"][best]["params"]))
    abl = pd.DataFrame([dict(variant="full detector", **prf(khama_rows(best, "test")))] +
                       [dict(variant=name, **prf(khama_rows(s3 + i, "test"))) for i, name in enumerate(ablations)])
    abl.to_csv(RESULTS / f"scenes_ablation{a.tag and '_' + a.tag}.csv", index=False, float_format="%.4f")
    print(abl[["variant", "P", "R", "F1", "R_cut", "R_grad", "flash_fp"]].to_string(index=False))

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

    # ---- real editing: hand-labelled films (scenes/labels/*.json) ----
    film_rows = []
    for lab in sorted((Path(__file__).parent / "labels").glob("*.json")):
        L = json.loads(lab.read_text(encoding="utf-8"))
        video = (Path(__file__).resolve().parents[1] / L["video"]).resolve()
        if not video.exists():
            continue
        film_grid = [khama[videos[0].stem]["results"][i]["params"] for i in (cut_hist, cut_only, best, default_cfg)]
        (work / "film_grid.json").write_text(json.dumps(film_grid))
        kj = bench_bin("scenes", video, "--grid", work / "film_grid.json")
        scores, _ = ffmpeg_scores(video, work / f"{lab.stem}.ffmpeg.json")
        gt, ign = L["transitions"], L.get("ignore", [])
        def kdet(i):
            return [(b["start"], b["end"]) for b in kj["results"][i]["boundaries"]]
        for name, det in [
            ("FFmpeg scene > 0.30 (old stills)", [(i - 1, i) for i, x in enumerate(scores) if x > 0.30 and i > 0]),
            ("FFmpeg scene > 0.32 (old detect)", [(i - 1, i) for i, x in enumerate(scores) if x > 0.32 and i > 0]),
            (f"FFmpeg scene > {best_ff} (best on dev)", [(i - 1, i) for i, x in enumerate(scores) if x > best_ff and i > 0]),
            ("Khama, colour only, cuts only", kdet(0)),
            ("Khama, colour + structure, cuts only", kdet(1)),
            ("Khama, full (best on dev)", kdet(2)),
            ("Khama, previous defaults", kdet(3)),
        ]:
            film_rows.append(dict(film=lab.stem, method=name, **prf([match(gt, det, [], ign)])))
    if film_rows:
        films = pd.DataFrame(film_rows)
        films.to_csv(RESULTS / f"scenes_films{a.tag and '_' + a.tag}.csv", index=False, float_format="%.4f")
        print(films[["film", "method", "P", "R", "F1", "R_cut", "R_grad", "tp", "fp", "fn"]].to_string(index=False))


if __name__ == "__main__":
    main()
