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

impl Jobs {
    /// يحجز رقم العملية ويسجّل زر إلغائها. wanted = رقم أخذته الواجهة مسبقًا من new_job_id،
    /// فتضيف البطاقة قبل أن يبدأ Rust ولا يصل تحديث لعملية لا تعرفها (T-18).
    pub(crate) fn claim(&self, wanted: Option<u64>) -> (u64, watch::Receiver<bool>) {
        let mut cancels = self.cancels.lock_ok();
        let id = wanted
            .filter(|id| *id > 0 && *id <= self.next_id.load(Ordering::Relaxed) && !cancels.contains_key(id))
            .unwrap_or_else(|| self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx) = watch::channel(false);
        cancels.insert(id, tx);
        (id, rx)
    }
}

/// رقم جديد لعملية ستبدأ: الواجهة تضيف بطاقتها أولًا ثم تبدأها بهذا الرقم (T-18)
#[tauri::command]
pub fn new_job_id(jobs: tauri::State<Jobs>) -> u64 {
    jobs.next_id.fetch_add(1, Ordering::Relaxed) + 1
}

/// عدد التنزيلات التي تعمل معًا افتراضيًا. الباقي ينتظر دوره (مهم مع قوائم التشغيل الطويلة)
const PARALLEL_DOWNLOADS: usize = 3;

/// الخانات، والحدّ الحالي (يغيّره المستخدم من الإعدادات، T-63)
pub struct DownloadQueue(pub Arc<Semaphore>, Mutex<usize>);

impl Default for DownloadQueue {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(PARALLEL_DOWNLOADS)), Mutex::new(PARALLEL_DOWNLOADS))
    }
}

impl DownloadQueue {
    /// يغيّر عدد الخانات. الزيادة فورية؛ والنقص يأخذ الخانات الفارغة الآن،
    /// والباقي يُسحب حين تنتهي تنزيلات جارية (لا نوقف تنزيلًا بدأ)
    pub fn set_limit(&self, n: usize) {
        let n = n.clamp(1, 5);
        let mut cur = self.1.lock_ok();
        if n > *cur {
            self.0.add_permits(n - *cur);
        } else if n < *cur {
            let need = *cur - n;
            let got = self.0.forget_permits(need);
            if got < need {
                let sem = self.0.clone();
                let rest = (need - got) as u32;
                tauri::async_runtime::spawn(async move {
                    if let Ok(p) = sem.acquire_many_owned(rest).await {
                        p.forget();
                    }
                });
            }
        }
        *cur = n;
    }
}

/// خانة التنزيل لكل عملية جارية. تُحرَّر قبل إزالة الموسيقى (T-40): الفصل له طابوره الخاص
/// (ملف واحد في كل مرة)، فلا تبقى خانة من خانات التنزيل محجوزة وهو ينتظر دوره أو يعمل.
static SLOTS: Mutex<Option<HashMap<u64, tokio::sync::OwnedSemaphorePermit>>> = Mutex::new(None);

pub(super) fn hold_slot(id: u64, permit: tokio::sync::OwnedSemaphorePermit) {
    SLOTS.lock_ok().get_or_insert_with(HashMap::new).insert(id, permit);
}

/// يحرّر خانة التنزيل (إن كانت ما زالت محجوزة) فيبدأ التنزيل التالي في الطابور
pub(super) fn release_slot(id: u64) {
    let permit = SLOTS.lock_ok().as_mut().and_then(|m| m.remove(&id));
    drop(permit);
}

/// حدّ مشترك للأعمال الثقيلة على المعالج (T-41): تحويل «جاهز للمونتاج» في التنزيلات،
/// والمحوّل، وإزالة الموسيقى. لكلٍّ طابوره، لكن بلا هذا الحد قد تعمل كلها معًا وتخنق الجهاز.
/// العدد: ربع الأنوية، بين 1 و3.
pub(crate) fn heavy_limit(cores: usize) -> usize {
    (cores / 4).clamp(1, 3)
}

static HEAVY: std::sync::LazyLock<Arc<Semaphore>> = std::sync::LazyLock::new(|| {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    Arc::new(Semaphore::new(heavy_limit(cores)))
});

/// ينتظر دور عمل ثقيل. None = أُلغيت العملية أثناء الانتظار
pub(crate) async fn heavy_turn(cancel: &mut watch::Receiver<bool>) -> Option<tokio::sync::OwnedSemaphorePermit> {
    tokio::select! {
        p = HEAVY.clone().acquire_owned() => p.ok(),
        _ = canceled(cancel) => None,
    }
}

