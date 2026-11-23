use super::*;
use crate::errors::LockExt;

// ======================= تشغيل التحويل =======================

/// الـ JSON الذي يطبعه loudnorm في المرور الأول
pub(super) fn parse_loudnorm(stderr: &str) -> Option<String> {
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

pub(super) fn output_dir_for(app: &AppHandle, o: &ConvertOptions, input: &Path) -> Result<PathBuf, AppError> {
    // الهاتف: ننهي الملف داخل التطبيق، ثم يُنقل إلى Download/Khama
    #[cfg(mobile)]
    {
        let _ = (o, input);
        return Ok(download::jobs_root(app)?.join("ready"));
    }
    #[allow(unreachable_code)]
    if let Some(d) = &o.out_dir {
        return Ok(PathBuf::from(d));
    }
    let s = app.state::<SettingsState>().0.lock_ok().clone();
    if s.convert_dest == "output" {
        settings::resolve_output_dir(app, &s)
    } else {
        Ok(input.parent().map(Path::to_path_buf).unwrap_or_default())
    }
}

/// يشغّل ffmpeg ويرسل النسبة والوقت المتبقي
#[allow(clippy::too_many_arguments)] // تُجمع في struct ضمن إعادة الهيكلة (T-11)
pub(super) async fn run_ffmpeg(
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
        } else if let Some(us) = line.strip_prefix("out_time_us=").and_then(num)
            && duration > 0.0
            && last.elapsed() >= Duration::from_millis(250)
        {
            last = Instant::now();
            let done = (us / 1e6).max(0.0);
            emit(
                app,
                JobUpdate {
                    id,
                    state,
                    percent: Some((done / duration * 100.0).clamp(0.0, 100.0)),
                    eta: speed.map(|s| ((duration - done) / s).max(0.0)),
                    ..Default::default()
                },
            );
        }
    })
    .await?;
    match outcome {
        RunOutcome::Canceled => Ok(None),
        RunOutcome::Exited { success: true, stderr } => Ok(Some(stderr)),
        RunOutcome::Exited { stderr, .. } => Err(crate::errors::ffmpeg_error(&stderr, "encodeFailed", 14)),
    }
}

