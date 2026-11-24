# Creates the desktop update-signing key and stores it as GitHub secrets, in one go.
# The password is typed by you into the prompts below: it never appears on screen, in history or in a file.
# Run once from the project folder:  powershell -ExecutionPolicy Bypass -File scripts/setup-updater-key.ps1
$ErrorActionPreference = "Stop"
$key = Join-Path $HOME ".tauri\khama-updater.key"

if (Test-Path $key) {
    Write-Host "Key already exists: $key (not overwriting). Delete it first to make a new one." -ForegroundColor Yellow
    exit 1
}
New-Item -ItemType Directory -Force (Split-Path $key) | Out-Null

Write-Host "`n1/3  Creating the key. Choose a password and type it twice." -ForegroundColor Cyan
npx tauri signer generate -w $key
if ($LASTEXITCODE -ne 0) { throw "Key creation failed" }

Write-Host "`n2/3  Uploading the private key to GitHub secrets." -ForegroundColor Cyan
# Through cmd, not a PowerShell pipe: Windows PowerShell 5 adds a BOM (0xEF) that makes CI reject the key
cmd /c "gh secret set TAURI_SIGNING_PRIVATE_KEY < `"$key`""
if ($LASTEXITCODE -ne 0) { throw "Uploading the key failed" }

Write-Host "`n3/3  Type the SAME password once more, for GitHub." -ForegroundColor Cyan
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
if ($LASTEXITCODE -ne 0) { throw "Uploading the password failed" }

Write-Host "`nDone. Back up this file and its password together with the Android keystore:" -ForegroundColor Green
Write-Host "  $key"
