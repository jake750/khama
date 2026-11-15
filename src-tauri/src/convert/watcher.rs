use super::*;
use crate::errors::LockExt;

// ======================= المجلدات المراقَبة =======================

#[cfg(desktop)]
pub(super) const MEDIA_EXT: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "mxf", "m4v", "webm", "mts", "m2ts", "wmv", "flv", "3gp", "mpg", "mpeg", "wav", "mp3", "m4a", "aac",
    "flac", "ogg", "opus", "aiff", "aif",
];

#[cfg(desktop)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WatchHit {
    /// رقم التحويل الذي بدأه Rust (الواجهة تضيف بطاقته فقط)
    id: u64,
    path: String,
    preset: String,
}

/// مجلد فرعي يُكتب فيه الناتج (حتى لا يلتقطه المراقب مرة أخرى)
#[cfg(desktop)]
pub const WATCH_OUT: &str = "Converted";

/// يفحص المجلدات المراقَبة كل 4 ثوانٍ. الملف الجديد يُحوَّل بعد أن يثبت حجمه
/// (أي انتهى نسخه إلى المجلد). الملفات الموجودة قبل بدء المراقبة لا تُلمس.
#[cfg(desktop)]
pub fn spawn_watcher(app: AppHandle) {
    use std::collections::{HashMap, HashSet};
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let mut known_dirs: HashSet<PathBuf> = HashSet::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut pending: HashMap<PathBuf, (u64, u8)> = HashMap::new();
        loop {
            tokio::time::sleep(Duration::from_secs(4)).await;
            let folders = app.state::<SettingsState>().0.lock_ok().watch_folders.clone();
            let active: Vec<_> = folders.into_iter().filter(|w| w.enabled && preset(&w.preset).is_some()).collect();
            known_dirs.retain(|d| active.iter().any(|w| Path::new(&w.dir) == d));
            for w in &active {
                let dir = PathBuf::from(&w.dir);
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                let first_scan = known_dirs.insert(dir.clone());
                for e in entries.flatten() {
                    let path = e.path();
                    let name = e.file_name().to_string_lossy().into_owned();
                    let is_media = path
                        .extension()
                        .and_then(|x| x.to_str())
                        .is_some_and(|x| MEDIA_EXT.contains(&x.to_lowercase().as_str()));
                    if !is_media || name.starts_with('.') || !path.is_file() || seen.contains(&path) {
                        continue;
                    }
                    if first_scan {
                        seen.insert(path);
                        continue;
                    }
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    let entry = pending.entry(path.clone()).or_insert((size, 0));
                    if entry.0 == size && size > 0 {
                        entry.1 += 1;
                    } else {
                        *entry = (size, 0);
                    }
                    if entry.1 >= 2 {
                        pending.remove(&path);
                        seen.insert(path.clone());
                        // التحويل يبدأ هنا في Rust، فلا يضيع الملف إن لم تكن الواجهة جاهزة (T-26)
                        let hw = app.state::<SettingsState>().0.lock_ok().convert_hw;
                        let request = ConvertRequest {
                            inputs: vec![path.to_string_lossy().into_owned()],
                            preset: w.preset.clone(),
                            options: ConvertOptions {
                                hw,
                                out_dir: Some(dir.join(WATCH_OUT).to_string_lossy().into_owned()),
                                ..Default::default()
                            },
                        };
                        if let Ok(id) = queue_convert(&app, request) {
                            let hit = WatchHit {
                                id,
                                path: path.to_string_lossy().into_owned(),
                                preset: w.preset.clone(),
                            };
                            let _ = app.emit("watch-file", hit);
                        }
                    }
                }
            }
        }
    });
}
