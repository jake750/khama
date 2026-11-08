//! جسر أندرويد.
//!
//! مكتبة youtubedl-android (عبر ToolsPlugin.kt) تفكّ Python و yt-dlp و FFmpeg و QuickJS
//! داخل التطبيق وتعطينا مساراتها. بعدها يشغّلها كود Rust نفسه الذي يعمل على الكمبيوتر
//! (نفس أوامر yt-dlp، ونفس قراءة التقدّم، ونفس الإلغاء).

use std::{collections::HashMap, path::Path, sync::OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, Runtime, Wry,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

use crate::errors::AppError;

#[derive(Debug, Clone, Deserialize)]
pub struct Paths {
    pub python: String,
    pub ytdlp: String,
    pub ffmpeg: String,
    pub quickjs: String,
    pub env: HashMap<String, String>,
}

static PATHS: OnceLock<Paths> = OnceLock::new();

struct Bridge<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("khama-tools")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.jake750.khama", "ToolsPlugin")?;
            app.manage(Bridge(handle));
            Ok(())
        })
        .build()
}

fn bridge(app: &AppHandle) -> Result<tauri::State<'_, Bridge<Wry>>, AppError> {
    app.try_state::<Bridge<Wry>>().ok_or_else(|| AppError::with_detail("toolMissing", "android bridge"))
}

/// أول استدعاء يفكّ الأدوات (ثوانٍ قليلة في أول تشغيل فقط)، والباقي من الذاكرة
pub fn paths(app: &AppHandle) -> Result<Paths, AppError> {
    if let Some(p) = PATHS.get() {
        return Ok(p.clone());
    }
    let p: Paths = bridge(app)?
        .0
        .run_mobile_plugin("setup", ())
        .map_err(|e| AppError::with_detail("toolsSetup", e.to_string()))?;
    let _ = PATHS.set(p.clone());
    Ok(p)
}

#[derive(Debug, Deserialize)]
pub struct UpdateOut {
    pub updated: bool,
    pub version: Option<String>,
}

pub fn update_ytdlp(app: &AppHandle) -> Result<UpdateOut, AppError> {
    paths(app)?;
    bridge(app)?
        .0
        .run_mobile_plugin("updateYtdlp", ())
        .map_err(|e| AppError::with_detail("updateFailed", e.to_string()))
}

#[derive(Serialize)]
struct PublishArgs<'a> {
    path: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct Published {
    pub path: String,
}

/// ينقل الملف المنتهي إلى Download/Khama العام (يظهر في المعرض ومدير الملفات)
pub fn publish(app: &AppHandle, file: &Path) -> Result<Published, AppError> {
    bridge(app)?
        .0
        .run_mobile_plugin("publish", PublishArgs { path: &file.to_string_lossy() })
        .map_err(|e| AppError::with_detail("saveFailed", e.to_string()))
}
