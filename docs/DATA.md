# Where Khama keeps its files · أين تحفظ خامة ملفاتها

Khama's ID is `com.jake750.khama`. Downloads and converted files go to the folder you pick; everything below is Khama's own data.

معرّف خامة `com.jake750.khama`. الملفات المنزّلة والمحوّلة تذهب إلى المجلد الذي تختاره، وما يلي بيانات خامة نفسها.

## Folders · المجلدات

| | Windows | macOS | Linux |
|---|---|---|---|
| Config | `%APPDATA%\com.jake750.khama` | `~/Library/Application Support/com.jake750.khama` | `~/.config/com.jake750.khama` |
| Data | `%LOCALAPPDATA%\com.jake750.khama` | `~/Library/Application Support/com.jake750.khama` | `~/.local/share/com.jake750.khama` |
| Cache | `%LOCALAPPDATA%\com.jake750.khama` | `~/Library/Caches/com.jake750.khama` | `~/.cache/com.jake750.khama` |

On Android all of it lives inside the app and goes away with it.

## Files · الملفات

| File | Folder | What it holds | Written by |
|---|---|---|---|
| `settings.json` | Config | All settings. `schemaVersion` says which migrations already ran. | `settings.rs` |
| `history.json` | Config | Finished downloads and conversions (newest first, up to 1000). | `history.rs` |
| `scheduled.json` | Config | Downloads waiting for their scheduled time. | `history.rs` |
| `counters.json` | Config | The last number used by `{n}` in file names, per folder. Replaced the old `counter.txt`, which is migrated once and deleted. | `settings.rs` |
| `cookies.txt` | Config | Cookies you saved for sign-in sites (Netscape format). Delete it from Settings → Cookies. | `settings.rs` |
| `watch-scans.json` | Config | Which files a watch folder already converted, so they aren't redone. | `convert/watcher.rs` |
| `bin/` | Data | yt-dlp downloaded by "Update yt-dlp". Used instead of the bundled one when present. | `tools.rs` |
| `ai/` | Data | The AI clean-up model (`UVR-MDX-NET-Voc_FT.onnx`, ~140 MB) and its runtime. | `separate.rs` |
| `hw-encoders.json` | Cache | Which graphics-card encoders work on this machine. Safe to delete. | `convert/info.rs` |

Every JSON file is written atomically (`persist.rs`: write to `.tmp`, then rename), so a crash never leaves half a file. A file that can't be read falls back to defaults and the problem is logged.

كل ملف JSON يُكتب دفعة واحدة (إلى `.tmp` ثم إعادة تسمية)، فلا يبقى ملف نصف مكتوب بعد انهيار. والملف الذي لا يُقرأ يُستبدل بالقيم الافتراضية ويُسجَّل الخطأ.

## Settings schema · مخطط الإعدادات

`settings.json` carries `schemaVersion` (`SETTINGS_VERSION` in `settings.rs`). When a release renames or reshapes a setting:

1. Bump `SETTINGS_VERSION`.
2. Add the migration in `migrate()`, gated on `schema_version < NEW`.
3. Add a test with an old file and one with a current file (see `current_files_skip_old_migrations`).

Unknown fields are ignored and missing ones take their defaults (`#[serde(default)]`), so older and newer versions can read each other's file.

## Clean uninstall · إزالة نظيفة

- **Windows**: the uninstaller has a "Delete the application data" box. Ticked, it removes the Config and Data folders.
- **macOS / Linux**: removing the app leaves the folders above. Delete them by hand to remove everything.
