use super::*;

// ======================= التحويل لصيغة المونتاج =======================

pub(super) struct MediaCheck {
    pub(super) duration: Option<f64>,
    pub(super) video_ok: bool,
    pub(super) audio_ok: bool,
}

pub(crate) fn fraction(s: &str) -> Option<f64> {
    let (a, b) = s.split_once('/')?;
    let (a, b) = (num(a)?, num(b)?);
    (b > 0.0).then(|| a / b)
}

/// هل الملف صالح كما هو لبرامج المونتاج؟
/// فيديو: H.264 بـ 8-bit 4:2:0 ومعدل إطارات ثابت. صوت: AAC أو MP3.
pub(super) async fn check_media(tools: &Tools, file: &Path) -> Result<MediaCheck, AppError> {
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

pub(super) async fn convert_for_editing(
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
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "cfr",
        ]);
    }
    if check.audio_ok {
        cmd.args(["-c:a", "copy"]);
    } else {
        cmd.args(["-c:a", "aac", "-b:a", "320k"]);
    }
    cmd.args(["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"])
        .arg(&output);

    let duration = check.duration.unwrap_or(0.0);
    let mut last = Instant::now() - Duration::from_secs(1);
    let outcome = run_streaming(cmd, cancel, |line| {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(num)
            && duration > 0.0
            && last.elapsed() >= Duration::from_millis(200)
        {
            last = Instant::now();
            emit(
                app,
                JobUpdate {
                    id,
                    state: "converting",
                    percent: Some((us / 1e6 / duration * 100.0).clamp(0.0, 100.0)),
                    ..Default::default()
                },
            );
        }
    })
    .await?;
    match outcome {
        RunOutcome::Canceled => Ok(None),
        RunOutcome::Exited { success: true, .. } => Ok(Some(output)),
        RunOutcome::Exited { stderr, .. } => Err(crate::errors::ffmpeg_error(&stderr, "convertFailed", 10)),
    }
}
