//! الإعدادات: تُحفظ كملف JSON في مجلد إعدادات التطبيق الخاص بالنظام
//! (Windows: %APPDATA%\com.jake750.khama  —  macOS: ~/Library/Application Support/...).
//! لا شيء يُرسل لأي خادم.

use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::errors::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// مجلد الحفظ. فارغ = مجلد التنزيلات الافتراضي للنظام
    pub output_dir: Option<String>,
    /// لغة الواجهة: "en" (الافتراضية) | "ar"
    pub language: String,
    /// "dark" | "light" | "system"
    pub theme: String,
    /// "video" | "audio"
    pub kind: String,
    /// "mp4" | "mov" للفيديو — "mp3" | "m4a" | "wav" للصوت
    pub video_format: String,
    pub audio_format: String,
    /// "best" | "2160" | "1440" | "1080" | "720" | "480"
    pub quality: String,
    /// تحويل تلقائي إلى H.264 + AAC بمعدل إطارات ثابت عند الحاجة
    pub editor_ready: bool,
    /// "none" | "browser" | "file"
    pub cookies_mode: String,
    /// firefox | chrome | edge | brave | ...
    pub cookies_browser: String,
    /// هل قرأ المستخدم تنبيه حقوق المحتوى
    pub accepted_notice: bool,
    /// هل رأى المستخدم ترحيب أول فتح (وعرض جولة الخصائص)
    pub seen_tour: bool,
    /// أين يُحفظ ناتج التحويل: "source" (بجانب الملف الأصلي) | "output" (مجلد الحفظ)
    pub convert_dest: String,
    /// آخر Preset استُخدم في المحوّل
    pub convert_preset: String,
    /// استخدام كرت الشاشة في التحويل إن توفر
    pub convert_hw: bool,
    /// مجلدات مراقَبة: كل ملف جديد فيها يُحوَّل تلقائيًا
    pub watch_folders: Vec<WatchFolder>,
    /// قالب اسم الملف: {title} {uploader} {date} {today} {site} {id} {res} {n}
    pub filename_template: String,
    /// مجلد فرعي لكل موقع (YouTube/، Instagram/...)
    pub site_folders: bool,
    /// حدّ سرعة التنزيل بالميغابايت/ثانية (0 = بلا حدّ)
    pub rate_limit: u32,
    /// إشعار من النظام عند انتهاء تنزيل أو فشله
    pub notify: bool,
    /// زر الإغلاق يُخفي النافذة في شريط المهام، والتنزيلات تكمل في الخلفية
    pub close_to_tray: bool,
    /// اقتراح تنزيل أي رابط يُنسخ (حتى والتطبيق في الخلفية)
    pub watch_clipboard: bool,
    /// آخر مجلدات حفظ استُخدمت (الأحدث أولًا)
    pub recent_dirs: Vec<String>,
    /// إضافات التنزيل المختارة آخر مرة
    pub want_subs: bool,
    pub sub_langs: Vec<String>,
    pub want_thumb: bool,
    pub want_info: bool,
    /// مشاريع: كل مشروع مجلد حفظ وإعدادات خاصة به
    pub projects: Vec<Project>,
    pub active_project: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub output_dir: Option<String>,
    pub kind: String,
    pub video_format: String,
    pub audio_format: String,
    pub quality: String,
    pub editor_ready: bool,
    pub filename_template: String,
    #[serde(default)]
    pub site_folders: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFolder {
    pub dir: String,
    pub preset: String,
    #[serde(default)]
    pub enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            output_dir: None,
            language: "en".into(),
            theme: "dark".into(),
            kind: "video".into(),
            video_format: "mp4".into(),
            audio_format: "mp3".into(),
            quality: "1080".into(),
            editor_ready: true,
            cookies_mode: "none".into(),
            cookies_browser: "firefox".into(),
            accepted_notice: false,
            seen_tour: false,
            convert_dest: "source".into(),
            convert_preset: "edit_h264".into(),
            convert_hw: true,
            watch_folders: Vec::new(),
            filename_template: "{title}".into(),
            site_folders: false,
            rate_limit: 0,
            notify: true,
            close_to_tray: true,
            watch_clipboard: false,
            recent_dirs: Vec::new(),
            want_subs: false,
            sub_langs: Vec::new(),
            want_thumb: false,
            want_info: false,
            projects: Vec::new(),
            active_project: None,
        }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

fn config_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::with_detail("configDir", e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(config_dir(app)?.join("settings.json"))
}

/// عدّاد {n} في قالب اسم الملف: يزيد مع كل تنزيل ويبقى بعد إغلاق التطبيق
pub fn next_counter(app: &AppHandle) -> u64 {
    static LOCK: Mutex<()> = Mutex::new(());
    let _g = LOCK.lock().unwrap();
    let Ok(p) = config_dir(app).map(|d| d.join("counter.txt")) else { return 1 };
    let n = fs::read_to_string(&p).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0) + 1;
    let _ = fs::write(&p, n.to_string());
    n
}

pub fn cookies_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(config_dir(app)?.join("cookies.txt"))
}

pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// المجلد الفعلي للحفظ: ما اختاره المستخدم، وإلا مجلد التنزيلات
pub fn resolve_output_dir(app: &AppHandle, s: &Settings) -> Result<PathBuf, AppError> {
    if let Some(dir) = s.output_dir.as_deref().filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    app.path()
        .download_dir()
        .map_err(|_| AppError::new("noDownloadsDir"))
}

// ---------------- أوامر تستدعيها الواجهة ----------------

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: tauri::State<SettingsState>,
    settings: Settings,
) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(&settings).expect("settings serialize");
    fs::write(settings_path(&app)?, json)?;
    *state.0.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
pub fn default_output_dir(app: AppHandle) -> Option<String> {
    app.path().download_dir().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn has_saved_cookies(app: AppHandle) -> bool {
    cookies_path(&app).map(|p| p.exists()).unwrap_or(false)
}

/// يحفظ كوكيز ملصوقة يدويًا (صيغة Netscape التي تصدّرها إضافات المتصفح)
#[tauri::command]
pub fn save_cookies(app: AppHandle, content: String) -> Result<(), AppError> {
    let content = content.replace("\r\n", "\n");
    let valid_lines = content
        .lines()
        .filter(|l| !l.starts_with('#') && l.split('\t').count() >= 7)
        .count();
    if valid_lines == 0 {
        return Err(AppError::new("cookiesInvalid"));
    }
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    out.push_str(content.trim_start_matches("# Netscape HTTP Cookie File\n"));
    if !out.ends_with('\n') {
        out.push('\n');
    }
    fs::write(cookies_path(&app)?, out)?;
    Ok(())
}

#[tauri::command]
pub fn delete_cookies(app: AppHandle) -> Result<(), AppError> {
    let p = cookies_path(&app)?;
    if p.exists() {
        fs::remove_file(p)?;
    }
    Ok(())
}
