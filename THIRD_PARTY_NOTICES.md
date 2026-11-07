# Third-party notices

Khama's own source code is MIT-licensed (see `LICENSE`). The installers also
**bundle the following independent programs**. Khama runs them as separate
processes and does not link to them, so each keeps its own license.

| Component | License | Source |
|---|---|---|
| **yt-dlp** (`khama-yt-dlp`) | The Unlicense. The official release executable bundles third-party code, and the combined executable is distributed under **GPLv3+**. | https://github.com/yt-dlp/yt-dlp |
| **FFmpeg / FFprobe** (`ffmpeg/`) | **GPLv3** build (includes libx264 and other GPL components). | Windows builds: https://github.com/yt-dlp/FFmpeg-Builds — Linux builds: https://github.com/BtbN/FFmpeg-Builds — macOS builds: https://ffmpeg.martin-riedl.de — FFmpeg source: https://git.ffmpeg.org/ffmpeg.git |
| **Deno** (`khama-deno`) | MIT | https://github.com/denoland/deno |
| **IBM Plex Sans Arabic** (font) | SIL Open Font License 1.1 | https://github.com/IBM/plex |
| **Tauri** | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |
| **React** | MIT | https://github.com/facebook/react |

## GPL source availability

The bundled yt-dlp and FFmpeg binaries are unmodified upstream builds. Their
complete corresponding source code is available at the links above. The exact
download URLs used for each release are recorded in
[`scripts/fetch-binaries.mjs`](scripts/fetch-binaries.mjs). If any of those
links stop working, open an issue in this repository and the source for the
version shipped in a given release will be provided.
