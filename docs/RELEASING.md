# Releasing · الإصدار

## Versions · أرقام الإصدارات

Khama uses `MAJOR.MINOR.PATCH`:

| Bump | When | Example |
|---|---|---|
| **patch** (0.3.15 → 0.3.16) | Fixes, text, design polish, small options. Nothing a user has to relearn. | Better error message, a new preset |
| **minor** (0.3 → 0.4) | A new feature area or a change in how something works. Release notes explain it. | The converter, Android, watch folders |
| **major** (0.x → 1.0) | 1.0 means: tested on every supported system ([TESTING.md](TESTING.md)), signed installers, settings format stable. After that, a major release is one that drops a system or breaks saved settings. | |

## When · متى

- A fix for something broken ships the same day.
- Everything else ships when it's done and the checks pass; there's no fixed schedule. More than one release a day is fine for fixes; features wait until they're whole (text in both languages, tested, documented).
- Before a demo or presentation, a **feature freeze**: from a week before, only fixes. The demo runs on a release that has been out for at least two days.

## How · الطريقة

```bash
npm run release
```

(or `npm run release -- minor`, `-- 1.0.0`). It:

1. checks the tree is clean and contains `origin/main`,
2. bumps the version in the five files (`tauri.conf.json`, `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock`),
3. regenerates `CHANGELOG.md`,
4. commits "الإصدار X.Y.Z" and pushes to `main`.

Then `build.yml` takes over, from a clean machine every time:

1. **check**: sees a new version, collects "What's new" from the commit titles since the last tag.
2. **build**: Windows, macOS (Apple Silicon and Intel), Linux (AppImage, deb, rpm) and the signed Android APK, each with pinned, checksum-verified yt-dlp, FFmpeg and Deno.
3. **publish**: the GitHub release (not a draft) with every file, `latest.json` for the updater, an SBOM, and the `vX.Y.Z` tag on the release commit. The job summary lists each installer's size.

Never tag, build release files on a laptop, or upload by hand: a local build carries that machine's state, and the tag must point at exactly what CI built.

Every `vX.Y.Z` tag matches a "الإصدار X.Y.Z" commit and the version inside the app; the updater reads `latest.json` from the latest release.

## If a release is broken · إذا كان الإصدار معطوبًا

Users get updates on start, so act fast:

1. **Stop the spread**: on GitHub, edit the broken release and tick **Set as a pre-release** (or delete its `latest.json` asset). The updater reads `releases/latest/download/latest.json`, so `latest` falls back to the previous release and nobody else updates to the broken one.
2. **Fix forward**: revert the bad commit (`git revert <sha>`), push, `npm run release`. The new, higher version reaches everyone, including those who already got the broken one. The updater never goes down a version, so a fix must always be a new version.
3. **If the app can't start at all**, users can reinstall the previous version from the Releases page; settings and history stay (they live outside the app, see [DATA.md](DATA.md)).
4. Write what happened in the next release's notes.

## Signing keys · مفاتيح التوقيع

Stored as repository secrets, used only by `build.yml`:

| Secret | Signs | If lost |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) | Updates (`latest.json` signatures) | Installed apps reject every future update. Users must reinstall by hand. |
| `KHAMA_KEYSTORE_BASE64` + `KHAMA_KEY_PASSWORD` | The Android APK | Android refuses to install updates over the old app. Users must uninstall (losing app data) and reinstall. |

A secret can't be read back from GitHub, so the backup is what saves you. Keep each key file and its password in two places you control (for example a password manager, plus an encrypted USB drive), never in the repository. See [RISKS.md](RISKS.md).
