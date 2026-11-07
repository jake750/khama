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
        Mutex,
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
    sync::watch,
};

use crate::{
    errors::{AppError, friendly_ytdlp_error, tail},
    settings::{self, Settings, SettingsState},
    tools::{self, Tools},
};

// ======================= الحالة والأنواع =======================

/// العمليات الجارية: لكل عملية "زر إلغاء" (قناة watch نرسل فيها true)
#[derive(Default)]
pub struct Jobs {
    next_id: AtomicU64,
    cancels: Mutex<HashMap<u64, watch::Sender<bool>>>,
}

#[derive(Debug, Clone, Deserialize)]
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
}

fn emit(app: &AppHandle, u: JobUpdate) {
    let _ = app.emit("job-update", u);
}

// ======================= بناء أوامر yt-dlp =======================

fn validate_url(url: &str) -> Result<String, AppError> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::new("الصق رابطًا صحيحًا يبدأ بـ http:// أو https://"));
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
    if req.kind == "audio" {
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

fn download_args(tools: &Tools, cookies: Vec<String>, req: &DownloadRequest, out: &Path, work: &Path) -> Vec<String> {
    let mut a = tools::ytdlp_base_args(tools);
    a.extend(cookies);
    a.extend(format_args(req));
    a.extend([
        "-P".into(),
        out.to_string_lossy().into_owned(),
        "-P".into(),
        format!("temp:{}", work.to_string_lossy()),
        "-o".into(),
        "%(title).150B.%(ext)s".into(),
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

enum RunOutcome {
    Exited { success: bool, stderr: String },
    Canceled,
}

/// يوقف العملية وكل ما شغّلته (yt-dlp يشغّل ffmpeg، ونسخة Windows منه تشغّل نفسها مرتين)
async fn kill_tree(child: &mut Child) {
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
async fn canceled(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|c| *c).await;
}

/// يشغّل أمرًا، ويمرّر كل سطر من مخرجاته إلى on_line، ويوقفه إن ضغط المستخدم إلغاء
async fn run_streaming(
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
            if buf.len() > 65_536 {
                let mut cut = buf.len() - 32_768;
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

fn num(s: &str) -> Option<f64> {
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

fn fraction(s: &str) -> Option<f64> {
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
        return Err(AppError::with_detail("تعذّر فحص الملف بعد التنزيل.", tail(&err, 8)));
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
            "اكتمل التنزيل لكن فشل تحويل الملف لصيغة المونتاج.",
            tail(&stderr, 10),
        )),
    }
}

// ======================= نقل الملف النهائي =======================

/// اسم غير مستخدم: "اسم.mp4" ← "اسم (1).mp4" ← "اسم (2).mp4"
fn unique_path(dir: &Path, name: &str) -> PathBuf {
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
            AppError::with_detail("تعذّر نقل الملف إلى مجلد الحفظ. تأكد من صلاحية الكتابة ومن المساحة المتاحة.", e.to_string())
        })?;
        let _ = tokio::fs::remove_file(src).await;
    }
    Ok(dest)
}

// ======================= العملية الكاملة =======================

fn jobs_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::with_detail("تعذّر تحديد المجلد المؤقت.", e.to_string()))?
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
    let final_dir = settings::resolve_output_dir(app, &settings)?;
    std::fs::create_dir_all(&final_dir).map_err(|e| {
        AppError::with_detail("تعذّر إنشاء مجلد الحفظ. اختر مجلدًا آخر من الإعدادات.", e.to_string())
    })?;
    let out = job_dir.join("out");
    let work = job_dir.join("work");

    // 1) التنزيل
    let mut cmd = tools::command(&tools.ytdlp);
    cmd.args(download_args(&tools, cookie_args(app, &settings), &req, &out, &work));

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
                        percent: p.percent,
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
    let mut file = match file.filter(|f| f.exists()) {
        Some(f) => f,
        None => return Err(AppError::new("انتهى التنزيل لكن لم أجد الملف الناتج.")),
    };

    // 2) جاهز للمونتاج؟
    if req.kind == "video" && req.editor_ready {
        emit(app, JobUpdate { id, state: "processing", ..Default::default() });
        let check = check_media(&tools, &file).await?;
        if !(check.video_ok && check.audio_ok) {
            emit(app, JobUpdate { id, state: "converting", percent: Some(0.0), ..Default::default() });
            match convert_for_editing(app, id, &tools, &file, &job_dir.join("conv"), &check, cancel).await? {
                Some(converted) => file = converted,
                None => return Ok(None),
            }
        }
    }

    // 3) النقل إلى مجلد المستخدم
    Ok(Some(move_into(&file, &final_dir).await?))
}

// ======================= أوامر تستدعيها الواجهة =======================

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    settings: State<'_, SettingsState>,
    request: DownloadRequest,
) -> Result<u64, AppError> {
    let mut req = request;
    req.url = validate_url(&req.url)?;
    let settings = settings.0.lock().unwrap().clone();
    let id = jobs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = watch::channel(false);
    jobs.cancels.lock().unwrap().insert(id, tx);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
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
            Ok(None) => JobUpdate { id, state: "canceled", ..Default::default() },
            Err(e) if *rx.borrow() => {
                let _ = e;
                JobUpdate { id, state: "canceled", ..Default::default() }
            }
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
}

/// يقرأ معلومات الرابط (العنوان، الصورة، الدقات المتاحة) دون تنزيل
#[tauri::command]
pub async fn probe(app: AppHandle, settings: State<'_, SettingsState>, url: String) -> Result<ProbeInfo, AppError> {
    let url = validate_url(&url)?;
    let s = settings.0.lock().unwrap().clone();
    let tools = tools::resolve(&app)?;
    let mut args = tools::ytdlp_base_args(&tools);
    args.extend(cookie_args(&app, &s));
    args.extend(["-J".to_string(), "--".to_string(), url]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    let run = tools::run_capture(&tools.ytdlp, &args);
    let (ok, out, err) = tokio::time::timeout(Duration::from_secs(90), run)
        .await
        .map_err(|_| AppError::new("استغرق الموقع وقتًا طويلًا في الرد. تحقق من الاتصال ثم أعد المحاولة."))??;
    if !ok {
        return Err(friendly_ytdlp_error(&err));
    }
    let j: Value = serde_json::from_str(&out)
        .map_err(|e| AppError::with_detail("تعذّرت قراءة معلومات الرابط.", e.to_string()))?;
    if j["_type"].as_str() == Some("playlist") {
        return Err(AppError::new("هذا رابط قائمة تشغيل. تنزيل القوائم قادم في المرحلة الثانية؛ الصق رابط فيديو واحد."));
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
        title: j["title"].as_str().unwrap_or("بدون عنوان").to_string(),
        thumbnail: j["thumbnail"].as_str().map(String::from),
        duration: j["duration"].as_f64(),
        uploader: j["uploader"].as_str().or(j["channel"].as_str()).map(String::from),
        site: j["extractor_key"].as_str().map(String::from),
        heights,
        is_live: j["is_live"].as_bool().unwrap_or(false),
    })
}

#[tauri::command]
pub fn reveal_file(app: AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::with_detail("تعذّر فتح المجلد.", e.to_string()))
}

#[tauri::command]
pub fn open_output_dir(app: AppHandle, settings: State<'_, SettingsState>) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let s = settings.0.lock().unwrap().clone();
    let dir = settings::resolve_output_dir(&app, &s)?;
    std::fs::create_dir_all(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::with_detail("تعذّر فتح المجلد.", e.to_string()))
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
        }
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
