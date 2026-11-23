//! الإعدادات: تُحفظ كملف JSON في مجلد إعدادات التطبيق الخاص بالنظام
//! (Windows: %APPDATA%\com.jake750.khama  —  macOS: ~/Library/Application Support/...).
//! لا شيء يُرسل لأي خادم.

use crate::errors::LockExt;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::errors::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// نسخة بنية الملف (M-36). ملف قديم بلا هذا الحقل = 0، وmigrate ترفعه خطوة خطوة إلى SETTINGS_VERSION
    #[serde(default)]
    pub schema_version: u32,
    /// مجلد الحفظ. فارغ = مجلد التنزيلات الافتراضي للنظام
    pub output_dir: Option<String>,
    /// لغة الواجهة: "en" (الافتراضية، وأول تشغيل دائمًا بالإنجليزية) | "ar". تُحفظ عند كل تغيير وتبقى بعد إعادة التشغيل
    pub language: String,
    /// "dark" | "light" | "system"
    pub theme: String,
    /// اتجاه التخطيط: "rtl" (الافتراضي، كما كان منذ 0.3.x) | "ltr" | "auto" (يتبع اللغة).
    /// مستقل عن اللغة: عربي بتخطيط من اليسار، أو إنجليزي معكوس
    pub layout_dir: String,
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
    /// مجلد فرعي لكل نوع: Video/ وAudio/ (U-88)
    pub kind_folders: bool,
    /// حدّ سرعة التنزيل بالكيلوبايت/ثانية (0 = بلا حدّ). بالكيلوبايت ليمكن 512 مثلًا (T-89)
    pub rate_limit_kb: u32,
    /// 0.3.1 وما قبله: الحدّ بالميغابايت. يُقرأ فقط ويحوَّل في migrate
    #[serde(skip_serializing)]
    #[cfg_attr(test, ts(skip))]
    pub rate_limit: u32,
    /// إشعار من النظام عند انتهاء تنزيل أو فشله
    pub notify: bool,
    /// زر الإغلاق يُخفي النافذة في شريط المهام، والتنزيلات تكمل في الخلفية
    pub close_to_tray: bool,
    /// اقتراح تنزيل أي رابط يُنسخ (حتى والتطبيق في الخلفية)
    pub watch_clipboard: bool,
    /// البحث عن تحديث لخامة عند الفتح (يتصل بـ GitHub). يمكن إطفاؤه (F-51)
    pub check_updates: bool,
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
    /// أندرويد: المجلد العام الذي تُحفظ فيه الملفات (Download وMovies وMusic وDCIM وPictures، U-76)
    pub mobile_base: String,
    /// أندرويد: اسم المجلد الفرعي داخله (فارغ = في المجلد العام مباشرة)
    pub mobile_folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
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
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
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
            schema_version: SETTINGS_VERSION,
            output_dir: None,
            language: "en".into(),
            theme: "dark".into(),
            layout_dir: "rtl".into(),
            kind: "video".into(),
            video_format: "mp4".into(),
            audio_format: "mp3".into(),
            quality: "1080".into(),
            editor_ready: true,
            cookies_mode: "none".into(),
            cookies_browser: "firefox".into(),
            accepted_notice: false,
            seen_tour: false,
            // في مجلد الحفظ افتراضيًا: «بجانب الأصل» قد يكتب ProRes ضخمًا على بطاقة الكاميرا نفسها (U-23)
            convert_dest: "output".into(),
            convert_preset: "edit_h264".into(),
            convert_hw: true,
            watch_folders: Vec::new(),
            filename_template: "{title}".into(),
            site_folders: false,
            kind_folders: false,
            rate_limit_kb: 0,
            rate_limit: 0,
            notify: true,
            close_to_tray: true,
            watch_clipboard: false,
            check_updates: true,
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
            mobile_base: "Download".into(),
            mobile_folder: "Khama".into(),
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

// ---------------- عدّاد {n} في قالب اسم الملف (T-66) ----------------
// لكل مشروع عدّاده، والرقم لا يُثبَّت إلا إن نجح التنزيل (الفاشل لا يستهلك رقمًا)، ويمكن تصفيره.
// تنزيلان يعملان معًا يحجز كلٌّ منهما رقمًا مختلفًا.

/// أرقام كل مشروع: آخر رقم ثُبِّت، والمحجوزة لتنزيلات جارية. المفتاح معرّف المشروع ("" = بلا مشروع)
#[derive(Default)]
pub(crate) struct Counters {
    pub last: std::collections::HashMap<String, u64>,
    reserved: std::collections::HashMap<String, std::collections::BTreeSet<u64>>,
}

