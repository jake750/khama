//! جسر أندرويد.
//!
//! مكتبة youtubedl-android (عبر ToolsPlugin.kt) تفكّ Python و yt-dlp و FFmpeg و QuickJS
//! داخل التطبيق وتعطينا مساراتها. بعدها يشغّلها كود Rust نفسه الذي يعمل على الكمبيوتر
//! (نفس أوامر yt-dlp، ونفس قراءة التقدّم، ونفس الإلغاء).

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::OnceLock,
};

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
    #[serde(default)]
    pub ffprobe: String,
    pub quickjs: String,
    /// مجلد المكتبات الأصلية (فيه libonnxruntime.so)
    #[serde(default)]
    pub libdir: String,
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
    if PATHS.set(p.clone()).is_ok() {
        // كل عملية نشغّلها (ffmpeg للمحوّل، ffprobe، إزالة الموسيقى...) ترث مكتبات FFmpeg و Python.
        // لا يؤثر على التطبيق نفسه: المكتبات المحمّلة لا تتغير بعد بدء العملية.
        for (k, v) in &p.env {
            // SAFETY: مرة واحدة، قبل تشغيل أي أداة؛ لا كود آخر يقرأ هذه المتغيرات
            unsafe { std::env::set_var(k, v) };
        }
    }
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
    subdir: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
pub struct Published {
    pub path: String,
}

/// ينقل الملف المنتهي إلى Download/Khama العام (يظهر في المعرض ومدير الملفات)
pub fn publish(app: &AppHandle, file: &Path) -> Result<Published, AppError> {
    publish_in(app, file, None)
}

/// مثل publish، داخل مجلد فرعي من Download/Khama
pub fn publish_in(app: &AppHandle, file: &Path, subdir: Option<&str>) -> Result<Published, AppError> {
    bridge(app)?
        .0
        .run_mobile_plugin("publish", PublishArgs { path: &file.to_string_lossy(), subdir })
        .map_err(|e| AppError::with_detail("saveFailed", e.to_string()))
}

/// ينشر ملفًا أو مجلدًا كاملًا (لقطات ثابتة، أجزاء، تسلسل صور): المجلد يصبح مجلدًا فرعيًا
pub async fn publish_any(app: &AppHandle, path: PathBuf) -> Result<PathBuf, AppError> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if path.is_dir() {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let mut files: Vec<PathBuf> = std::fs::read_dir(&path)?.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
            files.sort();
            let mut last = None;
            for f in files {
                last = Some(publish_in(&app, &f, Some(&name))?.path);
            }
            let _ = std::fs::remove_dir_all(&path);
            // نعيد مسار المجلد نفسه في Download/Khama
            Ok(last.map(|p| PathBuf::from(p).parent().map(Path::to_path_buf).unwrap_or_default()).unwrap_or_default())
        } else {
            Ok(PathBuf::from(publish(&app, &path)?.path))
        }
    })
    .await
    .map_err(|e| AppError::with_detail("saveFailed", e.to_string()))?
}

#[derive(Serialize)]
struct ImportArgs<'a> {
    uri: &'a str,
    dir: &'a str,
}

#[derive(Debug, Deserialize)]
struct Imported {
    path: String,
}

/// ملفات اختارها المستخدم (content://...) تُنسخ داخل التطبيق باسمها الحقيقي.
/// المسار العادي يبقى كما هو.
pub fn import_file(app: &AppHandle, uri: &str) -> Result<String, AppError> {
    if !uri.starts_with("content://") {
        return Ok(uri.to_string());
    }
    // مجلد لكل ملف: ملفان بنفس الاسم من مكانين مختلفين لا يتصادمان
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = crate::download::jobs_root(app)?.join("import").join(format!("{n:x}"));
    let out: Imported = bridge(app)?
        .0
        .run_mobile_plugin("importFile", ImportArgs { uri, dir: &dir.to_string_lossy() })
        .map_err(|e| AppError::with_detail("badInput", e.to_string()))?;
    Ok(out.path)
}

#[derive(Serialize)]
struct FetchArgs<'a> {
    url: &'a str,
    dest: &'a str,
}

/// تنزيل ملف كبير بشبكة أندرويد (بلا تشغيل عملية منفصلة). يعود بعد الاكتمال أو الخطأ أو الإلغاء.
pub fn fetch_file(app: &AppHandle, url: &str, dest: &Path) -> Result<(), AppError> {
    bridge(app)?
        .0
        .run_mobile_plugin::<serde_json::Value>("fetchFile", FetchArgs { url, dest: &dest.to_string_lossy() })
        .map(|_| ())
        .map_err(|e| AppError::with_detail("aiDownload", e.to_string()))
}

pub fn cancel_fetch(app: &AppHandle) {
    if let Ok(b) = bridge(app) {
        let _ = b.0.run_mobile_plugin::<serde_json::Value>("cancelFetch", ());
    }
}
