use super::*;

// ======================= الإضافات: ترجمة، صورة، معلومات، لقطات، تايم لاين =======================

/// ما جُلب قبل التنزيل: ملفات بجانب الفيديو + معلومات المصدر
#[derive(Default)]
pub(super) struct Sidecars {
    /// (الملف، لاحقة اسمه بعد اسم الفيديو) مثل (".../side.en.srt", ".en.srt")
    pub(super) files: Vec<(PathBuf, String)>,
    pub(super) info: Option<Value>,
}

/// يجلب الترجمة والصورة المصغّرة ومعلومات المصدر دون تنزيل الفيديو.
/// Some(فارغ) إن لم يُطلب شيء، None إن ألغى المستخدم.
pub(super) async fn fetch_sidecars(
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
    a.extend(single_item());
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
        RunOutcome::Exited { success: false, stderr } => log::warn!("sidecars: {}", tail(&stderr, 6)),
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
    Ok(Some(Sidecars {
        files,
        info: info.filter(|_| req.info_file),
    }))
}

/// "اسم.mp4" ← "اسم"
pub(super) fn stem_of(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// نص ملف معلومات المصدر (لذكر المصدر وحقوق المحتوى)
pub(super) fn info_text(info: &Value, sections: &[(f64, f64)], downloaded: &str) -> String {
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
        s("upload_date")
            .filter(|d| d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit()))
            .map(|d| format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..])),
    );
    line("Site", s("extractor_key").map(String::from));
    line("License", s("license").map(String::from));
    line("Downloaded", Some(downloaded.to_string()));
    if !sections.is_empty() {
        let parts: Vec<String> = sections.iter().map(|(a, b)| format!("{} - {}", ts(*a), ts(*b))).collect();
        line("Section", Some(parts.join(", ")));
    }
    out.push_str("\nDownloaded with Khama. Respect the rights of the content owner.\n");
    out
}

/// ينقل الملف الرئيسي ثم ما معه (ترجمة مقصوصة على المقاطع، صورة، معلومات، لقطات) بنفس الاسم
#[allow(clippy::too_many_arguments, unused_variables)]
pub(super) async fn deliver_with_extras(
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
            let content = tokio::fs::read_to_string(src).await.unwrap_or_default();
            tokio::fs::write(&target, crate::srt::for_sections(&content, sections)).await?;
        } else {
            tokio::fs::copy(src, &target).await?;
        }
        if let Err(e) = deliver(app, &target, final_dir).await {
            log::warn!("deliver extra: {e:?}");
        }
    }
    if let Some(info) = &side.info {
        let target = extra_dir.join(format!("{stem} - source.txt"));
        tokio::fs::write(&target, info_text(info, sections, &today(req.tz_offset_min))).await?;
        if let Err(e) = deliver(app, &target, final_dir).await {
            log::warn!("deliver info: {e:?}");
        }
    }
    if let Some(dir) = stills_dir {
        let dest = unique_dir(final_dir, &format!("{stem} stills"));
        // النسخ (حين يكون مجلد المستخدم على قرص آخر) خارج خيوط tokio (T-23)
        let (from, to) = (dir.clone(), dest.clone());
        blocking(move || {
            if std::fs::rename(&from, &to).is_err() {
                std::fs::create_dir_all(&to)?;
                for e in std::fs::read_dir(&from)?.flatten() {
                    std::fs::copy(e.path(), to.join(e.file_name()))?;
                }
            }
            Ok(())
        })
        .await?;
        // الهاتف: المجلد كله إلى مجلد الحفظ/<الاسم> stills
        #[cfg(mobile)]
        if let Err(e) = crate::mobile::publish_any(app, dest).await {
            log::warn!("deliver stills: {e:?}");
        }
    }
    Ok(Some(done))
}

