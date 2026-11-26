# Decisions · القرارات

Short records of choices that shape Khama: what was decided, why, and what would change it. A new decision that matters (a dependency, a format, a default, something hard to undo) gets an entry here before it ships.

سجلّ مختصر للقرارات المؤثرة: ماذا قُرِّر، ولماذا، ومتى نعيد النظر. أي قرار جديد مهم (اعتمادية، صيغة، قيمة افتراضية، شيء يصعب التراجع عنه) يُكتب هنا قبل أن يُنشر.

Format: **Decision** · Why · Instead of · Revisit when

---

### D1. Tauri, not Electron
- **Why**: an installer of tens of MB instead of 150+; the system WebView; Rust for running and parsing yt-dlp and FFmpeg safely.
- **Instead of**: Electron (size, memory), a native app per system (four codebases).
- **Revisit when**: WebView differences between systems cost more than they save.

### D2. React, not Svelte or plain JS
- **Why**: the most known way to build an interface, so help, examples and contributors are easy to find; React 19 with the compiler lint rules keeps re-renders in check without hand-tuning.
- **Instead of**: Svelte (smaller, but fewer people know it), plain DOM (the job cards and previews have too much state).
- **Revisit when**: bundle size or speed becomes a real complaint ([PERFORMANCE.md](PERFORMANCE.md) tracks it).

### D3. Bundle yt-dlp, FFmpeg and Deno instead of downloading them on first run
- **Why**: works offline and on the first click; every binary is pinned and checked by SHA-256 at build time (`scripts/binaries.lock.json`); no "downloading components…" screen that fails behind a firewall.
- **Instead of**: a small installer that fetches tools on first run (smaller download, but a second failure point and an unchecked network step).
- **Cost**: the installer is bigger. yt-dlp can still be updated in place (Settings → Tools) because sites change faster than releases.
- **Revisit when**: installer size becomes a reason people don't install.

### D4. Deno as yt-dlp's JavaScript runtime
- **Why**: YouTube now needs a JavaScript runtime to unlock formats; yt-dlp supports Deno first, and Deno is one self-contained binary with no install step.
- **Instead of**: Node (bigger, needs its own install), no runtime (YouTube downloads fail or fall back to low quality).

### D5. MDX-Net (UVR-MDX-NET-Voc_FT) through ONNX for AI clean-up, not Demucs
- **Why**: one ~140 MB ONNX model that runs on the CPU through ONNX Runtime with no Python; good voice/music separation for speech, which is what editors clean.
- **Instead of**: Demucs (better on music, but PyTorch, larger, slower on CPU), a cloud service (privacy, cost, needs internet).
- **Downloaded on first use**, not bundled: most people never use it, and it would double the installer. Checked by SHA-256, with mirrors.
- **Revisit when**: a smaller model of the same quality exists in ONNX.

### D6. The interface follows the system language on first run; English otherwise
- **Why**: the brief asked for a fully Arabic interface, and Khama is fully Arabic. But it is open source and also used by people who don't read Arabic, so the language is a setting, not a fork. On first run Khama picks Arabic when the system language is Arabic; otherwise English. Changing it later takes one click in Settings.
- **Instead of**: Arabic always (confusing for non-Arabic users who find it on GitHub), English always (wrong first impression for the main audience; the original default until 0.3.16).

### D7. Code comments in Arabic, public documents in both languages
- **Why**: the project is also a learning project, and the author reads Arabic first. Comments explain *why* in the language the maintainer thinks in.
- **Contributors**: README, CONTRIBUTING, SECURITY and everything in `docs/` are in English (Arabic alongside where users read it), so someone who doesn't read Arabic can still contribute. Identifiers, commit item IDs and error codes are English.
- **Revisit when**: regular contributors who don't read Arabic appear; then new comments switch to English.

### D8. Errors travel as codes, not sentences
- **Why**: two languages, and the interface owns the wording. Rust only says *what kind* of failure; the raw output goes along as `detail`. See [ERRORS.md](ERRORS.md).

### D9. No global state library; settings passed as props
- **Why**: one window, a handful of views, and settings change rarely. Props make every view's inputs visible and testable; a context or store would hide which view reads what. Language is the one context (`I18n`), because every component needs it.
- **Revisit when**: a prop passes through more than two components that don't use it, or a second window needs the same live state.

### D10. CSS in layers (`styles.css` → `redesign.css` → `guide.css` → `bubbly.css`)
- **Why**: the redesign landed in steps without breaking the working app, so each layer overrides the one before. Tokens (colors, radii, shadows) are variables on `:root`, so theme changes stay in one place.
- **Known cost**: some rules are overridden instead of replaced. When a component is touched, its rules move into one place and the overridden ones are deleted. A full merge is not worth a big-bang rewrite.

### D11. No feature flags
- **Why**: a desktop app with automatic updates ships a fix in hours ([RELEASING.md](RELEASING.md)), and a remote flag service would mean Khama calls home, which it doesn't do. The newer features do nothing until someone uses them: AI clean-up needs choosing and a model download, watch folders start empty, and Spotify handling only runs on a Spotify link (with a hint saying how it works). A broken one hurts only the people who use it, and it's turned off by not using it.
- **Revisit when**: a feature needs to be turned off for users who already enabled it, faster than a release.

