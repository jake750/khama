//! المحوّل (Encoder): يحوّل ملفات على جهاز المستخدم باستخدام FFmpeg المضمّن.
//!
//! الفكرة: المستخدم يختار "وش يبي يسوي بالملف" (Preset)، لا الكودك.
//! كل Preset يعرف حاويته وكودكاته وإعداداته، والخيارات الإضافية
//! (قص، تغيير المقاس، LUT، ترجمة محروقة، علامة مائية، توحيد الصوت...)
//! تُركّب كسلسلة فلاتر واحدة.
//!
//! التحويلات تمرّ بطابور: واحدة في كل مرة (FFmpeg يستهلك كل أنوية المعالج أصلًا).
//! الناتج يُكتب باسم مؤقت مخفي في مجلد الحفظ، ثم يُعاد تسميته عند النجاح،
//! فلا يرى المستخدم ملفًا ناقصًا أبدًا.

use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{OnceCell, Semaphore, watch};

use crate::{
    download::{self, JobUpdate, Jobs, RunOutcome, emit, fraction, num, run_streaming, unique_path},
    errors::{AppError, tail},
    settings::{self, SettingsState},
    tools::{self, Tools},
};

// ======================= الحالة =======================

/// طابور التحويل: تحويل واحد في كل مرة
pub struct ConvertQueue(pub Arc<Semaphore>);

impl Default for ConvertQueue {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(1)))
    }
}

/// مشفّرات كرت الشاشة المتاحة فعلًا على هذا الجهاز (تُفحص مرة واحدة)
static HW: OnceCell<Vec<String>> = OnceCell::const_new();

// ======================= معلومات الملف =======================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub codec: String,
    pub profile: Option<String>,
    /// المقاس كما يُعرض (بعد تطبيق دوران الجوال)
    pub width: u32,
    pub height: u32,
    pub fps: Option<f64>,
    pub vfr: bool,
    pub pix_fmt: String,
    pub bit_depth: u32,
    pub hdr: bool,
    pub interlaced: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub duration: Option<f64>,
    pub container: String,
    /// بت/ثانية
    pub bitrate: Option<f64>,
    pub video: Option<VideoInfo>,
    pub audio: Vec<AudioInfo>,
    pub subtitles: u32,
    /// صورة مصغّرة data:image/jpeg;base64,...
    pub thumbnail: Option<String>,
    /// ملاحظات للمونتير: vfr | hdr | interlaced | tenBit | heavyCodec | noAudio | resolveFreeAudio
    pub issues: Vec<&'static str>,
}

fn rotation_of(s: &Value) -> i64 {
    let from_side = s["side_data_list"].as_array().and_then(|l| {
        l.iter().find_map(|d| d["rotation"].as_f64().or_else(|| d["rotation"].as_str().and_then(num)))
    });
    let from_tag = s["tags"]["rotate"].as_str().and_then(num);
    (from_side.or(from_tag).unwrap_or(0.0).round() as i64).rem_euclid(360)
}

/// يقرأ JSON من ffprobe ويحوّله لمعلومات مفهومة
pub fn parse_probe(path: &Path, size: u64, j: &Value) -> MediaInfo {
    let streams = j["streams"].as_array().cloned().unwrap_or_default();
    let mut video = None;
    let mut audio = Vec::new();
    let mut subtitles = 0;
    for s in &streams {
        match s["codec_type"].as_str() {
            // صورة الغلاف داخل ملف صوتي ليست فيديو
            Some("video") if video.is_none() && s["disposition"]["attached_pic"].as_i64() != Some(1) => {
                let pix = s["pix_fmt"].as_str().unwrap_or("").to_string();
                let r = s["r_frame_rate"].as_str().and_then(fraction);
                let avg = s["avg_frame_rate"].as_str().and_then(fraction);
                let vfr = match (r, avg) {
                    (Some(r), Some(avg)) if r > 0.0 && avg > 0.0 => ((r - avg) / r).abs() > 0.02,
                    _ => false,
                };
                let fps = avg.filter(|v| *v > 0.0 && *v < 1000.0).or(r.filter(|v| *v > 0.0 && *v < 1000.0));
                let bit_depth = s["bits_per_raw_sample"]
                    .as_str()
                    .and_then(|b| b.parse().ok())
                    .unwrap_or(if pix.contains("10") { 10 } else if pix.contains("12") { 12 } else { 8 });
                let transfer = s["color_transfer"].as_str().unwrap_or("");
                let field = s["field_order"].as_str().unwrap_or("progressive");
                let (mut w, mut h) = (s["width"].as_u64().unwrap_or(0) as u32, s["height"].as_u64().unwrap_or(0) as u32);
                if matches!(rotation_of(s), 90 | 270) {
                    std::mem::swap(&mut w, &mut h);
                }
                video = Some(VideoInfo {
                    codec: s["codec_name"].as_str().unwrap_or("?").to_string(),
                    profile: s["profile"].as_str().map(String::from),
                    width: w,
                    height: h,
                    fps,
                    vfr,
                    pix_fmt: pix,
                    bit_depth,
                    hdr: matches!(transfer, "smpte2084" | "arib-std-b67"),
                    interlaced: !matches!(field, "progressive" | "unknown" | ""),
                });
            }
            Some("audio") => audio.push(AudioInfo {
                codec: s["codec_name"].as_str().unwrap_or("?").to_string(),
                channels: s["channels"].as_u64().unwrap_or(0) as u32,
                sample_rate: s["sample_rate"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0),
            }),
            Some("subtitle") => subtitles += 1,
            _ => {}
        }
    }

    let mut issues = Vec::new();
    if let Some(v) = &video {
        if v.vfr {
            issues.push("vfr");
        }
        if v.hdr {
            issues.push("hdr");
        }
        if v.interlaced {
            issues.push("interlaced");
        }
        if v.bit_depth > 8 && !v.hdr && !v.codec.starts_with("prores") && v.codec != "dnxhd" {
            issues.push("tenBit");
        }
        if matches!(v.codec.as_str(), "hevc" | "av1" | "vp9" | "vp8") {
            issues.push("heavyCodec");
        }
        if audio.is_empty() {
            issues.push("noAudio");
        }
    }
    // DaVinci Resolve المجاني على Linux لا يفك AAC (ولا H.264)
    if audio.iter().any(|a| a.codec == "aac") && cfg!(target_os = "linux") {
        issues.push("resolveFreeAudio");
    }

    MediaInfo {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size,
        duration: j["format"]["duration"].as_str().and_then(num),
        container: j["format"]["format_name"].as_str().unwrap_or("").to_string(),
        bitrate: j["format"]["bit_rate"].as_str().and_then(num),
        video,
        audio,
        subtitles,
        thumbnail: None,
        issues,
    }
}

async fn probe_file(tools: &Tools, path: &Path) -> Result<MediaInfo, AppError> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::with_detail("badInput", e.to_string()))?;
    let p = path.to_string_lossy();
    let (ok, out, err) = tools::run_capture(
        &tools.ffprobe,
        &["-v", "error", "-show_format", "-show_streams", "-of", "json", &p],
    )
    .await?;
    if !ok {
        return Err(AppError::with_detail("badInput", tail(&err, 6)));
    }
    let j: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    let info = parse_probe(path, meta.len(), &j);
    if info.video.is_none() && info.audio.is_empty() {
        return Err(AppError::new("badInput"));
    }
    Ok(info)
}

/// صورة مصغّرة من منتصف الفيديو تقريبًا
async fn thumbnail(tools: &Tools, path: &Path, duration: Option<f64>) -> Option<String> {
    use base64::Engine;
    let at = duration.map(|d| (d * 0.1).min(30.0)).unwrap_or(0.0);
    let out = tools::command(&tools.ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", &format!("{at:.2}"), "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf", "scale=320:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-"])
        .output()
        .await
        .ok()?;
    (out.status.success() && !out.stdout.is_empty())
        .then(|| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out.stdout)))
}

#[tauri::command]
pub async fn analyze_file(app: AppHandle, path: String) -> Result<MediaInfo, AppError> {
    let tools = tools::resolve(&app)?;
    let p = PathBuf::from(&path);
    let mut info = probe_file(&tools, &p).await?;
    if info.video.is_some() {
        info.thumbnail = thumbnail(&tools, &p, info.duration).await;
    }
    Ok(info)
}

// ======================= مشفّرات كرت الشاشة =======================