impl Counters {
    pub fn next(&self, key: &str) -> u64 {
        let last = self.last.get(key).copied().unwrap_or(0);
        let busy = self.reserved.get(key).and_then(|r| r.last().copied()).unwrap_or(0);
        last.max(busy) + 1
    }
    pub fn reserve(&mut self, key: &str) -> u64 {
        let n = self.next(key);
        self.reserved.entry(key.into()).or_default().insert(n);
        n
    }
    /// ok = نجح التنزيل فيُثبَّت الرقم، وإلا يُحرَّر
    pub fn finish(&mut self, key: &str, n: u64, ok: bool) {
        if let Some(r) = self.reserved.get_mut(key) {
            r.remove(&n);
        }
        if ok {
            let last = self.last.entry(key.into()).or_insert(0);
            *last = (*last).max(n);
        }
    }
    pub fn reset(&mut self, key: &str) {
        self.last.remove(key);
    }
}

/// (العدّادات محمّلة؟، العدّادات، العملية ← (المشروع، الرقم))
type CounterState = (bool, Counters, std::collections::HashMap<u64, (String, u64)>);
static COUNTERS: Mutex<Option<CounterState>> = Mutex::new(None);

fn with_counters<R>(app: &AppHandle, f: impl FnOnce(&mut Counters, &mut std::collections::HashMap<u64, (String, u64)>) -> R) -> R {
    let mut guard = COUNTERS.lock_ok();
    let state = guard.get_or_insert_with(Default::default);
    if !state.0 {
        state.0 = true;
        if let Ok(dir) = config_dir(app) {
            state.1.last = crate::persist::read_json(&dir.join("counters.json")).or_default_logged("counters.json");
            // 0.3.9 وما قبله: عدّاد واحد عام في counter.txt
            let old = dir.join("counter.txt");
            if let Some(n) = fs::read_to_string(&old).ok().and_then(|s| s.trim().parse::<u64>().ok()) {
                state.1.last.entry(String::new()).or_insert(n);
                let _ = fs::remove_file(old);
            }
        }
    }
    f(&mut state.1, &mut state.2)
}

fn save_counters(app: &AppHandle, c: &Counters) {
    if let (Ok(dir), Ok(json)) = (config_dir(app), serde_json::to_vec(&c.last)) {
        let _ = crate::persist::write_atomic(&dir.join("counters.json"), &json);
    }
}

fn project_key(s: &Settings) -> String {
    s.active_project.clone().unwrap_or_default()
}

/// يحجز رقم {n} لتنزيل يبدأ
pub fn reserve_counter(app: &AppHandle, id: u64, s: &Settings) -> u64 {
    let key = project_key(s);
    with_counters(app, |c, jobs| {
        let n = c.reserve(&key);
        jobs.insert(id, (key, n));
        n
    })
}

/// انتهى التنزيل: نجاح يثبّت رقمه، وفشل أو إلغاء يحرّره
pub fn finish_counter(app: &AppHandle, id: u64, ok: bool) {
    with_counters(app, |c, jobs| {
        if let Some((key, n)) = jobs.remove(&id) {
            c.finish(&key, n, ok);
            if ok {
                save_counters(app, c);
            }
        }
    });
}

/// الرقم الذي سيأخذه التنزيل القادم في المشروع النشط
#[tauri::command]
pub fn counter_next(app: AppHandle, state: tauri::State<SettingsState>) -> u64 {
    let key = project_key(&state.0.lock_ok());
    with_counters(&app, |c, _| c.next(&key))
}

#[tauri::command]
pub fn reset_counter(app: AppHandle, state: tauri::State<SettingsState>) -> u64 {
    let key = project_key(&state.0.lock_ok());
    with_counters(&app, |c, _| {
        c.reset(&key);
        save_counters(&app, c);
        c.next(&key)
    })
}

pub fn cookies_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(config_dir(app)?.join("cookies.txt"))
}

pub fn load(app: &AppHandle) -> Settings {
    settings_path(app).map(|p| load_from(&p)).unwrap_or_default()
}

/// لا ملف بعد (أول تشغيل) = الافتراضيات، والواجهة بالإنجليزية أيًّا كانت لغة النظام
fn load_from(path: &std::path::Path) -> Settings {
    migrate(crate::persist::read_json::<Settings>(path).or_default_logged("settings.json"))
}

/// ما يكتبه save_settings على القرص
fn write_to(path: &std::path::Path, mut settings: Settings) -> std::io::Result<()> {
    sanitize(&mut settings);
    let json = serde_json::to_string_pretty(&settings).expect("settings serialize");
    crate::persist::write_atomic(path, json.as_bytes())
}