pub(super) async fn run_convert(app: &AppHandle, id: u64, req: ConvertRequest, cancel: &mut watch::Receiver<bool>) -> Converted {
    let p = preset(&req.preset).ok_or_else(|| AppError::with_param("unknownPreset", req.preset.clone(), ""))?;
    let o = &req.options;
    if req.inputs.is_empty() {
        return Err(AppError::new("badInput"));
    }
    let tools = tools::resolve(app)?;

    emit(
        app,
        JobUpdate {
            id,
            state: "analyzing",
            ..Default::default()
        },
    );
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
        // نصًّا بـ UTF-8 لا نسخًا: FFmpeg يفترض UTF-8، وملف Windows-1256 كان يُحرق رموزًا مكسورة (RC10)
        let bytes = std::fs::read(sub).map_err(|e| AppError::with_detail("badInput", format!("{sub}: {e}")))?;
        std::fs::write(work.join(format!("sub.{}", sub_ext(sub))), crate::srt::decode(&bytes))?;
    }

    // ---- الكشف: لا ملف ناتج، فقط قائمة أوقات ----
    let c = Ctx {
        app,
        id,
        tools: &tools,
        work: &work,
    };
    if p.kind == PKind::Detect {
        return run_detect(&c, &p, &infos[0], o, cancel).await;
    }
    // ---- إزالة الموسيقى / الصوت البشري ----
    if p.kind == PKind::Stems {
        return run_stems(&c, &p, &infos[0], o, cancel).await;
    }

    let hw = if o.hw { hw_list(app, &tools).await } else { vec![] };

    // ---- توحيد الصوت: مرور أول للقياس ----
    let loudnorm = match o.loudness.filter(|_| matches!(p.kind, PKind::Video | PKind::Audio) && !o.mute) {
        Some(target) => match measure_loudness(&c, o, &infos, target, cancel).await? {
            Some(l) => Some(l),
            None => return Ok(None),
        },
        None => None,
    };

    // ---- مكان الناتج ----
    let dir = output_dir_for(app, o, &first_path)?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
    let stem = first_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let stem = if infos.len() > 1 { format!("{stem} merged") } else { stem };
    let folder_out = p.kind == PKind::Sequence || !o.split_at.is_empty();
    let final_name = if folder_out {
        format!("{stem} {}", if p.kind == PKind::Sequence { p.suffix } else { "parts" })
    } else {
        format!("{stem} [{}].{}", p.suffix, p.ext)
    };
    // نكتب في مجلد مؤقت مخفي داخل مجلد الحفظ (نفس القرص)، ثم نعيد التسمية (لحظية) عند النجاح
    let parts = PartDir::new(&dir)?;
    let temp = parts.0.join(format!(
        "{id}-part{}",
        if folder_out { String::new() } else { format!(".{}", p.ext) }
    ));
    let target = if folder_out {
        std::fs::create_dir_all(&temp)?;
        // مُخرجا image2 وsegment يقرآن المسار كله كقالب: «%» في الاسم («100% real.mp4») أو في
        // مجلد الحفظ يُفسَد القالب فيفشل التحويل. نضاعفه ليبقى حرفًا عاديًا
        let lit = |x: &str| x.replace('%', "%%");
        let pattern = if p.kind == PKind::Sequence {
            format!("{}_%05d.{}", lit(&stem), p.ext)
        } else {
            format!("{}_%03d.{}", lit(&stem), p.ext)
        };
        PathBuf::from(lit(&temp.to_string_lossy())).join(pattern)
    } else {
        temp.clone()
    };

    let plan = build_plan(&p, o, &infos, &hw, &target, loudnorm.as_deref())?;
    emit(
        app,
        JobUpdate {
            id,
            state: "converting",
            percent: Some(0.0),
            ..Default::default()
        },
    );
    let mut result = run_ffmpeg(app, id, &tools, &plan.args, &work, plan.duration, "converting", cancel).await;
    // مشفّر كرت الشاشة/الهاتف أنهى بلا فيديو (يحدث مع MediaCodec على بعض الأجهزة): نعيد بالمعالج
    let used_hw = plan.args.iter().any(|a| hw.contains(a));
    // أو فشل المشفّر نفسه: جلسات NVENC محدودة (OBS يسجّل معًا)، دقة فوق حد العتاد، تعريف تغيّر
    let hw_failed = match &result {
        Ok(Some(_)) => video_packets(&tools, &temp).await == 0,
        Err(_) => !*cancel.borrow(),
        Ok(None) => false,
    };
    if used_hw && !folder_out && p.kind == PKind::Video && hw_failed {
        log::warn!(
            "hw encoder failed or produced no video, retrying on CPU: {:?}",
            result.as_ref().err()
        );
        let _ = std::fs::remove_file(&temp);
        let plan = build_plan(&p, o, &infos, &[], &target, loudnorm.as_deref())?;
        emit(
            app,
            JobUpdate {
                id,
                state: "converting",
                percent: Some(0.0),
                ..Default::default()
            },
        );
        result = run_ffmpeg(app, id, &tools, &plan.args, &work, plan.duration, "converting", cancel).await;
    }
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
    // مجلد الناتج يُحجز مجلدًا فارغًا لا ملفًا: إعادة تسمية مجلد فوق ملف تفشل دائمًا على Unix،
    // وفي Windows تفشل من ثاني تصدير للملف نفسه
    let dest = if folder_out {
        download::unique_dir(&dir, &final_name)
    } else {
        unique_path(&dir, &final_name)
    };
    if let Err(e) = std::fs::rename(&temp, &dest) {
        let _ = if folder_out {
            std::fs::remove_dir(&dest)
        } else {
            std::fs::remove_file(&dest)
        };
        cleanup();
        return Err(AppError::with_detail("moveFailed", e.to_string()));
    }
    Ok(Some((deliver(app, dest).await?, None)))
}

/// مجلد مخفي للملفات غير المكتملة داخل مجلد الحفظ (T-52). كان الملف المؤقت يُكتب في مجلد
/// الحفظ نفسه باسم يبدأ بنقطة، والنقطة لا تُخفي شيئًا في Windows، فقد يلتقطه برنامج المونتاج
/// أو مجلد مراقَب. المجلد الفرعي لا يراه المراقِب (غير تكراري)، ويُعلَّم «مخفيًا» في Windows،
/// ويُحذف حين يفرغ. على نفس القرص لتبقى إعادة التسمية لحظية.
pub(super) struct PartDir(pub PathBuf);