fn hw_candidates() -> &'static [&'static str] {
    if cfg!(target_os = "macos") {
        &["h264_videotoolbox", "hevc_videotoolbox"]
    } else if cfg!(windows) {
        &["h264_nvenc", "hevc_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf"]
    } else {
        &["h264_nvenc", "hevc_nvenc"]
    }
}

/// يجرّب كل مشفّر بترميز إطار واحد صغير: الموجود في FFmpeg لا يعني أن الجهاز يدعمه
async fn detect_hw(tools: &Tools) -> Vec<String> {
    let mut found = Vec::new();
    for enc in hw_candidates() {
        let fmt = if enc.ends_with("_qsv") { "nv12" } else { "yuv420p" };
        let ok = tools::command(&tools.ffmpeg)
            .args([
                "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "color=s=256x256:d=0.2",
                "-frames:v", "2", "-pix_fmt", fmt, "-c:v", enc, "-f", "null", "-",
            ])
            .output();
        if let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(15), ok).await {
            if o.status.success() {
                found.push(enc.to_string());
            }
        }
    }
    found
}

async fn hw_list(tools: &Tools) -> Vec<String> {
    HW.get_or_init(|| detect_hw(tools)).await.clone()
}

#[tauri::command]
pub async fn hw_encoders(app: AppHandle) -> Result<Vec<String>, AppError> {
    let tools = tools::resolve(&app)?;
    Ok(hw_list(&tools).await)
}

// ======================= الـ Presets =======================

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PKind {
    /// فيديو (+ صوت)
    Video,
    /// صوت فقط
    Audio,
    /// إطار واحد كصورة
    Frame,
    /// سلسلة صور
    Sequence,
    Gif,
    /// نسخ بلا إعادة ترميز (تغيير الحاوية / قص سريع)
    Copy,
    /// كشف (مشاهد / سواد / صمت) بلا ملف ناتج
    Detect,
}

#[derive(Debug, Clone, Copy)]
pub struct Preset {
    pub id: &'static str,
    pub kind: PKind,
    pub ext: &'static str,
    pub suffix: &'static str,
}

const PRESETS: &[Preset] = &[
    // للمونتاج
    Preset { id: "edit_h264", kind: PKind::Video, ext: "mp4", suffix: "edit" },
    Preset { id: "prores_proxy", kind: PKind::Video, ext: "mov", suffix: "ProRes Proxy" },
    Preset { id: "prores_lt", kind: PKind::Video, ext: "mov", suffix: "ProRes LT" },
    Preset { id: "prores_422", kind: PKind::Video, ext: "mov", suffix: "ProRes 422" },
    Preset { id: "prores_hq", kind: PKind::Video, ext: "mov", suffix: "ProRes HQ" },
    Preset { id: "prores_4444", kind: PKind::Video, ext: "mov", suffix: "ProRes 4444" },
    Preset { id: "dnxhr_lb", kind: PKind::Video, ext: "mov", suffix: "DNxHR LB" },
    Preset { id: "dnxhr_sq", kind: PKind::Video, ext: "mov", suffix: "DNxHR SQ" },
    Preset { id: "dnxhr_hq", kind: PKind::Video, ext: "mov", suffix: "DNxHR HQ" },
    Preset { id: "dnxhr_hqx", kind: PKind::Video, ext: "mov", suffix: "DNxHR HQX" },
    Preset { id: "proxy", kind: PKind::Video, ext: "mp4", suffix: "proxy" },
    // للنشر
    Preset { id: "youtube", kind: PKind::Video, ext: "mp4", suffix: "YouTube" },
    Preset { id: "vertical", kind: PKind::Video, ext: "mp4", suffix: "vertical" },
    Preset { id: "whatsapp", kind: PKind::Video, ext: "mp4", suffix: "small" },
    Preset { id: "h265", kind: PKind::Video, ext: "mp4", suffix: "H265" },
    Preset { id: "av1", kind: PKind::Video, ext: "mp4", suffix: "AV1" },
    Preset { id: "webm", kind: PKind::Video, ext: "webm", suffix: "VP9" },
    Preset { id: "gif", kind: PKind::Gif, ext: "gif", suffix: "gif" },
    // صوت
    Preset { id: "wav", kind: PKind::Audio, ext: "wav", suffix: "audio" },
    Preset { id: "mp3", kind: PKind::Audio, ext: "mp3", suffix: "audio" },
    Preset { id: "aac", kind: PKind::Audio, ext: "m4a", suffix: "audio" },
    Preset { id: "flac", kind: PKind::Audio, ext: "flac", suffix: "audio" },
    Preset { id: "opus", kind: PKind::Audio, ext: "opus", suffix: "audio" },
    // أدوات
    Preset { id: "rewrap_mp4", kind: PKind::Copy, ext: "mp4", suffix: "rewrap" },
    Preset { id: "rewrap_mov", kind: PKind::Copy, ext: "mov", suffix: "rewrap" },
    Preset { id: "rewrap_mkv", kind: PKind::Copy, ext: "mkv", suffix: "rewrap" },
    Preset { id: "frame_png", kind: PKind::Frame, ext: "png", suffix: "frame" },
    Preset { id: "sequence_png", kind: PKind::Sequence, ext: "png", suffix: "frames" },
    Preset { id: "detect_scenes", kind: PKind::Detect, ext: "", suffix: "" },
    Preset { id: "detect_black", kind: PKind::Detect, ext: "", suffix: "" },
    Preset { id: "detect_silence", kind: PKind::Detect, ext: "", suffix: "" },
];

pub fn preset(id: &str) -> Option<Preset> {
    PRESETS.iter().copied().find(|p| p.id == id)
}

// ======================= الطلب =======================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConvertOptions {
    /// "high" | "balanced" | "small"
    pub quality: String,
    /// استخدم كرت الشاشة إن توفر (H.264 / H.265)
    pub hw: bool,
    /// الضلع القصير للصورة: 2160 | 1440 | 1080 | 720 | 540 | 480
    pub size: Option<u32>,
    /// قص لنسبة: "9:16" | "1:1" | "4:5" | "16:9"
    pub aspect: Option<String>,
    /// "23.976" | "24" | "25" | "29.97" | "30" | "50" | "59.94" | "60"
    pub fps: Option<String>,
    /// سرعة التشغيل 0.25–4
    pub speed: Option<f64>,
    /// "90" | "180" | "270" | "hflip" | "vflip"
    pub rotate: Option<String>,
    pub deinterlace: bool,
    pub denoise: bool,
    /// HDR ← SDR
    pub tonemap: bool,
    pub lut: Option<String>,
    pub subtitles: Option<String>,
    pub watermark: Option<String>,
    /// "tl" | "tr" | "bl" | "br" | "c"
    pub watermark_pos: Option<String>,
    pub timecode: bool,
    /// LUFS: -14 (يوتيوب/سوشال) | -16 | -23 (بث)
    pub loudness: Option<f64>,
    pub replace_audio: Option<String>,
    pub mute: bool,
    pub start: Option<f64>,
    pub end: Option<f64>,
    /// تقسيم الناتج عند هذه الأوقات (بالثواني)
    pub split_at: Vec<f64>,
    /// مجلد ناتج محدد (مثلًا من مجلد مراقَب). فارغ = حسب الإعدادات
    pub out_dir: Option<String>,
}

