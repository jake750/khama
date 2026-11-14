//! سجلّ التنزيلات: يبقى بعد إغلاق التطبيق (ملف JSON بجانب الإعدادات، لا يغادر الجهاز).

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
    let mut guard = state.0.lock().unwrap();
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

#[tauri::command]
pub fn get_history(app: AppHandle, state: State<'_, HistoryState>) -> Result<Vec<HistoryEntry>, AppError> {
    with_list(&app, &state, |list| {
        let mut out = list.clone();
        for e in &mut out {
            e.exists = std::path::Path::new(&e.file).exists();
        }
        (out, false)
    })
}

#[tauri::command]
pub fn add_history(app: AppHandle, state: State<'_, HistoryState>, entry: HistoryEntry) -> Result<(), AppError> {
    with_list(&app, &state, |list| {
        list.retain(|e| e.id != entry.id);
        list.insert(0, entry);
        list.truncate(MAX_ENTRIES);
        ((), true)
    })
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
    Ok(if list.is_array() { list } else { serde_json::Value::Array(Vec::new()) })
}

#[tauri::command]
pub fn save_scheduled(app: AppHandle, items: serde_json::Value) -> Result<(), AppError> {
    let json = serde_json::to_string(&items).expect("scheduled serialize");
    crate::persist::write_atomic(&scheduled_path(&app)?, json.as_bytes())?;
    Ok(())
}
