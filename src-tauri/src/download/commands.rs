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
    id: Option<u64>,
) -> Result<u64, AppError> {
    let mut req = request;
    req.url = validate_url(&req.url)?;
    let (history_url, history_kind, history_start) = (req.url.clone(), req.kind.clone(), req.history.take());
    let settings = settings.0.lock_ok().clone();
    let (id, mut rx) = jobs.claim(id);
    let slots = queue.0.clone();

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut job_dir: Result<PathBuf, AppError> = Err(AppError::new("canceled"));
        let mut dir_key: Option<String> = None;
        // إعادات بعد خطأ عابر (R3-F4)، و«ابدأ الآن» أثناء انتظار إحداها، والتباطؤ بعد rateLimited
        let mut retries = 0;
        let mut jumped = false;
        let mut throttled = false;
        // تحديث yt-dlp ثم إعادة واحدة (R3-F5)، والخانة تبقى محجوزة له
        let mut healed = false;
        let mut keep_slot = false;
        let result = loop {
            // ننتظر دورنا إن كانت كل الخانات مشغولة (والإلغاء ممكن أثناء الانتظار)
            let slot = if keep_slot {
                None
            } else {
                match slots.clone().try_acquire_owned() {
                    Ok(p) => Some(p),
                    Err(_) if jumped => None,
                    Err(_) => {
                        let jump = jump_signal(id);
                        emit(
                            &app2,
                            JobUpdate {
                                id,
                                state: "queued",
                                ..Default::default()
                            },
                        );
                        let got = tokio::select! {
                            p = slots.clone().acquire_owned() => Some(p.expect("semaphore never closed")),
                            // «ابدأ الآن»: بلا خانة، فوق العدد المحدد (U-11)
                            _ = jump.notified() => None,
                            _ = canceled(&mut rx) => {
                                forget_jump(id);
                                break Ok(None);
                            }
                        };
                        forget_jump(id);
                        got
                    }
                }
            };
            jumped = false;
            keep_slot = false;
            if let Some(slot) = slot {
                hold_slot(id, slot);
            }
            emit(
                &app2,
                JobUpdate {
                    id,
                    state: "starting",
                    ..Default::default()
                },
            );
            // المجلد نفسه في كل إعادة: yt-dlp يكمل من ملفات .part (T-56)
            release_job_dir(dir_key.take());
            let claimed = jobs_root(&app2).map(|r| claim_job_dir(&r, id, &req));
            (job_dir, dir_key) = match claimed {
                Ok((d, k)) => (Ok(d), k),
                Err(e) => (Err(e), None),
            };
            let generation = crate::tools::ytdlp_generation();
            let result = match &job_dir {
                // في مهمة منفصلة: panic داخلها (خلل غير متوقع) يصير خطأً على البطاقة،
                // وتُحرَّر الخانة والمجلد تحته، بدل بطاقة عالقة وخانة محجوزة إلى الأبد (RD7)
                Ok(dir) => {
                    let (app3, dir, mut rx2) = (app2.clone(), dir.clone(), rx.clone());
                    let (req, settings) = (req.clone(), settings.clone());
                    tauri::async_runtime::spawn(async move { run_job(&app3, id, req, settings, &dir, &mut rx2).await })
                        .await
                        .unwrap_or_else(|e| {
                            log::error!("download {id}: task panicked: {e}");
                            Err(AppError::with_detail("unknown", e.to_string()))
                        })
                }
                Err(e) => Err(e.clone()),
            };
            let error = match result {
                Err(e) if !*rx.borrow() && transient(e.code) && retries < RETRY_AFTER.len() => e,
                // الموقع تغيّر أو رفض: تحديث yt-dlp (مرة في الساعة على الأكثر) ثم إعادة هذه المهمة وحدها مرة (R3-F5)
                Err(e) if !*rx.borrow() && !healed && heals(e.code) => {
                    healed = true;
                    emit(
                        &app2,
                        JobUpdate {
                            id,
                            state: "queued",
                            retry: Some(Retry {
                                attempt: 1,
                                max: 1,
                                at: None,
                                reason: "update",
                                error: e.clone(),
                            }),
                            ..Default::default()
                        },
                    );
                    // التحديث لا يُقطع بالإلغاء (نسخته الاحتياطية تُعاد في آخره)، ثم يُحترم الإلغاء
                    let newer = crate::tools::heal_ytdlp(&app2, generation).await;
                    if *rx.borrow() {
                        break Ok(None);
                    }
                    if !newer {
                        break Err(e);
                    }
                    log::warn!("download {id}: {}, retrying once with the updated yt-dlp", e.code);
                    crate::settings::finish_counter(&app2, id, false);
                    keep_slot = true;
                    continue;
                }
                other => break other,
            };

            // ---- إعادة تلقائية بعد خطأ عابر (R3-F4): الخانة تُحرَّر أثناء الانتظار ----
            release_slot(id);
            crate::settings::finish_counter(&app2, id, false);
            let reason = error.code;
            if reason == "rateLimited" && !throttled {
                throttled = true;
                app2.state::<DownloadQueue>().throttle(true, user_parallel(&app2));
            }
            let wait = RETRY_AFTER[retries];
            retries += 1;
            log::warn!(
                "download {id}: {reason}, retry {retries}/{} in {wait}s: {:?}",
                RETRY_AFTER.len(),
                error.detail
            );
            emit(
                &app2,
                JobUpdate {
                    id,
                    state: "queued",
                    retry: Some(Retry {
                        attempt: retries as u32,
                        max: RETRY_AFTER.len() as u32,
                        at: Some(now_ms() + wait * 1000),
                        reason,
                        error,
                    }),
                    ..Default::default()
                },
            );
            let jump = jump_signal(id);
            let target = if reason == "network" { host_port(&req.url) } else { None };
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(wait)) => {}
                // انقطع الاتصال ثم عاد: لا ننتظر بقية المدة
                _ = back_online(target, Duration::from_secs(5)) => {}
                // «ابدأ الآن» على البطاقة المنتظرة: الآن، وبلا انتظار خانة
                _ = jump.notified() => jumped = true,
                _ = canceled(&mut rx) => {
                    forget_jump(id);
                    break Ok(None);
                }
            }
            forget_jump(id);
        };
        if throttled {
            app2.state::<DownloadQueue>().throttle(false, user_parallel(&app2));
        }
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
        release_slot(id);
        crate::settings::finish_counter(&app2, id, update.state == "done");
        // بعد خطأ (انقطاع الشبكة مثلًا) يبقى المجلد، فتكمل «أعد المحاولة» من حيث توقّف (T-56)
        if let Ok(dir) = job_dir
            && update.state != "error"
        {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
        release_job_dir(dir_key);
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

/// إعادة المحاولة التلقائية بعد خطأ عابر (R3-F4): بعد 30 ث، ثم 2 د، ثم 10 د
pub(super) const RETRY_AFTER: [u64; 3] = [30, 120, 600];

/// أخطاء تزول وحدها غالبًا: انقطاع الاتصال، مهلة، حظر مؤقت لكثرة الطلبات، تنزيل وصل ناقصًا
pub(super) fn transient(code: &str) -> bool {
    matches!(code, "network" | "timeout" | "rateLimited" | "incomplete")
}

/// أخطاء يصلحها تحديث yt-dlp غالبًا (R3-F5): الموقع تغيّر، أو صار يرفض النسخة القديمة (403)
pub(super) fn heals(code: &str) -> bool {
    matches!(code, "extractorOutdated" | "forbidden")
}

/// عدد التنزيلات معًا كما في الإعدادات الآن (يعود إليه الحد بعد التباطؤ)
fn user_parallel(app: &AppHandle) -> usize {
    app.state::<SettingsState>().0.lock_ok().parallel_downloads.into()
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// الخادم والمنفذ من رابط http(s)، لفحص عودة الاتصال
pub(super) fn host_port(url: &str) -> Option<(String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let default = match scheme.to_ascii_lowercase().as_str() {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    let auth = rest.split(['/', '?', '#']).next()?;
    let auth = auth.rsplit_once('@').map_or(auth, |(_, h)| h);
    let (host, port) = match auth.strip_prefix('[') {
        // IPv6: [::1]:8080
        Some(v6) => {
            let (h, after) = v6.split_once(']')?;
            (h, after.strip_prefix(':'))
        }
        None => match auth.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (auth, None),
        },
    };
    let port = match port {
        Some(p) => p.parse().ok()?,
        None => default,
    };
    (!host.is_empty()).then(|| (host.to_string(), port))
}

/// يعود حين يصل الجهاز إلى الموقع بعد أن تعذّر الوصول إليه (R3-F4: «عند عودة الاتصال»).
/// اتصال TCP فقط كل `every`. بلا هدف، أو إن لم ينقطع أصلًا (الموقع نفسه يرفض)، لا يعود: ينتظر المؤقت
pub(super) async fn back_online(target: Option<(String, u16)>, every: Duration) {
    let Some((host, port)) = target else {
        return std::future::pending().await;
    };
    let mut was_down = false;
    loop {
        let h = host.clone();
        let up = tokio::task::spawn_blocking(move || {
            use std::net::{TcpStream, ToSocketAddrs};
            (h.as_str(), port)
                .to_socket_addrs()
                .ok()
                .and_then(|mut a| a.next())
                .is_some_and(|a| TcpStream::connect_timeout(&a, Duration::from_secs(4)).is_ok())
        })
        .await
        .unwrap_or(false);
        if up && was_down {
            return;
        }
        was_down |= !up;
        tokio::time::sleep(every).await;
    }
}

#[tauri::command]
pub fn cancel_download(jobs: State<'_, Jobs>, id: u64) {
    if let Some(tx) = jobs.cancels.lock_ok().get(&id) {
        let _ = tx.send(true);
    }
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
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
    /// الحجم التقريبي لأفضل فيديو بكل دقة [الارتفاع، البايتات]، من الأعلى (U-36)
    pub(super) video_sizes: Vec<[u64; 2]>,
    /// الحجم التقريبي لأفضل صوت منفصل
    pub(super) audio_size: Option<u64>,
}

/// أحجام النسخ من قائمة formats: أكبر فيديو لكل ارتفاع، وأكبر صوت منفصل.
/// yt-dlp يعطي filesize أو filesize_approx (من معدل البت والمدة)، وقد لا يعطي أيًا منهما
pub(super) fn format_sizes(j: &Value) -> (Vec<[u64; 2]>, Option<u64>) {
    let size = |f: &Value| f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64());
    let mut video: Vec<[u64; 2]> = Vec::new();
    let mut audio: Option<u64> = None;
    for f in j["formats"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(bytes) = size(f) else { continue };
        let has_v = f["vcodec"].as_str().is_some_and(|v| v != "none");
        let has_a = f["acodec"].as_str().is_some_and(|a| a != "none");
        if has_v {
            let Some(h) = f["height"].as_u64() else { continue };
            match video.iter_mut().find(|e| e[0] == h) {
                Some(e) => e[1] = e[1].max(bytes),
                None => video.push([h, bytes]),
            }
        } else if has_a {
            audio = Some(audio.map_or(bytes, |a| a.max(bytes)));
        }
    }
    video.sort_unstable_by(|a, b| b[0].cmp(&a[0]));
    (video, audio)
}

/// المساحة الحرة (بايت) على القرص الذي فيه المجلد، أو أقرب مجلد أب موجود (T-96)
/// غير متزامن وبمهلة: مجلد على قرص شبكة نائم كان يجمّد النافذة كلها حتى تنتهي مهلة SMB
#[tauri::command]
pub async fn free_space(path: String) -> Option<u64> {
    let job = tauri::async_runtime::spawn_blocking(move || {
        let mut p = std::path::PathBuf::from(path);
        while !p.exists() {
            if !p.pop() {
                return None;
            }
        }
        disk_free(&p)
    });
    tokio::time::timeout(Duration::from_secs(3), job).await.ok()?.ok()?
}

#[cfg(windows)]
fn disk_free(p: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    // SAFETY: wide ينتهي بصفر، والمؤشرات الأخرى اختيارية (null) أو تشير إلى u64 صالح
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut())
    };
    (ok != 0).then_some(free)
}

