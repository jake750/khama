use super::*;
use crate::errors::LockExt;

// ======================= أوامر تستدعيها الواجهة =======================

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    jobs: State<'_, Jobs>,
    queue: State<'_, DownloadQueue>,
    settings: State<'_, SettingsState>,
    request: DownloadRequest,
) -> Result<u64, AppError> {
    let mut req = request;
    req.url = validate_url(&req.url)?;
    let (history_url, history_kind, history_start) = (req.url.clone(), req.kind.clone(), req.history.take());
    let settings = settings.0.lock_ok().clone();
    let id = jobs.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = watch::channel(false);
    jobs.cancels.lock_ok().insert(id, tx);
    let slots = queue.0.clone();

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        // ننتظر دورنا إن كانت كل الخانات مشغولة (والإلغاء ممكن أثناء الانتظار)
        let _slot = match slots.clone().try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                emit(
                    &app2,
                    JobUpdate {
                        id,
                        state: "queued",
                        ..Default::default()
                    },
                );
                tokio::select! {
                    p = slots.acquire_owned() => p.expect("semaphore never closed"),
                    _ = canceled(&mut rx) => {
                        app2.state::<Jobs>().cancels.lock_ok().remove(&id);
                        emit(&app2, JobUpdate { id, state: "canceled", ..Default::default() });
                        return;
                    }
                }
            }
        };
        emit(
            &app2,
            JobUpdate {
                id,
                state: "starting",
                ..Default::default()
            },
        );
        let job_dir = jobs_root(&app2).map(|r| r.join(id.to_string()));
        let result = match &job_dir {
            Ok(dir) => run_job(&app2, id, req, settings, dir, &mut rx).await,
            Err(e) => Err(e.clone()),
        };
        let update = match result {
            Ok(Some(path)) => JobUpdate {
                id,
                state: "done",
                percent: Some(100.0),
                file: Some(path.to_string_lossy().into_owned()),
                ..Default::default()
            },
            // إن فشل شيء بعد ضغط "إلغاء" فهو نتيجة الإلغاء، لا خطأ حقيقي
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
        if let Ok(dir) = job_dir {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        app2.state::<Jobs>().cancels.lock_ok().remove(&id);
        let printed = take_meta(id);
        // السجلّ يُكتب هنا في Rust قبل إعلان الانتهاء (T-19): حين تستقبل الواجهة "done" يكون موجودًا
        if let Some(file) = update.file.as_deref().filter(|_| update.state == "done") {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let entry = history_entry(&history_url, &history_kind, history_start, printed, Path::new(file), now);
            if let Err(e) = crate::history::add_entry(&app2, entry).await {
                log::error!("history: {e}");
            }
        }
        emit(&app2, update);
    });
    Ok(id)
}