impl Default for ConvertOptions {
    fn default() -> Self {
        Self {
            quality: "balanced".into(),
            hw: false,
            size: None,
            aspect: None,
            fps: None,
            speed: None,
            rotate: None,
            deinterlace: false,
            denoise: false,
            tonemap: false,
            lut: None,
            subtitles: None,
            watermark: None,
            watermark_pos: None,
            timecode: false,
            loudness: None,
            replace_audio: None,
            mute: false,
            start: None,
            end: None,
            split_at: Vec::new(),
            out_dir: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    /// أكثر من ملف = دمجها بالترتيب في ملف واحد
    pub inputs: Vec<String>,
    pub preset: String,
    #[serde(default)]
    pub options: ConvertOptions,
}

// ======================= بناء الأوامر =======================

fn even(v: f64) -> u32 {
    ((v / 2.0).round() as u32).max(1) * 2
}

fn parse_aspect(a: &str) -> Option<f64> {
    let (x, y) = a.split_once(':')?;
    let (x, y) = (num(x)?, num(y)?);
    (x > 0.0 && y > 0.0).then(|| x / y)
}

fn fps_expr(f: &str) -> Option<&'static str> {
    Some(match f {
        "23.976" => "24000/1001",
        "24" => "24",
        "25" => "25",
        "29.97" => "30000/1001",
        "30" => "30",
        "50" => "50",
        "59.94" => "60000/1001",
        "60" => "60",
        _ => return None,
    })
}

/// atempo يقبل 0.5–2 فقط، فنركّب أكثر من واحد للسرعات الأبعد
fn atempo_chain(speed: f64) -> Vec<String> {
    let mut v = Vec::new();
    let mut s = speed;
    while s > 2.0 {
        v.push("atempo=2".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        v.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 1e-3 {
        v.push(format!("atempo={s:.4}"));
    }
    v
}

/// مسار خط للتايم كود المحروق (خط بعرض ثابت من النظام)
fn timecode_font() -> Option<String> {
    let candidates: &[&str] = if cfg!(windows) {
        &["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf", "C:/Windows/Fonts/arial.ttf"]
    } else if cfg!(target_os = "macos") {
        &["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf", "/Library/Fonts/Arial.ttf"]
    } else {
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
            "/usr/share/fonts/liberation/LiberationMono-Regular.ttf",
        ]
    };
    candidates.iter().find(|p| Path::new(p).exists()).map(|p| p.replace(':', "\\:"))
}

/// مقاس الصورة بعد كل الفلاتر: نحتاجه لتحجيم العلامة المائية والتحقق من الأبعاد
pub fn output_dims(w: u32, h: u32, o: &ConvertOptions, default_short: Option<u32>) -> (u32, u32) {
    let (mut w, mut h) = (w as f64, h as f64);
    if let Some(r) = o.aspect.as_deref().and_then(parse_aspect) {
        if w / h > r {
            w = h * r;
        } else {
            h = w / r;
        }
    }
    if matches!(o.rotate.as_deref(), Some("90" | "270")) {
        std::mem::swap(&mut w, &mut h);
    }
    if let Some(short) = o.size.or(default_short) {
        let cur = w.min(h);
        // نصغّر فقط: لا نكبّر صورة صغيرة بلا فائدة إلا إن طلب المستخدم مقاسًا صراحة
        if o.size.is_some() || (short as f64) < cur {
            let k = short as f64 / cur;
            w *= k;
            h *= k;
        }
    }
    (even(w), even(h))
}

/// إعدادات المشفّر لكل Preset
fn codec_args(p: &Preset, o: &ConvertOptions, hw: &[String], src: Option<&VideoInfo>) -> Vec<String> {
    let q = o.quality.as_str();
    let pick = |high: u32, bal: u32, small: u32| match q {
        "high" => high,
        "small" => small,
        _ => bal,
    };
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();

    // H.264 / H.265 بالمعالج أو بكرت الشاشة
    let avc_hevc = |family: &str, crf: u32| -> Vec<String> {
        let hw_enc = o.hw.then(|| hw.iter().find(|e| e.starts_with(&format!("{family}_")))).flatten();
        let mut a: Vec<String> = match hw_enc.map(String::as_str) {
            Some(e) if e.ends_with("_nvenc") => {
                s(&["-c:v", e, "-preset", "p5", "-rc", "vbr", "-cq", &(crf + 1).to_string(), "-b:v", "0", "-pix_fmt", "yuv420p"])
            }
            Some(e) if e.ends_with("_qsv") => {
                s(&["-c:v", e, "-preset", "medium", "-global_quality", &(crf + 1).to_string(), "-pix_fmt", "nv12"])
            }
            Some(e) if e.ends_with("_amf") => {
                let qp = (crf + 1).to_string();
                s(&["-c:v", e, "-rc", "cqp", "-qp_i", &qp, "-qp_p", &qp, "-qp_b", &qp, "-pix_fmt", "yuv420p"])
            }
            Some(e) if e.ends_with("_videotoolbox") => {
                // مقياس جودة VideoToolbox من 1 إلى 100
                let vq = 100 - (crf * 2).min(90);
                s(&["-c:v", e, "-q:v", &vq.to_string(), "-pix_fmt", "yuv420p"])
            }
            _ if family == "hevc" => s(&["-c:v", "libx265", "-preset", "fast", "-crf", &crf.to_string(), "-pix_fmt", "yuv420p"]),
            _ => s(&["-c:v", "libx264", "-preset", "fast", "-crf", &crf.to_string(), "-pix_fmt", "yuv420p"]),
        };
        if family == "hevc" {
            // hvc1 = حتى تفتحه أجهزة Apple
            a.extend(s(&["-tag:v", "hvc1"]));
        } else if hw_enc.is_none() {
            a.extend(s(&["-profile:v", "high"]));
        }
        a
    };
    let aac = |k: u32| s(&["-c:a", "aac", "-b:a", &format!("{k}k")]);
    let pcm = || s(&["-c:a", "pcm_s16le"]);
    let _ = src;

    let mut a = match p.id {
        "edit_h264" => [avc_hevc("h264", pick(16, 18, 22)), aac(320)].concat(),
        "proxy" => [avc_hevc("h264", 26), aac(160), s(&["-g", "12"])].concat(),
        "youtube" => [avc_hevc("h264", pick(16, 18, 21)), aac(320)].concat(),
        "vertical" => [avc_hevc("h264", pick(17, 19, 23)), aac(256)].concat(),
        "whatsapp" => [avc_hevc("h264", pick(23, 26, 30)), aac(128)].concat(),
        "h265" => [avc_hevc("hevc", pick(19, 23, 28)), aac(256)].concat(),
        "av1" => [
            s(&["-c:v", "libsvtav1", "-preset", "8", "-crf", &pick(24, 32, 40).to_string(), "-pix_fmt", "yuv420p"]),
            aac(256),
        ]
        .concat(),
        "webm" => s(&[
            "-c:v", "libvpx-vp9", "-crf", &pick(24, 32, 40).to_string(), "-b:v", "0", "-row-mt", "1", "-deadline", "good",
            "-cpu-used", "4", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "160k",
        ]),
        id if id.starts_with("prores_") => {
            let (profile, pix) = match id {
                "prores_proxy" => ("0", "yuv422p10le"),
                "prores_lt" => ("1", "yuv422p10le"),
                "prores_422" => ("2", "yuv422p10le"),
                "prores_hq" => ("3", "yuv422p10le"),
                _ => ("4", "yuva444p10le"),
            };
            [s(&["-c:v", "prores_ks", "-profile:v", profile, "-vendor", "apl0", "-pix_fmt", pix]), pcm()].concat()
        }
        id if id.starts_with("dnxhr_") => {
            let profile = &id[..];
            // HQX هو الوحيد بـ 10-bit
            let pix = if id == "dnxhr_hqx" { "yuv422p10le" } else { "yuv422p" };
            [s(&["-c:v", "dnxhd", "-profile:v", profile, "-pix_fmt", pix]), pcm()].concat()
        }
        "wav" => s(&["-c:a", "pcm_s16le"]),
        "mp3" => s(&["-c:a", "libmp3lame", "-b:a", &format!("{}k", pick(320, 256, 160))]),
        "aac" => s(&["-c:a", "aac", "-b:a", &format!("{}k", pick(320, 256, 160))]),
        "flac" => s(&["-c:a", "flac"]),
        "opus" => s(&["-c:a", "libopus", "-b:a", &format!("{}k", pick(192, 128, 96))]),
        _ => vec![],
    };
    if p.kind == PKind::Video && p.id != "webm" {
        a.extend(s(&["-movflags", "+faststart+write_colr"]));
    }
    a
}

/// مقاس افتراضي لبعض الـ Presets (الضلع القصير)
fn default_short(p: &Preset) -> Option<u32> {
    match p.id {
        "proxy" => Some(540),
        "whatsapp" => Some(720),
        "vertical" => Some(1080),
        "gif" => Some(360),
        _ => None,
    }
}

/// سلسلة فلاتر الصورة قبل العلامة المائية
/// keep_ts: القص تم مع الحفاظ على التوقيت الأصلي (-copyts) حتى تتطابق الترجمة والتايم كود،
/// فنعيد التوقيت للصفر بعدهما
fn video_filters(p: &Preset, o: &ConvertOptions, v: &VideoInfo, keep_ts: bool) -> Vec<String> {
    let mut f = Vec::new();
    if o.deinterlace || v.interlaced {
        f.push("bwdif=mode=send_frame:deint=interlaced".to_string());
    }
    if o.tonemap && v.hdr {
        f.push(
            "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv"
                .to_string(),
        );
    }
    if o.lut.is_some() {
        // نسخنا ملف LUT إلى مجلد العمل باسم بسيط، فلا نحتاج تهريب المسار
        f.push("lut3d=file=lut.cube:interp=tetrahedral".to_string());
    }
    if o.denoise {
        f.push("hqdn3d=2:1.5:3:3".to_string());
    }
    let aspect = o.aspect.as_deref().and_then(parse_aspect);
    if let Some(r) = aspect {
        let (w, h) = (v.width as f64, v.height as f64);
        let (cw, ch) = if w / h > r { (h * r, h) } else { (w, w / r) };
        f.push(format!("crop={}:{}", even(cw.min(w)), even(ch.min(h))));
    }
    match o.rotate.as_deref() {
        Some("90") => f.push("transpose=1".into()),
        Some("270") => f.push("transpose=2".into()),
        Some("180") => f.push("hflip,vflip".into()),
        Some("hflip") => f.push("hflip".into()),
        Some("vflip") => f.push("vflip".into()),
        _ => {}
    }
    let (ow, oh) = output_dims(v.width, v.height, o, default_short(p));
    let (cw, ch) = output_dims(
        v.width,
        v.height,
        &ConvertOptions { size: None, ..o.clone() },
        None,
    );
    if (ow, oh) != (cw, ch) || ow % 2 == 1 || oh % 2 == 1 || v.width % 2 == 1 || v.height % 2 == 1 {
        f.push(format!("scale={ow}:{oh}:flags=lanczos"));
    }
    // الترجمة والتايم كود قبل تغيير السرعة: يتبعان توقيت المصدر
    if o.subtitles.is_some() {
        let ext = o.subtitles.as_deref().map(sub_ext).unwrap_or("srt");
        f.push(format!("subtitles=sub.{ext}"));
    }
    if o.timecode {
        f.push(timecode_filter());
    }
    if keep_ts {
        f.push("setpts=PTS-STARTPTS".into());
    }
    if let Some(r) = o.fps.as_deref().and_then(fps_expr) {
        f.push(format!("fps={r}"));
    }
    if let Some(sp) = o.speed.filter(|s| (*s - 1.0).abs() > 1e-3) {
        f.push(format!("setpts=PTS/{sp:.4}"));
    }
    f
}

fn sub_ext(path: &str) -> &'static str {
    let l = path.to_lowercase();
    if l.ends_with(".ass") || l.ends_with(".ssa") { "ass" } else if l.ends_with(".vtt") { "vtt" } else { "srt" }
}

fn overlay_pos(pos: Option<&str>) -> &'static str {
    match pos.unwrap_or("br") {
        "tl" => "x=W*0.03:y=H*0.03",
        "tr" => "x=W-w-W*0.03:y=H*0.03",
        "bl" => "x=W*0.03:y=H-h-H*0.03",
        "c" => "x=(W-w)/2:y=(H-h)/2",
        _ => "x=W-w-W*0.03:y=H-h-H*0.03",
    }
}

