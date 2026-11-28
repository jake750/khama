use super::*;
use crate::errors::LockExt;

// ======================= المجلدات المراقَبة =======================

#[cfg(desktop)]
pub(super) const MEDIA_EXT: &[&str] = &[
    // نفس src/mediaExt.ts (يطابقهما mediaExt.test.ts)
    "mp4", "mov", "mkv", "avi", "mxf", "m4v", "webm", "mts", "m2ts", "wmv", "flv", "3gp", "3g2", "mpg", "mpeg", "m2v", "ts", "vob", "ogv",
    "f4v", "wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "aiff", "aif", "wma", "mka", "ac3", "caf", "mp2", "amr",
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

/// ملفات الوسائط في المجلد (المسار، الحجم). يُستدعى خارج خيوط tokio لأن المجلد قد يكون
/// على قرص شبكي بطيء (T-23). None = تعذّرت قراءة المجلد.
#[cfg(desktop)]
fn list_media(dir: &Path) -> Option<Vec<(PathBuf, u64, u64)>> {
    let entries = std::fs::read_dir(dir).ok()?;
    Some(
        entries
            .flatten()
            .filter_map(|e| {
                let path = e.path();
                let hidden = e.file_name().to_string_lossy().starts_with('.');
                let is_media = path
                    .extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| MEDIA_EXT.contains(&x.to_lowercase().as_str()));
                let meta = e.metadata().ok().filter(|m| m.is_file())?;
                // نسخ Explorer يُبقي تاريخ التعديل الأصلي: ملف نُسخ والتطبيق مغلق يبدو «قديمًا» فلا يُحوَّل.
                // تاريخ الإنشاء (وقت وصوله للمجلد) يكشفه
                let modified = [meta.modified().ok(), meta.created().ok()]
                    .into_iter()
                    .flatten()
                    .map(ms_since_epoch)
                    .max()
                    .unwrap_or(0);
                (is_media && !hidden).then_some((path, meta.len(), modified))
            })
            .collect(),
    )
}

/// مجلد فرعي يُكتب فيه الناتج (حتى لا يلتقطه المراقب مرة أخرى)
#[cfg(desktop)]
pub const WATCH_OUT: &str = "Converted";

#[cfg(desktop)]
fn ms_since_epoch(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// آخر فحص لكل مجلد مراقَب، يبقى بعد إغلاق التطبيق (T-25)
#[cfg(desktop)]
type LastScans = std::collections::HashMap<String, u64>;

#[cfg(desktop)]
fn scans_path(app: &AppHandle) -> Option<PathBuf> {
    settings::config_dir(app).ok().map(|d| d.join("watch-scans.json"))
}

/// أول فحص لمجلد بعد الإقلاع: ملف عُدّل بعد آخر فحص (وصل والتطبيق مغلق) يُحوَّل،
/// وما قبله عولج أو كان موجودًا. مجلد بلا فحص سابق (أُضيف للتو): لا نلمس ما فيه.
#[cfg(desktop)]
pub(super) fn arrived_while_closed(modified_ms: u64, last_scan_ms: Option<u64>) -> bool {
    last_scan_ms.is_some_and(|last| modified_ms > last)
}

/// يفحص المجلدات المراقَبة كل 4 ثوانٍ. الملف الجديد يُحوَّل بعد أن يثبت حجمه
/// (أي انتهى نسخه إلى المجلد). المجلد غير تكراري عمدًا: المجلد الفرعي Converted فيه الناتج.
/// الاستطلاع لا أحداث النظام (notify) لأن المجلد كثيرًا ما يكون على قرص شبكي أو بطاقة كاميرا
/// لا تصل منها أحداث التغيير، وقراءة مجلد كل 4 ثوانٍ رخيصة.
#[cfg(desktop)]
pub fn spawn_watcher(app: AppHandle) {
    use std::collections::{HashMap, HashSet};
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let mut known_dirs: HashSet<PathBuf> = HashSet::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut pending: HashMap<PathBuf, (u64, u8)> = HashMap::new();
        let scans_file = scans_path(&app);
        let mut last_scans: LastScans = scans_file
            .as_deref()
            .map(|p| crate::persist::read_json(p).or_default_logged("watch-scans.json"))
            .unwrap_or_default();
        let mut saved_at = Instant::now();
        let mut queued_any = false;
        loop {
            tokio::time::sleep(Duration::from_secs(4)).await;
            let folders = app.state::<SettingsState>().0.lock_ok().watch_folders.clone();
            let active: Vec<_> = folders.into_iter().filter(|w| w.enabled && preset(&w.preset).is_some()).collect();
            known_dirs.retain(|d| active.iter().any(|w| Path::new(&w.dir) == d));
            for w in &active {
                let dir = PathBuf::from(&w.dir);
                let listing = tauri::async_runtime::spawn_blocking({
                    let dir = dir.clone();
                    move || list_media(&dir)
                });
                let scan_started = ms_since_epoch(std::time::SystemTime::now());
                let Ok(Some(entries)) = listing.await else {
                    continue;
                };
                let first_scan = known_dirs.insert(dir.clone());
                let previous_scan = last_scans.insert(w.dir.clone(), scan_started);
                // ملف حُذف أو نُقل لم يعد في «seen»، فلا تكبر بلا حد. مجموعة مرة واحدة لكل فحص:
                // البحث في القائمة لكل ملف كان تربيعيًا (مجلد بعشرة آلاف ملف = 10⁸ مقارنة كل 4 ثوانٍ)
                let present: HashSet<&Path> = entries.iter().map(|(e, _, _)| e.as_path()).collect();
                seen.retain(|p| p.parent() != Some(dir.as_path()) || present.contains(p.as_path()));
                pending.retain(|p, _| p.parent() != Some(dir.as_path()) || present.contains(p.as_path()));
                drop(present);
                for (path, size, modified) in entries {
                    if seen.contains(&path) {
                        continue;
                    }
                    if first_scan && !arrived_while_closed(modified, previous_scan) {
                        seen.insert(path);
                        continue;
                    }
                    let entry = pending.entry(path.clone()).or_insert((size, 0));
                    if entry.0 == size && size > 0 {
                        entry.1 += 1;
                    } else {
                        *entry = (size, 0);
                    }
                    if entry.1 >= 2 {
                        pending.remove(&path);
                        seen.insert(path.clone());
                        // التحويل يبدأ هنا في Rust، فلا يضيع الملف إن لم تكن الواجهة جاهزة (T-27)
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
                        // نعلن الملف للواجهة قبل أن يبدأ التحويل، فتعرف العملية قبل أول تحديث (T-18)
                        let id = app
                            .state::<crate::download::Jobs>()
                            .next_id
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                            + 1;
                        let hit = WatchHit {
                            id,
                            path: path.to_string_lossy().into_owned(),
                            preset: w.preset.clone(),
                        };
                        let _ = app.emit("watch-file", hit);
                        queued_any = true;
                        if let Err(e) = queue_convert(&app, request, Some(id)) {
                            crate::download::emit(
                                &app,
                                crate::download::JobUpdate {
                                    id,
                                    state: "error",
                                    error: Some(e),
                                    ..Default::default()
                                },
                            );
                        }
                    }
                }
            }
            // نحفظ أوقات الفحص كل دقيقة لا كل 4 ثوانٍ، وفورًا بعد بدء تحويل
            // (وإلا قد يُحوَّل الملف نفسه مرة أخرى في الإقلاع التالي)
            if (queued_any || saved_at.elapsed() >= Duration::from_secs(60))
                && let Some(p) = &scans_file
            {
                saved_at = Instant::now();
                queued_any = false;
                last_scans.retain(|d, _| active.iter().any(|w| &w.dir == d));
                if let Ok(json) = serde_json::to_vec(&last_scans) {
                    let _ = crate::persist::write_atomic(p, &json);
                }
            }
        }
    });
}