#[tauri::command]
pub fn cancel_download(jobs: State<'_, Jobs>, id: u64) {
    if let Some(tx) = jobs.cancels.lock_ok().get(&id) {
        let _ = tx.send(true);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub(super) title: String,
    pub(super) thumbnail: Option<String>,
    pub(super) duration: Option<f64>,
    pub(super) uploader: Option<String>,
    pub(super) site: Option<String>,
    /// الدقات المتوفرة (للفيديو)، من الأعلى للأقل
    pub(super) heights: Vec<u32>,
    pub(super) is_live: bool,
    /// رابط قائمة تشغيل: عناصرها (والحقول أعلاه تصف القائمة نفسها)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) entries: Option<Vec<Entry>>,
    /// لغات الترجمة المتاحة
    pub(super) subtitles: Vec<SubLang>,
    /// رابط مباشر لنسخة صغيرة (فيديو + صوت) لمعاينة القص داخل التطبيق
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) preview_url: Option<String>,
    /// ملفات Google Drive: تُنزَّل كما هي (بلا تحويل صيغة)
    pub(super) original: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubLang {
    pub(super) code: String,
    pub(super) name: String,
    /// ترجمة تلقائية (من الكلام) لا مكتوبة
    pub(super) auto: bool,
}

/// لغات الترجمة: المكتوبة أولًا، ثم التلقائية المفيدة فقط (لغة الفيديو الأصلية + العربية والإنجليزية)
/// لأن يوتيوب يعرض ترجمة آلية لأكثر من 100 لغة.
pub fn sub_langs(j: &Value) -> Vec<SubLang> {
    let name_of = |v: &Value, code: &str| {
        v.as_array()
            .and_then(|a| a.iter().find_map(|t| t["name"].as_str()))
            .map(String::from)
            .unwrap_or_else(|| code.to_string())
    };
    let mut out: Vec<SubLang> = Vec::new();
    if let Some(m) = j["subtitles"].as_object() {
        for (code, v) in m {
            if code == "live_chat" {
                continue;
            }
            out.push(SubLang {
                code: code.clone(),
                name: name_of(v, code),
                auto: false,
            });
        }
    }
    if let Some(m) = j["automatic_captions"].as_object() {
        let lang = j["language"].as_str().unwrap_or("");
        for (code, v) in m {
            let base = code.trim_end_matches("-orig");
            let useful = code.ends_with("-orig") || code == lang || code == "ar" || code == "en";
            if useful && !out.iter().any(|s| s.code == base || s.code.split('-').next() == Some(base)) {
                out.push(SubLang {
                    code: code.clone(),
                    name: name_of(v, code),
                    auto: true,
                });
            }
        }
    }
    out
}

/// أصغر نسخة فيها صورة وصوت معًا بصيغة MP4 (تكفي للمعاينة وتُشغَّل في المتصفح مباشرة)
pub(super) fn preview_url(j: &Value) -> Option<String> {
    j["formats"]
        .as_array()?
        .iter()
        .filter(|f| {
            f["vcodec"].as_str().is_some_and(|v| v != "none" && v.starts_with("avc1"))
                && f["acodec"].as_str().is_some_and(|a| a != "none")
                && f["ext"].as_str() == Some("mp4")
                && f["protocol"].as_str() == Some("https")
        })
        .min_by_key(|f| f["height"].as_u64().unwrap_or(9999))
        .and_then(|f| f["url"].as_str())
        .map(String::from)
}

/// قائمة سبوتيفاي: نجلب صفحة المشغّل المضمَّن بـ yt-dlp ونقرأ منها أسماء الأغاني
pub(super) async fn probe_spotify(tools: &Tools, embed: String) -> Result<ProbeInfo, AppError> {
    let mut args = tools::ytdlp_base_args(tools);
    args.extend(["--force-generic-extractor", "--dump-pages", "--skip-download", "--"].map(String::from));
    args.push(embed);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    // yt-dlp ينتهي بخطأ "Unsupported URL" بعد طباعة الصفحة، وهذا متوقّع
    let (_, out, err) = tokio::time::timeout(Duration::from_secs(60), tools::run_ytdlp(tools, &args))
        .await
        .map_err(|_| AppError::new("timeout"))??;
    let Some(page) = playlist::page_from_dump(&out) else {
        return Err(AppError::with_detail("spotifyFailed", tail(&err, 6)));
    };
    let list = playlist::parse_spotify_page(&page)?;
    Ok(ProbeInfo {
        title: list.title,
        thumbnail: list.thumbnail,
        duration: None,
        uploader: list.owner,
        site: Some("Spotify".into()),
        heights: vec![],
        is_live: false,
        entries: Some(list.entries),
        subtitles: vec![],
        preview_url: None,
        original: false,
    })
}

/// يقرأ معلومات الرابط (العنوان، الصورة، الدقات المتاحة) دون تنزيل.
/// رابط قائمة تشغيل: يعيد عناصرها في entries.
#[tauri::command]
pub async fn probe(app: AppHandle, settings: State<'_, SettingsState>, url: String, replace: Option<bool>) -> Result<ProbeInfo, AppError> {
    let url = validate_url(&url)?;
    let s = settings.0.lock_ok().clone();
    let tools = tools::resolve(&app)?;
    if let Some(embed) = playlist::spotify_embed_url(&url) {
        return probe_spotify(&tools, embed).await;
    }
    let mut args = tools::ytdlp_base_args(&tools);
    args.extend(cookie_args(&app, &s));
    // --flat-playlist: عناصر القائمة دون فتح كل واحد منها (لا يؤثّر على رابط فيديو واحد)
    args.extend(["-J".to_string(), "--flat-playlist".to_string(), "--".to_string(), url]);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();

    let (ok, out, err) = run_probe(&tools, &args, replace.unwrap_or(false)).await?;
    if !ok {
        return Err(friendly_ytdlp_error(&err));
    }
    let j: Value = serde_json::from_str(&out).map_err(|e| AppError::with_detail("probeParse", e.to_string()))?;
    if j["_type"].as_str() == Some("playlist") {
        let entries = playlist::entries_from_ytdlp(&j);
        if entries.is_empty() {
            return Err(AppError::new("playlistEmpty"));
        }
        let thumbnail = j["thumbnails"]
            .as_array()
            .and_then(|t| t.last())
            .and_then(|t| t["url"].as_str())
            .map(String::from)
            .or_else(|| entries.iter().find_map(|e| e.thumbnail.clone()));
        return Ok(ProbeInfo {
            title: j["title"].as_str().unwrap_or("Playlist").to_string(),
            thumbnail,
            duration: None,
            uploader: j["uploader"].as_str().or(j["channel"].as_str()).map(String::from),
            site: j["extractor_key"]
                .as_str()
                .map(|k| k.trim_end_matches("Tab").trim_end_matches("Set").to_string()),
            heights: vec![],
            is_live: false,
            entries: Some(entries),
            subtitles: vec![],
            preview_url: None,
            original: j["extractor_key"].as_str().is_some_and(|k| k.starts_with("GoogleDrive")),
        });
    }
    let mut heights: Vec<u32> = j["formats"]
        .as_array()
        .map(|fs| {
            fs.iter()
                .filter(|f| f["vcodec"].as_str().is_some_and(|v| v != "none"))
                .filter_map(|f| f["height"].as_u64().map(|h| h as u32))
                .collect()
        })
        .unwrap_or_default();
    heights.sort_unstable_by(|a, b| b.cmp(a));
    heights.dedup();
    Ok(ProbeInfo {
        title: j["title"].as_str().unwrap_or("Untitled").to_string(),
        thumbnail: j["thumbnail"].as_str().map(String::from),
        duration: j["duration"].as_f64(),
        uploader: j["uploader"].as_str().or(j["channel"].as_str()).map(String::from),
        site: j["extractor_key"].as_str().map(String::from),
        heights,
        is_live: j["is_live"].as_bool().unwrap_or(false),
        entries: None,
        subtitles: sub_langs(&j),
        preview_url: preview_url(&j),
        original: j["extractor_key"].as_str().is_some_and(|k| k.starts_with("GoogleDrive")),
    })
}

/// يحفظ الصورة المصغّرة بأعلى دقة (JPG) في مجلد الحفظ، دون تنزيل الفيديو
#[tauri::command]
pub async fn save_thumbnail(app: AppHandle, settings: State<'_, SettingsState>, url: String) -> Result<String, AppError> {
    let url = validate_url(&url)?;
    let s = settings.0.lock_ok().clone();
    let tools = tools::resolve(&app)?;
    static N: AtomicU64 = AtomicU64::new(0);
    let work = jobs_root(&app)?.join(format!("thumb-{}", N.fetch_add(1, Ordering::Relaxed)));
    let _ = tokio::fs::remove_dir_all(&work).await;
    tokio::fs::create_dir_all(&work).await?;
    let mut a = tools::ytdlp_base_args(&tools);
    a.extend(cookie_args(&app, &s));
    a.extend(["--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg", "-P"].map(String::from));
    a.push(work.to_string_lossy().into_owned());
    a.extend([
        "-o".into(),
        "%(title).150B.%(ext)s".into(),
        "--windows-filenames".into(),
        "--".into(),
        url,
    ]);
    let args: Vec<&str> = a.iter().map(String::as_str).collect();
    let (ok, _, err) = tokio::time::timeout(Duration::from_secs(90), tools::run_ytdlp(&tools, &args))
        .await
        .map_err(|_| AppError::new("timeout"))??;
    let jpg = std::fs::read_dir(&work)?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "jpg"));
    let Some(jpg) = jpg else {
        let _ = std::fs::remove_dir_all(&work);
        return Err(if ok {
            AppError::new("noThumbnail")
        } else {
            friendly_ytdlp_error(&err)
        });
    };
    #[cfg(mobile)]
    let dir = jobs_root(&app)?.join("ready");
    #[cfg(desktop)]
    let dir = settings::resolve_output_dir(&app, &s)?;
    tokio::fs::create_dir_all(&dir).await?;
    let done = deliver(&app, &jpg, &dir).await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    Ok(done?.to_string_lossy().into_owned())
}

