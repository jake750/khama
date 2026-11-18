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