// ======================= إفلات مجلد في المحوّل (R3-U13) =======================

/// أقصى عمق للمجلدات الفرعية، وأقصى عدد ملفات من إفلات واحد (مجلد ضخم لا يُغرق القائمة)
#[cfg(desktop)]
const EXPAND_DEPTH: usize = 4;
#[cfg(desktop)]
const EXPAND_MAX: usize = 2000;

/// المسارات كما هي، والمجلد يُستبدل بما فيه من وسائط (ومجلداته الفرعية حتى عمق 4) مرتبةً بالاسم.
/// المخفي (يبدأ بنقطة) لا يُدخل، ولا مجلد ناتج المراقبة «Converted».
#[cfg(desktop)]
pub(super) fn expand_media(paths: Vec<String>) -> Vec<String> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => {
                    if depth < EXPAND_DEPTH && name != WATCH_OUT {
                        dirs.push(path);
                    }
                }
                Ok(t) if t.is_file() => {
                    let media = path
                        .extension()
                        .and_then(|x| x.to_str())
                        .is_some_and(|x| MEDIA_EXT.contains(&x.to_lowercase().as_str()));
                    if media {
                        files.push(path);
                    }
                }
                _ => {}
            }
        }
        files.sort();
        dirs.sort();
        for f in files {
            if out.len() >= EXPAND_MAX {
                return;
            }
            out.push(f.to_string_lossy().to_string());
        }
        for d in dirs {
            walk(&d, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    for p in paths {
        if out.len() >= EXPAND_MAX {
            break;
        }
        let path = PathBuf::from(&p);
        if path.is_dir() {
            walk(&path, 0, &mut out);
        } else {
            out.push(p);
        }
    }
    out
}

/// يوسّع المجلدات المُفلتة أو المختارة إلى ملفاتها، خارج خيوط tokio (قد يكون قرصًا شبكيًا بطيئًا)
#[cfg(desktop)]
#[tauri::command]
pub async fn expand_media_paths(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || expand_media(paths))
        .await
        .unwrap_or_default()
}

#[cfg(all(test, desktop))]
mod expand_tests {
    use super::*;

    #[test]
    fn folder_becomes_its_media_files_sorted_and_files_pass_through() {
        let root = std::env::temp_dir().join(format!("khama-expand-{}", std::process::id()));
        let sub = root.join("B-roll");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(sub.join(".hidden")).unwrap();
        std::fs::create_dir_all(root.join(WATCH_OUT)).unwrap();
        for f in ["b.MP4", "a.wav", "notes.txt", ".x.mov"] {
            std::fs::write(root.join(f), b"x").unwrap();
        }
        std::fs::write(sub.join("c.mov"), b"x").unwrap();
        std::fs::write(sub.join(".hidden").join("d.mov"), b"x").unwrap();
        std::fs::write(root.join(WATCH_OUT).join("e.mp4"), b"x").unwrap();
        let loose = "C:/elsewhere/clip.mkv".to_string();
        let got = expand_media(vec![root.to_string_lossy().to_string(), loose.clone()]);
        let names: Vec<String> = got
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, ["a.wav", "b.MP4", "c.mov", "clip.mkv"]);
        assert_eq!(got.last().unwrap(), &loose);
        let _ = std::fs::remove_dir_all(&root);
    }
}