impl PartDir {
    pub(super) fn new(dir: &Path) -> Result<Self, AppError> {
        let p = dir.join(".khama-parts");
        std::fs::create_dir_all(&p).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
        // بقايا تحويل انقطع (إغلاق، انهيار، انقطاع كهرباء) قد تكون غيغابايتات في مجلد مخفي.
        // لا تحويل يبقى يومًا بلا كتابة (مؤقّت التعليق T-93)، فما هو أقدم من ذلك يُحذف
        if let Ok(rd) = std::fs::read_dir(&p) {
            for e in rd.flatten() {
                let old = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(24 * 3600));
                if old {
                    let path = e.path();
                    let _ = if path.is_dir() {
                        std::fs::remove_dir_all(&path)
                    } else {
                        std::fs::remove_file(&path)
                    };
                }
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_HIDDEN, SetFileAttributesW};
            let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
            // SAFETY: wide مسار منتهٍ بصفر
            unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN) };
        }
        Ok(Self(p))
    }
}

impl Drop for PartDir {
    fn drop(&mut self) {
        // يفشل إن لم يفرغ (تحويل آخر يعمل في نفس المجلد)، وهذا المطلوب
        let _ = std::fs::remove_dir(&self.0);
    }
}

/// على الهاتف: الناتج (ملف أو مجلد) يُنقل إلى مجلد الحفظ العام
pub(super) async fn deliver(app: &AppHandle, dest: PathBuf) -> Result<PathBuf, AppError> {
    #[cfg(mobile)]
    return crate::mobile::publish_any(app, dest).await;
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(dest)
    }
}

/// ملفات اختارها المستخدم: على الهاتف تأتي كروابط content:// فننسخها داخل التطبيق أولًا
#[tauri::command]
#[cfg_attr(mobile, allow(clippy::needless_return))]
pub async fn import_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<String>, AppError> {
    #[cfg(mobile)]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            paths
                .iter()
                .map(|p| crate::mobile::import_file(&app, p))
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        .map_err(|e| AppError::with_detail("badInput", e.to_string()))?;
    }
    #[cfg(desktop)]
    {
        let _ = app;
        Ok(paths)
    }
}

#[tauri::command]
pub async fn start_convert(app: AppHandle, request: ConvertRequest, id: Option<u64>) -> Result<u64, AppError> {
    queue_convert(&app, request, id)
}

/// يضع تحويلًا في الطابور ويعيد رقمه. تستدعيه الواجهة ومراقبة المجلدات.
pub fn queue_convert(app: &AppHandle, request: ConvertRequest, id: Option<u64>) -> Result<u64, AppError> {
    let jobs = app.state::<Jobs>();
    let queue = app.state::<ConvertQueue>();
    if preset(&request.preset).is_none() {
        return Err(AppError::with_param("unknownPreset", request.preset.clone(), ""));
    }
    let (id, mut rx) = jobs.claim(id);
    let sem = queue.0.clone();
    let app2 = app.clone();
    // للسجلّ: التحويلات (ومنها المجلدات المراقَبة) تُسجَّل كالتنزيلات (U-62، U-75)
    let (source, preset_id) = (request.inputs.first().cloned().unwrap_or_default(), request.preset.clone());
    tauri::async_runtime::spawn(async move {
        emit(
            &app2,
            JobUpdate {
                id,
                state: "queued",
                ..Default::default()
            },
        );
        // ننتظر دورنا في الطابور، ويمكن الإلغاء أثناء الانتظار
        let permit = tokio::select! {
            p = sem.acquire_owned() => p.ok(),
            _ = download::canceled(&mut rx) => None,
        };
        // ثم دورنا في الحدّ المشترك مع التنزيلات (T-41)
        let heavy = match permit {
            Some(_) => download::heavy_turn(&mut rx).await,
            None => None,
        };
        let result = match (permit, heavy) {
            // panic داخل التحويل يصير خطأً على البطاقة لا بطاقة عالقة (RD7)
            (Some(_), Some(_)) => {
                let (app3, mut rx2) = (app2.clone(), rx.clone());
                tauri::async_runtime::spawn(async move { run_convert(&app3, id, request, &mut rx2).await })
                    .await
                    .unwrap_or_else(|e| {
                        log::error!("convert {id}: task panicked: {e}");
                        Err(AppError::with_detail("unknown", e.to_string()))
                    })
            }
            _ => Ok(None),
        };
        let update = match result {
            Ok(Some((path, found))) => JobUpdate {
                id,
                state: "done",
                percent: Some(100.0),
                file: found.is_none().then(|| path.to_string_lossy().into_owned()),
                transcript: found.as_ref().and_then(|f| f.transcript),
                topics: found.as_ref().and_then(|f| f.topics.clone()),
                markers: found.map(|f| f.markers),
                ..Default::default()
            },
            Ok(None) | Err(_) if *rx.borrow() => JobUpdate {
                id,
                state: "canceled",
                ..Default::default()
            },
            Ok(None) => JobUpdate {
                id,
                state: "canceled",
                ..Default::default()
            },
            Err(e) => JobUpdate {
                id,
                state: "error",
                error: Some(e),
                ..Default::default()
            },
        };
        if let Ok(root) = download::jobs_root(&app2) {
            let _ = tokio::fs::remove_dir_all(root.join(format!("c{id}"))).await;
        }
        app2.state::<Jobs>().cancels.lock_ok().remove(&id);
        if let Some(file) = update.file.as_deref().filter(|_| update.state == "done") {
            let entry = convert_history_entry(
                &source,
                &preset_id,
                Path::new(file),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64),
            );
            if let Err(e) = crate::history::add_entry(&app2, entry).await {
                log::error!("history: {e}");
            }
        }
        emit(&app2, update);
    });
    Ok(id)
}

