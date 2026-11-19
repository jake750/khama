use super::*;

// ======================= بناء الأوامر =======================

pub(super) fn even(v: f64) -> u32 {
    ((v / 2.0).round() as u32).max(1) * 2
}

pub(super) fn parse_aspect(a: &str) -> Option<f64> {
    let (x, y) = a.split_once(':')?;
    let (x, y) = (num(x)?, num(y)?);
    (x > 0.0 && y > 0.0).then(|| x / y)
}

pub(super) fn fps_expr(f: &str) -> Option<&'static str> {
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
/// أقرب معدل قياسي لمتوسط معدل ملف VFR. دون هذا يأخذ `-fps_mode cfr` المعدل
/// الاسمي (r_frame_rate)، وهو في ملفات الهاتف غالبًا 60 أو 90 مع أن المتوسط نحو 30،
/// فيكرّر الإطارات ويضاعف حجم ProRes وDNxHR.
pub(super) fn standard_fps(avg: f64) -> &'static str {
    const RATES: [(f64, &str); 8] = [
        (24000.0 / 1001.0, "24000/1001"),
        (24.0, "24"),
        (25.0, "25"),
        (30000.0 / 1001.0, "30000/1001"),
        (30.0, "30"),
        (50.0, "50"),
        (60000.0 / 1001.0, "60000/1001"),
        (60.0, "60"),
    ];
    RATES
        .iter()
        .min_by(|a, b| (a.0 - avg).abs().total_cmp(&(b.0 - avg).abs()))
        .map(|r| r.1)
        .unwrap_or("30")
}

