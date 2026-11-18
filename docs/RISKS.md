# Risks · المخاطر

What could break Khama, how likely it is, and what to do. Reviewed at every minor release.

ما الذي قد يعطّل خامة، واحتماله، وما العمل. يُراجَع مع كل إصدار minor.

Likelihood and impact: **H** high, **M** medium, **L** low.

| # | Risk | L | I | Early warning | Plan |
|---|---|---|---|---|---|
| R1 | **A site changes and yt-dlp stops working** (YouTube most often) | H | H | `canary.yml` downloads from YouTube and three other sites every Monday; users report `extractorOutdated`. | "Update yt-dlp" in Settings fetches the fix in seconds without a Khama release. The error message points to it. Ship a release with the new pinned yt-dlp within a week. |
| R2 | **YouTube needs something new** (sign-in, tokens, a JavaScript runtime change) | M | H | yt-dlp issue tracker, canary failures that an update doesn't fix. | Follow yt-dlp's documented workaround (as with Deno, [DECISIONS.md](DECISIONS.md) D4). Cookies from the browser already cover sign-in checks. |
| R3 | **yt-dlp or FFmpeg release is broken or compromised** | L | H | `fetch-binaries` fails its SHA-256 check. | Binaries are pinned in `scripts/binaries.lock.json` and checked at build time; the in-app update only takes yt-dlp's official GitHub release. Pin back to the last good version. |
| R4 | **The AI model's download source disappears** (GitHub repo of a third party) | M | M | `ai_ready` downloads fail with `aiDownload`. | Mirrors are listed in `separate.rs`, and the model is checked by SHA-256 whatever the source. Copy the model to Khama's own release assets as a last mirror. |
| R5 | **Legal complaint** (a site's terms, a takedown request) | L | H | A GitHub DMCA notice. | Khama only works with public content, does not bypass DRM or sign-in, and tells users they are responsible ([README](../README.md) "Responsible use"). Same position as yt-dlp itself. If GitHub acts, comply first, then appeal with that position. |
| R6 | **Losing the updater signing key** | L | H | — | Without it, installed apps reject every update forever. Two backups, see [RELEASING.md](RELEASING.md). |
| R7 | **Losing the Android signing key** | L | H | — | Users would have to uninstall (losing data) to get updates. Two backups, see [RELEASING.md](RELEASING.md). |
| R8 | **youtubedl-android stops being maintained** | M | M | No release for months while yt-dlp moves on; Android canary failures. | It's one library (`io.github.junkfood02.youtubedl-android`, version in `src-tauri/gen/android/app/build.gradle.kts`, see below). The app updates yt-dlp on the phone by itself, so the library only needs to ship Python and FFmpeg. Fallback: fork it, or drop Android to "download only" until replaced. |
| R9 | **A broken release reaches everyone through auto-update** | M | M | Error reports right after a release. | Rollback steps in [RELEASING.md](RELEASING.md): unlist the release, fix forward. |
| R10 | **One maintainer** (illness, no time, lost interest) | M | H | — | Everything needed to build and ship is in the repository and CI; docs explain decisions and setup ([DEVELOPMENT.md](DEVELOPMENT.md)). The keys are the only thing that can't be handed over without the backups. |
| R11 | **WebView differences** (an old macOS Safari or Linux WebKitGTK) | M | L | Reports from one system only. | Minimum versions are stated in the README. CSS avoids features newer than those minimums. |
| R12 | **Unsigned installers scare users away** (Windows SmartScreen, macOS Gatekeeper) | H | M | People asking "is this a virus?" | README explains how to open it. Code signing is planned (T-37) when there's a budget for certificates. |

## youtubedl-android · مكتبة أندرويد

- **What**: the library that brings Python, yt-dlp and FFmpeg to Android, used through `ToolsPlugin.kt` and `src-tauri/src/mobile.rs`.
- **Version**: `0.18.1` (both `library` and `ffmpeg` artifacts must match), in `src-tauri/gen/android/app/build.gradle.kts`.
- **Updating**: check its releases on GitHub, change both versions, build the APK in CI, then test on a phone: a YouTube download, a trim, an audio-only download, "Update yt-dlp".
- **yt-dlp on the phone** updates itself through the library's `updateYoutubeDL`, independently of the library version.
