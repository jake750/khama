//! الإعدادات: تُحفظ كملف JSON في مجلد إعدادات التطبيق الخاص بالنظام
//! (Windows: %APPDATA%\com.jake750.khama  —  macOS: ~/Library/Application Support/...).
//! لا شيء يُرسل لأي خادم.

use crate::errors::LockExt;
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
    /// حدّ سرعة التنزيل بالكيلوبايت/ثانية (0 = بلا حدّ). بالكيلوبايت ليمكن 512 مثلًا (T-89)
    pub rate_limit_kb: u32,
    /// 0.3.1 وما قبله: الحدّ بالميغابايت. يُقرأ فقط ويحوَّل في migrate
    #[serde(skip_serializing)]
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
    /// عدد التنزيلات التي تعمل معًا، من 1 إلى 5 (T-63)
    pub parallel_downloads: u8,
    /// فحص أسبوعي لتحديث yt-dlp، بموافقة المستخدم (معطّل افتراضيًا، T-100)
    pub ytdlp_weekly: bool,
    /// آخر فحص لتحديث yt-dlp (ms منذ 1970)
    pub ytdlp_checked_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// معرّف ثابت لا يتغيّر بتغيّر الاسم. الإعدادات القديمة بلا معرّف: يُستخدم الاسم (انظر migrate)
    #[serde(default)]
    pub id: String,
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
            rate_limit_kb: 0,
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
            parallel_downloads: 3,
            ytdlp_weekly: false,
            ytdlp_checked_at: 0,
        }
    }
}

pub struct SettingsState(pub Mutex<Settings>);

pub(crate) fn config_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
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
    let _g = LOCK.lock_ok();
    let Ok(p) = config_dir(app).map(|d| d.join("counter.txt")) else {
        return 1;
    };
    let n = fs::read_to_string(&p).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0) + 1;
    let _ = crate::persist::write_atomic(&p, n.to_string().as_bytes());
    n
}

pub fn cookies_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(config_dir(app)?.join("cookies.txt"))
}

pub fn load(app: &AppHandle) -> Settings {
    match settings_path(app) {
        Ok(p) => migrate(crate::persist::read_json(&p).or_default_logged("settings.json")),
        Err(_) => Settings::default(),
    }
}

/// ترقية إعدادات الإصدارات السابقة
fn migrate(mut s: Settings) -> Settings {
    // 0.3.1 وما قبله: المشروع يُعرَّف باسمه، وactive_project يحمل الاسم.
    // نجعل المعرّف = الاسم فيبقى المشروع النشط مختارًا كما هو.
    for p in &mut s.projects {
        if p.id.is_empty() {
            p.id = p.name.clone();
        }
    }
    // 0.3.1 وما قبله: rateLimit بالميغابايت
    if s.rate_limit > 0 && s.rate_limit_kb == 0 {
        s.rate_limit_kb = s.rate_limit.saturating_mul(1024);
    }
    s.rate_limit = 0;
    sanitize(&mut s);
    s
}

/// يُرجع القيمة إن كانت من المسموح، وإلا الافتراضية
fn pick(v: &mut String, allowed: &[&str], fallback: &str) {
    if !allowed.contains(&v.as_str()) {
        *v = fallback.into();
    }
}

const KINDS: &[&str] = &["video", "audio"];
const VIDEO_FORMATS: &[&str] = &["mp4", "mov"];
const AUDIO_FORMATS: &[&str] = &["mp3", "m4a", "wav"];
const QUALITIES: &[&str] = &["best", "2160", "1440", "1080", "720", "480"];

