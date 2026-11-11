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
        let list = path(app)
            .ok()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        *guard = Some(list);
    }
    let list = guard.as_mut().expect("loaded above");
    let (out, changed) = f(list);
    if changed {
        fs::write(path(app)?, serde_json::to_string(list).expect("history serialize"))?;
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