/// ترقية إعدادات الإصدارات السابقة
/// نسخة بنية settings.json الحالية. أي تغيير لا يكفيه serde(default) يرفعها ويضيف خطوة في migrate
pub const SETTINGS_VERSION: u32 = 1;

fn migrate(mut s: Settings) -> Settings {
    if s.schema_version < 1 {
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
    }
    s.rate_limit = 0;
    s.schema_version = SETTINGS_VERSION;
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
const AUDIO_FORMATS: &[&str] = &["mp3", "m4a", "wav", "original"];
const QUALITIES: &[&str] = &["best", "2160", "1440", "1080", "720", "480"];

/// الحقول التي لها قيم محدودة تبقى نصوصًا في JSON (ليقرأها الإصدار الأقدم كما هي)،
/// لكن أي قيمة غير معروفة تعود إلى الافتراضية بدل أن تُقبل وتُحفظ (T-9).
/// اخترنا هذا على enum في serde لأن قيمة واحدة خاطئة في enum تُفشل قراءة الملف كله
/// فتضيع كل الإعدادات، أما هنا فيُصحَّح الحقل الخاطئ وحده.
fn sanitize(s: &mut Settings) {
    let d = Settings::default();
    pick(&mut s.language, &["en", "ar"], &d.language);
    pick(&mut s.theme, &["dark", "light", "system"], &d.theme);
    pick(&mut s.layout_dir, &["auto", "rtl", "ltr"], &d.layout_dir);
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
    pick(&mut s.mobile_base, MOBILE_BASES, &d.mobile_base);
    s.mobile_folder = clean_folder_name(&s.mobile_folder);
}

/// المجلدات العامة التي يقبلها MediaStore دون صلاحيات تخزين جديدة (U-76)
pub const MOBILE_BASES: &[&str] = &["Download", "Movies", "Music", "DCIM", "Pictures"];

/// اسم مجلد فرعي واحد آمن: بلا فواصل مسار أو رموز ممنوعة، ولا «.» أو «..»، وبطول معقول
fn clean_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"/\:*?"<>|"#.contains(c) { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches('.').trim().chars().take(60).collect::<String>();
    cleaned.trim().to_string()
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
    write_to(&settings_path(&app)?, settings.clone())?;
    *state.0.lock_ok() = settings;
    Ok(())
}

/// نسخة احتياطية من الإعدادات والمشاريع في ملف يختاره المستخدم (M-99). الكوكيز لا تُصدَّر
#[tauri::command]
pub fn export_settings(state: tauri::State<SettingsState>, path: String) -> Result<(), AppError> {
    // ملف JSON فقط، ولا يُستبدل ملف موجود ليس JSON: أمر IPC يكتب في أي مسار كان يكفي
    // لكتابة نص فوق ‎~/.bashrc مثلًا لو حُقن كود في الواجهة (نموذج التهديد T-33)
    let target = Path::new(&path);
    if !target.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) {
        return Err(AppError::with_detail("badInput", "backup must be a .json file"));
    }
    if let Ok(old) = fs::read_to_string(target)
        && serde_json::from_str::<serde_json::Value>(&old).is_err()
    {
        return Err(AppError::with_detail("badInput", "refusing to replace a file that is not JSON"));
    }
    let json = serde_json::to_string_pretty(&*state.0.lock_ok()).expect("settings serialize");
    crate::persist::write_atomic(Path::new(&path), json.as_bytes())?;
    Ok(())
}

/// يقرأ ملف إعدادات مصدَّرًا ويرجعه بعد الترقية والتنقية؛ الواجهة تحفظه بـ save_settings
#[tauri::command]
pub fn read_settings_file(path: String) -> Result<Settings, AppError> {
    let text = fs::read_to_string(&path)?;
    let mut s = parse_backup(&text)?;
    sanitize(&mut s);
    Ok(s)
}

