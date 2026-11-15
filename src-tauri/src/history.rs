//! سجلّ التنزيلات: يبقى بعد إغلاق التطبيق (ملف JSON بجانب الإعدادات، لا يغادر الجهاز).

use crate::errors::LockExt;
use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::errors::AppError;

/// أقصى عدد عناصر نحتفظ به (الأقدم يُحذف)
const MAX_ENTRIES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: u64,
    pub title: String,
    pub url: String,
    pub file: String,
    /// "video" | "audio"
    pub kind: String,
    /// سطر الوصف: الصيغة والجودة
    pub meta: String,
    #[serde(default)]
    pub thumbnail: Option<String>,
    /// وقت الانتهاء (ميلي ثانية منذ 1970)
    pub date: u64,
    /// يُحسب عند القراءة: هل الملف ما زال موجودًا؟
    #[serde(default, skip_deserializing)]
    pub exists: bool,
}

#[derive(Default)]
pub struct HistoryState(pub Mutex<Option<Vec<HistoryEntry>>>);

fn path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::with_detail("configDir", e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("history.json"))
}

fn with_list<T>(app: &AppHandle, state: &HistoryState, f: impl FnOnce(&mut Vec<HistoryEntry>) -> (T, bool)) -> Result<T, AppError> {
    let mut guard = state.0.lock_ok();
    if guard.is_none() {
        let list = match path(app) {
            Ok(p) => crate::persist::read_json(&p).or_default_logged("history.json"),
            Err(_) => Vec::new(),
        };
        *guard = Some(list);
    }
    let list = guard.as_mut().expect("loaded above");
    let (out, changed) = f(list);
    if changed {
        let json = serde_json::to_string(list).expect("history serialize");
        crate::persist::write_atomic(&path(app)?, json.as_bytes())?;
    }
    Ok(out)
}

/// async + خيط منفصل (T-21): فحص وجود حتى 1000 ملف لا يجمّد النافذة
/// (الأوامر المتزامنة في Tauri تعمل على الخيط الرئيسي).
#[tauri::command]
pub async fn get_history(app: AppHandle, state: State<'_, HistoryState>) -> Result<Vec<HistoryEntry>, AppError> {
    let mut out = with_list(&app, &state, |list| (list.clone(), false))?;
    tauri::async_runtime::spawn_blocking(move || {
        for e in &mut out {
            e.exists = std::path::Path::new(&e.file).exists();
        }
        out
    })
    .await
    .map_err(|e| AppError::with_detail("history", e.to_string()))
}

/// هل هذا الملف في السجلّ؟ (للتحقق من مسارات تطلبها الواجهة)
pub fn contains_file(app: &AppHandle, file: &str) -> bool {
    let state = app.state::<HistoryState>();
    with_list(app, &state, |list| (list.iter().any(|e| e.file == file), false)).unwrap_or(false)
}

/// معرّف جديد أكبر من كل ما في السجلّ (T-19): لا تصادم حتى لو انتهى تنزيلان في نفس الجزء من الثانية
fn next_id(list: &[HistoryEntry], now_ms: u64) -> u64 {
    let newest = list.iter().map(|e| e.id).max().unwrap_or(0);
    newest.max(now_ms.saturating_mul(1000)) + 1
}

#[tauri::command]
pub async fn add_history(app: AppHandle, state: State<'_, HistoryState>, mut entry: HistoryEntry) -> Result<(), AppError> {
    if let Some(local) = local_thumbnail(&app, &entry).await {
        entry.thumbnail = Some(local);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    with_list(&app, &state, |list| {
        entry.id = next_id(list, now);
        list.insert(0, entry);
        list.truncate(MAX_ENTRIES);
        ((), true)
    })
}

/// نسخة صغيرة دائمة من الصورة المصغّرة (T-20): روابط صور إنستغرام وتيك توك موقّعة
/// وتنتهي خلال ساعات، فنحفظ الصورة نفسها (حوالي 4 كيلوبايت) بدل رابطها.
/// المصدر: رابط الصورة وهو ما زال صالحًا، وإلا إطار من الفيديو المنزَّل.
async fn local_thumbnail(app: &AppHandle, entry: &HistoryEntry) -> Option<String> {
    let current = entry.thumbnail.as_deref().unwrap_or_default();
    if current.starts_with("data:") {
        return None;
    }
    let tools = crate::tools::resolve(app).ok()?;
    if (current.starts_with("https://") || current.starts_with("http://"))
        && let Some(img) = crate::convert::small_jpeg(&tools, current.as_ref(), 0.0, 160, 6).await
    {
        return Some(img);
    }
    let file = std::path::Path::new(&entry.file);
    if entry.kind == "video" && file.is_file() {
        return crate::convert::small_jpeg(&tools, file.as_os_str(), 3.0, 160, 6).await;
    }
    None
}

#[tauri::command]
pub fn remove_history(app: AppHandle, state: State<'_, HistoryState>, id: u64) -> Result<(), AppError> {
    with_list(&app, &state, |list| {
        list.retain(|e| e.id != id);
        ((), true)
    })
}

#[tauri::command]
pub fn clear_history(app: AppHandle, state: State<'_, HistoryState>) -> Result<(), AppError> {
    with_list(&app, &state, |list| {
        list.clear();
        ((), true)
    })
}

// ---------------- التنزيلات المجدولة ----------------
// تُحفظ في scheduled.json حتى تبقى بعد إغلاق التطبيق. محتواها تملكه الواجهة (قائمة JSON).

fn scheduled_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(path(app)?.with_file_name("scheduled.json"))
}

#[tauri::command]
pub fn get_scheduled(app: AppHandle) -> Result<serde_json::Value, AppError> {
    let list: serde_json::Value = crate::persist::read_json(&scheduled_path(&app)?).or_default_logged("scheduled.json");
    Ok(if list.is_array() {
        list
    } else {
        serde_json::Value::Array(Vec::new())
    })
}

#[tauri::command]
pub fn save_scheduled(app: AppHandle, items: serde_json::Value) -> Result<(), AppError> {
    let json = serde_json::to_string(&items).expect("scheduled serialize");
    crate::persist::write_atomic(&scheduled_path(&app)?, json.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: u64) -> HistoryEntry {
        HistoryEntry {
            id,
            title: String::new(),
            url: String::new(),
            file: String::new(),
            kind: "video".into(),
            meta: String::new(),
            thumbnail: None,
            date: 0,
            exists: false,
        }
    }

    #[test]
    fn next_id_is_unique_even_within_the_same_millisecond() {
        let mut list = vec![];
        for _ in 0..5 {
            let id = next_id(&list, 1_000);
            assert!(list.iter().all(|e: &HistoryEntry| e.id != id));
            list.insert(0, entry(id));
        }
        assert_eq!(list[0].id, 1_000_005);
    }

    #[test]
    fn next_id_keeps_growing_if_the_clock_goes_back() {
        let list = vec![entry(9_000_000)];
        assert_eq!(next_id(&list, 1), 9_000_001);
    }
}