fn timecode_filter() -> String {
    let font = match timecode_font() {
        Some(f) => format!("fontfile='{f}'"),
        None => "font=monospace".to_string(),
    };
    format!(
        "drawtext={font}:text='%{{pts\\:hms}}':x=(w-tw)/2:y=h*0.04:fontsize=h*0.045:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10"
    )
}

/// صيغة البكسل التي يحتاجها المشفّر في آخر السلسلة (حتى لا يختار FFmpeg شيئًا غريبًا)
fn final_pix(args: &[String]) -> Option<String> {
    args.windows(2).find(|w| w[0] == "-pix_fmt").map(|w| w[1].clone())
}

/// الأمر الكامل لتحويل ملف (أو دمج عدة ملفات) — بدون ffmpeg نفسه
pub struct Plan {
    pub args: Vec<String>,
    /// مدة الناتج المتوقعة بالثواني (لحساب النسبة)
    pub duration: f64,
}

pub fn build_plan(
    p: &Preset,
    o: &ConvertOptions,
    infos: &[MediaInfo],
    hw: &[String],
    output: &Path,
    loudnorm: Option<&str>,
) -> Result<Plan, AppError> {
    let first = infos.first().ok_or_else(|| AppError::new("badInput"))?;
    let merging = infos.len() > 1;
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();

    let needs_video = matches!(p.kind, PKind::Video | PKind::Gif | PKind::Frame | PKind::Sequence);
    if needs_video && first.video.is_none() {
        return Err(AppError::new("noVideoStream"));
    }
    if p.kind == PKind::Audio && first.audio.is_empty() && o.replace_audio.is_none() {
        return Err(AppError::new("noAudioStream"));
    }

    let start = o.start.filter(|v| *v > 0.0);
    let end = o.end.filter(|e| *e > start.unwrap_or(0.0));
    let total: f64 = infos.iter().map(|i| i.duration.unwrap_or(0.0)).sum();
    let speed = o.speed.filter(|s| *s > 0.0).unwrap_or(1.0);
    let span = end.unwrap_or(total) - start.unwrap_or(0.0);
    let duration = (span / if p.kind == PKind::Copy { 1.0 } else { speed }).max(0.0);

    // الترجمة المحروقة والتايم كود يحتاجان التوقيت الأصلي بعد القص
    let keep_ts = !merging && start.is_some() && (o.subtitles.is_some() || o.timecode) && p.kind != PKind::Copy;
    let mut a = s(&["-hide_banner", "-nostdin", "-y"]);
    if keep_ts {
        a.push("-copyts".into());
    }

    // ---- المدخلات ----
    for info in infos {
        if !merging {
            if let Some(st) = start {
                a.extend(["-ss".into(), format!("{st:.3}")]);
            }
            if let Some(e) = end {
                a.extend(["-to".into(), format!("{e:.3}")]);
            }
        }
        a.extend(["-i".into(), info.path.clone()]);
    }
    let mut next_input = infos.len();
    let replace_idx = o.replace_audio.as_ref().map(|path| {
        a.extend(["-i".into(), path.clone()]);
        next_input += 1;
        next_input - 1
    });
    let wm_idx = (p.kind == PKind::Video).then_some(()).and(o.watermark.as_ref()).map(|path| {
        a.extend(["-i".into(), path.clone()]);
        next_input += 1;
        next_input - 1
    });
    // ملفات بلا صوت داخل الدمج: نولّد صمتًا بنفس المدة
    let mut silent_idx = vec![None; infos.len()];
    if merging && !o.mute && replace_idx.is_none() {
        for (i, info) in infos.iter().enumerate() {
            if info.audio.is_empty() {
                a.extend(s(&["-f", "lavfi", "-t", &format!("{:.3}", info.duration.unwrap_or(1.0)), "-i", "anullsrc=r=48000:cl=stereo"]));
                silent_idx[i] = Some(next_input);
                next_input += 1;
            }
        }
    }
    // في الدمج: القص على الناتج (توقيته بعد تغيير السرعة)
    if merging {
        let k = if p.kind == PKind::Copy { 1.0 } else { speed };
        if let Some(st) = start {
            a.extend(["-ss".into(), format!("{:.3}", st / k)]);
        }
        if let Some(e) = end {
            a.extend(["-to".into(), format!("{:.3}", e / k)]);
        }
    }

    // ---- نسخ بلا ترميز ----
    if p.kind == PKind::Copy {
        if merging {
            return Err(AppError::new("mergeCopy"));
        }
        a.extend(s(&["-map", "0:v?", "-map", "0:a?", "-c", "copy", "-avoid_negative_ts", "make_zero"]));
        if o.mute {
            a.push("-an".into());
        }
        if p.ext != "mkv" {
            a.extend(s(&["-movflags", "+faststart"]));
        }
        push_split(&mut a, o, false);
        a.extend(s(&["-progress", "pipe:1", "-nostats"]));
        a.push(output.to_string_lossy().into_owned());
        return Ok(Plan { args: a, duration: span.max(0.0) });
    }

    let codec = codec_args(p, o, hw, first.video.as_ref());
    let mut graph: Vec<String> = Vec::new();
    let mut vlabel: Option<String> = None;
    let mut alabel: Option<String> = None;

    // ---- الدمج: توحيد المقاس والمعدل والصوت ثم concat ----
    if merging {
        let v0 = first.video.as_ref();
        let (tw, th) = v0.map(|v| (even(v.width as f64), even(v.height as f64))).unwrap_or((1920, 1080));
        let fps = v0.and_then(|v| v.fps).unwrap_or(30.0);
        let mut pads = String::new();
        let with_audio = !o.mute && replace_idx.is_none();
        for (i, info) in infos.iter().enumerate() {
            if needs_video {
                if info.video.is_none() {
                    return Err(AppError::with_param("noVideoStream", info.name.clone(), info.path.clone()));
                }
                graph.push(format!(
                    "[{i}:v:0]scale={tw}:{th}:force_original_aspect_ratio=decrease,pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps:.5},format=yuv420p[mv{i}]"
                ));
                pads.push_str(&format!("[mv{i}]"));
            }
            if with_audio {
                let src = silent_idx[i].map(|k| format!("[{k}:a]")).unwrap_or_else(|| format!("[{i}:a:0]"));
                graph.push(format!("{src}aresample=48000,aformat=channel_layouts=stereo[ma{i}]"));
                pads.push_str(&format!("[ma{i}]"));
            }
        }
        let vflag = if needs_video { 1 } else { 0 };
        let aflag = if with_audio { 1 } else { 0 };
        let mut outs = String::new();
        if needs_video {
            outs.push_str("[cv]");
            vlabel = Some("cv".into());
        }
        if with_audio {
            outs.push_str("[ca]");
            alabel = Some("ca".into());
        }
        graph.push(format!("{pads}concat=n={}:v={vflag}:a={aflag}{outs}", infos.len()));
    }

    // ---- فلاتر الصورة ----
    if needs_video {
        let v = first.video.as_ref().expect("checked");
        // بعد الدمج صارت كل المقاطع بمقاس المقطع الأول
        let mut chain = video_filters(p, o, v, keep_ts);
        let src = vlabel.clone().map(|l| format!("[{l}]")).unwrap_or_else(|| "[0:v:0]".into());
        let (ow, _oh) = output_dims(v.width, v.height, o, default_short(p));
        match p.kind {
            PKind::Gif => {
                let fps = o.fps.as_deref().and_then(fps_expr).unwrap_or("15");
                chain.retain(|f| !f.starts_with("fps="));
                chain.push(format!("fps={fps}"));
                let pre = chain.join(",");
                graph.push(format!(
                    "{src}{pre},split[g1][g2];[g1]palettegen=stats_mode=diff[pal];[g2][pal]paletteuse=dither=sierra2_4a[vout]"
                ));
            }
            _ => {
                let mut post: Vec<String> = Vec::new();
                if let Some(pix) = final_pix(&codec) {
                    post.push(format!("format={pix}"));
                }
                let pre = if chain.is_empty() { "null".to_string() } else { chain.join(",") };
                if let Some(wi) = wm_idx {
                    let ww = even(ow as f64 * 0.16);
                    let pos = overlay_pos(o.watermark_pos.as_deref());
                    let post = if post.is_empty() { "null".to_string() } else { post.join(",") };
                    graph.push(format!(
                        "{src}{pre}[base];[{wi}:v]scale={ww}:-1,format=rgba,colorchannelmixer=aa=0.9[wm];[base][wm]overlay={pos}:format=auto,{post}[vout]"
                    ));
                } else {
                    let all: Vec<String> = std::iter::once(pre).chain(post).collect();
                    graph.push(format!("{src}{}[vout]", all.join(",")));
                }
            }
        }
        vlabel = Some("vout".into());
    }

    // ---- فلاتر الصوت ----
    let wants_audio = matches!(p.kind, PKind::Video | PKind::Audio) && !o.mute;
    if wants_audio {
        let src = if let Some(r) = replace_idx {
            Some(format!("[{r}:a:0]"))
        } else if let Some(l) = &alabel {
            Some(format!("[{l}]"))
        } else if !first.audio.is_empty() {
            Some("[0:a:0]".to_string())
        } else {
            None
        };
        if let Some(src) = src {
            let mut af: Vec<String> = Vec::new();
            if keep_ts && replace_idx.is_none() {
                af.push("asetpts=PTS-STARTPTS".into());
            }
            if let Some(sp) = o.speed.filter(|s| (*s - 1.0).abs() > 1e-3) {
                af.extend(atempo_chain(sp));
            }
            if let Some(ln) = loudnorm {
                af.push(ln.to_string());
                // loudnorm يرفع معدل العينة لـ 192kHz داخليًا؛ نرجعه لمعدل المونتاج
                af.push("aresample=48000".to_string());
            }
            if af.is_empty() {
                af.push("anull".into());
            }
            graph.push(format!("{src}{}[aout]", af.join(",")));
            alabel = Some("aout".into());
        } else {
            alabel = None;
        }
    } else {
        alabel = None;
    }

    if !graph.is_empty() {
        a.extend(["-filter_complex".into(), graph.join(";")]);
    }
    if let Some(v) = &vlabel {
        a.extend(["-map".into(), format!("[{v}]")]);
    }
    if let Some(al) = &alabel {
        a.extend(["-map".into(), format!("[{al}]")]);
    }
    if replace_idx.is_some() {
        a.push("-shortest".into());
    }

    match p.kind {
        PKind::Video => {
            a.extend(codec);
            a.extend(s(&["-fps_mode", "cfr"]));
            if alabel.is_none() {
                a.push("-an".into());
            }
        }
        PKind::Audio => {
            a.extend(codec);
            a.push("-vn".into());
        }
        PKind::Gif => a.extend(s(&["-loop", "0"])),
        PKind::Frame => a.extend(s(&["-frames:v", "1", "-update", "1"])),
        PKind::Sequence => a.extend(s(&["-start_number", "1"])),
        _ => {}
    }
    push_split(&mut a, o, true);
    a.extend(s(&["-progress", "pipe:1", "-nostats"]));
    a.push(output.to_string_lossy().into_owned());
    let duration = if p.kind == PKind::Frame { 0.0 } else { duration };
    Ok(Plan { args: a, duration })
}

