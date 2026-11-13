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

use crate::{
    errors::{AppError, friendly_ytdlp_error, tail},
    playlist::{self, Entry},
    settings::{self, Settings, SettingsState},
    tools::{self, Tools},
};

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
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
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
    Some((s, e)).filter(|_| req.start.is_some() || req.end.is_some())
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
    let _ = app.emit("job-update", u);
}

// ======================= بناء أوامر yt-dlp =======================

fn validate_url(url: &str) -> Result<String, AppError> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::new("invalidUrl"));
    }
    Ok(url.to_string())
}

fn cookie_args(app: &AppHandle, s: &Settings) -> Vec<String> {
    match s.cookies_mode.as_str() {
        "browser" if !s.cookies_browser.is_empty() => {
            vec!["--cookies-from-browser".into(), s.cookies_browser.clone()]
        }
        "file" => match settings::cookies_path(app) {
            Ok(p) if p.exists() => vec!["--cookies".into(), p.to_string_lossy().into_owned()],
            _ => vec![],
        },
        _ => vec![],
    }
}

/// خيارات اختيار الصيغة والجودة. منفصلة لتسهل قراءتها واختبارها.
pub fn format_args(req: &DownloadRequest) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if req.original {
        // الملف الأصلي كما رفعه صاحبه (Google Drive: صيغة "source")
        a.extend(["-f", "source/b"].map(String::from));
    } else if req.kind == "audio" {
        let fmt = match req.audio_format.as_str() {
            "m4a" | "wav" => req.audio_format.as_str(),
            _ => "mp3",
        };
        a.extend(["-f", "ba/b", "-x", "--audio-format", fmt, "--audio-quality", "0"].map(String::from));
    } else {
        let container = if req.video_format == "mov" { "mov" } else { "mp4" };
        // -S = ترتيب الأفضلية: أولًا الدقة (لا تتجاوز المطلوبة)،
        // ثم - إن كان "جاهز للمونتاج" مفعّلًا - نفضّل H.264 و AAC حتى لا نحتاج تحويلًا.
        let mut sort = match req.quality.as_str() {
            q @ ("2160" | "1440" | "1080" | "720" | "480" | "360") => format!("res:{q}"),
            _ => "res".to_string(),
        };
        if req.editor_ready || container == "mov" {
            sort.push_str(",vcodec:h264,acodec:aac");
        }
        a.extend([
            "-f".into(),
            "bv*+ba/b".into(),
            "-S".into(),
            sort,
            "--merge-output-format".into(),
            container.into(),
            "--remux-video".into(),
            container.into(),
        ]);
    }
    a
}

fn download_args(
    tools: &Tools,
    cookies: Vec<String>,
    req: &DownloadRequest,
    opts: &JobOptions,
    section: Option<(f64, f64)>,
    out: &Path,
    work: &Path,
) -> Vec<String> {
    let mut a = tools::ytdlp_base_args(tools);
    a.extend(cookies);
    a.extend(format_args(req));
    if opts.rate_limit > 0 {
        a.extend(["-r".into(), format!("{}M", opts.rate_limit)]);
    }
    // أغنية من سبوتيفاي: رابط بحث، نأخذ أول نتيجة فقط
    if req.url.starts_with(playlist::MUSIC_SEARCH) {
        a.extend(["--playlist-items".into(), "1".into()]);
    }
    let mut template = format!("{}.%(ext)s", opts.template);
    if let Some((s, e)) = section {
        // * = بالوقت (لا بالفصول). نجبر إطارات مفتاحية عند نقطتي القص حتى يكون القص دقيقًا بالإطار
        a.push("--download-sections".into());
        a.push(format!("*{}-{}", ts(s), ts(e)));
        if req.kind == "video" && !req.original {
            a.push("--force-keyframes-at-cuts".into());
        }
        template = format!("{} [{} - {}].%(ext)s", opts.template, ts_name(s), ts_name(e));
    }
    a.extend([
        "-P".into(),
        out.to_string_lossy().into_owned(),
        "-P".into(),
        format!("temp:{}", work.to_string_lossy()),
        "-o".into(),
        template,
        "--windows-filenames".into(), // أسماء ملفات تصلح على كل الأنظمة
        "--no-mtime".into(),          // تاريخ الملف = وقت التنزيل (أسهل للفرز في المجلد)
        "--newline".into(),
        "--progress".into(),
        "--no-simulate".into(),
        // أسطر تقدّم بصيغة نحن نحددها، لنقرأها بسهولة
        "--progress-template".into(),
        "download:KHAMA_DL %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.vcodec)s|%(info.acodec)s|%(progress.fragment_index)s|%(progress.fragment_count)s".into(),
        "--progress-template".into(),
        "postprocess:KHAMA_PP %(progress.status)s|%(progress.postprocessor)s".into(),
        "--print".into(),
        "after_move:KHAMA_FILE %(filepath)s".into(),
        "--".into(), // ما بعده رابط وليس خيارًا (حماية من روابط تبدأ بـ -)
        req.url.clone(),
    ]);
    a
}

// ======================= تشغيل عملية مع إمكانية الإلغاء =======================

pub(crate) enum RunOutcome {
    Exited { success: bool, stderr: String },
    Canceled,
}

/// يوقف العملية وكل ما شغّلته (yt-dlp يشغّل ffmpeg، ونسخة Windows منه تشغّل نفسها مرتين)
pub(crate) async fn kill_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            let _ = tools::command(Path::new("taskkill"))
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .await;
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status().await;
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

/// ينتهي عندما يضغط المستخدم "إلغاء".
/// (دالة مستقلة حتى لا نُبقي قفل القناة محجوزًا أثناء انتظار أشياء أخرى)
pub(crate) async fn canceled(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|c| *c).await;
}

/// يشغّل أمرًا، ويمرّر كل سطر من مخرجاته إلى on_line، ويوقفه إن ضغط المستخدم إلغاء
pub(crate) async fn run_streaming(
    mut cmd: Command,
    cancel: &mut watch::Receiver<bool>,
    mut on_line: impl FnMut(&str),
) -> Result<RunOutcome, AppError> {
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // نجمع stderr في الخلفية (نحتفظ بآخر ~32KB فقط)
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut r = BufReader::new(stderr).split(b'\n');
        while let Ok(Some(l)) = r.next_segment().await {
            buf.push_str(String::from_utf8_lossy(&l).trim_end_matches('\r'));
            buf.push('\n');
            // نحتفظ بآخر 2MB (نتائج الكشف عن المشاهد قد تكون طويلة)
            if buf.len() > 4_194_304 {
                let mut cut = buf.len() - 2_097_152;
                while !buf.is_char_boundary(cut) {
                    cut += 1;
                }
                buf.drain(..cut);
            }
        }
        buf
    });

    let mut lines = BufReader::new(stdout).split(b'\n');
    loop {
        tokio::select! {
            seg = lines.next_segment() => match seg {
                Ok(Some(l)) => on_line(String::from_utf8_lossy(&l).trim_end_matches('\r')),
                _ => break,
            },
            _ = canceled(cancel) => {
                kill_tree(&mut child).await;
                return Ok(RunOutcome::Canceled);
            }
        }
    }
    let status = tokio::select! {
        s = child.wait() => s?,
        _ = canceled(cancel) => {
            kill_tree(&mut child).await;
            return Ok(RunOutcome::Canceled);
        }
    };
    let stderr = err_task.await.unwrap_or_default();
    Ok(RunOutcome::Exited { success: status.success(), stderr })
}

