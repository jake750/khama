"""Paths and small helpers shared by the bench scripts.

Everything heavy (datasets, encodes) lives in bench/data and bench/work, which are not in git.
Results (CSV) and figures (PNG) go to bench/results and are committed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parent
DATA = BENCH / "data"
WORK = BENCH / "work"
RESULTS = BENCH / "results"
for d in (DATA, WORK, RESULTS):
    d.mkdir(parents=True, exist_ok=True)

EXE = ".exe" if os.name == "nt" else ""
FFMPEG = Path(os.environ.get("KHAMA_FFMPEG", ROOT / "src-tauri" / "binaries" / "ffmpeg" / "bin" / f"ffmpeg{EXE}"))
FFPROBE = FFMPEG.with_name(f"ffprobe{EXE}")
_target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "src-tauri" / "target"))
KHAMA_BENCH = Path(os.environ.get("KHAMA_BENCH", _target / "release" / f"khama-bench{EXE}"))


def run(cmd: list, **kw) -> subprocess.CompletedProcess:
    """Runs a command and raises with its stderr on failure."""
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    if p.returncode != 0:
        lines = [l for l in p.stderr.strip().splitlines() if l.strip()]
        raise RuntimeError(f"{Path(str(cmd[0])).name} failed ({p.returncode}): " + " | ".join(lines[:3]))
    return p


def ffmpeg(*args, **kw) -> subprocess.CompletedProcess:
    return run([FFMPEG, "-hide_banner", "-nostdin", "-y", *args], **kw)


def probe(path: Path) -> dict:
    out = run([FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", path]).stdout
    return json.loads(out)


def bench_bin(*args) -> dict:
    """Runs khama-bench (the app's own Rust code) and parses its JSON output."""
    if not KHAMA_BENCH.exists():
        raise SystemExit(
            f"{KHAMA_BENCH} not found. Build it with:\n"
            "  cd src-tauri && cargo build --release --features bench --bin khama-bench"
        )
    return json.loads(run([KHAMA_BENCH, "--ffmpeg", FFMPEG, *args]).stdout)
