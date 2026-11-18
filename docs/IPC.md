# Interface ↔ Rust contract · العقد بين الواجهة وRust

The React interface only talks to Rust through `src/api.ts`. Every command below is a `#[tauri::command]` registered in `src-tauri/src/lib.rs`; arguments are camelCase in TypeScript and snake_case in Rust (Tauri converts them). A failing command rejects with an `AppError` (`{ code, param?, detail? }`, see [ERRORS.md](ERRORS.md)).

الواجهة لا تكلّم Rust إلا عبر `src/api.ts`. الأمر الفاشل يرجع `AppError` برمز تترجمه الواجهة.

## Commands · الأوامر

| Command | Arguments | Returns | Notes |
|---|---|---|---|
| `get_settings` | — | `Settings` | Runs migrations on first read. |
| `save_settings` | `settings` | — | Atomic write. |
| `export_settings` | `path` | — | Backup file of settings and projects (no cookies). |
| `read_settings_file` | `path` | `Settings` | Reads a backup, migrated and sanitised; fails with `settingsFile` if it isn't one. The interface then saves it. |
| `default_output_dir` | — | `string \| null` | The system Downloads folder. |
| `has_saved_cookies` / `save_cookies` / `delete_cookies` | `content` (save) | `boolean` / — | `cookies.txt` in the config folder. |
| `counter_next` / `reset_counter` | — | `number` | The `{n}` file-name counter. |
| `get_scheduled` / `save_scheduled` | `items` (save) | `ScheduledItem[]` / — | Survives restarts. |
| `tools_info` | — | `ToolsInfo` | Versions and paths of yt-dlp, FFmpeg, Deno. |
| `update_ytdlp` | — | `{ version?, updated }` | Downloads the official release into the data folder. |
| `probe` | `url`, `replace` | `ProbeInfo` | Reads title, formats, chapters, playlist entries. `replace` cancels a running probe. |
| `cancel_probe` | — | — | |
| `new_job_id` | — | `number` | Reserve an ID so the card exists before the first update. |
| `start_download` | `request`, `id?` | `number` (job ID) | Progress arrives as `job-update` events. |
| `start_convert` | `request`, `id?` | `number` (job ID) | Same events as downloads. |
| `start_now` | `id` | — | Skip the queue limit for one job. |
| `cancel_download` | `id` | — | Cancels a download or a conversion. |
| `remember_job` / `list_jobs` | `id`, `card` | — / cards | In memory only: lets the mini window show the same cards. |
| `import_files` | `paths` | `string[]` | Copies picked files into reach (Android content URIs). |
| `analyze_file` | `path` | `MediaInfo` | ffprobe summary for the converter. |
| `hw_encoders` | — | `string[]` | Working GPU encoders, cached. |
| `ai_ready` | — | `boolean` | Is the AI model downloaded? |
| `save_thumbnail` | `url` | `string` (path) | |
| `read_links_file` | `path` | `string` | A `.txt` of links for batch download. |
| `get_history` / `remove_history` / `clear_history` | `id` (remove) | `HistoryEntry[]` / — | |
| `reveal_file` / `open_file` / `open_output_dir` | `path` | — | Opens the system file manager or player. |
| `free_space` | `path` | `number \| null` | Bytes free on that drive. |
| `take_deep_link` | — | `string \| null` | A `khama://` link that started the app. |
| `set_compact` / `hide_main` / `quit_app` | `compact` | — | Window control (desktop). |

## Events · الأحداث (Rust → interface)

| Event | Payload | When |
|---|---|---|
| `job-update` | `JobUpdate` (id, state, progress, speed, ETA, file, error) | Every progress line, state change, finish or failure. Throttled in Rust. |
| `deep-link` | `string` | A `khama://` link opened while the app runs. |
| `clipboard-url` | `string` | A supported link was copied (when clipboard watching is on). |
| `watch-file` | `{ id, path, preset }` | A new file appeared in a watch folder. |
| `close-requested` | — | The window's close button was pressed; the interface decides between the tray and quitting. |

## Changing the contract · تغيير العقد

1. Change the Rust command and its registration in `lib.rs`.
2. Change the wrapper and types in `src/api.ts`.
3. Mirror it in `src/dev-mock.ts`, so the interface still runs in a plain browser.
4. Update this table.

**Shared types.** The structs that cross the boundary (`Settings`, `DownloadRequest`, `JobUpdate`, `MediaInfo`, `ConvertOptions`…) derive `ts_rs::TS` in test builds, and `cargo test` writes them to `src/bindings/` (do not edit those files). `src/api.ts` keeps its own hand-written types because they use exact unions where Rust has `String`, but `src/ipcTypes.check.ts` makes `tsc` fail when a field exists on one side only, and CI fails if `src/bindings/` is out of date. So after changing a struct: `cargo test`, then fix what `tsc` reports.

الهياكل المشتركة تولَّد إلى `src/bindings/` عند `cargo test`، و`tsc` يفشل إن اختلفت أسماء الحقول بينها وبين `api.ts`.