/// يشغّل yt-dlp للمعاينة (حد 90 ثانية). replace = معاينة شاشة التنزيل: كل معاينة جديدة
/// توقف السابقة وكل ما شغّلته (T-42)، فكتابة رابط ببطء أو تغييره لا تُراكم عمليات Python.
pub(super) async fn run_probe(tools: &Tools, args: &[&str], replace: bool) -> Result<(bool, String, String), AppError> {
    use std::sync::OnceLock;
    use tokio::io::AsyncReadExt;
    static LATEST: OnceLock<watch::Sender<u64>> = OnceLock::new();
    let latest = LATEST.get_or_init(|| watch::channel(0).0);
    let mut mine = 0;
    if replace {
        latest.send_modify(|g| {
            *g += 1;
            mine = *g;
        });
    }
    let mut newer = latest.subscribe();

    let mut child = tools::ytdlp_command(tools)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let read = |pipe: Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>>| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf).await;
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let out = read(child.stdout.take().map(|p| Box::new(p) as _));
    let err = read(child.stderr.take().map(|p| Box::new(p) as _));

    let status = tokio::select! {
        s = child.wait() => s?,
        // (داخل async حتى لا يبقى Ref غير القابل للإرسال بين الخيوط)
        _ = async { let _ = newer.wait_for(|g| replace && *g != mine).await; } => {
            kill_tree(&mut child).await;
            return Err(AppError::new("canceled"));
        }
        _ = tokio::time::sleep(Duration::from_secs(90)) => {
            kill_tree(&mut child).await;
            return Err(AppError::new("timeout"));
        }
    };
    Ok((status.success(), out.await.unwrap_or_default(), err.await.unwrap_or_default()))
}

#[tauri::command]
pub fn reveal_file(app: AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    // فقط ملفات أنتجها التطبيق: في هذه الجلسة أو في السجلّ (T-33)
    if !was_produced(&path) && !crate::history::contains_file(&app, &path) {
        return Err(AppError::with_detail("openFolder", "not a file produced by Khama"));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::with_detail("openFolder", e.to_string()))
}

#[tauri::command]
pub fn open_output_dir(app: AppHandle, settings: State<'_, SettingsState>) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let s = settings.0.lock_ok().clone();
    let dir = settings::resolve_output_dir(&app, &s)?;
    std::fs::create_dir_all(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::with_detail("openFolder", e.to_string()))
}