/// إزالة الموسيقى ثقيلة على المعالج والذاكرة: ملف واحد في كل مرة
static SEPARATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub url: String,
    /// فرق توقيت الجهاز عن UTC بالدقائق (من الواجهة)، ليكون {today} تاريخ اليوم المحلي (T-65)
    #[serde(default)]
    pub tz_offset_min: i32,
    /// ما تعرفه الواجهة عند البدء (عنوان المعاينة وسطر الوصف) ليكتب Rust عنصر السجلّ عند الانتهاء (T-19)
    #[serde(default)]
    pub history: Option<HistoryStart>,
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
    rate_limit_kb: u32,
    /// أقصى طول لاسم الملف (بالحروف)، حتى لا يتجاوز المسار الكامل 260 حرفًا على Windows (T-97)
    max_name: usize,
}

/// طول اسم الملف المسموح حتى يبقى أطول المسارين (مجلد العمل المؤقت ومجلد الحفظ) تحت حد Windows.
/// 260 ناقص المجلد، ناقص 40 لمجلد الموقع ولاحقة المقطع (" [00m10s - 00m20s]") والامتداد. لا يقل عن 60.
pub(super) fn max_name_len(dirs: &[&Path]) -> usize {
    let longest = dirs.iter().map(|d| d.to_string_lossy().encode_utf16().count()).max().unwrap_or(0);
    260usize.saturating_sub(longest + 40).max(60)
}

/// اليوم المحلي بصيغة 2026-11-10 (بلا مكتبة تواريخ: خوارزمية التقويم المدني).
/// offset_min = فرق توقيت المستخدم عن UTC؛ بدونه يكون التاريخ خاطئًا بعد منتصف الليل المحلي (T-65)
fn today(offset_min: i32) -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    local_date(secs, offset_min)
}

fn local_date(utc_secs: i64, offset_min: i32) -> String {
    // فرق التوقيت في العالم بين -12 و+14 ساعة؛ ما خارجه قيمة خاطئة فنهملها
    let offset = if (-720..=840).contains(&offset_min) {
        i64::from(offset_min) * 60
    } else {
        0
    };
    civil_date((utc_secs + offset).div_euclid(86_400))
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
    /// عنوان الفيديو وصورته كما طبعهما yt-dlp قبل التنزيل (T-43)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStart {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub meta: String,
    #[serde(default)]
    pub thumbnail: Option<String>,
}

/// العنوان والصورة كما طبعهما yt-dlp لكل عملية جارية (لعنصر السجلّ)
/// (العنوان، الصورة)
type Printed = (Option<String>, Option<String>);
static JOB_META: Mutex<Option<HashMap<u64, Printed>>> = Mutex::new(None);

fn remember_meta(u: &JobUpdate) {
    if u.title.is_none() && u.thumbnail.is_none() {
        return;
    }
    let mut guard = JOB_META.lock_ok();
    let slot = guard.get_or_insert_with(HashMap::new).entry(u.id).or_default();
    if u.title.is_some() {
        slot.0.clone_from(&u.title);
    }
    if u.thumbnail.is_some() {
        slot.1.clone_from(&u.thumbnail);
    }
}

pub(super) fn take_meta(id: u64) -> Printed {
    JOB_META.lock_ok().as_mut().and_then(|m| m.remove(&id)).unwrap_or_default()
}

/// عنصر السجلّ لتنزيل انتهى: عنوان المعاينة إن وُجد (وليس رابطًا)، وإلا ما طبعه yt-dlp، وإلا اسم الملف
pub(super) fn history_entry(
    req_url: &str,
    kind: &str,
    start: Option<HistoryStart>,
    printed: Printed,
    file: &Path,
    now_ms: u64,
) -> crate::history::HistoryEntry {
    let start = start.unwrap_or_default();
    let is_url = |t: &str| t.starts_with("http://") || t.starts_with("https://");
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let title = Some(start.title)
        .filter(|t| !t.trim().is_empty() && !is_url(t))
        .or(printed.0)
        .unwrap_or(stem);
    crate::history::HistoryEntry {
        id: 0,
        title,
        url: req_url.to_string(),
        file: file.to_string_lossy().into_owned(),
        kind: kind.to_string(),
        meta: start.meta,
        thumbnail: start.thumbnail.or(printed.1),
        date: now_ms,
        exists: true,
    }
}