/// لقطات JPG من الفيديو: كل N ثانية، أو عند تغيّر المشهد
pub(super) async fn grab_stills(
    tools: &Tools,
    file: &Path,
    mode: &str,
    dir: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<PathBuf>, AppError> {
    std::fs::create_dir_all(dir)?;
    let filter = match mode {
        // أول إطار + أول إطار نظيف بعد كل انتقال تكشفه خوارزمية خامة (scenes.rs)
        "scene" => {
            let Some(found) = crate::scenes::detect_file(tools, file, None, None, crate::scenes::Params::default(), |_| {}, cancel).await?
            else {
                return Ok(None);
            };
            let picks: String = found.iter().map(|b| format!("+eq(n\\,{})", b.end)).collect();
            format!("select='eq(n\\,0){picks}'")
        }
        n => format!("fps=1/{}", n.parse::<u32>().unwrap_or(5).clamp(1, 600)),
    };
    let mut cmd = tools::ffmpeg_command(tools);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(file)
        .args(["-vf", &filter, "-fps_mode", "vfr", "-q:v", "2"])
        // سطر تقدّم كل نصف ثانية: بدونه لا يكتب ffmpeg شيئًا في stdout فيقتله مؤقّت التعليق (T-93) بعد 15 دقيقة
        .args(["-progress", "pipe:1", "-nostats"])
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
pub(super) async fn write_timeline(tools: &Tools, clips: &[(PathBuf, (f64, f64))]) -> Result<(), AppError> {
    let Some((first, _)) = clips.first() else { return Ok(()) };
    let f = first.to_string_lossy();
    let (_, out, _) = tools::run_capture(
        &tools.ffprobe,
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate",
            "-of",
            "json",
            &f,
        ],
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

#[cfg(desktop)]
pub(super) fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// مسار ملف بصيغة file:// (المسافات والرموز مرمّزة)
#[cfg(desktop)]
pub(super) fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from(if s.starts_with('/') {
        "file://localhost"
    } else {
        "file://localhost/"
    });
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(desktop)]
pub fn timeline_xml(clips: &[(PathBuf, (f64, f64))], durations: &[f64], fps: f64, width: u64, height: u64) -> String {
    // timebase عدد صحيح؛ 29.97 و 23.976 تُكتب 30 و 24 مع ntsc=TRUE
    let ntsc = (fps.round() - fps).abs() > 0.01;
    let tb = fps.round().max(1.0) as u64;
    let rate = format!(
        "<rate><timebase>{tb}</timebase><ntsc>{}</ntsc></rate>",
        if ntsc { "TRUE" } else { "FALSE" }
    );
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
pub(super) async fn fetch(
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
    cmd.args(download_args(
        tools,
        cookies.to_vec(),
        req,
        opts,
        section,
        &out_dir,
        &dir.join("work"),
    ));

    let (i, n) = (part.0 as f64, part.1.max(1) as f64);
    let mut file: Option<PathBuf> = None;
    let mut last = Instant::now() - Duration::from_secs(1);
    let outcome = run_streaming(cmd, cancel, |line| {
        if let Some(rest) = line.strip_prefix("KHAMA_DL ") {
            if let Some(p) = parse_dl_line(rest) {
                // نحدّث الواجهة 5 مرات في الثانية كحد أقصى
                if p.finished || last.elapsed() >= Duration::from_millis(200) {
                    last = Instant::now();
                    emit(
                        app,
                        JobUpdate {
                            id,
                            state: "downloading",
                            stage: Some(p.stage),
                            percent: p.percent.map(|v| (i * 100.0 + v) / n),
                            speed: p.speed,
                            eta: p.eta,
                            ..Default::default()
                        },
                    );
                }
            }
        } else if let Some(rest) = line.strip_prefix("KHAMA_PP ") {
            if rest.starts_with("started") && !rest.ends_with("MoveFiles") {
                emit(
                    app,
                    JobUpdate {
                        id,
                        state: "processing",
                        ..Default::default()
                    },
                );
            }
        } else if let Some(path) = line.strip_prefix("KHAMA_FILE ") {
            file = Some(PathBuf::from(path.trim()));
        } else if let Some((title, thumbnail)) = line.strip_prefix("KHAMA_META ").and_then(parse_meta_line) {
            emit(
                app,
                JobUpdate {
                    id,
                    state: "downloading",
                    title,
                    thumbnail,
                    ..Default::default()
                },
            );
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
pub(super) async fn finish(
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
        emit(
            app,
            JobUpdate {
                id,
                state: "processing",
                ..Default::default()
            },
        );
        let check = check_media(tools, &file).await?;
        if !(check.video_ok && check.audio_ok) {
            emit(
                app,
                JobUpdate {
                    id,
                    state: "converting",
                    percent: Some(0.0),
                    ..Default::default()
                },
            );
            // التنزيل انتهى: لا نحجز خانته أثناء انتظار دور المعالج المشترك (مثل الفصل، T-40)،
            // وإلا وقفت طابور التنزيل كله خلف تحويل طويل والشبكة فارغة
            release_slot(id);
            let Some(_heavy) = heavy_turn(cancel).await else {
                return Ok(None);
            };
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
        let ext = file
            .extension()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "mp4".into());
        let tag = if keep == separate::Keep::Voice { "no music" } else { "music only" };
        let out = sep_dir.join(format!("{stem} [{tag}].{ext}"));
        // الفصل واحد في كل مرة: إن كان غيره يفصل الآن تقول البطاقة «تنتظر دور الذكاء الاصطناعي»
        // لا «جارٍ الفصل» (U-71)، ثم تتحوّل حين يأتي دورها
        let busy = SEPARATING.try_lock().is_err();
        let separating = |stage| JobUpdate {
            id,
            state: "separating",
            stage,
            ..Default::default()
        };
        emit(app, separating(busy.then_some("wait")));
        // التنزيل انتهى: نترك خانته لغيره قبل انتظار دور الفصل (T-40)
        release_slot(id);
        let _turn = tokio::select! {
            g = SEPARATING.lock() => g,
            _ = canceled(cancel) => return Ok(None),
        };
        if busy {
            emit(app, separating(None));
        }
        let Some(_heavy) = heavy_turn(cancel).await else {
            return Ok(None);
        };
        if !separate::process_file(
            app,
            id,
            tools,
            &file,
            &out,
            &separate::VOICE,
            keep,
            None,
            None,
            duration,
            &dir.join("sepwork"),
            cancel,
        )
        .await?
        {
            return Ok(None);
        }
        file = out;
    }
    Ok(Some(file))
}

/// يشغّل عملية ملفات طويلة على خيط مخصّص بدل خيوط tokio
pub(super) async fn blocking(f: impl FnOnce() -> std::io::Result<()> + Send + 'static) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::with_detail("saveFailed", e.to_string()))??;
    Ok(())
}

/// النقل إلى مجلد المستخدم (وعلى الهاتف: إلى مجلد الحفظ العام)
#[cfg_attr(mobile, allow(clippy::needless_return))]
pub(super) async fn deliver(app: &AppHandle, file: &Path, final_dir: &Path) -> Result<PathBuf, AppError> {
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
pub(super) fn joined_name(first: &Path, count: usize) -> String {
    let stem = first.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let base = match stem.rfind(" [") {
        Some(i) if stem.ends_with(']') => &stem[..i],
        _ => stem.as_str(),
    };
    let ext = first
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mp4".into());
    format!("{base} [{count} clips].{ext}")
}

/// سطر في قائمة concat الخاصة بـ ffmpeg (نهرب علامة ' داخل المسار)
pub(super) fn concat_line(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/").replace('\'', r"'\''");
    format!("file '{s}'\n")
}

/// يدمج المقاطع بالترتيب في ملف واحد. أولًا بلا إعادة ترميز (سريع، والمقاطع من نفس المصدر)،
/// وإن فشل ذلك نعيد الترميز.
pub(super) async fn concat_files(
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
        cmd.args(["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i"])
            .arg(&list);
        if !reencode || is_wav {
            cmd.args(["-c", "copy"]);
        } else if req.kind == "video" {
            cmd.args([
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k",
            ]);
        } else if output.extension().is_some_and(|e| e == "mp3") {
            cmd.args(["-c:a", "libmp3lame", "-q:a", "0"]);
        } else {
            cmd.args(["-c:a", "aac", "-b:a", "320k"]);
        }
        if req.kind == "video" || output.extension().is_some_and(|e| e == "m4a") {
            cmd.args(["-movflags", "+faststart"]);
        }
        // إعادة الترميز قد تطول: أسطر التقدّم تُبقي مؤقّت التعليق راضيًا
        cmd.args(["-progress", "pipe:1", "-nostats"]).arg(&output);
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