fn parse_backup(text: &str) -> Result<Settings, AppError> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| AppError::with_detail("settingsFile", e.to_string()))?;
    // ملف JSON آخر (ليس إعدادات خامة) يُرفض بدل أن يمحو الإعدادات بالقيم الافتراضية
    if !v.as_object().is_some_and(|o| o.contains_key("language") && o.contains_key("theme")) {
        return Err(AppError::with_detail("settingsFile", "not a Khama settings file"));
    }
    serde_json::from_value(v)
        .map(migrate)
        .map_err(|e| AppError::with_detail("settingsFile", e.to_string()))
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
        assert_eq!(s.schema_version, SETTINGS_VERSION, "الملف القديم يُرفع إلى النسخة الحالية");
    }

    #[test]
    fn backup_file_is_checked() {
        assert!(parse_backup("not json").is_err());
        assert!(parse_backup(r#"{"a": 1}"#).is_err(), "JSON ليس لخامة");
        let s = parse_backup(r#"{"language": "ar", "theme": "light", "rateLimit": 2}"#).unwrap();
        assert_eq!(s.language, "ar");
        assert_eq!(s.rate_limit_kb, 2048, "ملف قديم يُرقّى");
        assert_eq!(s.schema_version, SETTINGS_VERSION);
    }

    #[test]
    fn current_files_skip_old_migrations() {
        // ملف بالنسخة الحالية: rateLimit القديم لا يُحوَّل مرة ثانية
        let json = format!(r#"{{"schemaVersion":{SETTINGS_VERSION},"rateLimit":5,"rateLimitKb":0}}"#);
        let s = migrate(serde_json::from_str(&json).unwrap());
        assert_eq!(s.rate_limit_kb, 0);
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
    fn first_launch_is_english_and_the_chosen_language_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("khama-settings-lang-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let _ = std::fs::remove_file(&path);
        // أول تشغيل: لا ملف، فالواجهة بالإنجليزية
        let first = load_from(&path);
        assert_eq!(first.language, "en");
        // المستخدم يختار العربية: يُكتب الملف كما يكتبه save_settings، ثم إعادة تشغيل تقرؤه من جديد
        write_to(
            &path,
            Settings {
                language: "ar".into(),
                layout_dir: "ltr".into(),
                ..first
            },
        )
        .unwrap();
        let again = load_from(&path);
        assert_eq!((again.language.as_str(), again.layout_dir.as_str()), ("ar", "ltr"));
        // والعودة إلى الإنجليزية تبقى كذلك
        write_to(
            &path,
            Settings {
                language: "en".into(),
                ..again
            },
        )
        .unwrap();
        assert_eq!(load_from(&path).language, "en");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn layout_dir_defaults_to_rtl_and_is_cleaned() {
        // ملف 0.3.18 وما قبله لا يعرف الحقل: يبقى التخطيط من اليمين لليسار كما كان، بأي لغة
        let s = migrate(serde_json::from_str(r#"{"schemaVersion":1,"language":"en"}"#).unwrap());
        assert_eq!(s.layout_dir, "rtl");
        let s = migrate(serde_json::from_str(r#"{"layoutDir":"ltr","language":"ar"}"#).unwrap());
        assert_eq!((s.layout_dir.as_str(), s.language.as_str()), ("ltr", "ar"));
        let s = migrate(serde_json::from_str(r#"{"layoutDir":"auto"}"#).unwrap());
        assert_eq!(s.layout_dir, "auto");
        let s = migrate(serde_json::from_str(r#"{"layoutDir":"sideways"}"#).unwrap());
        assert_eq!(s.layout_dir, "rtl", "قيمة غير معروفة تعود إلى الافتراضية");
    }

    #[test]
    fn mobile_save_folder_defaults_and_is_cleaned() {
        // ملف 0.3.17 وما قبله لا يعرف الحقلين: يبقى الحفظ في Download/Khama كما كان
        let s = migrate(serde_json::from_str(r#"{"schemaVersion":1,"language":"ar"}"#).unwrap());
        assert_eq!((s.mobile_base.as_str(), s.mobile_folder.as_str()), ("Download", "Khama"));
        let s = migrate(serde_json::from_str(r#"{"mobileBase":"Movies","mobileFolder":"  ../مشاريع/2026:نهائي  "}"#).unwrap());
        assert_eq!((s.mobile_base.as_str(), s.mobile_folder.as_str()), ("Movies", "مشاريع 2026 نهائي"));
        let s = migrate(serde_json::from_str(r#"{"mobileBase":"Android","mobileFolder":".."}"#).unwrap());
        assert_eq!(
            (s.mobile_base.as_str(), s.mobile_folder.as_str()),
            ("Download", ""),
            "مجلد غير مسموح يعود إلى Download"
        );
    }

    #[test]
    fn counter_is_per_project_and_only_successful_downloads_use_a_number() {
        let mut c = Counters::default();
        let (a, b) = (c.reserve(""), c.reserve(""));
        assert_eq!((a, b), (1, 2), "تنزيلان معًا: رقمان مختلفان");
        c.finish("", b, false);
        c.finish("", a, true);
        assert_eq!(c.next(""), 2, "الفاشل لم يستهلك رقمًا");
        assert_eq!(c.reserve("p1"), 1, "مشروع آخر يبدأ من 1");
        c.reset("");
        assert_eq!(c.next(""), 1);
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
