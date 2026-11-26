# Testing · الاختبار

## What runs by itself · ما يعمل آليًا

| When | What | Where |
|---|---|---|
| Every commit (pre-commit hook) | Prettier on staged files, `tsc`, `cargo fmt --check` | `.githooks/pre-commit` |
| Every push (`check.yml`) | Types, ESLint, Prettier, Vitest (interface logic, RTL rules, translations, dev-mock coverage), end-to-end tests (`npm run e2e`: Playwright + Chromium on the dev server with `dev-mock.ts`, files in `e2e/`), interface size budget, Rust tests and Clippy on Linux, Android compile | GitHub Actions |
| Every release (`build.yml`) | Rust tests on Windows, macOS ×2 and Linux; bundled FFmpeg checked for its encoders; every installer built from clean; APK signature verified | GitHub Actions |
| Every Monday (`canary.yml`) | The pinned yt-dlp still reads popular sites (`--simulate`: formats are chosen, nothing is downloaded; YouTube may fail because it blocks CI runners), the Spotify embed page still parses, and FFmpeg handles an Arabic file name | GitHub Actions |

```bash
npx vitest run
```

```bash
cargo test -q --manifest-path src-tauri/Cargo.toml
```

## Test files · ملفات الاختبار

```bash
sh scripts/make-samples.sh
```

Builds `samples/` (git ignores it) with FFmpeg: no downloads, the same files on every machine.

| File | Checks |
|---|---|
| `01-cfr-1080p-h264.mp4` | Every preset on a plain source |
| `02-vfr-phone.mp4` | Variable frame rate: the suggestion is "H.264 for editing", and the output is constant frame rate |
| `03-hdr-10bit-hevc.mkv` | HDR is detected; the HDR hint shows; SDR output isn't washed out |
| `04-prores4444-alpha.mov` | ProRes 4444 keeps the transparent half transparent |
| `05-cuts-black-silence.mp4` | Scene cuts near 3 s and 6 s, black frames 3–4 s, silence 6–8 s |
| `06-quiet.wav`, `06-loud.wav` | Loudness normalisation brings both near the target |
| `07-rotated-phone.mp4` | A 90° rotation flag: output is upright |
| `08-اسم عربي … 🎬 ….mp4` | Arabic, emoji, `&` and brackets in the name survive every preset and the history |

**AI clean-up** needs real speech over music, which can't be generated. Use the same three clips every time, kept outside the repository: a voice over loud music, a voice over quiet background music, and music with no voice (should come out nearly silent). Listen to all three after any change to `separate.rs`.

`separate.rs` has two guards: `stft_roundtrip` (always runs) checks that STFT then inverse STFT gives back the same signal, and `separates_voice_from_music` (manual) mixes a voice file with a music file, separates them with the real model, and fails if the result isn't much closer to the original voice than the mix was. Run it after any change to the STFT, chunking or model settings:

```bash
KHAMA_AI=<folder with onnxruntime and the .onnx model> KHAMA_VOICE=voice.wav KHAMA_MUSIC=music.wav cargo test --manifest-path src-tauri/Cargo.toml separates_voice_from_music -- --ignored --nocapture
```

The model folder is Khama's own `ai/` folder ([DATA.md](DATA.md)) once AI clean-up has been used.

## Before every minor release · قبل كل إصدار minor

Patch releases rely on the automatic checks plus a quick try of what changed. Minor releases also go through this list on at least Windows and one other system. Record the result in the table below.

**Download**
- [ ] YouTube video, 1080p MP4: file opens in a player and in an editor
- [ ] Audio only, MP3 and WAV
- [ ] Trim 0:10–0:20: the file is ~10 s
- [ ] Two clips from one video, then "merge"
- [ ] A playlist of 10+: all queued, the queue limit respected
- [ ] Subtitles as SRT
- [ ] A link that fails (private video): clear message and the right button
- [ ] Cancel mid-download: no leftover `.part` files
- [ ] Schedule a download for 2 minutes later, close and reopen the app: it still runs

**Converter**
- [ ] Every sample above with its check
- [ ] Graphics-card option on a machine that has one
- [ ] Watch folder: drop a file in, it converts once

**App**
- [ ] Both languages, right-to-left layout correct, light and dark
- [ ] Settings survive a restart
- [ ] "Update yt-dlp"
- [ ] Tray, notification, mini window (desktop)

**Install and upgrade**
- [ ] Fresh install on a machine without Khama: opens, first download works
- [ ] Install over the previous release with its settings and history: both survive, nothing asks again
- [ ] The in-app updater offers and installs the new version
- [ ] Uninstall (Windows with "Delete the application data"): the folders in [DATA.md](DATA.md) are gone