/// عنصر سجلّ لتحويل مكتمل: kind = "convert"، والرابط = الملف المصدر، وmeta = رقم الـ preset
/// (الواجهة تعرض اسمه بلغة المستخدم)
pub(super) fn convert_history_entry(source: &str, preset: &str, out: &Path, now_ms: u64) -> crate::history::HistoryEntry {
    crate::history::HistoryEntry {
        id: 0,
        title: out.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        url: source.to_string(),
        file: out.to_string_lossy().into_owned(),
        kind: "convert".into(),
        meta: preset.to_string(),
        thumbnail: None,
        date: now_ms,
        exists: true,
    }
}

type Converted = Result<Option<(PathBuf, Option<Found>)>, AppError>;

/// نتائج الكشف (بدل ملف ناتج)
pub(super) struct Found {
    pub markers: Vec<[f64; 2]>,
    pub topics: Option<Vec<Topic>>,
    pub transcript: Option<&'static str>,
}

impl From<Vec<[f64; 2]>> for Found {
    fn from(markers: Vec<[f64; 2]>) -> Self {
        Self {
            markers,
            topics: None,
            transcript: None,
        }
    }
}

/// ما تحتاجه مراحل التحويل كلها
pub(super) struct Ctx<'a> {
    pub app: &'a AppHandle,
    pub id: u64,
    pub tools: &'a Tools,
    pub work: &'a Path,
}

/// الكشف: لا ملف ناتج، فقط قائمة أوقات
async fn run_detect(c: &Ctx<'_>, p: &Preset, info: &MediaInfo, o: &ConvertOptions, cancel: &mut watch::Receiver<bool>) -> Converted {
    if p.id == "topics" {
        let Some(r) = run_topics(c, info, o, cancel).await? else {
            return Ok(None);
        };
        let found = Found {
            markers: r.silences,
            topics: Some(r.topics),
            transcript: Some(r.source),
        };
        return Ok(Some((PathBuf::from(&info.path), Some(found))));
    }
    if p.id == "detect_silence" && info.audio.is_empty() {
        return Err(AppError::new("noAudioStream"));
    }
    if p.id != "detect_silence" && info.video.is_none() {
        return Err(AppError::new("noVideoStream"));
    }
    let dur = o.end.unwrap_or(info.duration.unwrap_or(0.0)) - o.start.unwrap_or(0.0);
    if p.id == "detect_silence" {
        let Some(found) = detect_silences(c, info, o, cancel).await? else {
            return Ok(None);
        };
        return Ok(Some((PathBuf::from(&info.path), Some(found.into()))));
    }
    // المشاهد: خوارزمية خامة (مدرّج ألوان HSV + عتبة متكيّفة + كشف الانتقالات التدريجية)، انظر scenes.rs
    if p.id == "detect_scenes" {
        let t0 = o.start.unwrap_or(0.0);
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let path = PathBuf::from(&info.path);
        let found = crate::scenes::detect_file(
            c.tools,
            &path,
            o.start,
            o.end,
            crate::scenes::Params::default(),
            |t| {
                if dur > 0.0 && last.elapsed() >= std::time::Duration::from_millis(250) {
                    last = std::time::Instant::now();
                    let pct = ((t - t0) / dur * 100.0).clamp(0.0, 100.0);
                    emit(
                        c.app,
                        JobUpdate {
                            id: c.id,
                            state: "analyzing",
                            percent: Some(pct),
                            ..Default::default()
                        },
                    );
                }
            },
            cancel,
        )
        .await?;
        let Some(found) = found else { return Ok(None) };
        return Ok(Some((path, Some(found.iter().map(|b| b.marker()).collect::<Vec<_>>().into()))));
    }
    let args = detect_args(p.id, &info.path, o);
    let Some(log) = run_ffmpeg(c.app, c.id, c.tools, &args, c.work, dur, "analyzing", cancel).await? else {
        return Ok(None);
    };
    Ok(Some((PathBuf::from(&info.path), Some(parse_markers(p.id, &log).into()))))
}