/// يقرأ سطر KHAMA_META: {"title": ..., "thumbnail": ...}
pub(super) fn parse_meta_line(rest: &str) -> Option<(Option<String>, Option<String>)> {
    let v: serde_json::Value = serde_json::from_str(rest.trim()).ok()?;
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from);
    let (title, thumbnail) = (text("title"), text("thumbnail"));
    (title.is_some() || thumbnail.is_some()).then_some((title, thumbnail))
}

/// حال كل عملية جارية كما يعرفها Rust (T-17): بطاقة الواجهة + آخر تحديث مدموج.
/// لو أُعيد تحميل الواجهة (أو فُتحت النافذة من شريط المهام) تستعيد القائمة بـ list_jobs
/// بدل أن تستمر التنزيلات في الخلفية والواجهة لا تعرف عنها.
static LIVE: Mutex<Option<HashMap<u64, serde_json::Map<String, serde_json::Value>>>> = Mutex::new(None);

fn track_live(u: &JobUpdate) {
    let mut guard = LIVE.lock_ok();
    let live = guard.get_or_insert_with(HashMap::new);
    if matches!(u.state, "done" | "error" | "canceled") {
        live.remove(&u.id);
        return;
    }
    if let Ok(serde_json::Value::Object(fields)) = serde_json::to_value(u) {
        live.entry(u.id).or_default().extend(fields);
    }
}

/// الواجهة تسجّل بطاقة العملية (العنوان، الطلب، النوع) لتستعيدها بعد إعادة التحميل
#[tauri::command]
pub fn remember_job(jobs: tauri::State<Jobs>, id: u64, card: serde_json::Map<String, serde_json::Value>) {
    // انتهت قبل أن تصل البطاقة: لا نعيد إحياءها
    if !jobs.cancels.lock_ok().contains_key(&id) {
        return;
    }
    let mut guard = LIVE.lock_ok();
    let entry = guard.get_or_insert_with(HashMap::new).entry(id).or_default();
    // التحديثات أحدث من البطاقة: تبقى فوقها
    let mut merged = card;
    merged.insert("id".into(), id.into());
    merged.extend(std::mem::take(entry));
    *entry = merged;
}

/// العمليات التي ما زالت تعمل، الأحدث أولًا
#[tauri::command]
pub fn list_jobs() -> Vec<serde_json::Map<String, serde_json::Value>> {
    let guard = LIVE.lock_ok();
    let mut v: Vec<_> = guard.iter().flat_map(|m| m.iter()).map(|(id, f)| (*id, f.clone())).collect();
    v.sort_by_key(|e| std::cmp::Reverse(e.0));
    v.into_iter().map(|(_, f)| f).collect()
}

pub(crate) fn emit(app: &AppHandle, u: JobUpdate) {
    if let Some(f) = &u.file {
        remember_output(f);
    }
    remember_meta(&u);
    track_live(&u);
    if should_emit(&u, Instant::now()) {
        let _ = app.emit("job-update", u);
    }
}

/// الملفات التي أنتجها Rust في هذه الجلسة (T-33): reveal_file يقبلها هي وملفات السجلّ فقط،
/// فلا تستطيع الواجهة (لو حُقن فيها كود) أن تفتح أي مسار على الجهاز.
static PRODUCED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

pub(crate) fn remember_output(path: &str) {
    PRODUCED.lock_ok().get_or_insert_with(Default::default).insert(path.to_string());
}

pub(crate) fn was_produced(path: &str) -> bool {
    PRODUCED.lock_ok().as_ref().is_some_and(|s| s.contains(path))
}

/// أقل فاصل بين تحديثين للتقدّم في نفس المرحلة (T-85): yt-dlp وFFmpeg يكتبان عدة أسطر
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
    // تحديث يحمل العنوان لا يُتخطّى أبدًا
    if u.title.is_some() || u.thumbnail.is_some() {
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
    #[test]
    fn live_jobs_keep_the_latest_state_and_drop_finished_ones() {
        let id = 9_000_001;
        track_live(&JobUpdate { id, state: "downloading", percent: Some(10.0), ..Default::default() });
        track_live(&JobUpdate { id, state: "downloading", percent: Some(40.0), title: Some("t".into()), ..Default::default() });
        let mine = |v: Vec<serde_json::Map<String, serde_json::Value>>| v.into_iter().find(|f| f["id"] == id);
        let f = mine(list_jobs()).expect("جارية");
        assert_eq!((f["percent"].as_f64(), f["title"].as_str()), (Some(40.0), Some("t")));
        track_live(&JobUpdate { id, state: "done", ..Default::default() });
        assert!(mine(list_jobs()).is_none());
    }

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
