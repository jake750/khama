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

/// أغنية من سبوتيفاي (T-46): كانت تُنزَّل أول نتيجة لبحث YouTube Music كما هي، فقد تكون
/// نسخة حية أو غلافًا أو أغنية أخرى. نقرأ أول 5 نتائج (بلا فتح كل واحدة) ونختار الأنسب.
/// None = نترك البحث كما هو (yt-dlp يأخذ أول نتيجة).
async fn pick_song(tools: &Tools, cookies: &[String], req: &DownloadRequest) -> Option<String> {
    if req.expect_title.is_none() && req.expect_duration.is_none() {
        return None;
    }
    let mut args = tools::ytdlp_base_args(tools);
    args.extend(cookies.iter().cloned());
    args.extend(["-J", "--flat-playlist", "--playlist-items", "1:5", "--"].map(String::from));
    args.push(req.url.clone());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (ok, out, _) = run_probe(tools, &args, false).await.ok()?;
    let json: serde_json::Value = serde_json::from_str(&out).ok().filter(|_| ok)?;
    let found: Vec<SongHit> = json["entries"]
        .as_array()?
        .iter()
        .filter_map(|e| {
            Some(SongHit {
                url: e["url"].as_str().or(e["webpage_url"].as_str())?.to_string(),
                title: e["title"].as_str().unwrap_or_default().to_string(),
                duration: e["duration"].as_f64(),
            })
        })
        .collect();
    best_song(&found, req.expect_title.as_deref(), req.expect_duration)
}

pub(super) struct SongHit {
    pub url: String,
    pub title: String,
    pub duration: Option<f64>,
}

/// كلمات تعني نسخة غير الأصلية، إلا إن كانت في عنوان سبوتيفاي نفسه
const VARIANTS: &[&str] = &[
    "live",
    "cover",
    "remix",
    "karaoke",
    "instrumental",
    "acoustic",
    "sped up",
    "slowed",
    "مباشر",
    "ريمكس",
];

fn norm(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// أعلى نقاطًا: العنوان نفسه، ثم يحتويه، والمدة القريبة (10 ثوانٍ أو 5%) إن عُرفت،
/// وخصم لنسخة حية أو غلاف لم تُطلب. التعادل لترتيب YouTube Music. لا نتائج = None
pub(super) fn best_song(found: &[SongHit], title: Option<&str>, duration: Option<f64>) -> Option<String> {
    let want = title.map(norm).unwrap_or_default();
    let score = |h: &SongHit| {
        let got = norm(&h.title);
        let mut s = 0i32;
        if !want.is_empty() {
            if got == want {
                s += 4;
            } else if got.contains(&want) {
                s += 2;
            }
            if VARIANTS.iter().any(|v| got.contains(v) && !want.contains(v)) {
                s -= 5;
            }
        }
        if let (Some(d), Some(e)) = (h.duration, duration) {
            s += if (d - e).abs() <= (e * 0.05).max(10.0) { 3 } else { -3 };
        }
        s
    };
    let mut best: Option<(&SongHit, i32)> = None;
    for h in found {
        let sc = score(h);
        if best.is_none_or(|(_, b)| sc > b) {
            best = Some((h, sc));
        }
    }
    best.map(|(h, _)| h.url.clone())
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
    let mut req = req;
    if req.url.starts_with(playlist::MUSIC_SEARCH)
        && let Some(url) = pick_song(&tools, &cookie_args(app, &settings), &req).await
    {
        req.url = url;
    }
    // على الهاتف: ننهي الملف داخل التطبيق ثم ننقله إلى Download/Khama العام
    #[cfg(mobile)]
    let final_dir = jobs_root(app)?.join("ready");
    #[cfg(desktop)]
    let final_dir = {
        let mut base = settings::resolve_output_dir(app, &settings)?;
        // الصوت والفيديو كلٌّ في مجلده إن طلب المستخدم ذلك (U-88)
        if settings.kind_folders {
            base = base.join(if req.kind == "audio" { "Audio" } else { "Video" });
        }
        match req.subdir.as_deref().and_then(playlist::folder_name) {
            Some(sub) => base.join(sub),
            None => base,
        }
    };
    std::fs::create_dir_all(&final_dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
    let cookies = cookie_args(app, &settings);
    let user_tpl = &settings.filename_template;
    let n = if user_tpl.contains("{n}") {
        settings::reserve_counter(app, id, &settings)
    } else {
        0
    };
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
