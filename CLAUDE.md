# Khama

## Release
- Always release: put the version bump in the feature PR itself. Run `npm run release -- patch` (or `minor`/`major`/`X.Y.Z`) on the feature branch; it bumps the 5 version files, commits, pushes and opens the PR if none exists. Do not open a separate release PR.
- After merge, GitHub does the rest: `tag-release.yml` tags `vX.Y.Z` and starts `build.yml`, which builds every installer plus the signed APK into a draft release. The user publishes the draft. For a release, don't tag, build the release APK locally or upload it by hand (local test builds for the user are still fine). If you need to wait for CI, use `gh run watch <id> --exit-status` in the background, not repeated polling.

## Keep output short
- Tests: `cargo test -q --manifest-path src-tauri/Cargo.toml`; `npx vitest run --reporter=dot` if vitest is present.
- Android signing and local builds: `docs/ANDROID_RELEASE.md`.