### D12. Design: one hero per screen
- **Why**: each screen has one main action that is visibly the biggest thing on it (the link field, the file drop, the download button). Everything else is smaller and quieter. It keeps a feature-heavy app usable on the first visit. See [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

### D13. Push to `main`, releases built only by CI
- **Why**: one maintainer. Every push runs the checks; every release is built from a clean machine with the same steps, not from a laptop's state. See [RELEASING.md](RELEASING.md).

### D14. Topics: subtitles first, whisper.cpp only as a fallback, splitting without a model
- **Text**: a subtitle file next to the video, then subtitles inside it, then the site's captions (yt-dlp, only for a download of the whole video), and only then transcription with whisper.cpp (`ggml-small-q5_1`, 190 MB, downloaded once and checked by SHA-256 like the AI clean-up model). Subtitles are instant and usually better than a CPU transcription; the small model is the smallest one that handles Arabic acceptably. Prebuilt whisper.cpp exists for Windows and Linux only, so macOS and Android need a subtitle file (error `transcribeUnsupported`).
- **Splitting**: TextTiling (word overlap between the 30 s before and after each 10 s boundary; a topic starts where it drops deepest, moved to the longest pause nearby). It works offline in milliseconds, in any language, with no second model to download. The title is the topic's most distinctive words, not a sentence: writing real titles needs a language model, which Khama doesn't ship.
- **Reel fit and lengths** are computed in the interface from the topic times and the detected silences, so changing "keep at each edge" doesn't need a new analysis.
- **Revisit when**: an offline language model is bundled anyway (then it can write titles and judge which topics stand alone), or whisper.cpp ships macOS/Android builds.

### D15. First run: the welcome comes before the legal notice
- **Why**: the 2026-11 review suggested showing the notice before the welcome. The owner declined: the current order stays.

### D16. History may open any delivered file, executables included
- **Why**: the 2026-11 review suggested blocking `open_file` on executables. The owner declined: the app only opens files it downloaded or converted itself and that are in the history (`history::contains_file`), and blocking by extension would also stop legitimate files.

### D17. Reel subtitles: word times without a new model, line rules in the interface
- **Word times**: YouTube's automatic captions in json3 (every word has its offset), otherwise whisper.cpp with DTW (`-nfa -dtw small -ojf`, the model Khama already downloads). "Sync the subtitles to the audio" aligns a subtitle file's own text to the words whisper heard (longest common sequence on normalised spelling, unmatched words spread between their neighbours), as the arabic-word-timing tool does. A word's end is cut at a detected silence, because whisper puts it at the next word's start and hides the pause.
- **Lines**: built in `src/reels.ts`, so changing the words or seconds per line, or the margins kept around silences, needs no new analysis. A line starts on its first word, breaks at a sentence end, a pause or a comma once half full, and when the limit is reached it breaks at the longest pause in its second half; small gaps are closed and lines never overlap or run past the clip.
- **Instead of**: WhisperX or ctc-forced-aligner (Python, 1+ GB models, the MMS aligner is non-commercial), stable-ts (Python; its silence-snapping idea is used here).
- **Topic kinds**: "fits", "fits once split" (split points at pauses and sentence ends, chosen so every part is within the Reel length and none starts with a connective such as «لكن» or «لأن»), "doesn't fit". A heuristic, not a language model: see [PLAN-REELS.md](PLAN-REELS.md) for the embeddings step.
- **A link before downloading**: the "topics" preset accepts a URL. Captions in json3 when the site has them (nothing is downloaded; pauses come from the gaps between words), otherwise the audio alone (`bestaudio`) is downloaded to the job's work folder and goes through the same transcription and silence detection. Exporting downloads only each clip's range (or the span from the first to the last for one video), then cuts it like a local file.
- **Revisit when**: a small offline language model is bundled (then it can judge whether a part stands alone).

### D18. Noise removal: RNNoise through FFmpeg's arnndn
- **Why**: the bundled FFmpeg already has the filter, so the only download is the model (`std.rnnn`, the one shipped with Xiph's RNNoise, BSD-3, 300 KB, SHA-256 checked). About 70× real time on the CPU. On a real voice recording it took the level between words from −39 to −69 dB and kept the speech level (+2 dB after the filter makes up what it removes).
- **Instead of**: `afftdn` / `anlmdn` without a model (on the same recording they left the level between words unchanged: room reverb and breathing aren't steady noise), DeepFilterNet (better on hard noise, but three ONNX models and its own STFT pipeline; planned as the "higher quality" setting in [PLAN-REELS.md](PLAN-REELS.md)).
- The model is copied into the job's work folder and named there, because a Windows path (`C:`) breaks the filter's option syntax.

### D19. Lead voice only: KARA_2 through the same MDX pipeline
- **Why**: UVR_MDXNET_KARA_2 is an MDX-Net ONNX model (53 MB, SHA-256 checked, two mirrors) that runs in `separate.rs` unchanged: only its STFT size (5120, 2048 bins) and level make-up (1.065) differ, so models are now a small table (`SepModel`). It predicts the accompaniment (music, chorus, backing voices), so the lead is the mix minus the prediction. On a real nasheed it removed, on top of Voc_FT, a part 5–8 dB under the voice in the chorus sections, about 90% of it voices, and ran at 0.6× real time against 0.94×.
- **Instead of**: Mel-Roformer karaoke (better, but PyTorch only, 400+ MB). Reverb_HQ_By_FoxJoy was tried for echo removal with the same table and dropped: it did not separate room echo from speech (numbers in [PLAN-REELS.md](PLAN-REELS.md)).