/// الحقول التي لها قيم محدودة تبقى نصوصًا في JSON (ليقرأها الإصدار الأقدم كما هي)،
/// لكن أي قيمة غير معروفة تعود إلى الافتراضية بدل أن تُقبل وتُحفظ (T-9).
/// اخترنا هذا على enum في serde لأن قيمة واحدة خاطئة في enum تُفشل قراءة الملف كله
/// فتضيع كل الإعدادات، أما هنا فيُصحَّح الحقل الخاطئ وحده.
fn sanitize(s: &mut Settings) {
    let d = Settings::default();
    pick(&mut s.language, &["en", "ar"], &d.language);
    pick(&mut s.theme, &["dark", "light", "system"], &d.theme);
    pick(&mut s.kind, KINDS, &d.kind);
    pick(&mut s.video_format, VIDEO_FORMATS, &d.video_format);
    pick(&mut s.audio_format, AUDIO_FORMATS, &d.audio_format);
    pick(&mut s.quality, QUALITIES, &d.quality);
    pick(&mut s.cookies_mode, &["none", "browser", "file"], &d.cookies_mode);
    pick(&mut s.convert_dest, &["source", "output"], &d.convert_dest);
    for p in &mut s.projects {
        pick(&mut p.kind, KINDS, &d.kind);
        pick(&mut p.video_format, VIDEO_FORMATS, &d.video_format);
        pick(&mut p.audio_format, AUDIO_FORMATS, &d.audio_format);
        pick(&mut p.quality, QUALITIES, &d.quality);
    }
    s.parallel_downloads = s.parallel_downloads.clamp(1, 5);
}

/// المجلد الفعلي للحفظ: ما اختاره المستخدم، وإلا مجلد التنزيلات
pub fn resolve_output_dir(app: &AppHandle, s: &Settings) -> Result<PathBuf, AppError> {
    if let Some(dir) = s.output_dir.as_deref().filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    app.path().download_dir().map_err(|_| AppError::new("noDownloadsDir"))
}

// ---------------- أوامر تستدعيها الواجهة ----------------

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> Settings {
    state.0.lock_ok().clone()
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: tauri::State<SettingsState>,
    queue: tauri::State<crate::download::DownloadQueue>,
    mut settings: Settings,
) -> Result<(), AppError> {
    sanitize(&mut settings);
    #[cfg(desktop)]
    crate::background::set_clipboard_watch(settings.watch_clipboard);
    queue.set_limit(settings.parallel_downloads.into());
    let json = serde_json::to_string_pretty(&settings).expect("settings serialize");
    crate::persist::write_atomic(&settings_path(&app)?, json.as_bytes())?;
    *state.0.lock_ok() = settings;
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
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out = clean_cookies(&content, now).map_err(AppError::new)?;
    crate::persist::write_atomic_private(&cookies_path(&app)?, out.as_bytes())?;
    Ok(())
}

/// سطر كوكيز بصيغة Netscape: نطاق، TRUE/FALSE، مسار، TRUE/FALSE، انتهاء (ثوانٍ، 0 = للجلسة)، اسم، قيمة.
/// يُرجع وقت الانتهاء إن كان السطر صالحًا.
fn cookie_expiry(line: &str) -> Option<u64> {
    let f: Vec<&str> = line.split('\t').collect();
    let flag = |s: &str| s == "TRUE" || s == "FALSE";
    let domain = f.first()?.trim_start_matches("#HttpOnly_");
    let ok = f.len() == 7 && domain.contains('.') && flag(f[1]) && f[2].starts_with('/') && flag(f[3]) && !f[5].is_empty();
    if !ok {
        return None;
    }
    f[4].parse::<f64>().ok().filter(|e| *e >= 0.0).map(|e| e as u64)
}

/// يتحقق من ملف الكوكيز الملصوق ويُبقي الأسطر الصالحة فقط (T-59).
/// "cookiesInvalid" = لا سطر صالح، "cookiesExpired" = كل الكوكيز منتهية.
fn clean_cookies(content: &str, now: u64) -> Result<String, &'static str> {
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    let (mut valid, mut alive) = (0, 0);
    for line in content.lines().map(|l| l.trim_end_matches('\r')) {
        // تعليق عادي (لا #HttpOnly_ الذي هو كوكيز حقيقية)
        if line.is_empty() || (line.starts_with('#') && !line.starts_with("#HttpOnly_")) {
            continue;
        }
        if let Some(exp) = cookie_expiry(line) {
            valid += 1;
            if exp == 0 || exp > now {
                alive += 1;
            }
            out.push_str(line);
            out.push('\n');
        }
    }
    match (valid, alive) {
        (0, _) => Err("cookiesInvalid"),
        (_, 0) => Err("cookiesExpired"),
        _ => Ok(out),
    }
}