// ======================= قراءة أسطر التقدّم =======================

pub(crate) fn num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

struct DlProgress {
    finished: bool,
    stage: &'static str,
    percent: Option<f64>,
    speed: Option<f64>,
    eta: Option<f64>,
}

/// "KHAMA_DL downloading|1024|433081|NA|144344.3|3|avc1.4D400C|none|NA|NA"
fn parse_dl_line(rest: &str) -> Option<DlProgress> {
    let f: Vec<&str> = rest.split('|').collect();
    if f.len() < 10 {
        return None;
    }
    let downloaded = num(f[1]);
    let total = num(f[2]).or(num(f[3]));
    let mut percent = match (downloaded, total) {
        (Some(d), Some(t)) if t > 0.0 => Some(d / t * 100.0),
        _ => None,
    };
    if percent.is_none() {
        // بث مقسّم إلى أجزاء (HLS/DASH): نحسب بعدد الأجزاء
        if let (Some(i), Some(c)) = (num(f[8]), num(f[9])) {
            if c > 0.0 {
                percent = Some(i / c * 100.0);
            }
        }
    }
    let (v, a) = (f[6], f[7]);
    let stage = if v == "none" && a != "none" {
        "audio"
    } else if v != "none" && v != "NA" && a == "none" {
        "video"
    } else {
        "file"
    };
    Some(DlProgress {
        finished: f[0] == "finished",
        stage,
        percent: percent.map(|p| p.clamp(0.0, 100.0)),
        speed: num(f[4]),
        eta: num(f[5]),
    })
}

// ======================= التحويل لصيغة المونتاج =======================

struct MediaCheck {
    duration: Option<f64>,
    video_ok: bool,
    audio_ok: bool,
}

pub(crate) fn fraction(s: &str) -> Option<f64> {
    let (a, b) = s.split_once('/')?;
    let (a, b) = (num(a)?, num(b)?);
    (b > 0.0).then(|| a / b)
}

/// هل الملف صالح كما هو لبرامج المونتاج؟
/// فيديو: H.264 بـ 8-bit 4:2:0 ومعدل إطارات ثابت. صوت: AAC أو MP3.
async fn check_media(tools: &Tools, file: &Path) -> Result<MediaCheck, AppError> {
    let f = file.to_string_lossy();
    let (ok, out, err) = tools::run_capture(
        &tools.ffprobe,
        &[
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,pix_fmt,r_frame_rate,avg_frame_rate:format=duration",
            "-of",
            "json",
            &f,
        ],
    )
    .await?;
    if !ok {
        return Err(AppError::with_detail("probeFileFailed", tail(&err, 8)));
    }
    let j: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    let streams = j["streams"].as_array().cloned().unwrap_or_default();
    let mut video_ok = true;
    let mut audio_ok = true;
    for s in &streams {
        let codec = s["codec_name"].as_str().unwrap_or("");
        match s["codec_type"].as_str() {
            Some("video") => {
                let pix = s["pix_fmt"].as_str().unwrap_or("");
                let r = s["r_frame_rate"].as_str().and_then(fraction);
                let avg = s["avg_frame_rate"].as_str().and_then(fraction);
                // إن اختلف المعدل الاسمي عن المتوسط الفعلي بأكثر من 2% فهو غالبًا متغيّر (VFR)
                let cfr = match (r, avg) {
                    (Some(r), Some(avg)) if r > 0.0 => ((r - avg) / r).abs() < 0.02,
                    _ => true,
                };
                video_ok = codec == "h264" && (pix == "yuv420p" || pix == "yuvj420p") && cfr;
            }
            Some("audio") => audio_ok = codec == "aac" || codec == "mp3",
            _ => {}
        }
    }
    Ok(MediaCheck {
        duration: j["format"]["duration"].as_str().and_then(num),
        video_ok,
        audio_ok,
    })
}

async fn convert_for_editing(
    app: &AppHandle,
    id: u64,
    tools: &Tools,
    input: &Path,
    out_dir: &Path,
    check: &MediaCheck,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PathBuf>, AppError> {
    std::fs::create_dir_all(out_dir)?;
    let output = out_dir.join(input.file_name().unwrap_or_default());
    let mut cmd = tools::command(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"]).arg(input);
    cmd.args(["-map", "0:v:0", "-map", "0:a:0?"]);
    if check.video_ok {
        cmd.args(["-c:v", "copy"]);
    } else {
        // crf 18 = جودة شبه مطابقة للأصل. veryfast = توازن جيد بين السرعة والحجم.
        cmd.args([
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-fps_mode", "cfr",
        ]);
    }
    if check.audio_ok {
        cmd.args(["-c:a", "copy"]);
    } else {
        cmd.args(["-c:a", "aac", "-b:a", "320k"]);
    }
    cmd.args(["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"]).arg(&output);

    let duration = check.duration.unwrap_or(0.0);
    let mut last = Instant::now() - Duration::from_secs(1);
    let outcome = run_streaming(cmd, cancel, |line| {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(num) {
            if duration > 0.0 && last.elapsed() >= Duration::from_millis(200) {
                last = Instant::now();
                emit(app, JobUpdate {
                    id,
                    state: "converting",
                    percent: Some((us / 1e6 / duration * 100.0).clamp(0.0, 100.0)),
                    ..Default::default()
                });
            }
        }
    })
    .await?;
    match outcome {
        RunOutcome::Canceled => Ok(None),
        RunOutcome::Exited { success: true, .. } => Ok(Some(output)),
        RunOutcome::Exited { stderr, .. } => Err(AppError::with_detail(
            "convertFailed",
            tail(&stderr, 10),
        )),
    }
}

// ======================= نقل الملف النهائي =======================

/// اسم غير مستخدم: "اسم.mp4" ← "اسم (1).mp4" ← "اسم (2).mp4"
pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (1..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|p| !p.exists())
        .expect("infinite iterator")
}

async fn move_into(src: &Path, dir: &Path) -> Result<PathBuf, AppError> {
    let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("download");
    let dest = unique_path(dir, name);
    // rename يفشل إن كان المجلدان على قرصين مختلفين، فننسخ ثم نحذف
    if tokio::fs::rename(src, &dest).await.is_err() {
        tokio::fs::copy(src, &dest).await.map_err(|e| {
            AppError::with_detail("moveFailed", e.to_string())
        })?;
        let _ = tokio::fs::remove_file(src).await;
    }
    Ok(dest)
}

// ======================= العملية الكاملة =======================

pub(crate) fn jobs_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::with_detail("cacheDir", e.to_string()))?
        .join("jobs"))
}

/// يُستدعى عند بدء التطبيق: يحذف بقايا عمليات قديمة (لو أُغلق التطبيق فجأة)
pub fn clean_stale_jobs(app: &AppHandle) {
    if let Ok(root) = jobs_root(app) {
        let _ = std::fs::remove_dir_all(root);
    }
}