pub(super) fn atempo_chain(speed: f64) -> Vec<String> {
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
pub(super) fn timecode_font() -> Option<String> {
    let candidates: &[&str] = if cfg!(windows) {
        &[
            "C:/Windows/Fonts/consola.ttf",
            "C:/Windows/Fonts/cour.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
    } else if cfg!(target_os = "android") {
        &[
            "/system/fonts/DroidSansMono.ttf",
            "/system/fonts/CutiveMono.ttf",
            "/system/fonts/Roboto-Regular.ttf",
        ]
    } else if cfg!(target_os = "macos") {
        &[
            "/System/Library/Fonts/Menlo.ttc",
            "/System/Library/Fonts/Monaco.ttf",
            "/Library/Fonts/Arial.ttf",
        ]
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
/// مشفّر الهاتف لا يفهم CRF: نحسب معدّل بت يقابله من المقاس وعدد الإطارات
pub(super) fn mediacodec_bitrate(src: Option<&VideoInfo>, o: &ConvertOptions, crf: u32) -> u64 {
    let (w, h, fps) = src
        .map(|v| (v.width, v.height, v.fps.unwrap_or(30.0)))
        .unwrap_or((1920, 1080, 30.0));
    let (w, h) = output_dims(w, h, o, None);
    // بت لكل بكسل: أعلى جودة ← رقم أكبر
    let bpp = match crf {
        0..=18 => 0.16,
        19..=22 => 0.11,
        23..=26 => 0.07,
        _ => 0.04,
    };
    ((w as f64 * h as f64 * fps.clamp(1.0, 120.0) * bpp) as u64).clamp(500_000, 80_000_000)
}

pub(super) fn codec_args(p: &Preset, o: &ConvertOptions, hw: &[String], src: Option<&VideoInfo>) -> Vec<String> {
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
            Some(e) if e.ends_with("_nvenc") => s(&[
                "-c:v",
                e,
                "-preset",
                "p5",
                "-rc",
                "vbr",
                "-cq",
                &(crf + 1).to_string(),
                "-b:v",
                "0",
                "-pix_fmt",
                "yuv420p",
            ]),
            Some(e) if e.ends_with("_qsv") => s(&[
                "-c:v",
                e,
                "-preset",
                "medium",
                "-global_quality",
                &(crf + 1).to_string(),
                "-pix_fmt",
                "nv12",
            ]),
            Some(e) if e.ends_with("_amf") => {
                let qp = (crf + 1).to_string();
                s(&[
                    "-c:v", e, "-rc", "cqp", "-qp_i", &qp, "-qp_p", &qp, "-qp_b", &qp, "-pix_fmt", "yuv420p",
                ])
            }
            Some(e) if e.ends_with("_mediacodec") => s(&[
                "-c:v",
                e,
                "-b:v",
                &mediacodec_bitrate(src, o, crf).to_string(),
                "-pix_fmt",
                "yuv420p",
            ]),
            Some(e) if e.ends_with("_videotoolbox") => {
                // مقياس جودة VideoToolbox من 1 إلى 100
                let vq = 100 - (crf * 2).min(90);
                s(&["-c:v", e, "-q:v", &vq.to_string(), "-pix_fmt", "yuv420p"])
            }
            _ if family == "hevc" => s(&[
                "-c:v",
                "libx265",
                "-preset",
                "fast",
                "-crf",
                &crf.to_string(),
                "-pix_fmt",
                "yuv420p",
            ]),
            _ => s(&[
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                &crf.to_string(),
                "-pix_fmt",
                "yuv420p",
            ]),
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
    let mut a = match p.id {
        "edit_h264" => [avc_hevc("h264", pick(16, 18, 22)), aac(320)].concat(),
        "proxy" => [avc_hevc("h264", 26), aac(160), s(&["-g", "12"])].concat(),
        "youtube" => [avc_hevc("h264", pick(16, 18, 21)), aac(320)].concat(),
        "vertical" => [avc_hevc("h264", pick(17, 19, 23)), aac(256)].concat(),
        "whatsapp" => [avc_hevc("h264", pick(23, 26, 30)), aac(128)].concat(),
        "h265" => [avc_hevc("hevc", pick(19, 23, 28)), aac(256)].concat(),
        "av1" => [
            s(&[
                "-c:v",
                "libsvtav1",
                "-preset",
                "8",
                "-crf",
                &pick(24, 32, 40).to_string(),
                "-pix_fmt",
                "yuv420p",
            ]),
            aac(256),
        ]
        .concat(),
        "webm" => s(&[
            "-c:v",
            "libvpx-vp9",
            "-crf",
            &pick(24, 32, 40).to_string(),
            "-b:v",
            "0",
            "-row-mt",
            "1",
            "-deadline",
            "good",
            "-cpu-used",
            "4",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "libopus",
            "-b:a",
            "160k",
        ]),
        id if id.starts_with("prores_") => {
            let (profile, pix) = match id {
                "prores_proxy" => ("0", "yuv422p10le"),
                "prores_lt" => ("1", "yuv422p10le"),
                "prores_422" => ("2", "yuv422p10le"),
                "prores_hq" => ("3", "yuv422p10le"),
                _ => ("4", "yuva444p10le"),
            };
            [
                s(&["-c:v", "prores_ks", "-profile:v", profile, "-vendor", "apl0", "-pix_fmt", pix]),
                pcm(),
            ]
            .concat()
        }
        id if id.starts_with("dnxhr_") => {
            let profile = id;
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
pub(super) fn default_short(p: &Preset) -> Option<u32> {
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
pub(super) fn video_filters(p: &Preset, o: &ConvertOptions, v: &VideoInfo, keep_ts: bool) -> Vec<String> {
    let mut f = Vec::new();
    if o.deinterlace || v.interlaced {
        f.push("bwdif=mode=send_frame:deint=interlaced".to_string());
    }
    if o.tonemap && v.hdr {
        f.push("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv".to_string());
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
    let (cw, ch) = output_dims(v.width, v.height, &ConvertOptions { size: None, ..o.clone() }, None);
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
    } else if let Some(avg) = v.fps.filter(|_| v.vfr) {
        f.push(format!("fps={}", standard_fps(avg)));
    }
    if let Some(sp) = o.speed.filter(|s| (*s - 1.0).abs() > 1e-3) {
        f.push(format!("setpts=PTS/{sp:.4}"));
    }
    f
}

pub(super) fn sub_ext(path: &str) -> &'static str {
    let l = path.to_lowercase();
    if l.ends_with(".ass") || l.ends_with(".ssa") {
        "ass"
    } else if l.ends_with(".vtt") {
        "vtt"
    } else {
        "srt"
    }
}

pub(super) fn overlay_pos(pos: Option<&str>) -> &'static str {
    match pos.unwrap_or("br") {
        "tl" => "x=W*0.03:y=H*0.03",
        "tr" => "x=W-w-W*0.03:y=H*0.03",
        "bl" => "x=W*0.03:y=H-h-H*0.03",
        "c" => "x=(W-w)/2:y=(H-h)/2",
        _ => "x=W-w-W*0.03:y=H-h-H*0.03",
    }
}

pub(super) fn timecode_filter() -> String {
    let font = match timecode_font() {
        Some(f) => format!("fontfile='{f}'"),
        None => "font=monospace".to_string(),
    };
    format!(
        "drawtext={font}:text='%{{pts\\:hms}}':x=(w-tw)/2:y=h*0.04:fontsize=h*0.045:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=10"
    )
}

/// صيغة البكسل التي يحتاجها المشفّر في آخر السلسلة (حتى لا يختار FFmpeg شيئًا غريبًا)
pub(super) fn final_pix(args: &[String]) -> Option<String> {
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
                a.extend(s(&[
                    "-f",
                    "lavfi",
                    "-t",
                    &format!("{:.3}", info.duration.unwrap_or(1.0)),
                    "-i",
                    "anullsrc=r=48000:cl=stereo",
                ]));
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
        a.extend(s(&[
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
        ]));
        if o.mute {
            a.push("-an".into());
        }
        if p.ext != "mkv" {
            a.extend(s(&["-movflags", "+faststart"]));
        }
        push_split(&mut a, o, false);
        a.extend(s(&["-progress", "pipe:1", "-nostats"]));
        a.push(output.to_string_lossy().into_owned());
        return Ok(Plan {
            args: a,
            duration: span.max(0.0),
        });
    }

    let codec = codec_args(p, o, hw, first.video.as_ref());
    let mut graph: Vec<String> = Vec::new();
    let mut vlabel: Option<String> = None;
    let mut alabel: Option<String> = None;

    // ---- الدمج: توحيد المقاس والمعدل والصوت ثم concat ----
    if merging {
        let with_audio = !o.mute && replace_idx.is_none();
        (vlabel, alabel) = merge_graph(infos, needs_video, with_audio, &silent_idx, &mut graph)?;
    }

    // ---- فلاتر الصورة ----
    if needs_video {
        let v = first.video.as_ref().expect("checked");
        let src = vlabel.clone().map(|l| format!("[{l}]")).unwrap_or_else(|| "[0:v:0]".into());
        graph.push(video_graph(p, o, v, keep_ts, &src, &codec, wm_idx));
        vlabel = Some("vout".into());
    }

    // ---- فلاتر الصوت ----
    let wants_audio = matches!(p.kind, PKind::Video | PKind::Audio) && !o.mute;
    let asrc = if !wants_audio {
        None
    } else if let Some(r) = replace_idx {
        Some(format!("[{r}:a:0]"))
    } else if let Some(l) = &alabel {
        Some(format!("[{l}]"))
    } else if !first.audio.is_empty() {
        Some("[0:a:0]".to_string())
    } else {
        None
    };
    alabel = asrc.map(|src| {
        graph.push(audio_graph(o, &src, keep_ts && replace_idx.is_none(), loudnorm));
        "aout".to_string()
    });

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
pub(super) fn push_split(a: &mut Vec<String>, o: &ConvertOptions, reencode: bool) {
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

/// الدمج: كل مقطع بمقاس الأول ومعدله وصوت 48kHz ستيريو، ثم concat. يعيد تسميتي الصورة والصوت
fn merge_graph(
    infos: &[MediaInfo],
    needs_video: bool,
    with_audio: bool,
    silent_idx: &[Option<usize>],
    graph: &mut Vec<String>,
) -> Result<(Option<String>, Option<String>), AppError> {
    let first = &infos[0];
    let v0 = first.video.as_ref();
    let (tw, th) = v0.map(|v| (even(v.width as f64), even(v.height as f64))).unwrap_or((1920, 1080));
    let fps = v0.and_then(|v| v.fps).unwrap_or(30.0);
    let mut pads = String::new();
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
    let (mut vlabel, mut alabel) = (None, None);
    if needs_video {
        outs.push_str("[cv]");
        vlabel = Some("cv".into());
    }
    if with_audio {
        outs.push_str("[ca]");
        alabel = Some("ca".into());
    }
    graph.push(format!("{pads}concat=n={}:v={vflag}:a={aflag}{outs}", infos.len()));
    Ok((vlabel, alabel))
}

/// سلسلة فلاتر الصورة من `src` إلى [vout]: فلاتر الخيارات، ثم لوحة الألوان للـ GIF
/// أو العلامة المائية وصيغة البكسل التي يحتاجها المشفّر
pub(super) fn video_graph(
    p: &Preset,
    o: &ConvertOptions,
    v: &VideoInfo,
    keep_ts: bool,
    src: &str,
    codec: &[String],
    wm_idx: Option<usize>,
) -> String {
    // بعد الدمج صارت كل المقاطع بمقاس المقطع الأول
    let mut chain = video_filters(p, o, v, keep_ts);
    let (ow, _oh) = output_dims(v.width, v.height, o, default_short(p));
    match p.kind {
        PKind::Gif => {
            let fps = o.fps.as_deref().and_then(fps_expr).unwrap_or("15");
            chain.retain(|f| !f.starts_with("fps="));
            chain.push(format!("fps={fps}"));
            let pre = chain.join(",");
            format!("{src}{pre},split[g1][g2];[g1]palettegen=stats_mode=diff[pal];[g2][pal]paletteuse=dither=sierra2_4a[vout]")
        }
        _ => {
            let mut post: Vec<String> = Vec::new();
            if let Some(pix) = final_pix(codec) {
                post.push(format!("format={pix}"));
            }
            let pre = if chain.is_empty() { "null".to_string() } else { chain.join(",") };
            if let Some(wi) = wm_idx {
                let ww = even(ow as f64 * 0.16);
                let pos = overlay_pos(o.watermark_pos.as_deref());
                let post = if post.is_empty() { "null".to_string() } else { post.join(",") };
                format!(
                    "{src}{pre}[base];[{wi}:v]scale={ww}:-1,format=rgba,colorchannelmixer=aa=0.9[wm];[base][wm]overlay={pos}:format=auto,{post}[vout]"
                )
            } else {
                let all: Vec<String> = std::iter::once(pre).chain(post).collect();
                format!("{src}{}[vout]", all.join(","))
            }
        }
    }
}

/// سلسلة فلاتر الصوت من `src` إلى [aout]: تصفير التوقيت بعد القص، والسرعة، وتوحيد الصوت
fn audio_graph(o: &ConvertOptions, src: &str, reset_ts: bool, loudnorm: Option<&str>) -> String {
    let mut af: Vec<String> = Vec::new();
    if reset_ts {
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
    format!("{src}{}[aout]", af.join(","))
}