#[tauri::command]
pub fn delete_cookies(app: AppHandle) -> Result<(), AppError> {
    let p = cookies_path(&app)?;
    if p.exists() {
        fs::remove_file(p)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_gives_old_projects_their_name_as_id() {
        let json = r#"{"projects":[{"name":"قناتي","outputDir":null,"kind":"video","videoFormat":"mp4",
            "audioFormat":"mp3","quality":"1080","editorReady":true,"filenameTemplate":"{title}"}],
            "activeProject":"قناتي"}"#;
        let s = migrate(serde_json::from_str(json).unwrap());
        assert_eq!(s.projects[0].id, "قناتي");
        assert_eq!(s.active_project.as_deref(), Some(s.projects[0].id.as_str()));
    }

    #[test]
    fn cookies_are_validated_line_by_line() {
        let good = ".youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tabc";
        let http_only = "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tHSID\txyz";
        let old = ".youtube.com\tTRUE\t/\tTRUE\t1000\tOLD\tv";
        let text = format!("# Netscape HTTP Cookie File\r\n# comment\r\n{good}\r\nnot a cookie\r\n{http_only}\r\n{old}\r\n");
        let out = clean_cookies(&text, 1_800_000_000).unwrap();
        assert_eq!(out, format!("# Netscape HTTP Cookie File\n{good}\n{http_only}\n{old}\n"));

        assert_eq!(clean_cookies("hello\tworld", 0), Err("cookiesInvalid"));
        assert_eq!(clean_cookies("a\tb\tc\td\te\tf\tg", 0), Err("cookiesInvalid"), "7 حقول لا تكفي");
        assert_eq!(clean_cookies(old, 1_800_000_000), Err("cookiesExpired"));
    }

    #[test]
    fn parallel_downloads_defaults_to_three_and_is_clamped() {
        let s = migrate(serde_json::from_str("{}").unwrap());
        assert_eq!(s.parallel_downloads, 3);
        let s = migrate(serde_json::from_str(r#"{"parallelDownloads":9}"#).unwrap());
        assert_eq!(s.parallel_downloads, 5);
        let s = migrate(serde_json::from_str(r#"{"parallelDownloads":0}"#).unwrap());
        assert_eq!(s.parallel_downloads, 1);
    }

    #[test]
    fn unknown_values_fall_back_to_defaults() {
        let json = r#"{"theme":"purple","kind":"video","quality":"999","cookiesMode":"x","convertDest":"output",
            "projects":[{"name":"p","outputDir":null,"kind":"gif","videoFormat":"mov","audioFormat":"ogg",
            "quality":"720","editorReady":true,"filenameTemplate":"{title}"}]}"#;
        let s = migrate(serde_json::from_str(json).unwrap());
        assert_eq!(
            (s.theme.as_str(), s.quality.as_str(), s.cookies_mode.as_str()),
            ("dark", "1080", "none")
        );
        assert_eq!(
            (s.kind.as_str(), s.convert_dest.as_str()),
            ("video", "output"),
            "القيم الصحيحة تبقى"
        );
        let p = &s.projects[0];
        assert_eq!(
            (
                p.kind.as_str(),
                p.video_format.as_str(),
                p.audio_format.as_str(),
                p.quality.as_str()
            ),
            ("video", "mov", "mp3", "720")
        );
    }

    #[test]
    fn migrate_turns_old_megabyte_limit_into_kilobytes() {
        let s = migrate(serde_json::from_str(r#"{"rateLimit":5}"#).unwrap());
        assert_eq!(s.rate_limit_kb, 5 * 1024);
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains(r#""rateLimitKb":5120"#) && !json.contains(r#""rateLimit":"#));
        let s = migrate(serde_json::from_str(r#"{"rateLimitKb":512}"#).unwrap());
        assert_eq!(s.rate_limit_kb, 512);
    }
}