/// التقسيم عند أوقات محددة (مثلًا عند المشاهد المكتشفة)
fn push_split(a: &mut Vec<String>, o: &ConvertOptions, reencode: bool) {
    let mut times: Vec<f64> = o.split_at.iter().copied().filter(|t| t.is_finite() && *t > 0.0).collect();
    if times.is_empty() {
        return;
    }
    times.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let st = o.start.unwrap_or(0.0);
    let list = times
        .iter()
        .map(|t| format!("{:.3}", (t - st).max(0.0)))
        .collect::<Vec<_>>()
        .join(",");
    if reencode {
        // إطار مفتاحي عند كل نقطة قص = قص دقيق
        a.extend(["-force_key_frames".into(), list.clone()]);
    }
    a.extend([
        "-f".into(),
        "segment".into(),
        "-segment_times".into(),
        list,
        "-reset_timestamps".into(),
        "1".into(),
    ]);
}

// ======================= الكشف (مشاهد، سواد، صمت) =======================

pub fn detect_args(kind: &str, input: &str, o: &ConvertOptions) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin"].iter().map(|s| s.to_string()).collect();
    if let Some(st) = o.start.filter(|v| *v > 0.0) {
        a.extend(["-ss".into(), format!("{st:.3}")]);
    }
    if let Some(e) = o.end {
        a.extend(["-to".into(), format!("{e:.3}")]);
    }
    a.extend(["-copyts".into(), "-i".into(), input.to_string()]);
    match kind {
        "detect_silence" => a.extend(
            ["-map", "0:a:0", "-af", "silencedetect=n=-40dB:d=0.6"].iter().map(|s| s.to_string()),
        ),
        "detect_black" => a.extend(
            ["-map", "0:v:0", "-vf", "blackdetect=d=0.3:pix_th=0.10"].iter().map(|s| s.to_string()),
        ),
        // تصغير الصورة قبل التحليل = أسرع بكثير وبنفس الدقة تقريبًا
        _ => a.extend(
            ["-map", "0:v:0", "-vf", "scale=320:-2,select='gt(scene,0.32)',showinfo"].iter().map(|s| s.to_string()),
        ),
    }
    a.extend(["-progress", "pipe:1", "-nostats", "-f", "null", "-"].iter().map(|s| s.to_string()));
    a
}

