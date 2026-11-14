"""Evaluates Khama's voice/music separation (the app's own Rust code) on MUSDB18.

    python separation/evaluate.py                     # 7-second previews, test subset (50 tracks)
    python separation/evaluate.py --tracks 10 --configs default overlap_0.5s

For each configuration of SepOptions and each track:
- the mixture is written to WAV and separated by `khama-bench separate` (one model pass, both stems);
- BSS Eval v4 (museval) gives SDR, SIR, SAR and ISR for vocals and accompaniment on 1 s windows,
  summarised by the median over windows (the SiSEC convention), then the median over tracks;
- "join SNR": the SNR of the vocal estimate within ±0.1 s of the points where two chunks meet,
  which is where the margin / overlap settings act;
- time (real-time factor = processing seconds / audio seconds) and peak memory of the process.

Output: results/separation_tracks.csv (one row per track and config), results/separation.csv (summary),
        results/separation.png
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from common import DATA, FFMPEG, KHAMA_BENCH, RESULTS, WORK  # noqa: E402

SR = 44100
N_FFT, HOP, DIM_T = 7680, 1024, 256
CHUNK = HOP * (DIM_T - 1)

CONFIGS = {
    "default": dict(),  # margin = n_fft/2 = 3840, no overlap, compensate 1.021, music = mix - voice
    "margin_0.25s": dict(margin=11025),
    "margin_0.5s": dict(margin=22050),
    "margin_1s": dict(margin=44100),
    "overlap_0.25s": dict(overlap=11025),
    "overlap_0.5s": dict(overlap=22050),
    "overlap_1s": dict(overlap=44100),
    "compensate_1.0": dict(compensate=1.0),
    "compensate_1.05": dict(compensate=1.05),
    "mask": dict(derive="mask"),
    "mask_overlap_0.5s": dict(derive="mask", overlap=22050),
}


def joins(n: int, opts: dict) -> list[int]:
    margin = min(opts.get("margin", N_FFT // 2), CHUNK // 2 - 1024)
    kept = CHUNK - 2 * margin
    overlap = min(opts.get("overlap", 0), kept // 2)
    step = kept - overlap
    # chunk k covers output samples [k*step, k*step + kept); the join is the middle of the overlap
    return [k * step + overlap // 2 for k in range(1, n // step + 1) if k * step < n]


def snr(ref: np.ndarray, est: np.ndarray) -> float:
    e = np.sum((ref - est) ** 2)
    return float(10 * np.log10(np.sum(ref**2) / max(e, 1e-12))) if np.sum(ref**2) > 1e-8 else float("nan")


def read_wav(p: Path) -> np.ndarray:
    raw = subprocess.run([str(FFMPEG), "-v", "error", "-i", str(p), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2).astype(np.float64)


def write_wav(p: Path, x: np.ndarray) -> None:
    subprocess.run([str(FFMPEG), "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-", "-c:a", "pcm_f32le", str(p)],
                   input=x.astype("<f4").tobytes(), check=True)


def run_separation(mix: Path, voice: Path, music: Path, opts: dict) -> tuple[dict, float]:
    """Runs khama-bench and records the peak memory of the process (Windows: peak working set)."""
    import psutil

    p = subprocess.Popen([str(KHAMA_BENCH), "--ffmpeg", str(FFMPEG), "separate", str(mix), "--voice", str(voice),
                          "--music", str(music), "--opts", json.dumps(opts)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    proc = psutil.Process(p.pid)
    peak = 0
    while p.poll() is None:
        try:
            mi = proc.memory_info()
            peak = max(peak, getattr(mi, "peak_wset", 0) or mi.rss)
        except psutil.Error:
            pass
        time.sleep(0.05)
    out, err = p.communicate()
    if p.returncode != 0:
        raise RuntimeError(err[-2000:])
    return json.loads(out), peak / 2**20


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracks", type=int, default=50)
    ap.add_argument("--configs", nargs="*", default=list(CONFIGS))
    ap.add_argument("--root", type=Path, default=DATA / "musdb")
    a = ap.parse_args()

    import musdb
    import museval

    db = musdb.DB(root=str(a.root), download=True, subsets="test")
    tracks = db.tracks[: a.tracks]
    work = WORK / "separation"
    work.mkdir(parents=True, exist_ok=True)
    out_csv = RESULTS / "separation_tracks.csv"
    rows = pd.read_csv(out_csv).to_dict("records") if out_csv.exists() else []
    done = {(r["config"], r["track"]) for r in rows}

    for cfg in a.configs:
        opts = CONFIGS[cfg]
        for t in tracks:
            if (cfg, t.name) in done:
                continue
            mix = work / "mix.wav"
            write_wav(mix, t.audio)
            vpath, mpath = work / "voice.wav", work / "music.wav"
            info, peak_mb = run_separation(mix, vpath, mpath, opts)
            v, m = read_wav(vpath), read_wav(mpath)
            n = min(len(v), len(t.audio))
            ref_v = t.targets["vocals"].audio[:n]
            ref_m = t.targets["accompaniment"].audio[:n]
            est = {"vocals": v[:n], "accompaniment": m[:n]}
            # BSS Eval v4 on 1 s windows; median over windows
            sdr, isr, sir, sar = museval.evaluate([ref_v, ref_m], [est["vocals"], est["accompaniment"]], win=SR, hop=SR)
            med = lambda x: float(np.nanmedian(x))  # noqa: E731
            js = [j for j in joins(n, opts) if 4410 <= j < n - 4410]
            jv = [snr(ref_v[j - 4410:j + 4410], est["vocals"][j - 4410:j + 4410]) for j in js]
            row = dict(config=cfg, track=t.name, seconds=n / SR,
                       sdr_vocals=med(sdr[0]), sir_vocals=med(sir[0]), sar_vocals=med(sar[0]), isr_vocals=med(isr[0]),
                       sdr_accomp=med(sdr[1]), sir_accomp=med(sir[1]), sar_accomp=med(sar[1]), isr_accomp=med(isr[1]),
                       snr_vocals=snr(ref_v, est["vocals"]), join_snr_vocals=float(np.nanmean(jv)) if jv else float("nan"),
                       rtf=info["rtf"], process_s=info["seconds"], peak_mb=peak_mb)
            rows.append(row)
            pd.DataFrame(rows).to_csv(out_csv, index=False, float_format="%.4f")
            print(f"{cfg:18s} {t.name[:30]:30s} SDR voc {row['sdr_vocals']:6.2f}  acc {row['sdr_accomp']:6.2f}  "
                  f"RTF {row['rtf']:.2f}  {peak_mb:.0f} MB", flush=True)

    df = pd.DataFrame(rows)
    summary = df.groupby("config").agg(
        tracks=("track", "nunique"),
        sdr_vocals=("sdr_vocals", "median"), sir_vocals=("sir_vocals", "median"), sar_vocals=("sar_vocals", "median"),
        sdr_accomp=("sdr_accomp", "median"), sir_accomp=("sir_accomp", "median"), sar_accomp=("sar_accomp", "median"),
        snr_vocals=("snr_vocals", "median"), join_snr_vocals=("join_snr_vocals", "median"),
        rtf=("rtf", "median"), peak_mb=("peak_mb", "max"),
    ).reindex([c for c in CONFIGS if c in set(df.config)]).reset_index()
    summary.to_csv(RESULTS / "separation.csv", index=False, float_format="%.3f")
    print(summary.round(2).to_string(index=False))

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(10, 4), dpi=140, sharey=True)
    order = summary.config.tolist()
    for ax, col, title in ((axes[0], "sdr_vocals", "Vocals SDR (dB)"), (axes[1], "sdr_accomp", "Accompaniment SDR (dB)")):
        data = [df[df.config == c][col].dropna().to_numpy() for c in order]
        ax.boxplot(data, orientation="horizontal", tick_labels=order, showfliers=False)
        ax.set_title(title, fontsize=10)
        ax.grid(alpha=0.3, axis="x")
    fig.tight_layout()
    fig.savefig(RESULTS / "separation.png")


if __name__ == "__main__":
    main()
