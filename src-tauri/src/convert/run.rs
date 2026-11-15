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
#[allow(clippy::too_many_arguments)] // تُجمع في struct ضمن إعادة الهيكلة (T-8)
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
        RunOutcome::Exited { stderr, .. } => Err(AppError::with_detail("encodeFailed", tail(&stderr, 14))),
    }
}

pub(super) async fn run_convert(
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

    // ---- إزالة الموسيقى / الصوت البشري ----
    if p.kind == PKind::Stems {
        let info = &infos[0];
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
        let dir = output_dir_for(app, o, &first_path)?;
        std::fs::create_dir_all(&dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
        let stem = first_path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        let temp = dir.join(format!(".khama-{id}-part.{ext}"));
        let start = o.start.filter(|v| *v > 0.0);
        let ok = separate::process_file(
            app,
            id,
            &tools,
            &first_path,
            &temp,
            keep,
            start,
            o.end,
            info.duration,
            &work,
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
        std::fs::rename(&temp, &dest).map_err(|e| AppError::with_detail("moveFailed", e.to_string()))?;
        return Ok(Some((deliver(app, dest).await?, None)));
    }

    let hw = if o.hw { hw_list(&tools).await } else { vec![] };

    // ---- توحيد الصوت: مرور أول للقياس ----
    let mut loudnorm = None;
    if let Some(target) = o.loudness.filter(|_| matches!(p.kind, PKind::Video | PKind::Audio) && !o.mute) {
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
            &infos,
            &[],
            Path::new("-"),
            Some(&format!("{base}:print_format=json")),
        )?;
        let mut args = probe_plan.args;
        // نستبدل الناتج بـ "لا شيء": نريد القياس فقط
        args.pop();
        args.extend(["-f", "null", "-"].iter().map(|s| s.to_string()));
        emit(
            app,
            JobUpdate {
                id,
                state: "analyzing",
                percent: Some(0.0),
                ..Default::default()
            },
        );
        let Some(log) = run_ffmpeg(app, id, &tools, &args, &work, probe_plan.duration, "analyzing", cancel).await? else {
            return Ok(None);
        };
        let measured = parse_loudnorm(&log).ok_or_else(|| AppError::with_detail("loudnessFailed", tail(&log, 10)))?;
        loudnorm = Some(format!("{base}:{measured}:linear=true"));
    }

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
    // نكتب باسم مخفي مؤقت في نفس المجلد، ثم نعيد التسمية (لحظية) عند النجاح
    let temp = dir.join(format!(
        ".khama-{id}-part{}",
        if folder_out { String::new() } else { format!(".{}", p.ext) }
    ));
    let target = if folder_out {
        std::fs::create_dir_all(&temp)?;
        let pattern = if p.kind == PKind::Sequence {
            format!("{stem}_%05d.{}", p.ext)
        } else {
            format!("{stem}_%03d.{}", p.ext)
        };
        temp.join(pattern)
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
    if used_hw && !folder_out && p.kind == PKind::Video && matches!(result, Ok(Some(_))) && video_packets(&tools, &temp).await == 0 {
        eprintln!("hw encoder produced no video, retrying on CPU");
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
    let dest = unique_path(&dir, &final_name);
    std::fs::rename(&temp, &dest).map_err(|e| AppError::with_detail("moveFailed", e.to_string()))?;
    Ok(Some((deliver(app, dest).await?, None)))
}

/// على الهاتف: الناتج (ملف أو مجلد) يُنقل إلى Download/Khama العام
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
pub async fn start_convert(app: AppHandle, request: ConvertRequest) -> Result<u64, AppError> {
    queue_convert(&app, request)
}

/// يضع تحويلًا في الطابور ويعيد رقمه. تستدعيه الواجهة ومراقبة المجلدات.
pub fn queue_convert(app: &AppHandle, request: ConvertRequest) -> Result<u64, AppError> {
    let jobs = app.state::<Jobs>();
    let queue = app.state::<ConvertQueue>();
    if preset(&request.preset).is_none() {
        return Err(AppError::with_param("unknownPreset", request.preset.clone(), ""));
    }
    let id = jobs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = watch::channel(false);
    jobs.cancels.lock_ok().insert(id, tx);
    let sem = queue.0.clone();
    let app2 = app.clone();
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
        emit(&app2, update);
    });
    Ok(id)
}