fn field_after(line: &str, key: &str) -> Option<f64> {
    let i = line.find(key)? + key.len();
    let rest = line[i..].trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(rest.len());
    num(&rest[..end])
}

/// يقرأ نتائج الكشف من مخرجات FFmpeg (stderr)
pub fn parse_markers(kind: &str, log: &str) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    match kind {
        "detect_black" => {
            for l in log.lines().filter(|l| l.contains("black_start")) {
                if let (Some(s), Some(e)) = (field_after(l, "black_start:"), field_after(l, "black_end:")) {
                    out.push([s, e]);
                }
            }
        }
        "detect_silence" => {
            let mut open: Option<f64> = None;
            for l in log.lines() {
                if let Some(s) = field_after(l, "silence_start:") {
                    open = Some(s);
                } else if let Some(e) = field_after(l, "silence_end:") {
                    out.push([open.take().unwrap_or(e).max(0.0), e]);
                }
            }
        }
        _ => {
            for l in log.lines().filter(|l| l.contains("Parsed_showinfo") && l.contains("pts_time:")) {
                if let Some(t) = field_after(l, "pts_time:") {
                    out.push([t, t]);
                }
            }
        }
    }
    out
}

// ======================= تشغيل التحويل =======================

/// الـ JSON الذي يطبعه loudnorm في المرور الأول
fn parse_loudnorm(stderr: &str) -> Option<String> {
    let start = stderr.rfind('{')?;
    let end = stderr[start..].find('}')? + start + 1;
    let j: Value = serde_json::from_str(&stderr[start..end]).ok()?;
    let g = |k: &str| j[k].as_str().and_then(num);
    Some(format!(
        "measured_I={:.2}:measured_TP={:.2}:measured_LRA={:.2}:measured_thresh={:.2}:offset={:.2}",
        g("input_i")?,
        g("input_tp")?,
        g("input_lra")?,
        g("input_thresh")?,
        g("target_offset")?
    ))
}

fn output_dir_for(app: &AppHandle, o: &ConvertOptions, input: &Path) -> Result<PathBuf, AppError> {
    if let Some(d) = &o.out_dir {
        return Ok(PathBuf::from(d));
    }
    let s = app.state::<SettingsState>().0.lock().unwrap().clone();
    if s.convert_dest == "output" {
        settings::resolve_output_dir(app, &s)
    } else {
        Ok(input.parent().map(Path::to_path_buf).unwrap_or_default())
    }
}

/// يشغّل ffmpeg ويرسل النسبة والوقت المتبقي
async fn run_ffmpeg(
    app: &AppHandle,
    id: u64,
    tools: &Tools,
    args: &[String],
    cwd: &Path,
    duration: f64,
    state: &'static str,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<String>, AppError> {
    let mut cmd = tools::command(&tools.ffmpeg);
    cmd.args(args).current_dir(cwd);
    let mut last = Instant::now() - Duration::from_secs(1);
    let mut speed: Option<f64> = None;
    let outcome = run_streaming(cmd, cancel, |line| {
        if let Some(v) = line.strip_prefix("speed=") {
            speed = num(v.trim().trim_end_matches('x')).filter(|s| *s > 0.0);
        } else if let Some(us) = line.strip_prefix("out_time_us=").and_then(num) {
            if duration > 0.0 && last.elapsed() >= Duration::from_millis(250) {
                last = Instant::now();
                let done = (us / 1e6).max(0.0);
                emit(app, JobUpdate {
                    id,
                    state,
                    percent: Some((done / duration * 100.0).clamp(0.0, 100.0)),
                    eta: speed.map(|s| ((duration - done) / s).max(0.0)),
                    ..Default::default()
                });
            }
        }
    })
    .await?;
    match outcome {
        RunOutcome::Canceled => Ok(None),
        RunOutcome::Exited { success: true, stderr } => Ok(Some(stderr)),
        RunOutcome::Exited { stderr, .. } => Err(AppError::with_detail("encodeFailed", tail(&stderr, 14))),
    }
}

async fn run_convert(
    app: &AppHandle,
    id: u64,
    req: ConvertRequest,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<(PathBuf, Option<Vec<[f64; 2]>>)>, AppError> {
    let p = preset(&req.preset).ok_or_else(|| AppError::with_param("unknownPreset", req.preset.clone(), ""))?;
    let o = &req.options;
    if req.inputs.is_empty() {
        return Err(AppError::new("badInput"));
    }
    let tools = tools::resolve(app)?;

    emit(app, JobUpdate { id, state: "analyzing", ..Default::default() });
    let mut infos = Vec::new();
    for i in &req.inputs {
        infos.push(probe_file(&tools, Path::new(i)).await?);
    }
    let first_path = PathBuf::from(&infos[0].path);

    // مجلد عمل مؤقت: ملفات LUT والترجمة تُنسخ إليه بأسماء بسيطة
    let work = download::jobs_root(app)?.join(format!("c{id}"));
    std::fs::create_dir_all(&work)?;
    let copy_in = |src: &Option<String>, name: &str| -> Result<(), AppError> {
        if let Some(s) = src {
            std::fs::copy(s, work.join(name)).map_err(|e| AppError::with_detail("badInput", format!("{s}: {e}")))?;
        }
        Ok(())
    };
    copy_in(&o.lut, "lut.cube")?;
    if let Some(sub) = &o.subtitles {
        copy_in(&o.subtitles, &format!("sub.{}", sub_ext(sub)))?;
    }

    // ---- الكشف: لا ملف ناتج، فقط قائمة أوقات ----
    if p.kind == PKind::Detect {
        if p.id == "detect_silence" && infos[0].audio.is_empty() {
            return Err(AppError::new("noAudioStream"));
        }
        if p.id != "detect_silence" && infos[0].video.is_none() {
            return Err(AppError::new("noVideoStream"));
        }
        let args = detect_args(p.id, &infos[0].path, o);
        let dur = o.end.unwrap_or(infos[0].duration.unwrap_or(0.0)) - o.start.unwrap_or(0.0);
        let Some(log) = run_ffmpeg(app, id, &tools, &args, &work, dur, "analyzing", cancel).await? else {
            return Ok(None);
        };
        return Ok(Some((first_path, Some(parse_markers(p.id, &log)))));
    }

    let hw = if o.hw { hw_list(&tools).await } else { vec![] };

    // ---- توحيد الصوت: مرور أول للقياس ----
    let mut loudnorm = None;
    if let Some(target) = o.loudness.filter(|_| matches!(p.kind, PKind::Video | PKind::Audio) && !o.mute) {
        let base = format!("loudnorm=I={target:.1}:TP=-1.5:LRA=11");
        let mut measure = ConvertOptions { split_at: vec![], ..o.clone() };
        measure.subtitles = None;
        measure.timecode = false;
        let probe_plan = build_plan(
            &preset("wav").unwrap(),
            &measure,
            &infos,
            &[],
            Path::new("-"),
            Some(&format!("{base}:print_format=json")),
        )?;
        let mut args = probe_plan.args;
        // نستبدل الناتج بـ "لا شيء": نريد القياس فقط
        args.pop();
        args.extend(["-f", "null", "-"].iter().map(|s| s.to_string()));
        emit(app, JobUpdate { id, state: "analyzing", percent: Some(0.0), ..Default::default() });
        let Some(log) = run_ffmpeg(app, id, &tools, &args, &work, probe_plan.duration, "analyzing", cancel).await? else {
            return Ok(None);
        };
        let measured = parse_loudnorm(&log).ok_or_else(|| AppError::with_detail("loudnessFailed", tail(&log, 10)))?;
        loudnorm = Some(format!("{base}:{measured}:linear=true"));
    }

    // ---- مكان الناتج ----
    let dir = output_dir_for(app, o, &first_path)?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
    let stem = first_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let stem = if infos.len() > 1 { format!("{stem} merged") } else { stem };
    let folder_out = p.kind == PKind::Sequence || !o.split_at.is_empty();
    let final_name = if folder_out {
        format!("{stem} {}", if p.kind == PKind::Sequence { p.suffix } else { "parts" })
    } else {
        format!("{stem} [{}].{}", p.suffix, p.ext)
    };
    // نكتب باسم مخفي مؤقت في نفس المجلد، ثم نعيد التسمية (لحظية) عند النجاح
    let temp = dir.join(format!(".khama-{id}-part{}", if folder_out { String::new() } else { format!(".{}", p.ext) }));
    let target = if folder_out {
        std::fs::create_dir_all(&temp)?;
        let pattern = if p.kind == PKind::Sequence { format!("{stem}_%05d.{}", p.ext) } else { format!("{stem}_%03d.{}", p.ext) };
        temp.join(pattern)
    } else {
        temp.clone()
    };

    let plan = build_plan(&p, o, &infos, &hw, &target, loudnorm.as_deref())?;
    emit(app, JobUpdate { id, state: "converting", percent: Some(0.0), ..Default::default() });
    let result = run_ffmpeg(app, id, &tools, &plan.args, &work, plan.duration, "converting", cancel).await;
    let cleanup = || {
        if folder_out {
            let _ = std::fs::remove_dir_all(&temp);
        } else {
            let _ = std::fs::remove_file(&temp);
        }
    };
    match result {
        Ok(Some(_)) => {}
        Ok(None) => {
            cleanup();
            return Ok(None);
        }
        Err(e) => {
            cleanup();
            return Err(e);
        }
    }
    let dest = unique_path(&dir, &final_name);
    std::fs::rename(&temp, &dest).map_err(|e| AppError::with_detail("moveFailed", e.to_string()))?;
    Ok(Some((dest, None)))
}

#[tauri::command]
pub async fn start_convert(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    queue: State<'_, ConvertQueue>,
    request: ConvertRequest,
) -> Result<u64, AppError> {
    if preset(&request.preset).is_none() {
        return Err(AppError::with_param("unknownPreset", request.preset.clone(), ""));
    }
    let id = jobs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = watch::channel(false);
    jobs.cancels.lock().unwrap().insert(id, tx);
    let sem = queue.0.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        emit(&app2, JobUpdate { id, state: "queued", ..Default::default() });
        // ننتظر دورنا في الطابور، ويمكن الإلغاء أثناء الانتظار
        let permit = tokio::select! {
            p = sem.acquire_owned() => p.ok(),
            _ = download::canceled(&mut rx) => None,
        };
        let result = match permit {
            Some(_) => run_convert(&app2, id, request, &mut rx).await,
            None => Ok(None),
        };
        let update = match result {
            Ok(Some((path, markers))) => JobUpdate {
                id,
                state: "done",
                percent: Some(100.0),
                file: markers.is_none().then(|| path.to_string_lossy().into_owned()),
                markers,
                ..Default::default()
            },
            Ok(None) | Err(_) if *rx.borrow() => JobUpdate { id, state: "canceled", ..Default::default() },
            Ok(None) => JobUpdate { id, state: "canceled", ..Default::default() },
            Err(e) => JobUpdate { id, state: "error", error: Some(e), ..Default::default() },
        };
        if let Ok(root) = download::jobs_root(&app2) {
            let _ = tokio::fs::remove_dir_all(root.join(format!("c{id}"))).await;
        }
        app2.state::<Jobs>().cancels.lock().unwrap().remove(&id);
        emit(&app2, update);
    });
    Ok(id)
}

