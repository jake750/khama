# Khama

Talk to the user in Arabic.

## Releases
- No PRs: commit finished work and push straight to `main` (from a worktree, rebase on `origin/main` first, then `git push -q origin HEAD:main`). Don't wait for the user to merge.
- Any change to the app itself (source, native/config, icons, assets, dependencies) ships in a new release without asking: `npm run release` (default `patch`; or `minor`/`major`/`X.Y.Z`). It bumps the 5 version files, commits and pushes to `main`. CI, scripts, tests and docs ride in the next release.
- `build.yml` sees the new version on `main`, builds every platform plus the signed APK, publishes the release and creates the `vX.Y.Z` tag. Never tag, build release files locally or upload by hand (local test builds for the user are fine).
- To wait for CI: `gh run watch <id> --exit-status` in the background, never polling.

## Keep output short
- Tests: `cargo test -q --manifest-path src-tauri/Cargo.toml`; `npx tsc --noEmit`; `git push -q`; `npm ci --silent`.
- Grep or read line ranges instead of whole files. Android signing and local builds: `docs/ANDROID_RELEASE.md`.