async fn run_job(
    app: &AppHandle,
    id: u64,
    req: DownloadRequest,
    settings: Settings,
    job_dir: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PathBuf>, AppError> {
    let tools = tools::resolve(app)?;
    // على الهاتف: ننهي الملف داخل التطبيق ثم ننقله إلى Download/Khama العام
    #[cfg(mobile)]
    let final_dir = jobs_root(app)?.join("ready");
    #[cfg(desktop)]
    let final_dir = {
        let base = settings::resolve_output_dir(app, &settings)?;
        match req.subdir.as_deref().and_then(playlist::folder_name) {
            Some(sub) => base.join(sub),
            None => base,
        }
    };
    std::fs::create_dir_all(&final_dir).map_err(|e| {
        AppError::with_detail("outputDirCreate", e.to_string())
    })?;
    let cookies = cookie_args(app, &settings);
    let user_tpl = &settings.filename_template;
    let n = if user_tpl.contains("{n}") { settings::next_counter(app) } else { 0 };
    let opts = JobOptions {
        template: output_template(user_tpl, settings.site_folders, n, &today()),
        rate_limit: settings.rate_limit,
    };
    let parts = clips(&req);
    // الدمج يحتاج ffmpeg، وهو على الكمبيوتر فقط
    let join = req.join_clips && parts.len() > 1;

    // الترجمة والصورة ومعلومات المصدر: تُجلب مرة واحدة قبل التنزيل
    let side = fetch_sidecars(&tools, &cookies, &req, &job_dir.join("side"), cancel).await?;
    let Some(side) = side else { return Ok(None) };

    // مقطع واحد أو الملف كاملًا
    if parts.len() <= 1 {
        let section = parts.first().copied();
        let Some((file, sub)) = fetch(app, id, &tools, &cookies, &req, &opts, section, job_dir, (0, 1), cancel).await? else {
            return Ok(None);
        };
        let Some(file) = finish(app, id, &tools, &req, file, job_dir, cancel).await? else {
            return Ok(None);
        };
        let dir = final_dir.join(sub);
        let done = deliver_with_extras(app, &tools, &req, &file, &dir, &side, &parts, job_dir, cancel).await?;
        return Ok(done);
    }

    let count = parts.len();
    let mut files = Vec::with_capacity(count);
    for (i, sec) in parts.iter().enumerate() {
        let dir = job_dir.join(format!("clip{i}"));
        let Some((file, sub)) = fetch(app, id, &tools, &cookies, &req, &opts, Some(*sec), &dir, (i, count), cancel).await? else {
            return Ok(None);
        };
        files.push((file, dir, sub));
    }

    if join {
        emit(app, JobUpdate { id, state: "processing", ..Default::default() });
        let inputs: Vec<PathBuf> = files.iter().map(|(f, _, _)| f.clone()).collect();
        let Some(joined) = concat_files(&tools, &req, &inputs, &job_dir.join("joined"), cancel).await? else {
            return Ok(None);
        };
        let Some(file) = finish(app, id, &tools, &req, joined, job_dir, cancel).await? else {
            return Ok(None);
        };
        let dir = final_dir.join(&files[0].2);
        return deliver_with_extras(app, &tools, &req, &file, &dir, &side, &parts, job_dir, cancel).await;
    }

    // ملف لكل مقطع: نعيد مسار الأول (الواجهة تفتح مجلده)
    let mut first = None;
    let mut delivered = Vec::with_capacity(count);
    for (i, (file, dir, sub)) in files.into_iter().enumerate() {
        let Some(file) = finish(app, id, &tools, &req, file, &dir, cancel).await? else {
            return Ok(None);
        };
        let target = final_dir.join(sub);
        let Some(done) = deliver_with_extras(app, &tools, &req, &file, &target, &side, &parts[i..=i], &dir, cancel).await? else {
            return Ok(None);
        };
        delivered.push((done.clone(), parts[i]));
        first.get_or_insert(done);
    }
    #[cfg(desktop)]
    if req.timeline && req.kind == "video" {
        if let Err(e) = write_timeline(&tools, &delivered).await {
            eprintln!("timeline: {e:?}");
        }
    }
    Ok(first)
}

// ======================= الإضافات: ترجمة، صورة، معلومات، لقطات، تايم لاين =======================

/// ما جُلب قبل التنزيل: ملفات بجانب الفيديو + معلومات المصدر
#[derive(Default)]
struct Sidecars {
    /// (الملف، لاحقة اسمه بعد اسم الفيديو) مثل (".../side.en.srt", ".en.srt")
    files: Vec<(PathBuf, String)>,
    info: Option<Value>,
}

/// يجلب الترجمة والصورة المصغّرة ومعلومات المصدر دون تنزيل الفيديو.
/// Some(فارغ) إن لم يُطلب شيء، None إن ألغى المستخدم.
async fn fetch_sidecars(
    tools: &Tools,
    cookies: &[String],
    req: &DownloadRequest,
    dir: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<Sidecars>, AppError> {
    if req.subs.is_empty() && !req.thumbnail && !req.info_file {
        return Ok(Some(Sidecars::default()));
    }
    std::fs::create_dir_all(dir)?;
    let mut a = tools::ytdlp_base_args(tools);
    a.extend(cookies.iter().cloned());
    a.extend(["--skip-download", "--no-simulate"].map(String::from));
    if req.url.starts_with(playlist::MUSIC_SEARCH) {
        a.extend(["--playlist-items".into(), "1".into()]);
    }
    if !req.subs.is_empty() {
        a.extend([
            "--write-subs".into(),
            "--write-auto-subs".into(),
            "--sub-langs".into(),
            req.subs.join(","),
            "--convert-subs".into(),
            "srt".into(),
        ]);
    }
    if req.thumbnail {
        a.extend(["--write-thumbnail", "--convert-thumbnails", "jpg"].map(String::from));
    }
    a.extend([
        "--print".into(),
        "KHAMA_INFO %(.{title,uploader,channel,webpage_url,upload_date,extractor_key,duration,license,id})j".into(),
        "-P".into(),
        dir.to_string_lossy().into_owned(),
        "-o".into(),
        "side.%(ext)s".into(),
        "--".into(),
        req.url.clone(),
    ]);
    let mut cmd = tools::ytdlp_command(tools);
    cmd.args(a);
    let mut info = None;
    let outcome = run_streaming(cmd, cancel, |line| {
        if let Some(j) = line.strip_prefix("KHAMA_INFO ") {
            info = serde_json::from_str(j).ok();
        }
    })
    .await?;
    match outcome {
        RunOutcome::Canceled => return Ok(None),
        // الإضافات ليست أساسية: إن فشلت نكمل تنزيل الفيديو نفسه
        RunOutcome::Exited { success: false, stderr } => eprintln!("sidecars: {}", tail(&stderr, 6)),
        RunOutcome::Exited { success: true, .. } => {}
    }
    let mut files = Vec::new();
    for e in std::fs::read_dir(dir)?.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let wanted = (req.thumbnail && name.ends_with(".jpg")) || (!req.subs.is_empty() && name.ends_with(".srt"));
        if let Some(suffix) = name.strip_prefix("side").filter(|_| wanted) {
            files.push((p, suffix.to_string()));
        }
    }
    files.sort();
    Ok(Some(Sidecars { files, info: info.filter(|_| req.info_file) }))
}

/// "اسم.mp4" ← "اسم"
fn stem_of(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// نص ملف معلومات المصدر (لذكر المصدر وحقوق المحتوى)
fn info_text(info: &Value, sections: &[(f64, f64)]) -> String {
    let s = |k: &str| info[k].as_str().filter(|v| !v.is_empty() && *v != "NA");
    let mut out = String::new();
    let mut line = |label: &str, v: Option<String>| {
        if let Some(v) = v {
            out.push_str(&format!("{label}: {v}\n"));
        }
    };
    line("Title", s("title").map(String::from));
    line("Source", s("webpage_url").map(String::from));
    line("Uploader", s("uploader").or(s("channel")).map(String::from));
    line(
        "Published",
        s("upload_date").filter(|d| d.len() == 8).map(|d| format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..])),
    );
    line("Site", s("extractor_key").map(String::from));
    line("License", s("license").map(String::from));
    line("Downloaded", Some(today()));
    if !sections.is_empty() {
        let parts: Vec<String> = sections.iter().map(|(a, b)| format!("{} - {}", ts(*a), ts(*b))).collect();
        line("Section", Some(parts.join(", ")));
    }
    out.push_str("\nDownloaded with Khama. Respect the rights of the content owner.\n");
    out
}