// ======================= اختبارات =======================

#[cfg(test)]
mod tests {
    use super::*;

    fn video(w: u32, h: u32) -> MediaInfo {
        MediaInfo {
            path: "in.mp4".into(),
            name: "in.mp4".into(),
            size: 1,
            duration: Some(60.0),
            container: "mov,mp4".into(),
            bitrate: None,
            video: Some(VideoInfo {
                codec: "h264".into(),
                profile: None,
                width: w,
                height: h,
                fps: Some(30.0),
                vfr: false,
                pix_fmt: "yuv420p".into(),
                bit_depth: 8,
                hdr: false,
                interlaced: false,
            }),
            audio: vec![AudioInfo { codec: "aac".into(), channels: 2, sample_rate: 48000 }],
            subtitles: 0,
            thumbnail: None,
            issues: vec![],
        }
    }

    fn joined(plan: &Plan) -> String {
        plan.args.join(" ")
    }

    #[test]
    fn vertical_crop_dims() {
        let o = ConvertOptions { aspect: Some("9:16".into()), ..Default::default() };
        assert_eq!(output_dims(1920, 1080, &o, Some(1080)), (608, 1080));
        let o = ConvertOptions { aspect: Some("9:16".into()), size: Some(1080), ..Default::default() };
        assert_eq!(output_dims(1920, 1080, &o, None), (1080, 1920));
    }

    #[test]
    fn prores_plan() {
        let p = preset("prores_hq").unwrap();
        let plan = build_plan(&p, &ConvertOptions::default(), &[video(1920, 1080)], &[], Path::new("o.mov"), None).unwrap();
        let s = joined(&plan);
        assert!(s.contains("-c:v prores_ks -profile:v 3"));
        assert!(s.contains("-c:a pcm_s16le"));
        assert!(s.contains("format=yuv422p10le"));
        assert_eq!(plan.duration, 60.0);
    }

    #[test]
    fn trim_and_speed() {
        let p = preset("edit_h264").unwrap();
        let o = ConvertOptions { start: Some(10.0), end: Some(30.0), speed: Some(2.0), ..Default::default() };
        let plan = build_plan(&p, &o, &[video(1920, 1080)], &[], Path::new("o.mp4"), None).unwrap();
        let s = joined(&plan);
        assert!(s.contains("-ss 10.000 -to 30.000 -i in.mp4"));
        assert!(s.contains("setpts=PTS/2.0000"));
        assert!(s.contains("atempo=2"));
        assert_eq!(plan.duration, 10.0);
    }

    #[test]
    fn hw_encoder_used_when_available() {
        let p = preset("edit_h264").unwrap();
        let o = ConvertOptions { hw: true, ..Default::default() };
        let plan = build_plan(&p, &o, &[video(1920, 1080)], &["h264_qsv".into()], Path::new("o.mp4"), None).unwrap();
        assert!(joined(&plan).contains("-c:v h264_qsv"));
    }

    #[test]
    fn audio_only_rejects_video_preset() {
        let mut m = video(1, 1);
        m.video = None;
        let p = preset("prores_422").unwrap();
        assert!(build_plan(&p, &ConvertOptions::default(), &[m], &[], Path::new("o"), None).is_err());
    }

    #[test]
    fn atempo_ranges() {
        // حاصل ضرب السرعات = المطلوب، وكل واحدة ضمن 0.5–2
        for want in [4.0, 0.25, 3.0, 0.3, 1.5] {
            let chain = atempo_chain(want);
            let prod: f64 = chain.iter().map(|a| a[7..].parse::<f64>().unwrap()).product();
            assert!((prod - want).abs() < 1e-3, "{want}: {chain:?}");
            assert!(chain.iter().all(|a| (0.5..=2.0).contains(&a[7..].parse::<f64>().unwrap())));
        }
        assert!(atempo_chain(1.0).is_empty());
    }

    #[test]
    fn markers() {
        let log = "[blackdetect @ 0x1] black_start:0 black_end:1.52 black_duration:1.52\n\
                   [silencedetect @ 0x2] silence_start: 3.5\n[silencedetect @ 0x2] silence_end: 4.75 | silence_duration: 1.25\n\
                   [Parsed_showinfo_2 @ 0x3] n:   0 pts:  12345 pts_time:4.115   duration:1";
        assert_eq!(parse_markers("detect_black", log), vec![[0.0, 1.52]]);
        assert_eq!(parse_markers("detect_silence", log), vec![[3.5, 4.75]]);
        assert_eq!(parse_markers("detect_scenes", log), vec![[4.115, 4.115]]);
    }

    #[test]
    fn loudnorm_json() {
        let err = "blah\n{\n\t\"input_i\" : \"-20.31\",\n\t\"input_tp\" : \"-3.10\",\n\t\"input_lra\" : \"6.20\",\n\t\"input_thresh\" : \"-30.62\",\n\t\"output_i\" : \"-14.1\",\n\t\"target_offset\" : \"0.12\"\n}\n";
        assert_eq!(
            parse_loudnorm(err).unwrap(),
            "measured_I=-20.31:measured_TP=-3.10:measured_LRA=6.20:measured_thresh=-30.62:offset=0.12"
        );
    }
}

/// اختبار حقيقي لكل Preset مع FFmpeg المضمّن (بطيء؛ يعمل يدويًا فقط):
/// KHAMA_SAMPLE=<فيديو قصير> cargo test -- --ignored presets_real
#[cfg(test)]
mod real {
    use super::*;
    use std::process::Command as Std;

