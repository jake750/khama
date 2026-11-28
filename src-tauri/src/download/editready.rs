use super::*;

// ======================= التحويل لصيغة المونتاج =======================

pub(super) struct MediaCheck {
    pub(super) duration: Option<f64>,
    pub(super) video_ok: bool,
    pub(super) audio_ok: bool,
    /// مقاس الفيديو ومعدله: لمعدل بت مشفّر الهاتف (MediaCodec لا يفهم CRF)
    pub(super) video: Option<crate::convert::VideoInfo>,
}

/// وسائط FFmpeg لـ«جاهز للمونتاج» (بلا ffmpeg نفسه). hw = مشفّر كرت الشاشة (h264_nvenc، h264_qsv...)
/// أو None للمعالج.
/// فك الترميز بالعتاد (`-hwaccel auto`) جُرّب ولم يُضف: على 4K AV1 مع Quick Sync كان 17.7 ث مقابل
/// 16.4 بلا فك بالعتاد (20 ث من الملف)، لأن نسخ الإطارات من الكرت يأكل ما يوفّره
pub(super) fn editready_args(input: &Path, output: &Path, check: &MediaCheck, hw: Option<&str>) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut a = s(&["-hide_banner", "-nostdin", "-y"]);
    a.extend(["-i".into(), input.to_string_lossy().into_owned()]);
    // «?» للفيديو أيضًا: رابط فيديو قد يعود بصوت فقط (SoundCloud، Bandcamp، archive.org) بترميز opus أو flac،
    // فيُحوَّل صوته إلى AAC بدل أن يفشل ffmpeg بـ «matches no streams»
    a.extend(s(&["-map", "0:v:0?", "-map", "0:a:0?"]));
    if check.video_ok {
        a.extend(s(&["-c:v", "copy"]));
    } else {
        match hw {
            // نفس مشفّر «H.264 للمونتاج» في المحوّل وجودته (R3-F7)
            Some(enc) => a.extend(crate::convert::edit_video_args(enc, check.video.as_ref())),
            // crf 18 = جودة شبه مطابقة للأصل. veryfast = توازن جيد بين السرعة والحجم.
            None => a.extend(s(&["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"])),
        }
        a.extend(s(&["-fps_mode", "cfr"]));
    }
    if check.audio_ok {
        a.extend(s(&["-c:a", "copy"]));
    } else {
        a.extend(s(&["-c:a", "aac", "-b:a", "320k"]));
    }
    a.extend(s(&["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"]));
    a.push(output.to_string_lossy().into_owned());
    a
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
            "stream=codec_type,codec_name,pix_fmt,r_frame_rate,avg_frame_rate,width,height:format=duration",
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
    let mut video = None;
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
                video.get_or_insert(crate::convert::VideoInfo {
                    codec: codec.to_string(),
                    profile: None,
                    width: s["width"].as_u64().unwrap_or(0) as u32,
                    height: s["height"].as_u64().unwrap_or(0) as u32,
                    fps: avg.or(r).filter(|f| *f > 0.0 && *f < 1000.0),
                    vfr: !cfr,
                    pix_fmt: pix.to_string(),
                    bit_depth: if pix.contains("10") { 10 } else { 8 },
                    hdr: false,
                    interlaced: false,
                });
            }
            Some("audio") => audio_ok = codec == "aac" || codec == "mp3",
            _ => {}
        }
    }
    Ok(MediaCheck {
        duration: j["format"]["duration"].as_str().and_then(num),
        video_ok,
        audio_ok,
        video,
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
    // كرت الشاشة كما في المحوّل (R3-F7): خيار «استخدم كرت الشاشة» نفسه، وأول مشفّر H.264 يعمل فعلًا
    let use_hw = !check.video_ok && app.state::<SettingsState>().0.lock_ok().convert_hw;
    let hw = if use_hw {
        crate::convert::hw_list(app, tools)
            .await
            .into_iter()
            .find(|e| e.starts_with("h264_"))
    } else {
        None
    };
    let first = encode_for_editing(app, id, tools, &editready_args(input, &output, check, hw.as_deref()), check, cancel).await;
    // جلسات NVENC محدودة، ودقة فوق حد العتاد، وتعريف تغيّر، وMediaCodec يُنهي بلا فيديو: نعيد بالمعالج
    let hw_failed = match &first {
        Ok(Some(_)) => crate::convert::video_packets(tools, &output).await == 0,
        Err(_) => !*cancel.borrow(),
        Ok(None) => false,
    };
    if let Some(enc) = hw.as_deref().filter(|_| hw_failed) {
        log::warn!("edit-ready: {enc} failed, retrying on the CPU: {:?}", first.as_ref().err());
        let _ = std::fs::remove_file(&output);
        return encode_for_editing(app, id, tools, &editready_args(input, &output, check, None), check, cancel).await;
    }
    first
}

async fn encode_for_editing(
    app: &AppHandle,
    id: u64,
    tools: &Tools,
    args: &[String],
    check: &MediaCheck,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PathBuf>, AppError> {
    let output = PathBuf::from(args.last().expect("output"));
    let mut cmd = tools::command(&tools.ffmpeg);
    cmd.args(args);
    emit(
        app,
        JobUpdate {
            id,
            state: "converting",
            percent: Some(0.0),
            ..Default::default()
        },
    );

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