/// فترات الصمت بعتبة الملف نفسه (انظر silence.rs)، مع تقدّم «تحليل» على البطاقة
pub(super) async fn detect_silences(
    c: &Ctx<'_>,
    info: &MediaInfo,
    o: &ConvertOptions,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<Vec<[f64; 2]>>, AppError> {
    let t0 = o.start.unwrap_or(0.0);
    let dur = o.end.unwrap_or(info.duration.unwrap_or(0.0)) - t0;
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let levels = silence::levels_file(
        c.tools,
        Path::new(&info.path),
        o.start,
        o.end,
        |t| {
            if dur > 0.0 && last.elapsed() >= std::time::Duration::from_millis(250) {
                last = std::time::Instant::now();
                emit(
                    c.app,
                    JobUpdate {
                        id: c.id,
                        state: "analyzing",
                        percent: Some(((t - t0) / dur * 100.0).clamp(0.0, 100.0)),
                        ..Default::default()
                    },
                );
            }
        },
        cancel,
    )
    .await?;
    Ok(levels.map(|lv| silence::find_silences(&lv, o.silence_db, o.silence_min).0))
}

/// إزالة الموسيقى أو الصوت البشري بالنموذج
async fn run_stems(c: &Ctx<'_>, p: &Preset, info: &MediaInfo, o: &ConvertOptions, cancel: &mut watch::Receiver<bool>) -> Converted {
    let first_path = PathBuf::from(&info.path);
    if info.audio.is_empty() {
        return Err(AppError::new("noAudioStream"));
    }
    let src_ext = first_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let ext = if info.video.is_some() {
        if matches!(src_ext.as_str(), "mp4" | "mov" | "mkv" | "webm") {
            src_ext.as_str()
        } else {
            "mp4"
        }
    } else {
        "wav"
    };
    let keep = if p.id == "stem_music" {
        separate::Keep::Music
    } else {
        separate::Keep::Voice
    };
    let dir = output_dir_for(c.app, o, &first_path)?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
    let stem = first_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let parts = PartDir::new(&dir)?;
    let temp = parts.0.join(format!("{}-part.{ext}", c.id));
    let start = o.start.filter(|v| *v > 0.0);
    let ok = separate::process_file(
        c.app,
        c.id,
        c.tools,
        &first_path,
        &temp,
        keep,
        start,
        o.end,
        info.duration,
        c.work,
        cancel,
    )
    .await;
    match ok {
        Ok(true) => {}
        Ok(false) => {
            let _ = std::fs::remove_file(&temp);
            return Ok(None);
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    }
    let dest = unique_path(&dir, &format!("{stem} [{}].{ext}", p.suffix));
    std::fs::rename(&temp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&dest);
        AppError::with_detail("moveFailed", e.to_string())
    })?;
    Ok(Some((deliver(c.app, dest).await?, None)))
}

/// توحيد الصوت: مرور أول يقيس الملف ويعيد مرشّح loudnorm بالقياسات (None إن أُلغي)
async fn measure_loudness(
    c: &Ctx<'_>,
    o: &ConvertOptions,
    infos: &[MediaInfo],
    target: f64,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<String>, AppError> {
    let base = format!("loudnorm=I={target:.1}:TP=-1.5:LRA=11");
    let mut measure = ConvertOptions {
        split_at: vec![],
        ..o.clone()
    };
    measure.subtitles = None;
    measure.timecode = false;
    let probe_plan = build_plan(
        &preset("wav").unwrap(),
        &measure,
        infos,
        &[],
        Path::new("-"),
        Some(&format!("{base}:print_format=json")),
    )?;
    let mut args = probe_plan.args;
    // نستبدل الناتج بـ "لا شيء": نريد القياس فقط
    args.pop();
    args.extend(["-f", "null", "-"].iter().map(|s| s.to_string()));
    emit(
        c.app,
        JobUpdate {
            id: c.id,
            state: "analyzing",
            percent: Some(0.0),
            ..Default::default()
        },
    );
    let Some(log) = run_ffmpeg(c.app, c.id, c.tools, &args, c.work, probe_plan.duration, "analyzing", cancel).await? else {
        return Ok(None);
    };
    let measured = parse_loudnorm(&log).ok_or_else(|| AppError::with_detail("loudnessFailed", tail(&log, 10)))?;
    Ok(Some(format!("{base}:{measured}:linear=true")))
}