    fn bin(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/ffmpeg/bin").join(format!("{name}{}", tools::EXE))
    }

    fn probe(path: &Path) -> MediaInfo {
        let o = Std::new(bin("ffprobe"))
            .args(["-v", "error", "-show_format", "-show_streams", "-of", "json"])
            .arg(path)
            .output()
            .unwrap();
        let j: Value = serde_json::from_slice(&o.stdout).unwrap();
        parse_probe(path, 1, &j)
    }

    #[test]
    #[ignore]
    fn presets_real() {
        let sample = PathBuf::from(std::env::var("KHAMA_SAMPLE").expect("KHAMA_SAMPLE"));
        let out = std::env::temp_dir().join("khama-presets");
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();
        // ملفات مساعدة: علامة مائية، LUT، ترجمة عربية
        Std::new(bin("ffmpeg"))
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red@0.8:s=400x200,format=rgba", "-frames:v", "1"])
            .arg(out.join("wm.png"))
            .status()
            .unwrap();
        let mut cube = String::from("LUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    cube.push_str(&format!("{} {} {}\n", r as f64 * 0.9, g as f64, b as f64 * 0.8));
                }
            }
        }
        std::fs::write(out.join("lut.cube"), cube).unwrap();
        std::fs::write(out.join("sub.srt"), "1\n00:00:01,000 --> 00:00:04,000\nمرحبا بالعالم — Hello\n").unwrap();

        let info = probe(&sample);
        let hw: Vec<String> = std::env::var("KHAMA_HW").map(|v| v.split(',').map(String::from).collect()).unwrap_or_default();
        let o = |f: &dyn Fn(&mut ConvertOptions)| {
            let mut x = ConvertOptions { start: Some(1.0), end: Some(6.0), ..Default::default() };
            f(&mut x);
            x
        };
        let cases: Vec<(&str, ConvertOptions)> = vec![
            ("edit_h264", o(&|_| {})),
            ("edit_h264", o(&|x| x.hw = true)),
            ("prores_proxy", o(&|_| {})),
            ("prores_hq", o(&|_| {})),
            ("prores_4444", o(&|_| {})),
            ("dnxhr_sq", o(&|_| {})),
            ("dnxhr_hqx", o(&|_| {})),
            ("proxy", o(&|_| {})),
            ("youtube", o(&|x| x.loudness = Some(-14.0))),
            ("vertical", o(&|x| x.aspect = Some("9:16".into()))),
            ("whatsapp", o(&|x| x.watermark = Some(out.join("wm.png").to_string_lossy().into()))),
            ("h265", o(&|x| x.fps = Some("25".into()))),
            ("h265", o(&|x| x.hw = true)),
            ("av1", o(&|x| x.size = Some(480))),
            ("webm", o(&|x| x.size = Some(480))),
            ("gif", o(&|_| {})),
            ("wav", o(&|_| {})),
            ("mp3", o(&|x| x.speed = Some(1.5))),
            ("aac", o(&|_| {})),
            ("flac", o(&|_| {})),
            ("opus", o(&|_| {})),
            ("rewrap_mov", o(&|_| {})),
            ("rewrap_mkv", o(&|x| x.split_at = vec![3.0, 4.5])),
            ("frame_png", o(&|_| {})),
            ("edit_h264", o(&|x| {
                x.lut = Some("lut.cube".into());
                x.subtitles = Some("sub.srt".into());
                x.timecode = true;
                x.denoise = true;
                x.rotate = Some("90".into());
                x.speed = Some(0.5);
            })),
            ("edit_h264", o(&|x| x.mute = true)),
        ];
        let mut failures = Vec::new();
        for (i, (id, opts)) in cases.iter().enumerate() {
            let p = preset(id).unwrap();
            let target = if opts.split_at.is_empty() {
                out.join(format!("{i:02}_{id}.{}", p.ext))
            } else {
                out.join(format!("{i:02}_{id}_%03d.{}", p.ext))
            };
            let plan = build_plan(&p, opts, &[info.clone()], &hw, &target, None).unwrap();
            let mut args = plan.args.clone();
            if let Some(t) = opts.loudness {
                // مرور القياس مختصر هنا: نستخدم loudnorm بمرور واحد
                let i = args.iter().position(|a| a == "anull").unwrap_or(0);
                if i > 0 {
                    args[i] = format!("loudnorm=I={t}");
                }
            }
            let t0 = Instant::now();
            let r = Std::new(bin("ffmpeg")).args(&args).current_dir(&out).output().unwrap();
            let ok = r.status.success();
            let what = if opts.split_at.is_empty() {
                let m = probe(&target);
                format!(
                    "{:?} {:?} dur={:?}",
                    m.video.as_ref().map(|v| format!("{} {}x{} {:?}fps {}", v.codec, v.width, v.height, v.fps.map(|f| (f * 100.0).round() / 100.0), v.pix_fmt)),
                    m.audio.first().map(|a| a.codec.clone()),
                    m.duration.map(|d| (d * 100.0).round() / 100.0)
                )
            } else {
                format!("{} parts", std::fs::read_dir(&out).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with(&format!("{i:02}_"))).count())
            };
            println!("{} {i:02} {id:<14} {:>5.1}s  {what}", if ok { "OK  " } else { "FAIL" }, t0.elapsed().as_secs_f64());
            if !ok {
                println!("     args: {}\n     {}", args.join(" "), tail(&String::from_utf8_lossy(&r.stderr), 6).replace('\n', "\n     "));
                failures.push(*id);
            }
        }
        assert!(failures.is_empty(), "failed: {failures:?}");
    }
}

// ======================= المجلدات المراقَبة =======================

const MEDIA_EXT: &[&str] = &[
    "mp4", "mov", "mkv", "avi", "mxf", "m4v", "webm", "mts", "m2ts", "wmv", "flv", "3gp", "mpg", "mpeg", "wav", "mp3",
    "m4a", "aac", "flac", "ogg", "opus", "aiff", "aif",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchHit {
    path: String,
    preset: String,
    out_dir: String,
}

/// مجلد فرعي يُكتب فيه الناتج (حتى لا يلتقطه المراقب مرة أخرى)
pub const WATCH_OUT: &str = "Converted";

/// يفحص المجلدات المراقَبة كل 4 ثوانٍ. الملف الجديد يُحوَّل بعد أن يثبت حجمه
/// (أي انتهى نسخه إلى المجلد). الملفات الموجودة قبل بدء المراقبة لا تُلمس.
pub fn spawn_watcher(app: AppHandle) {
    use std::collections::{HashMap, HashSet};
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let mut known_dirs: HashSet<PathBuf> = HashSet::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut pending: HashMap<PathBuf, (u64, u8)> = HashMap::new();
        loop {
            tokio::time::sleep(Duration::from_secs(4)).await;
            let folders = app.state::<SettingsState>().0.lock().unwrap().watch_folders.clone();
            let active: Vec<_> = folders.into_iter().filter(|w| w.enabled && preset(&w.preset).is_some()).collect();
            known_dirs.retain(|d| active.iter().any(|w| Path::new(&w.dir) == d));
            for w in &active {
                let dir = PathBuf::from(&w.dir);
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                let first_scan = known_dirs.insert(dir.clone());
                for e in entries.flatten() {
                    let path = e.path();
                    let name = e.file_name().to_string_lossy().into_owned();
                    let is_media = path
                        .extension()
                        .and_then(|x| x.to_str())
                        .is_some_and(|x| MEDIA_EXT.contains(&x.to_lowercase().as_str()));
                    if !is_media || name.starts_with('.') || !path.is_file() || seen.contains(&path) {
                        continue;
                    }
                    if first_scan {
                        seen.insert(path);
                        continue;
                    }
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    let entry = pending.entry(path.clone()).or_insert((size, 0));
                    if entry.0 == size && size > 0 {
                        entry.1 += 1;
                    } else {
                        *entry = (size, 0);
                    }
                    if entry.1 >= 2 {
                        pending.remove(&path);
                        seen.insert(path.clone());
                        let _ = app.emit("watch-file", WatchHit {
                            path: path.to_string_lossy().into_owned(),
                            preset: w.preset.clone(),
                            out_dir: dir.join(WATCH_OUT).to_string_lossy().into_owned(),
                        });
                    }
                }
            }
        }
    });
}
