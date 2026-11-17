use super::*;

// ======================= العملية الكاملة =======================

pub(crate) fn jobs_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::with_detail("cacheDir", e.to_string()))?
        .join("jobs"))
}

/// كم يبقى تنزيل منقطع قابلًا للاستكمال
const RESUME_FOR: std::time::Duration = std::time::Duration::from_secs(3 * 24 * 3600);

/// يُستدعى عند بدء التطبيق: يحذف بقايا عمليات قديمة (لو أُغلق التطبيق فجأة)،
/// ويُبقي مجلدات التنزيلات المنقطعة الحديثة (r…) ليكمل منها طلب التنزيل نفسه (T-56)
pub fn clean_stale_jobs(app: &AppHandle) {
    let Ok(entries) = jobs_root(app).and_then(|r| std::fs::read_dir(r).map_err(AppError::from)) else {
        return;
    };
    for e in entries.flatten() {
        let fresh = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age < RESUME_FOR);
        if !(is_resumable_dir(&e.file_name().to_string_lossy()) && fresh) {
            let p = e.path();
            let _ = if p.is_dir() {
                std::fs::remove_dir_all(p)
            } else {
                std::fs::remove_file(p)
            };
        }
    }
}

pub(super) fn is_resumable_dir(name: &str) -> bool {
    name.len() == 17 && name.starts_with('r') && name[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// اسم مجلد العمل لطلب تنزيل: ثابت للطلب نفسه (الرابط والخيارات)، فإن انقطع التنزيل
/// (إغلاق التطبيق، انقطاع الكهرباء) وطُلب مرة أخرى، وجد yt-dlp ملف .part فأكمل منه (T-56)
pub(super) fn resume_key(req: &DownloadRequest) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    format!("{req:?}").hash(&mut h);
    format!("r{:016x}", h.finish())
}

/// مجلدات عمل مستعملة الآن: طلبان متطابقان معًا لا يتشاركان مجلدًا
static ACTIVE_DIRS: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

/// يحجز مجلد العمل. للاستكمال نُبقي ما نزّله yt-dlp (work للأجزاء، out لما اكتمل)
/// ونحذف ما بعده من مراحل (تحويل، فصل) لتُعاد من أولها
pub(super) fn claim_job_dir(root: &Path, id: u64, req: &DownloadRequest) -> (PathBuf, Option<String>) {
    let key = resume_key(req);
    let mut active = ACTIVE_DIRS.lock_ok();
    if !active.get_or_insert_with(Default::default).insert(key.clone()) {
        return (root.join(id.to_string()), None);
    }
    let dir = root.join(&key);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten().filter(|e| e.file_name() != "work" && e.file_name() != "out") {
            let p = e.path();
            let _ = if p.is_dir() {
                std::fs::remove_dir_all(p)
            } else {
                std::fs::remove_file(p)
            };
        }
    }
    (dir, Some(key))
}

pub(super) fn release_job_dir(key: Option<String>) {
    if let (Some(k), Some(set)) = (key, ACTIVE_DIRS.lock_ok().as_mut()) {
        set.remove(&k);
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
        template: output_template(user_tpl, settings.site_folders, n, &today(req.tz_offset_min)),
        rate_limit_kb: settings.rate_limit_kb,
        max_name: max_name_len(&[&final_dir, &job_dir.join("work")]),
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