**Hard conditions**
- [ ] **Network cut**: unplug mid-download. Expect a `network` error with "Try again", and the retry resumes. Same during the AI model download: no half model is used (SHA-256 check).
- [ ] **Disk full**: save to a nearly full USB stick. Expect `diskFull`, no broken file left, and the free-space warning before starting.
- [ ] **Load**: paste 100 links at once, and a 1000-item playlist. Expect the interface to stay responsive, the queue limit to hold, and memory to stay under ~500 MB.
- [ ] **Bad names**: a video titled with `<>:"/\|?*` and emoji saves on Windows.

## Systems · الأنظمة

What was tested by hand, on which release. Fill one row per run.

| System | Version tested | Release | Date | Result | Notes |
|---|---|---|---|---|---|
| Windows 11 x64 | | | | | |
| Windows 10 x64 | | | | | |
| macOS Apple Silicon | | | | | |
| macOS Intel | | | | | |
| Ubuntu 22.04+ (deb / AppImage) | | | | | |
| Fedora (rpm) | | | | | |
| Android (phone model, Android version) | | | | | |

### Android

Phones differ more than computers. For each release that changes Android code or youtubedl-android, try at least one phone running Android 9–11 and one running 13+:

- [ ] Install over the previous APK (same signing key): data stays
- [ ] YouTube download to `Download/Khama`, audio only, a trim
- [ ] "Update yt-dlp"
- [ ] Share a link from the YouTube app into Khama
- [ ] AI clean-up on a short clip (slow is fine; a crash is not)
- [ ] Rotate the phone, switch to another app and back during a download

## Test log · محضر الاختبار

For anything tested by hand that isn't in the lists above, keep one line per check so it can be repeated:

