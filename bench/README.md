# Khama bench: reproducible experiments for the PFE

Three studies, each replacing a hard-coded value in the app with a measured one. The scripts call the
**app's own code**: the Rust detector and separator run through the `khama-bench` binary, and the
encoders run with the exact FFmpeg arguments built by `codec_args`, so the results describe the
application itself rather than a re-implementation.

| Axis | Question | App code | Script |
|---|---|---|---|
| A | Which hardware quality value gives the same visual quality as the software CRF? How do the codecs compare? | `convert.rs` `codec_args` | `codecs/run_bench.py`, `codecs/analyze.py` |
| B | How good is the voice/music separation, and do the chunking settings matter? | `separate.rs` | `separation/evaluate.py` |
| C | Does Khama's own shot-boundary detector beat FFmpeg's fixed `scene > 0.3`? | `scenes.rs` | `scenes/make_dataset.py`, `scenes/evaluate.py` |

## Setup (once)

```bash
cd bench
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # Linux/macOS: .venv/bin/python
cd ../src-tauri && cargo build --release --features bench --bin khama-bench && cd ../bench
```

FFmpeg is taken from `src-tauri/binaries/ffmpeg` (the one bundled with the app; it includes libvmaf).
Set `KHAMA_FFMPEG`, `CARGO_TARGET_DIR` or `KHAMA_BENCH` if yours are elsewhere. The separation needs the
model and ONNX Runtime that the app downloads on first use (or `--ai <folder>`).

## Data (not in git)

```bash
.venv/Scripts/python fetch_clips.py          # ~12 Xiph.org clips (first 4 s only) + Sintel trailer
```

| Data | Source | Licence | Used by |
|---|---|---|---|
| Xiph.org "derf" test sequences, first 4 s, stored as lossless FFV1 720p | media.xiph.org/video/derf | freely redistributable test media; per-clip terms in `data/clips/LICENCES.txt` (talking-head and Twitch clips: public domain) | A, C |
| Sintel trailer | download.blender.org/durian | CC-BY 3.0, Blender Foundation | C (real editing) |
| MUSDB18, 7-second previews (test subset, 50 tracks) | sigsep, fetched by the `musdb` package | academic / educational use only | B |

No content downloaded from video platforms is used in any experiment.

## Running

```bash
# Axis C: shot boundaries
.venv/Scripts/python scenes/make_dataset.py --videos 24 --seed 7
.venv/Scripts/python scenes/evaluate.py

# Axis A: codecs (several hours: every clip x encoder x quality, plus VMAF)
.venv/Scripts/python codecs/run_bench.py
.venv/Scripts/python codecs/analyze.py

# Axis B: separation (~10 min per configuration on an i5-1135G7)
.venv/Scripts/python separation/evaluate.py
```

Every script writes raw results as CSV into `results/`, and the figures are generated from those CSV
files only, so a figure can always be traced back to its numbers.

## Test machine

Intel Core i5-1135G7 (4 cores / 8 threads, Iris Xe, Quick Sync), 16 GB RAM, NVIDIA GeForce MX350, Windows 11.
On this machine `h264_qsv` and `hevc_qsv` work. The NVENC encoders fail: the installed driver exposes
NVENC API 13.0 while FFmpeg needs 13.1, and the MX350 (GP107 without NVENC) has no hardware encoder
anyway. `av1_qsv` fails because Tiger Lake's Quick Sync cannot encode AV1. The script records this
in `results/codecs_hw.csv`, and the calibration only covers the encoders that could be measured.