/// ينقل الملف الرئيسي ثم ما معه (ترجمة مقصوصة على المقاطع، صورة، معلومات، لقطات) بنفس الاسم
#[allow(clippy::too_many_arguments, unused_variables)]
async fn deliver_with_extras(
    app: &AppHandle,
    tools: &Tools,
    req: &DownloadRequest,
    file: &Path,
    final_dir: &Path,
    side: &Sidecars,
    sections: &[(f64, f64)],
    work: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PathBuf>, AppError> {
    std::fs::create_dir_all(final_dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;

    // لقطات ثابتة: قبل نقل الفيديو (نحتاجه في مكانه المؤقت)
    let stills_dir = match req.stills.as_deref().filter(|_| req.kind == "video" && !req.original) {
        Some(mode) => match grab_stills(tools, file, mode, &work.join("stills"), cancel).await? {
            Some(d) => Some(d),
            None => return Ok(None),
        },
        None => None,
    };

    let done = deliver(app, file, final_dir).await?;
    let stem = stem_of(&done);
    let extra_dir = work.join("extras");
    std::fs::create_dir_all(&extra_dir)?;

    for (src, suffix) in &side.files {
        let target = extra_dir.join(format!("{stem}{suffix}"));
        if suffix.ends_with(".srt") && !sections.is_empty() {
            let content = std::fs::read_to_string(src).unwrap_or_default();
            std::fs::write(&target, crate::srt::for_sections(&content, sections))?;
        } else {
            std::fs::copy(src, &target)?;
        }
        if let Err(e) = deliver(app, &target, final_dir).await {
            eprintln!("deliver extra: {e:?}");
        }
    }
    if let Some(info) = &side.info {
        let target = extra_dir.join(format!("{stem} - source.txt"));
        std::fs::write(&target, info_text(info, sections))?;
        if let Err(e) = deliver(app, &target, final_dir).await {
            eprintln!("deliver info: {e:?}");
        }
    }
    if let Some(dir) = stills_dir {
        let dest = unique_path(final_dir, &format!("{stem} stills"));
        if std::fs::rename(&dir, &dest).is_err() {
            std::fs::create_dir_all(&dest)?;
            for e in std::fs::read_dir(&dir)?.flatten() {
                std::fs::copy(e.path(), dest.join(e.file_name()))?;
            }
        }
        // الهاتف: المجلد كله إلى Download/Khama/<الاسم> stills
        #[cfg(mobile)]
        if let Err(e) = crate::mobile::publish_any(app, dest).await {
            eprintln!("deliver stills: {e:?}");
        }
    }
    Ok(Some(done))
}

/// لقطات JPG من الفيديو: كل N ثانية، أو عند تغيّر المشهد
async fn grab_stills(
    tools: &Tools,
    file: &Path,
    mode: &str,
    dir: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PathBuf>, AppError> {
    std::fs::create_dir_all(dir)?;
    let filter = match mode {
        "scene" => "select='eq(n\\,0)+gt(scene\\,0.3)'".to_string(),
        n => format!("fps=1/{}", n.parse::<u32>().unwrap_or(5).clamp(1, 600)),
    };
    let mut cmd = tools::ffmpeg_command(tools);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(file)
        .args(["-vf", &filter, "-fps_mode", "vfr", "-q:v", "2"])
        .arg(dir.join("still_%03d.jpg"));
    match run_streaming(cmd, cancel, |_| {}).await? {
        RunOutcome::Canceled => Ok(None),
        RunOutcome::Exited { success: true, .. } => Ok(Some(dir.to_path_buf())),
        RunOutcome::Exited { stderr, .. } => Err(AppError::with_detail("stillsFailed", tail(&stderr, 8))),
    }
}

/// ملف تايم لاين بصيغة Final Cut Pro 7 XML (يستورده Premiere و DaVinci Resolve):
/// المقاطع متتالية على مسار واحد، بنفس ترتيبها في الفيديو الأصلي.
#[cfg(desktop)]
async fn write_timeline(tools: &Tools, clips: &[(PathBuf, (f64, f64))]) -> Result<(), AppError> {
    let Some((first, _)) = clips.first() else { return Ok(()) };
    let f = first.to_string_lossy();
    let (_, out, _) = tools::run_capture(
        &tools.ffprobe,
        &["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", &f],
    )
    .await?;
    let j: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    let s = &j["streams"][0];
    let width = s["width"].as_u64().unwrap_or(1920);
    let height = s["height"].as_u64().unwrap_or(1080);
    let fps = s["r_frame_rate"].as_str().and_then(fraction).unwrap_or(30.0);
    let mut durations = Vec::new();
    for (p, (a, b)) in clips {
        let d = check_media(tools, p).await.ok().and_then(|c| c.duration).unwrap_or(b - a);
        durations.push(d);
    }
    let xml = timeline_xml(clips, &durations, fps, width, height);
    let dir = first.parent().unwrap_or(Path::new("."));
    let base = joined_name(first, clips.len());
    let name = format!("{} timeline.xml", base.rsplit_once('.').map(|(s, _)| s).unwrap_or(&base));
    std::fs::write(unique_path(dir, &name), xml)?;
    Ok(())
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// مسار ملف بصيغة file:// (المسافات والرموز مرمّزة)
fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from(if s.starts_with('/') { "file://localhost" } else { "file://localhost/" });
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn timeline_xml(clips: &[(PathBuf, (f64, f64))], durations: &[f64], fps: f64, width: u64, height: u64) -> String {
    // timebase عدد صحيح؛ 29.97 و 23.976 تُكتب 30 و 24 مع ntsc=TRUE
    let ntsc = (fps.round() - fps).abs() > 0.01;
    let tb = fps.round().max(1.0) as u64;
    let rate = format!("<rate><timebase>{tb}</timebase><ntsc>{}</ntsc></rate>", if ntsc { "TRUE" } else { "FALSE" });
    let frames = |sec: f64| (sec * fps).round() as u64;
    let mut video = String::new();
    let mut audio = String::new();
    let mut at = 0u64;
    for (i, ((p, _), d)) in clips.iter().zip(durations).enumerate() {
        let len = frames(*d).max(1);
        let name = xml_escape(&p.file_name().unwrap_or_default().to_string_lossy());
        let file = format!(
            "<file id=\"file-{i}\"><name>{name}</name><pathurl>{}</pathurl>{rate}<duration>{len}</duration>\
             <media><video><samplecharacteristics><width>{width}</width><height>{height}</height></samplecharacteristics></video>\
             <audio><channelcount>2</channelcount></audio></media></file>",
            xml_escape(&file_url(p))
        );
        video.push_str(&format!(
            "<clipitem id=\"v-{i}\"><name>{name}</name><duration>{len}</duration>{rate}<start>{at}</start><end>{}</end><in>0</in><out>{len}</out>{file}</clipitem>",
            at + len
        ));
        audio.push_str(&format!(
            "<clipitem id=\"a-{i}\"><name>{name}</name><duration>{len}</duration>{rate}<start>{at}</start><end>{}</end><in>0</in><out>{len}</out><file id=\"file-{i}\"/><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>",
            at + len
        ));
        at += len;
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE xmeml>\n<xmeml version=\"4\"><sequence id=\"khama\"><name>Khama clips</name><duration>{at}</duration>{rate}\
         <media><video><format><samplecharacteristics>{rate}<width>{width}</width><height>{height}</height></samplecharacteristics></format>\
         <track>{video}</track></video><audio><track>{audio}</track></audio></media></sequence></xmeml>\n"
    )
}

/// تنزيل مقطع واحد (أو الملف كاملًا) بـ yt-dlp إلى dir/out.
/// part = (رقم المقطع، عدد المقاطع) لحساب نسبة التقدم الكلية.
#[allow(clippy::too_many_arguments)]
async fn fetch(
    app: &AppHandle,
    id: u64,
    tools: &Tools,
    cookies: &[String],
    req: &DownloadRequest,
    opts: &JobOptions,
    section: Option<(f64, f64)>,
    dir: &Path,
    part: (usize, usize),
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<(PathBuf, PathBuf)>, AppError> {
    let out_dir = dir.join("out");
    let mut cmd = tools::ytdlp_command(tools);
    cmd.args(download_args(tools, cookies.to_vec(), req, opts, section, &out_dir, &dir.join("work")));

    let (i, n) = (part.0 as f64, part.1.max(1) as f64);
    let mut file: Option<PathBuf> = None;
    let mut last = Instant::now() - Duration::from_secs(1);
    let outcome = run_streaming(cmd, cancel, |line| {
        if let Some(rest) = line.strip_prefix("KHAMA_DL ") {
            if let Some(p) = parse_dl_line(rest) {
                // نحدّث الواجهة 5 مرات في الثانية كحد أقصى
                if p.finished || last.elapsed() >= Duration::from_millis(200) {
                    last = Instant::now();
                    emit(app, JobUpdate {
                        id,
                        state: "downloading",
                        stage: Some(p.stage),
                        percent: p.percent.map(|v| (i * 100.0 + v) / n),
                        speed: p.speed,
                        eta: p.eta,
                        ..Default::default()
                    });
                }
            }
        } else if let Some(rest) = line.strip_prefix("KHAMA_PP ") {
            if rest.starts_with("started") && !rest.ends_with("MoveFiles") {
                emit(app, JobUpdate { id, state: "processing", ..Default::default() });
            }
        } else if let Some(path) = line.strip_prefix("KHAMA_FILE ") {
            file = Some(PathBuf::from(path.trim()));
        }
    })
    .await?;

    match outcome {
        RunOutcome::Canceled => return Ok(None),
        RunOutcome::Exited { success: false, stderr } => return Err(friendly_ytdlp_error(&stderr)),
        RunOutcome::Exited { success: true, .. } => {}
    }
    match file.filter(|f| f.exists()) {
        Some(f) => {
            // مجلد فرعي من القالب (مثل YouTube/) يُحفظ كما هو داخل مجلد الحفظ
            let sub = f
                .parent()
                .and_then(|p| p.strip_prefix(&out_dir).ok())
                .map(Path::to_path_buf)
                .unwrap_or_default();
            Ok(Some((f, sub)))
        }
        None => Err(AppError::new("noOutputFile")),
    }
}

/// ما بعد التنزيل: جاهز للمونتاج، ثم إزالة الموسيقى/الصوت. dir = مجلد عمل خاص بهذا الملف.
#[allow(unused_variables, unused_mut)]
async fn finish(
    app: &AppHandle,
    id: u64,
    tools: &Tools,
    req: &DownloadRequest,
    mut file: PathBuf,
    dir: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PathBuf>, AppError> {
    // جاهز للمونتاج؟
    if req.kind == "video" && req.editor_ready && !req.original {
        emit(app, JobUpdate { id, state: "processing", ..Default::default() });
        let check = check_media(tools, &file).await?;
        if !(check.video_ok && check.audio_ok) {
            emit(app, JobUpdate { id, state: "converting", percent: Some(0.0), ..Default::default() });
            match convert_for_editing(app, id, tools, &file, &dir.join("conv"), &check, cancel).await? {
                Some(converted) => file = converted,
                None => return Ok(None),
            }
        }
    }

    // إزالة الموسيقى (أو الصوت البشري)؟
    if let Some(keep) = req.stems.as_deref().and_then(crate::separate::Keep::parse) {
        use crate::separate;
        let duration = check_media(tools, &file).await.ok().and_then(|c| c.duration);
        let sep_dir = dir.join("sep");
        std::fs::create_dir_all(&sep_dir)?;
        let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let ext = file.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
        let tag = if keep == separate::Keep::Voice { "no music" } else { "music only" };
        let out = sep_dir.join(format!("{stem} [{tag}].{ext}"));
        emit(app, JobUpdate { id, state: "separating", ..Default::default() });
        let _turn = tokio::select! {
            g = SEPARATING.lock() => g,
            _ = canceled(cancel) => return Ok(None),
        };
        if !separate::process_file(app, id, tools, &file, &out, keep, None, None, duration, &dir.join("sepwork"), cancel).await? {
            return Ok(None);
        }
        file = out;
    }
    Ok(Some(file))
}

/// النقل إلى مجلد المستخدم (وعلى الهاتف: إلى Download/Khama العام)
async fn deliver(app: &AppHandle, file: &Path, final_dir: &Path) -> Result<PathBuf, AppError> {
    let done = move_into(file, final_dir).await?;
    #[cfg(mobile)]
    {
        let app = app.clone();
        let published = tauri::async_runtime::spawn_blocking(move || crate::mobile::publish(&app, &done))
            .await
            .map_err(|e| AppError::with_detail("saveFailed", e.to_string()))??;
        return Ok(PathBuf::from(published.path));
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(done)
    }
}

/// "اسم [00m10s - 00m20s].mp4" + 3 مقاطع ← "اسم [3 clips].mp4"
fn joined_name(first: &Path, count: usize) -> String {
    let stem = first.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let base = match stem.rfind(" [") {
        Some(i) if stem.ends_with(']') => &stem[..i],
        _ => stem.as_str(),
    };
    let ext = first.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
    format!("{base} [{count} clips].{ext}")
}

/// سطر في قائمة concat الخاصة بـ ffmpeg (نهرب علامة ' داخل المسار)
fn concat_line(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/").replace('\'', r"'\''");
    format!("file '{s}'\n")
}

/// يدمج المقاطع بالترتيب في ملف واحد. أولًا بلا إعادة ترميز (سريع، والمقاطع من نفس المصدر)،
/// وإن فشل ذلك نعيد الترميز.
async fn concat_files(
    tools: &Tools,
    req: &DownloadRequest,
    inputs: &[PathBuf],
    dir: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PathBuf>, AppError> {
    std::fs::create_dir_all(dir)?;
    let list = dir.join("list.txt");
    std::fs::write(&list, inputs.iter().map(|p| concat_line(p)).collect::<String>())?;
    let output = dir.join(joined_name(&inputs[0], inputs.len()));
    let is_wav = output.extension().is_some_and(|e| e == "wav");

    let mut last_err = String::new();
    for reencode in [false, true] {
        let mut cmd = tools::command(&tools.ffmpeg);
        cmd.args(["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i"]).arg(&list);
        if !reencode || is_wav {
            cmd.args(["-c", "copy"]);
        } else if req.kind == "video" {
            cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k"]);
        } else if output.extension().is_some_and(|e| e == "mp3") {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "0"]);
        } else {
            cmd.args(["-c:a", "aac", "-b:a", "320k"]);
        }
        if req.kind == "video" || output.extension().is_some_and(|e| e == "m4a") {
            cmd.args(["-movflags", "+faststart"]);
        }
        cmd.arg(&output);
        match run_streaming(cmd, cancel, |_| {}).await? {
            RunOutcome::Canceled => return Ok(None),
            RunOutcome::Exited { success: true, .. } => return Ok(Some(output)),
            RunOutcome::Exited { stderr, .. } => last_err = tail(&stderr, 10),
        }
        if is_wav {
            break;
        }
    }
    Err(AppError::with_detail("joinFailed", last_err))
}

// ======================= أوامر تستدعيها الواجهة =======================

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    queue: State<'_, DownloadQueue>,
    settings: State<'_, SettingsState>,
    request: DownloadRequest,
) -> Result<u64, AppError> {
    let mut req = request;
    req.url = validate_url(&req.url)?;
    let settings = settings.0.lock().unwrap().clone();
    let id = jobs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = watch::channel(false);
    jobs.cancels.lock().unwrap().insert(id, tx);
    let slots = queue.0.clone();

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // ننتظر دورنا إن كانت كل الخانات مشغولة (والإلغاء ممكن أثناء الانتظار)
        let _slot = match slots.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                emit(&app2, JobUpdate { id, state: "queued", ..Default::default() });
                tokio::select! {
                    p = slots.acquire_owned() => p.expect("semaphore never closed"),
                    _ = canceled(&mut rx) => {
                        app2.state::<Jobs>().cancels.lock().unwrap().remove(&id);
                        emit(&app2, JobUpdate { id, state: "canceled", ..Default::default() });
                        return;
                    }
                }
            }
        };
        emit(&app2, JobUpdate { id, state: "starting", ..Default::default() });
        let job_dir = jobs_root(&app2).map(|r| r.join(id.to_string()));
        let result = match &job_dir {
            Ok(dir) => run_job(&app2, id, req, settings, dir, &mut rx).await,
            Err(e) => Err(e.clone()),
        };
        let update = match result {
            Ok(Some(path)) => JobUpdate {
                id,
                state: "done",
                percent: Some(100.0),
                file: Some(path.to_string_lossy().into_owned()),
                ..Default::default()
            },
            // إن فشل شيء بعد ضغط "إلغاء" فهو نتيجة الإلغاء، لا خطأ حقيقي
            Ok(None) | Err(_) if *rx.borrow() => JobUpdate { id, state: "canceled", ..Default::default() },
            Ok(None) => JobUpdate { id, state: "canceled", ..Default::default() },
            Err(e) => JobUpdate { id, state: "error", error: Some(e), ..Default::default() },
        };
        if let Ok(dir) = job_dir {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        app2.state::<Jobs>().cancels.lock().unwrap().remove(&id);
        emit(&app2, update);
    });
    Ok(id)
}

#[tauri::command]
pub fn cancel_download(jobs: State<'_, Jobs>, id: u64) {
    if let Some(tx) = jobs.cancels.lock().unwrap().get(&id) {
        let _ = tx.send(true);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    title: String,
    thumbnail: Option<String>,
    duration: Option<f64>,
    uploader: Option<String>,
    site: Option<String>,
    /// الدقات المتوفرة (للفيديو)، من الأعلى للأقل
    heights: Vec<u32>,
    is_live: bool,
    /// رابط قائمة تشغيل: عناصرها (والحقول أعلاه تصف القائمة نفسها)
    #[serde(skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<Entry>>,
    /// لغات الترجمة المتاحة
    subtitles: Vec<SubLang>,
    /// رابط مباشر لنسخة صغيرة (فيديو + صوت) لمعاينة القص داخل التطبيق
    #[serde(skip_serializing_if = "Option::is_none")]
    preview_url: Option<String>,
    /// ملفات Google Drive: تُنزَّل كما هي (بلا تحويل صيغة)
    original: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubLang {
    code: String,
    name: String,
    /// ترجمة تلقائية (من الكلام) لا مكتوبة
    auto: bool,
}

/// لغات الترجمة: المكتوبة أولًا، ثم التلقائية المفيدة فقط (لغة الفيديو الأصلية + العربية والإنجليزية)
/// لأن يوتيوب يعرض ترجمة آلية لأكثر من 100 لغة.
pub fn sub_langs(j: &Value) -> Vec<SubLang> {
    let name_of = |v: &Value, code: &str| {
        v.as_array()
            .and_then(|a| a.iter().find_map(|t| t["name"].as_str()))
            .map(String::from)
            .unwrap_or_else(|| code.to_string())
    };
    let mut out: Vec<SubLang> = Vec::new();
    if let Some(m) = j["subtitles"].as_object() {
        for (code, v) in m {
            if code == "live_chat" {
                continue;
            }
            out.push(SubLang { code: code.clone(), name: name_of(v, code), auto: false });
        }
    }
    if let Some(m) = j["automatic_captions"].as_object() {
        let lang = j["language"].as_str().unwrap_or("");
        for (code, v) in m {
            let base = code.trim_end_matches("-orig");
            let useful = code.ends_with("-orig") || code == lang || code == "ar" || code == "en";
            if useful && !out.iter().any(|s| s.code == base || s.code.split('-').next() == Some(base)) {
                out.push(SubLang { code: code.clone(), name: name_of(v, code), auto: true });
            }
        }
    }
    out
}

/// أصغر نسخة فيها صورة وصوت معًا بصيغة MP4 (تكفي للمعاينة وتُشغَّل في المتصفح مباشرة)
fn preview_url(j: &Value) -> Option<String> {
    j["formats"]
        .as_array()?
        .iter()
        .filter(|f| {
            f["vcodec"].as_str().is_some_and(|v| v != "none" && v.starts_with("avc1"))
                && f["acodec"].as_str().is_some_and(|a| a != "none")
                && f["ext"].as_str() == Some("mp4")
                && f["protocol"].as_str() == Some("https")
        })
        .min_by_key(|f| f["height"].as_u64().unwrap_or(9999))
        .and_then(|f| f["url"].as_str())
        .map(String::from)
}

/// قائمة سبوتيفاي: نجلب صفحة المشغّل المضمَّن بـ yt-dlp ونقرأ منها أسماء الأغاني
async fn probe_spotify(tools: &Tools, embed: String) -> Result<ProbeInfo, AppError> {
    let mut args = tools::ytdlp_base_args(tools);
    args.extend(["--force-generic-extractor", "--dump-pages", "--skip-download", "--"].map(String::from));
    args.push(embed);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    // yt-dlp ينتهي بخطأ "Unsupported URL" بعد طباعة الصفحة، وهذا متوقّع
    let (_, out, err) = tokio::time::timeout(Duration::from_secs(60), tools::run_ytdlp(tools, &args))
        .await
        .map_err(|_| AppError::new("timeout"))??;
    let Some(page) = playlist::page_from_dump(&out) else {
        return Err(AppError::with_detail("spotifyFailed", tail(&err, 6)));
    };
    let list = playlist::parse_spotify_page(&page)?;
    Ok(ProbeInfo {
        title: list.title,
        thumbnail: list.thumbnail,
        duration: None,
        uploader: list.owner,
        site: Some("Spotify".into()),
        heights: vec![],
        is_live: false,
        entries: Some(list.entries),
        subtitles: vec![],
        preview_url: None,
        original: false,
    })
}

/// تفاصيل عناصر قائمة لم يعطِ الموقع أسماءها مع --flat-playlist (ساوندكلاود):
/// يفتح yt-dlp كل رابط ويعيد عنوانه الحقيقي ومدته وصورته. الواجهة تطلبها على دفعات صغيرة
/// فتظهر الأسماء تباعًا بدل انتظار القائمة كلها.
#[tauri::command]
pub async fn playlist_details(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    urls: Vec<String>,
) -> Result<Vec<(String, playlist::Entry)>, AppError> {
    let urls: Vec<String> = urls.iter().filter_map(|u| validate_url(u).ok()).take(20).collect();
    if urls.is_empty() {
        return Ok(vec![]);
    }
    let s = settings.0.lock().unwrap().clone();
    let tools = tools::resolve(&app)?;
    let mut args = tools::ytdlp_base_args(&tools);
    args.extend(cookie_args(&app, &s));
    // --ignore-errors: عنصر محذوف أو خاص لا يُسقط الباقي
    args.extend(["-j", "--no-playlist", "--ignore-errors", "--"].map(String::from));
    args.extend(urls);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (_, out, _) = tokio::time::timeout(Duration::from_secs(120), tools::run_ytdlp(&tools, &args))
        .await
        .map_err(|_| AppError::new("timeout"))??;
    Ok(playlist::details_from_lines(&out))
}

/// يقرأ معلومات الرابط (العنوان، الصورة، الدقات المتاحة) دون تنزيل.
/// رابط قائمة تشغيل: يعيد عناصرها في entries.
#[tauri::command]
pub async fn probe(app: AppHandle, settings: State<'_, SettingsState>, url: String) -> Result<ProbeInfo, AppError> {
    let url = validate_url(&url)?;
    let s = settings.0.lock().unwrap().clone();
    let tools = tools::resolve(&app)?;
    if let Some(embed) = playlist::spotify_embed_url(&url) {
        return probe_spotify(&tools, embed).await;
    }
    let mut args = tools::ytdlp_base_args(&tools);
    args.extend(cookie_args(&app, &s));
    // --flat-playlist: عناصر القائمة دون فتح كل واحد منها (لا يؤثّر على رابط فيديو واحد)
    args.extend(["-J".to_string(), "--flat-playlist".to_string(), "--".to_string(), url]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    let run = tools::run_ytdlp(&tools, &args);
    let (ok, out, err) = tokio::time::timeout(Duration::from_secs(90), run)
        .await
        .map_err(|_| AppError::new("timeout"))??;
    if !ok {
        return Err(friendly_ytdlp_error(&err));
    }
    let j: Value = serde_json::from_str(&out)
        .map_err(|e| AppError::with_detail("probeParse", e.to_string()))?;
    if j["_type"].as_str() == Some("playlist") {
        let entries = playlist::entries_from_ytdlp(&j);
        if entries.is_empty() {
            return Err(AppError::new("playlistEmpty"));
        }
        let thumbnail = j["thumbnails"]
            .as_array()
            .and_then(|t| t.last())
            .and_then(|t| t["url"].as_str())
            .map(String::from)
            .or_else(|| entries.iter().find_map(|e| e.thumbnail.clone()));
        return Ok(ProbeInfo {
            title: j["title"].as_str().unwrap_or("Playlist").to_string(),
            thumbnail,
            duration: None,
            uploader: j["uploader"].as_str().or(j["channel"].as_str()).map(String::from),
            site: j["extractor_key"].as_str().map(|k| k.trim_end_matches("Tab").trim_end_matches("Set").to_string()),
            heights: vec![],
            is_live: false,
            entries: Some(entries),
            subtitles: vec![],
            preview_url: None,
            original: j["extractor_key"].as_str().is_some_and(|k| k.starts_with("GoogleDrive")),
        });
    }
    let mut heights: Vec<u32> = j["formats"]
        .as_array()
        .map(|fs| {
            fs.iter()
                .filter(|f| f["vcodec"].as_str().is_some_and(|v| v != "none"))
                .filter_map(|f| f["height"].as_u64().map(|h| h as u32))
                .collect()
        })
        .unwrap_or_default();
    heights.sort_unstable_by(|a, b| b.cmp(a));
    heights.dedup();
    Ok(ProbeInfo {
        title: j["title"].as_str().unwrap_or("Untitled").to_string(),
        thumbnail: j["thumbnail"].as_str().map(String::from),
        duration: j["duration"].as_f64(),
        uploader: j["uploader"].as_str().or(j["channel"].as_str()).map(String::from),
        site: j["extractor_key"].as_str().map(String::from),
        heights,
        is_live: j["is_live"].as_bool().unwrap_or(false),
        entries: None,
        subtitles: sub_langs(&j),
        preview_url: preview_url(&j),
        original: j["extractor_key"].as_str().is_some_and(|k| k.starts_with("GoogleDrive")),
    })
}

/// يحفظ الصورة المصغّرة بأعلى دقة (JPG) في مجلد الحفظ، دون تنزيل الفيديو
#[tauri::command]
pub async fn save_thumbnail(app: AppHandle, settings: State<'_, SettingsState>, url: String) -> Result<String, AppError> {
    let url = validate_url(&url)?;
    let s = settings.0.lock().unwrap().clone();
    let tools = tools::resolve(&app)?;
    static N: AtomicU64 = AtomicU64::new(0);
    let work = jobs_root(&app)?.join(format!("thumb-{}", N.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work)?;
    let mut a = tools::ytdlp_base_args(&tools);
    a.extend(cookie_args(&app, &s));
    a.extend(["--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg", "-P"].map(String::from));
    a.push(work.to_string_lossy().into_owned());
    a.extend(["-o".into(), "%(title).150B.%(ext)s".into(), "--windows-filenames".into(), "--".into(), url]);
    let args: Vec<&str> = a.iter().map(String::as_str).collect();
    let (ok, _, err) = tokio::time::timeout(Duration::from_secs(90), tools::run_ytdlp(&tools, &args))
        .await
        .map_err(|_| AppError::new("timeout"))??;
    let jpg = std::fs::read_dir(&work)?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "jpg"));
    let Some(jpg) = jpg else {
        let _ = std::fs::remove_dir_all(&work);
        return Err(if ok { AppError::new("noThumbnail") } else { friendly_ytdlp_error(&err) });
    };
    #[cfg(mobile)]
    let dir = jobs_root(&app)?.join("ready");
    #[cfg(desktop)]
    let dir = settings::resolve_output_dir(&app, &s)?;
    std::fs::create_dir_all(&dir)?;
    let done = deliver(&app, &jpg, &dir).await;
    let _ = std::fs::remove_dir_all(&work);
    Ok(done?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reveal_file(app: AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::with_detail("openFolder", e.to_string()))
}

#[tauri::command]
pub fn open_output_dir(app: AppHandle, settings: State<'_, SettingsState>) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let s = settings.0.lock().unwrap().clone();
    let dir = settings::resolve_output_dir(&app, &s)?;
    std::fs::create_dir_all(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::with_detail("openFolder", e.to_string()))
}

// ======================= اختبارات =======================

#[cfg(test)]
mod tests {
    use super::*;

    fn req(kind: &str, fmt: &str, q: &str, editor: bool) -> DownloadRequest {
        DownloadRequest {
            url: "https://example.com".into(),
            kind: kind.into(),
            video_format: fmt.into(),
            audio_format: fmt.into(),
            quality: q.into(),
            editor_ready: editor,
            start: None,
            end: None,
            stems: None,
            clips: vec![],
            join_clips: false,
            subdir: None,
            ..Default::default()
        }
    }

    #[test]
    fn templates() {
        assert_eq!(output_template("{title}", false, 0, "2026-11-10"), "%(title).120B");
        assert_eq!(
            output_template("ref_{n} {site}", true, 7, "2026-11-10"),
            "%(extractor_key)s/ref_007 %(extractor_key)s"
        );
        // نص بلا متغيرات: يُضاف العنوان بعده، والرموز الممنوعة تُستبدل
        assert_eq!(output_template("a/b 100%", false, 0, "x"), "a_b 100%% %(title).120B");
        assert_eq!(output_template("", false, 0, "x"), "%(title).120B");
        assert_eq!(output_template("{today}_{title}", false, 0, "2026-11-10"), "2026-11-10_%(title).120B");
    }

    #[test]
    fn dates() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(20_402), "2025-11-10");
        assert_eq!(civil_date(11_016), "2000-02-29");
    }

    #[test]
    fn subtitle_languages() {
        let j: Value = serde_json::from_str(r#"{
            "language": "fr",
            "subtitles": {"en": [{"name": "English"}], "live_chat": []},
            "automatic_captions": {"fr-orig": [{"name": "French (Original)"}], "fr": [{"name": "French"}], "en": [{"name": "English"}], "ar": [{"name": "Arabic"}], "de": [{"name": "German"}]}
        }"#).unwrap();
        let codes: Vec<(String, bool)> = sub_langs(&j).into_iter().map(|s| (s.code, s.auto)).collect();
        assert_eq!(codes, vec![("en".into(), false), ("ar".into(), true), ("fr".into(), true)]);
    }

    #[test]
    fn timeline() {
        let clips = vec![(PathBuf::from("C:/v/a b.mp4"), (0.0, 2.0)), (PathBuf::from("C:/v/c&d.mp4"), (5.0, 6.0))];
        let x = timeline_xml(&clips, &[2.0, 1.0], 29.97, 1920, 1080);
        assert!(x.contains("<timebase>30</timebase><ntsc>TRUE</ntsc>"));
        assert!(x.contains("<pathurl>file://localhost/C:/v/a%20b.mp4</pathurl>"));
        assert!(x.contains("c&amp;d.mp4"));
        assert!(x.contains("<start>60</start><end>90</end>"));
    }

    #[test]
    fn info_file_text() {
        let j: Value = serde_json::from_str(r#"{"title":"T","webpage_url":"https://x","uploader":"U","upload_date":"20141110","extractor_key":"Youtube","license":"NA"}"#).unwrap();
        let t = info_text(&j, &[(1.0, 2.5)]);
        assert!(t.contains("Source: https://x\n"));
        assert!(t.contains("Published: 2014-11-10\n"));
        assert!(!t.contains("License"));
        assert!(t.contains("Section: 0:00:01.000 - 0:00:02.500"));
    }

    #[test]
    fn multiple_clips() {
        let mut r = req("video", "mp4", "1080", true);
        assert!(clips(&r).is_empty());
        r.start = Some(5.0);
        r.end = Some(9.0);
        assert_eq!(clips(&r), vec![(5.0, 9.0)]);
        // المقاطع تتقدّم على start/end، وتُرتّب، والخاطئ منها يُهمل
        r.clips = vec![[60.0, 70.0], [10.0, 20.0], [30.0, 25.0], [f64::NAN, 3.0]];
        assert_eq!(clips(&r), vec![(10.0, 20.0), (60.0, 70.0)]);
    }

    #[test]
    fn joined_names() {
        let p = Path::new("C:/x/My Video [00m10s - 00m20s].mp4");
        assert_eq!(joined_name(p, 3), "My Video [3 clips].mp4");
        assert_eq!(joined_name(Path::new("/a/plain.mp3"), 2), "plain [2 clips].mp3");
        assert_eq!(concat_line(Path::new(r"C:\a\it's.mp4")), "file 'C:/a/it'\\''s.mp4'\n");
    }

    #[test]
    fn sections() {
        let mut r = req("video", "mp4", "1080", true);
        assert_eq!(section(&r), None);
        r.start = Some(75.5);
        r.end = Some(130.0);
        assert_eq!(section(&r), Some((75.5, 130.0)));
        assert_eq!(ts(75.5), "0:01:15.500");
        assert_eq!(ts_name(3725.0), "1h02m05s");
        r.end = Some(10.0); // نهاية قبل البداية
        assert_eq!(section(&r), None);
    }

    #[test]
    fn video_1080_editor_ready_prefers_h264() {
        let a = format_args(&req("video", "mp4", "1080", true));
        let i = a.iter().position(|x| x == "-S").unwrap();
        assert_eq!(a[i + 1], "res:1080,vcodec:h264,acodec:aac");
        assert!(a.contains(&"mp4".to_string()));
    }

    #[test]
    fn video_best_without_editor_ready() {
        let a = format_args(&req("video", "mp4", "best", false));
        let i = a.iter().position(|x| x == "-S").unwrap();
        assert_eq!(a[i + 1], "res");
    }

    #[test]
    fn audio_wav() {
        let a = format_args(&req("audio", "wav", "best", true));
        assert!(a.windows(2).any(|w| w[0] == "--audio-format" && w[1] == "wav"));
    }

    #[test]
    fn parses_progress_line() {
        let p = parse_dl_line("downloading|1024|2048|NA|5000.5|3|avc1.4D400C|none|NA|NA").unwrap();
        assert_eq!(p.stage, "video");
        assert_eq!(p.percent, Some(50.0));
        assert_eq!(p.speed, Some(5000.5));
        assert!(!p.finished);
    }

    #[test]
    fn parses_fragment_progress() {
        let p = parse_dl_line("downloading|1024|NA|NA|NA|NA|none|mp4a.40.2|5|20").unwrap();
        assert_eq!(p.stage, "audio");
        assert_eq!(p.percent, Some(25.0));
    }

    #[test]
    fn rejects_non_http_url() {
        assert!(validate_url("ftp://x").is_err());
        assert!(validate_url("  https://youtu.be/x ").is_ok());
    }

    #[test]
    fn unique_names() {
        let dir = std::env::temp_dir().join(format!("khama-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.mp4"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.mp4"), dir.join("a (1).mp4"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
