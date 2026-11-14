# Releasing an update of the Android app (Khama)

A guide for any new chat that needs to build a new APK. It contains no passwords: the secrets live in local files outside Git.

## Signing key (do not lose it)
- Key: `C:/Users/foura/.khama/khama-release.jks` (alias `khama`)
- Password and path: `C:/Users/foura/.khama/keystore.properties`, plus a copy at `src-tauri/gen/android/keystore.properties` (ignored by Git, so it is not in new worktrees: copy it there from `~/.khama` before building).
- Every update **must** be signed with this same key. Otherwise Android refuses to install it over the old version, and the user has to uninstall the app and lose their data. Keep a backup of the `.khama` folder outside this PC.
- Gradle reads the key from `keystore.properties`, or from the `KHAMA_KEYSTORE` environment variables in CI (see `src-tauri/gen/android/app/build.gradle.kts`).

## Building in GitHub Actions (normal releases)
`build.yml` builds the signed arm64 APK and attaches it to the release, but only when the repository secrets `KHAMA_KEYSTORE_BASE64` and `KHAMA_KEY_PASSWORD` exist. The user sets them once in PowerShell (values read from the files, never typed):
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.khama\khama-release.jks")) | gh secret set KHAMA_KEYSTORE_BASE64 -R jake750/khama
$p = @{}; Get-Content "$HOME\.khama\keystore.properties" | ForEach-Object { if ($_ -match '^\s*(\w+)\s*=\s*(.*)$') { $p[$matches[1]] = $matches[2].Trim() } }; gh secret set KHAMA_KEY_PASSWORD -R jake750/khama --body $p.password; "alias: " + $p.keyAlias
```
The alias must be `khama` (the CI default). Check with `gh secret list -R jake750/khama`.

Without them the Android job is skipped and the desktop builds run as before.

## Version number
Run `npm run release` (see `CLAUDE.md`). It raises `version` in `tauri.conf.json`, `package.json`, `package-lock.json`, `Cargo.toml` and `Cargo.lock` together. Tauri derives `versionName` and `versionCode` from it automatically. If the number doesn't go up, Android won't treat the APK as an update.

## The environment on this PC
- JDK 17: `C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot` (already in `JAVA_HOME`)
- Android SDK: `%LOCALAPPDATA%\Android\Sdk`, and `ANDROID_HOME` is not set persistently, so set it in the session:
  ```powershell
  $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
  $env:NDK_HOME = "$env:ANDROID_HOME\ndk\29.0.14206865"   # installed: 23.1, 28.2, 29.0
  ```

## Build
From the repo root (it is on `main`):
```powershell
npm install
npx tauri android build --apk --split-per-abi
```
Output (signed, per architecture):
- `src-tauri/gen/android/app/build/outputs/apk/arm64/release/app-arm64-release.apk` (almost every modern phone)
- `.../arm/release/app-arm-release.apk` (old phones), `.../x86_64/release/app-x86_64-release.apk` (emulator)

Check the signature: `apksigner verify --print-certs <apk>` (in `build-tools` inside the SDK).

## Things to keep in mind
- The mobile build uses `youtubedl-android`, so the APK is GPL-3 (the desktop build stays MIT). See `THIRD_PARTY_NOTICES.md`.
- Converting and AI clean-up are hidden on the phone (`isMobile` in `src/platform.ts`).
- The in-app update check (branch `claude/magical-matsumoto-b7411c`, not yet merged into `main` when this was written) compares the version against the latest GitHub release and opens its APK. For it to work: publish a release whose tag is the new version and attach `app-arm64-release.apk` to it.
- The desktop updater needs a separate key: `C:/Users/foura/.tauri/khama.key` (its password is not recorded here), plus `pubkey` in `tauri.conf.json` and the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