| Date | Release | System | Link or file | Steps | Expected | Result | Screenshot |
|---|---|---|---|---|---|---|---|
| 2026-11-21 | 0.3.24 | Windows 11 | YouTube 43XWDK6-BbI (8:41, English talk) and rHokT2KpVB0 (Arabic talk, auto-captions) | `khama-bench topics <video> <captions.srt>`; UI with the dev mock: ⋯ → Find topics on a download, then «Clip without silences» | 9 topics close to the 7 tips; 17 topics of 40–180 s for the Arabic talk; the clip request keeps 0.15 s of each silence | As expected. whisper.cpp transcription not run here (first real run is in the released app) | — |
| 2026-11-21 | 0.3.26 | Windows 11 | 6 voice recordings (WAV, 41–73 s, room noise around −37 dB) and a 9 s tone with digital silence from 6 s | `khama-bench silence <file>`; UI with the dev mock: Tools → Find silences shows «Auto» selected | Before: 0 silences in all 6 at the fixed −40 dB. After: auto level −30.6 to −31.5 dB, 13–23 pauses per file (13–20 s); the tone file gives 6.0–9.0 s at −75 dB. About 0.1 s per file | As expected. Pauses not checked by ear | — |
| 2026-11-26 | 0.3.35 (main) | Windows 11 | «مقاصد الحج ومعانيه» (Downloads, 4:03, Arabic lecture) | whisper.cpp small with `-nfa -dtw small -ojf` (1316 tokens timed); `khama-bench silence`; `khama-bench topics <video> <srt> --words <json>`, then `planTopic` and `exportCues` on the output; UI with the dev mock: ⋯ → Find topics → Select what fits → Export | Levels shown; topics classified; SRT per clip from 0, no overlaps, within limits | Speech −18.3 dB, noise −63.8 dB, threshold −50.1 dB. 3 topics: 2 fit (69 s, 57 s after silences), 1 of 112 s split at pauses into 20 + 16 + 78 s (no pause found after 2:46). Topic 2 tight: 20 lines, ≤ 7 words, ≤ 3.46 s, 0 overlaps, last line ends at the clip's 57.3 s. Export started 6 jobs with their own SRT. Not yet run inside the released app | — |
| 2026-11-26 | 0.3.36 (main) | Windows 11 | YouTube rHokT2KpVB0 (26:53, Arabic talk, auto-captions) | bundled yt-dlp `--write-auto-subs --sub-format json3/vtt/srt/best --skip-download`; `khama-bench topics - cap.ar-orig.json3`; `planTopic`/`exportCues` on the output; UI with the dev mock: paste link → Analyze the video → tick a topic → Export | json3 read with word times; topics as with VTT; long topics split into few parts; export downloads only the range, then cuts it with its SRT | 690 lines, 3402 timed words, 73 pauses from word gaps, 17 topics (same as the VTT run of 0.3.24). 9 fit, 8 split, each into 2 parts (before the fix: up to 8 parts). Topic 3 tight: 42 lines, ≤ 7 words, ≤ 3.33 s, 0 overlaps; `>>` speaker marks removed. Mock: download 0.2–51 s, then convert 0–50.8 s with SRT. Audio-only path (no captions) not run on a real link | — |
| 2026-11-26 | 0.3.36 (main) | Windows 11 | Telegram voice note «12-06-2026 12.26.m4a» (first 60 s) and «مقاصد الحج» (first 30 s, video) | bundled FFmpeg with the exact arguments of `denoise.rs`; levels with `khama-bench silence` | Lower level between words, speech kept, video copied | Noise −39.1 → −69.2 dB, speech −18.7 → −18.4 dB; 60 s in 0.8 s. Video: h264 copied, AAC audio, 30.07 s. afftdn (nr 12–30) and anlmdn: no change in the level between words. Not run inside the released app | — |
| 2026-11-26 | 0.3.36 (main) | Windows 11 | «Polish cow meme #Shorts» (Downloads, 1080×1440, heavily compressed) | first 5 s through the enhance filters of `args.rs` + libx264 veryfast; crop of the same frame side by side | Filters run; speed per mode; visible but modest change | Off 1.0 s, Light 2.0 s, Sharpen 1.8 s, Strong 57 s with nlmeans p7 r9 → 35 s with p5 r7 (kept). Light/Strong sharpen edges and soften blocks slightly; no detail is invented (that needs Real-ESRGAN). Time estimate shown from the measured slices | — |
| 2026-11-26 | 0.3.36 (main) | Windows 11 | Telegram voice note «12-06-2026 12.26.m4a», «مقاصد الحج» (with and without added reverb), «We are making a feature film!», five Arabic course lessons joined | `khama-bench separate --model lead/dereverb --model-file`, Silero VAD v5 and multilingual-e5-small in Python with onnxruntime; levels in 20 ms frames | Each candidate beats what ships | None did: FoxJoy left added reverb untouched and lowered contrast on the voice note; KARA_2 ≈ Voc_FT; Silero VAD missed 40 s of real speech; TextTiling already hit 4/4 known topic boundaries. Details in docs/PLAN-REELS.md | Not merged (KARA_2 later merged, next row) |
| 2026-11-26 | 0.3.37 (main) | Windows 11 | Nasheed with a chorus (Telegram «jxjTU7B1….m4a», 3:24) | `khama-bench separate` with Voc_FT and with `--model lead` (KARA_2) on the whole file; the difference run through Voc_FT again | KARA_2 drops the chorus that Voc_FT keeps | Extra removal 5–8 dB under the voice in the chorus parts (75, 80, 175 s), voice share of it −0.6 to −1 dB; −13 to −22 dB elsewhere. 0.6× real time. The app downloads the same file (SHA matches) but the preset was not run inside the released app | — |
| 2026-11-26 | 0.3.37 (main) | Windows 11 | «nature broll» and «meeting broll» (clean, degraded on purpose) and «wawa.mp4» (dark phone video) | FFmpeg with each denoise candidate, SSIM against the clean original, timing; crops of a real dark frame | The new Light and Strong clean more camera noise without harming compressed video | SSIM numbers in DECISIONS.md D20. On wawa.mp4 no visible damage; text unchanged | — |
| 2026-11-26 | 0.3.37 (main) | Windows 11 | YouTube rHokT2KpVB0 (Arabic talk, 25 min) | the bundled yt-dlp with format 251 (best audio) and with `AUDIO_FOR_ANALYSIS`; `khama-bench silence` on both | Same silences from the lighter track | The lighter track was 250 (64k, no DRC): 12.8 MB against 24.8 MB. Levels identical (−16.7 / −37.9 / −31.5 dB), 212 silences each, 195 within 50 ms | — |
| 2026-11-26 | 0.3.37 (main) | Windows 11 | YouTube rHokT2KpVB0 (json3 words, 64k audio, whisper small on 3 min) | whisper.cpp `-nfa -dtw small -ojf` against json3 and against audio onsets after pauses; `khama-bench topics` then `exportCues` on all 17 topics at 7/3.5, 4/2 and 10/5 | Lines start with the voice, never overlap or pass the limit | Start error after pauses 0.154 → 0.106 s (YouTube), 0.164 → 0.111 s (whisper). 2600 lines: overlaps 4 → 0, over the limit 37 → 0, gaps < 0.12 s 96 → 14; «[موسيقى]» no longer in the lines | — |
| | | | | | | | |