#[cfg(unix)]
fn disk_free(p: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: c مسار منتهٍ بصفر، وst بنية مهيّأة يملؤها النظام
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
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
        video_sizes: vec![],
        audio_size: None,
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
    let cookies = cookie_args(&app, &s);
    args.extend(cookies.iter().cloned());
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
            video_sizes: vec![],
            audio_size: None,
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
        video_sizes: format_sizes(&j).0,
        audio_size: format_sizes(&j).1,
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
    let cookies = cookie_args(&app, &s);
    a.extend(cookies.iter().cloned());
    a.extend(single_item());
    a.extend(["--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg", "-P"].map(String::from));
    a.push(work.to_string_lossy().into_owned());
    a.extend([
        "-o".into(),
        "%(title).150B.%(ext)s".into(),
        "--windows-filenames".into(),
        "--".into(),
        url,
    ]);
    // مخرج واحد لكل الحالات: مجلد العمل لا يبقى بعد مهلة أو خطأ
    let done = thumbnail_into(&app, &s, &tools, &a, &work).await;
    let _ = tokio::fs::remove_dir_all(&work).await;
    done
}

async fn thumbnail_into(app: &AppHandle, s: &Settings, tools: &Tools, a: &[String], work: &Path) -> Result<String, AppError> {
    let args: Vec<&str> = a.iter().map(String::as_str).collect();
    let (ok, _, err) = tokio::time::timeout(Duration::from_secs(90), tools::run_ytdlp(tools, &args))
        .await
        .map_err(|_| AppError::new("timeout"))??;
    let mut jpg = None;
    let mut rd = tokio::fs::read_dir(work).await?;
    while let Some(e) = rd.next_entry().await? {
        if e.path().extension().is_some_and(|x| x == "jpg") {
            jpg = Some(e.path());
            break;
        }
    }
    let Some(jpg) = jpg else {
        return Err(if ok {
            AppError::new("noThumbnail")
        } else {
            friendly_ytdlp_error(&err)
        });
    };
    #[cfg(mobile)]
    let dir = {
        let _ = s;
        jobs_root(app)?.join("ready")
    };
    #[cfg(desktop)]
    let dir = settings::resolve_output_dir(app, s)?;
    tokio::fs::create_dir_all(&dir).await?;
    Ok(deliver(app, &jpg, &dir).await?.to_string_lossy().into_owned())
}

