//! محرّك التنزيل.
//!
//! مسار كل عملية تنزيل:
//!   1. yt-dlp ينزّل إلى مجلد مؤقت خاص بالعملية (jobs/<id>/out)
//!   2. (للفيديو مع خيار "جاهز للمونتاج") ffprobe يفحص الترميز، وإن لزم يحوّله ffmpeg
//!      إلى H.264 + AAC بمعدل إطارات ثابت
//!   3. ننقل الملف النهائي إلى مجلد المستخدم
//!
//! هكذا لا يرى المستخدم في مجلده ملفًا ناقصًا أبدًا، حتى لو ألغى في المنتصف.
//! التقدّم يُرسل للواجهة كأحداث "job-update".

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::{Semaphore, watch},
};

use crate::errors::LockExt;
use crate::{
    errors::{AppError, friendly_ytdlp_error, tail},
    playlist::{self, Entry},
    settings::{self, Settings, SettingsState},
    tools::{self, Tools},
};

mod args;
pub use args::*;
mod process;
pub(crate) use process::*;
mod progress;
pub(crate) use progress::*;
mod editready;
pub(crate) use editready::*;
mod deliver;
pub(crate) use deliver::*;
mod job;
pub use job::*;
mod extras;
use extras::*;
mod commands;
pub use commands::*;
#[cfg(test)]
mod tests;

// ======================= الحالة والأنواع =======================

/// العمليات الجارية: لكل عملية "زر إلغاء" (قناة watch نرسل فيها true)
#[derive(Default)]
pub struct Jobs {
    pub(crate) next_id: AtomicU64,
    pub(crate) cancels: Mutex<HashMap<u64, watch::Sender<bool>>>,
}

/// عدد التنزيلات التي تعمل معًا. الباقي ينتظر دوره (مهم مع قوائم التشغيل الطويلة)
const PARALLEL_DOWNLOADS: usize = 3;

pub struct DownloadQueue(pub Arc<Semaphore>);

impl Default for DownloadQueue {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(PARALLEL_DOWNLOADS)))
    }
}

/// إزالة الموسيقى ثقيلة على المعالج والذاكرة: ملف واحد في كل مرة
static SEPARATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    /// "video" | "audio"
    pub kind: String,
    /// "mp4" | "mov"
    pub video_format: String,
    /// "mp3" | "m4a" | "wav"
    pub audio_format: String,
    /// "best" | "2160" | "1440" | "1080" | "720" | "480"
    pub quality: String,
    pub editor_ready: bool,
    /// تحميل جزء فقط: بداية ونهاية بالثواني (فارغ = الملف كاملًا)
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub end: Option<f64>,
    /// إزالة بالذكاء الاصطناعي بعد التنزيل: "voice" (أبقِ الصوت البشري = احذف الموسيقى) | "music"
    #[serde(default)]
    pub stems: Option<String>,
    /// عدة مقاطع من نفس الفيديو: [[بداية، نهاية], ...] بالثواني (فارغ = استخدم start/end)
    #[serde(default)]
    pub clips: Vec<[f64; 2]>,
    /// مع عدة مقاطع: true = تُدمج في فيديو واحد، false = ملف لكل مقطع
    #[serde(default)]
    pub join_clips: bool,
    /// مجلد فرعي داخل مجلد الحفظ (اسم قائمة التشغيل). على الكمبيوتر فقط
    #[serde(default)]
    #[cfg_attr(mobile, allow(dead_code))]
    pub subdir: Option<String>,
    /// لغات الترجمة المطلوبة (SRT بجانب الملف). فارغ = بلا ترجمة
    #[serde(default)]
    pub subs: Vec<String>,
    /// الصورة المصغّرة بأعلى دقة كملف JPG بجانب الملف
    #[serde(default)]
    pub thumbnail: bool,
    /// ملف نصي بمعلومات المصدر (الرابط، صاحب المحتوى، التاريخ)
    #[serde(default)]
    pub info_file: bool,
    /// لقطات ثابتة من الفيديو: "5" | "10" (كل N ثانية) | "scene" (عند تغيّر المشهد). الكمبيوتر فقط
    #[serde(default)]
    pub stills: Option<String>,
    /// مع مقاطع منفصلة: ملف تايم لاين XML يفتح في Premiere و DaVinci. الكمبيوتر فقط
    #[serde(default)]
    #[cfg_attr(mobile, allow(dead_code))]
    pub timeline: bool,
    /// الملف الأصلي كما هو بلا تحويل صيغة (ملفات Google Drive مثلًا)
    #[serde(default)]
    pub original: bool,
}

/// ما يحتاجه التنزيل من الإعدادات (يُقرأ مرة عند بدء العملية)
struct JobOptions {
    /// قالب yt-dlp لاسم الملف، بلا لاحقة المقطع ولا الامتداد
    template: String,
    rate_limit: u32,
}

/// اليوم بصيغة 2026-11-10 (بلا مكتبة تواريخ: خوارزمية التقويم المدني)
fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    civil_date(secs.div_euclid(86_400))
}

fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// قالب المستخدم ← قالب yt-dlp.
/// {title} {uploader} {date} (تاريخ النشر) {today} {site} {id} {res} {n} (عدّاد)
pub fn output_template(user: &str, site_folders: bool, n: u64, today: &str) -> String {
    // نص المستخدم حرفي: نهرب % ونمنع فواصل المسارات
    let mut t: String = user
        .trim()
        .replace('%', "%%")
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    if !t.contains('{') {
        t = if t.is_empty() { "{title}".into() } else { format!("{t} {{title}}") };
    }
    let t = t
        .replace("{title}", "%(title).120B")
        .replace("{uploader}", "%(uploader,channel|Unknown).40B")
        .replace("{date}", "%(upload_date>%Y-%m-%d|)s")
        .replace("{today}", today)
        .replace("{site}", "%(extractor_key)s")
        .replace("{id}", "%(id)s")
        .replace("{res}", "%(height&{}p|)s")
        .replace("{n}", &format!("{n:03}"));
    if site_folders { format!("%(extractor_key)s/{t}") } else { t }
}

/// المقطع المطلوب بعد التحقق: (بداية، نهاية). None = الملف كاملًا
pub fn section(req: &DownloadRequest) -> Option<(f64, f64)> {
    let s = req.start.filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(0.0);
    let e = req.end.filter(|v| v.is_finite() && *v > s)?;
    // جزء يبدأ من الصفر بدون نهاية محددة = الملف كاملًا
    (req.start.is_some() || req.end.is_some()).then_some((s, e))
}

/// كل المقاطع المطلوبة بعد التحقق، مرتّبة حسب البداية. فارغة = الملف كاملًا
pub fn clips(req: &DownloadRequest) -> Vec<(f64, f64)> {
    if req.clips.is_empty() {
        return section(req).into_iter().collect();
    }
    let mut v: Vec<(f64, f64)> = req
        .clips
        .iter()
        .map(|[s, e]| (*s, *e))
        .filter(|(s, e)| s.is_finite() && e.is_finite() && *s >= 0.0 && *e > *s)
        .collect();
    v.sort_by(|a, b| a.0.total_cmp(&b.0));
    v
}

/// 75.5 → "1:15.500" (صيغة يفهمها yt-dlp و ffmpeg)
fn ts(sec: f64) -> String {
    let ms = (sec * 1000.0).round() as u64;
    format!("{}:{:02}:{:02}.{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

/// 75.5 → "01m15s" لاسم الملف
fn ts_name(sec: f64) -> String {
    let s = sec.floor() as u64;
    if s >= 3600 {
        format!("{}h{:02}m{:02}s", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{:02}m{:02}s", s / 60, s % 60)
    }
}

/// تحديث تستقبله الواجهة. الحقول الفارغة لا تُرسل، فتدمجها الواجهة مع ما لديها.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobUpdate {
    pub id: u64,
    /// starting | downloading | processing | converting | done | error | canceled
    pub state: &'static str,
    /// أثناء التنزيل: video | audio | file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    /// بايت/ثانية
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    /// ثوانٍ متبقية
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
    /// نتائج الكشف (مشاهد، لقطات سوداء، صمت): [بداية، نهاية]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markers: Option<Vec<[f64; 2]>>,
}

pub(crate) fn emit(app: &AppHandle, u: JobUpdate) {
    if should_emit(&u, Instant::now()) {
        let _ = app.emit("job-update", u);
    }
}

/// أقل فاصل بين تحديثين للتقدّم في نفس المرحلة (T-82): yt-dlp وFFmpeg يكتبان عدة أسطر
/// في الثانية، وكل حدث يعيد رسم الواجهة. 5 تحديثات في الثانية تكفي للعين.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// آخر تحديث أُرسل لعملية: وقته، وحالته، ومرحلته
type LastEmit = (Instant, &'static str, Option<&'static str>);

/// تغيّر الحالة أو المرحلة يمرّ دائمًا، وكذلك النهاية (done/error/canceled)
fn should_emit(u: &JobUpdate, now: Instant) -> bool {
    static LAST: Mutex<Option<HashMap<u64, LastEmit>>> = Mutex::new(None);
    let mut guard = LAST.lock_ok();
    let last = guard.get_or_insert_with(HashMap::new);
    if matches!(u.state, "done" | "error" | "canceled") {
        last.remove(&u.id);
        return true;
    }
    match last.get(&u.id) {
        Some(&(at, state, stage)) if state == u.state && stage == u.stage && now.duration_since(at) < PROGRESS_EVERY => false,
        _ => {
            last.insert(u.id, (now, u.state, u.stage));
            true
        }
    }
}

#[cfg(test)]
mod emit_tests {
    use super::*;

    fn up(id: u64, state: &'static str) -> JobUpdate {
        JobUpdate {
            id,
            state,
            ..Default::default()
        }
    }

    #[test]
    fn progress_is_throttled_but_state_changes_and_endings_pass() {
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        assert!(should_emit(&up(900, "downloading"), ms(0)));
        assert!(!should_emit(&up(900, "downloading"), ms(50)), "تقدّم متقارب يُتخطّى");
        assert!(should_emit(&up(900, "downloading"), ms(250)), "بعد 200ms يمرّ");
        assert!(should_emit(&up(900, "processing"), ms(260)), "تغيّر الحالة يمرّ فورًا");
        assert!(should_emit(&up(900, "done"), ms(270)), "النهاية تمرّ دائمًا");
        assert!(should_emit(&up(900, "downloading"), ms(280)), "بعد النهاية تبدأ من جديد");
    }
}
