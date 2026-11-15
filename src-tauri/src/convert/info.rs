use super::*;

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

pub(super) fn rotation_of(s: &Value) -> i64 {
    let from_side = s["side_data_list"].as_array().and_then(|l| {
        l.iter()
            .find_map(|d| d["rotation"].as_f64().or_else(|| d["rotation"].as_str().and_then(num)))
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
                    .unwrap_or(if pix.contains("10") {
                        10
                    } else if pix.contains("12") {
                        12
                    } else {
                        8
                    });
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

pub(super) async fn probe_file(tools: &Tools, path: &Path) -> Result<MediaInfo, AppError> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::with_detail("badInput", e.to_string()))?;
    let p = path.to_string_lossy();
    let (ok, out, err) = tools::run_capture(&tools.ffprobe, &["-v", "error", "-show_format", "-show_streams", "-of", "json", &p]).await?;
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
pub(super) async fn thumbnail(tools: &Tools, path: &Path, duration: Option<f64>) -> Option<String> {
    let at = duration.map(|d| (d * 0.1).min(30.0)).unwrap_or(0.0);
    small_jpeg(tools, path.as_os_str(), at, 320, 4).await
}

/// إطار واحد من `input` (ملف أو رابط صورة) كـ data URL بعرض `width`.
/// `quality`: 2 (أفضل) إلى 31 (أصغر حجمًا).
pub async fn small_jpeg(tools: &Tools, input: &std::ffi::OsStr, seek: f64, width: u32, quality: u8) -> Option<String> {
    use base64::Engine;
    let mut cmd = tools::command(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if seek > 0.0 {
        cmd.args(["-ss", &format!("{seek:.2}")]);
    }
    cmd.arg("-i").arg(input).args([
        "-frames:v",
        "1",
        "-vf",
        &format!("scale={width}:-2"),
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-q:v",
        &quality.to_string(),
        "-",
    ]);
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output())
        .await
        .ok()?
        .ok()?;
    (out.status.success() && !out.stdout.is_empty()).then(|| {
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&out.stdout)
        )
    })
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

pub(super) fn hw_candidates() -> &'static [&'static str] {
    if cfg!(target_os = "android") {
        // شريحة الهاتف (MediaCodec): أسرع بكثير من المعالج وأقل حرارة
        &["h264_mediacodec", "hevc_mediacodec"]
    } else if cfg!(target_os = "macos") {
        &["h264_videotoolbox", "hevc_videotoolbox"]
    } else if cfg!(windows) {
        &["h264_nvenc", "hevc_nvenc", "h264_qsv", "hevc_qsv", "h264_amf", "hevc_amf"]
    } else {
        &["h264_nvenc", "hevc_nvenc"]
    }
}

/// يجرّب كل مشفّر بترميز إطارات قليلة إلى ملف حقيقي: الموجود في FFmpeg لا يعني أن الجهاز يدعمه،
/// وبعض المشفّرات (MediaCodec على بعض الهواتف) تنجح بلا أن تُخرج أي إطار، فنتأكد أن في الملف فيديو.
pub(super) async fn detect_hw(tools: &Tools) -> Vec<String> {
    let mut found = Vec::new();
    let dir = std::env::temp_dir().join(format!("khama-hw-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    for enc in hw_candidates() {
        let fmt = if enc.ends_with("_qsv") { "nv12" } else { "yuv420p" };
        let out = dir.join(format!("{enc}.mp4"));
        let ok = tools::command(&tools.ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=320x240:r=30:d=0.5",
                "-pix_fmt",
                fmt,
                "-c:v",
                enc,
                "-b:v",
                "1M",
            ])
            .arg(&out)
            .output();
        if let Ok(Ok(o)) = tokio::time::timeout(Duration::from_secs(20), ok).await
            && o.status.success()
            && video_packets(tools, &out).await > 0
        {
            found.push(enc.to_string());
        }
        let _ = std::fs::remove_file(&out);
    }
    let _ = std::fs::remove_dir_all(&dir);
    found
}

/// عدد إطارات الفيديو المرمّزة في ملف (0 = لا فيديو)
pub(super) async fn video_packets(tools: &Tools, file: &Path) -> u64 {
    let f = file.to_string_lossy();
    let args = [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_packets",
        "-show_entries",
        "stream=nb_read_packets",
        "-of",
        "csv=p=0",
        &f,
    ];
    match tools::run_capture(&tools.ffprobe, &args).await {
        Ok((true, out, _)) => out.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

pub(super) async fn hw_list(tools: &Tools) -> Vec<String> {
    HW.get_or_init(|| detect_hw(tools)).await.clone()
}

#[tauri::command]
pub async fn hw_encoders(app: AppHandle) -> Result<Vec<String>, AppError> {
    let tools = tools::resolve(&app)?;
    Ok(hw_list(&tools).await)
}
