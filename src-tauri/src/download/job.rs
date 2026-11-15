use super::*;

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

pub(super) async fn run_job(
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
    std::fs::create_dir_all(&final_dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
    let cookies = cookie_args(app, &settings);
    let user_tpl = &settings.filename_template;
    let n = if user_tpl.contains("{n}") { settings::next_counter(app) } else { 0 };
    let opts = JobOptions {
        template: output_template(user_tpl, settings.site_folders, n, &today()),
        rate_limit_kb: settings.rate_limit_kb,
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
        emit(
            app,
            JobUpdate {
                id,
                state: "processing",
                ..Default::default()
            },
        );
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
    if req.timeline
        && req.kind == "video"
        && let Err(e) = write_timeline(&tools, &delivered).await
    {
        log::warn!("timeline: {e:?}");
    }
    Ok(first)
}