/// يشغّل yt-dlp للمعاينة (حد 90 ثانية). replace = معاينة شاشة التنزيل: كل معاينة جديدة
/// توقف السابقة وكل ما شغّلته (T-42)، فكتابة رابط ببطء أو تغييره لا تُراكم عمليات Python.
fn latest_probe() -> &'static watch::Sender<u64> {
    static LATEST: std::sync::OnceLock<watch::Sender<u64>> = std::sync::OnceLock::new();
    LATEST.get_or_init(|| watch::channel(0).0)
}

/// زر «إلغاء» أثناء قراءة الرابط (U-78): يوقف معاينة شاشة التنزيل الجارية كما تفعل معاينة أحدث
#[tauri::command]
pub fn cancel_probe() {
    latest_probe().send_modify(|g| *g += 1);
}

pub(super) async fn run_probe(tools: &Tools, args: &[&str], replace: bool) -> Result<(bool, String, String), AppError> {
    use tokio::io::AsyncReadExt;
    let latest = latest_probe();
    let mut mine = 0;
    if replace {
        latest.send_modify(|g| {
            *g += 1;
            mine = *g;
        });
    }
    let mut newer = latest.subscribe();

    let mut child = spawn_tree(tools::ytdlp_command(tools).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()))?;
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
    // الملف نُقل أو حُذف (الممنتج نقله لمجلد المشروع): نفتح مجلده إن بقي، ونقول إن الملف لم يعد فيه (R2-17)
    let p = Path::new(&path);
    if !p.exists() {
        if let Some(dir) = p.parent().filter(|d| d.is_dir()) {
            app.opener()
                .open_path(dir.to_string_lossy(), None::<&str>)
                .map_err(|e| AppError::with_detail("openFolder", e.to_string()))?;
            return Err(AppError::with_detail("fileGoneFolderOpened", path));
        }
        return Err(AppError::with_detail("fileGone", path));
    }
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| AppError::with_detail("openFolder", e.to_string()))
}

/// ملف نصي فيه روابط أُفلت على التطبيق (U-51): نقرأ .txt فقط وحتى 1MB، والواجهة تستخرج الروابط
#[tauri::command]
pub fn read_links_file(path: String) -> Result<String, AppError> {
    let p = Path::new(&path);
    let is_txt = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("txt"));
    let small = std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() <= 1_048_576);
    if !is_txt || !small {
        return Err(AppError::with_detail("linksFile", "only .txt up to 1MB"));
    }
    // Notepad يحفظ «Unicode» بـ UTF-16، وملفات عربية قديمة بـ Windows-1256: نفس فك الترميز المستعمل للترجمات
    Ok(crate::srt::decode(&std::fs::read(p)?))
}

/// يفتح الملف ببرنامجه الافتراضي (U-64)، بنفس شرط reveal_file: ملفات أنتجها التطبيق فقط
#[tauri::command]
pub fn open_file(app: AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    if !was_produced(&path) && !crate::history::contains_file(&app, &path) {
        return Err(AppError::with_detail("openFolder", "not a file produced by Khama"));
    }
    app.opener()
        .open_path(&path, None::<&str>)
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
