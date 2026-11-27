use super::*;

// ======================= بناء أوامر yt-dlp =======================

pub(super) fn validate_url(url: &str) -> Result<String, AppError> {
    // تحليل كامل للرابط (T-70) لا مجرد البادئة: http/https ومعه اسم موقع
    let url = url.trim();
    match tauri::Url::parse(url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()) => Ok(url.to_string()),
        _ => Err(AppError::new("invalidUrl")),
    }
}

/// عنصر واحد فقط من أي رابط قائمة (التنزيل والملحقات والصورة المصغّرة)
pub(super) fn single_item() -> [String; 2] {
    ["--playlist-items".into(), "1".into()]
}

/// خيارات الكوكيز لتشغيل yt-dlp واحد. تبقى حيّة طوال التشغيل: نسخة الملف تُحذف عند إسقاطها.
pub(super) struct Cookies {
    args: Vec<String>,
    copy: Option<PathBuf>,
}

impl std::ops::Deref for Cookies {
    type Target = Vec<String>;
    fn deref(&self) -> &Vec<String> {
        &self.args
    }
}

impl Drop for Cookies {
    fn drop(&mut self) {
        if let Some(p) = &self.copy {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// yt-dlp يعيد كتابة ملف --cookies عند انتهائه: تنزيلان معًا على الملف نفسه قد يتركانه تالفًا
/// فتفشل كل التنزيلات بعدها. لكل تشغيل نسخة خاصة، والأصل لا يُلمس (RD2، بموافقة صاحب التطبيق).
pub(super) fn cookie_args(app: &AppHandle, s: &Settings) -> Cookies {
    static N: AtomicU64 = AtomicU64::new(0);
    let none = Cookies { args: vec![], copy: None };
    match s.cookies_mode.as_str() {
        "browser" if !s.cookies_browser.is_empty() => Cookies {
            args: vec!["--cookies-from-browser".into(), s.cookies_browser.clone()],
            copy: None,
        },
        "file" => {
            let Ok(src) = settings::cookies_path(app) else { return none };
            let Ok(data) = std::fs::read(&src) else { return none };
            let Ok(root) = jobs_root(app) else { return none };
            let _ = std::fs::create_dir_all(&root);
            let mine = format!("cookies-{}-", std::process::id());
            // نسخ تركها تشغيل سابق انقطع (إغلاق مفاجئ): فيها جلسات الحساب، فلا تبقى
            for e in std::fs::read_dir(&root).into_iter().flatten().flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with("cookies-") && !name.starts_with(&mine) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
            let copy = root.join(format!("{mine}{}.txt", N.fetch_add(1, Ordering::Relaxed)));
            if crate::persist::write_atomic_private(&copy, &data).is_err() {
                return none;
            }
            Cookies {
                args: vec!["--cookies".into(), copy.to_string_lossy().into_owned()],
                copy: Some(copy),
            }
        }
        _ => none,
    }
}

/// خيارات اختيار الصيغة والجودة. منفصلة لتسهل قراءتها واختبارها.
pub fn format_args(req: &DownloadRequest) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if req.original {
        // الملف الأصلي كما رفعه صاحبه (Google Drive: صيغة "source")
        a.extend(["-f", "source/b"].map(String::from));
    } else if req.kind == "audio" {
        // "original" = الصوت كما رُفع بلا تحويل (U-95): WAV من مصدر AAC لا يحسّن شيئًا.
        // «best» في yt-dlp يستخرج المسار الصوتي كما هو دون إعادة ترميز
        let fmt = match req.audio_format.as_str() {
            "m4a" | "wav" => req.audio_format.as_str(),
            "original" => "best",
            _ => "mp3",
        };
        a.extend(["-f", "ba/b", "-x", "--audio-format", fmt, "--audio-quality", "0"].map(String::from));
    } else {
        let container = if req.video_format == "mov" { "mov" } else { "mp4" };
        // -S = ترتيب الأفضلية: أولًا الدقة (لا تتجاوز المطلوبة)،
        // ثم - إن كان "جاهز للمونتاج" مفعّلًا - نفضّل H.264 و AAC حتى لا نحتاج تحويلًا.
        let mut sort = match req.quality.as_str() {
            q @ ("2160" | "1440" | "1080" | "720" | "480" | "360") => format!("res:{q}"),
            _ => "res".to_string(),
        };
        if req.editor_ready || container == "mov" {
            sort.push_str(",vcodec:h264,acodec:aac");
        }
        a.extend([
            "-f".into(),
            "bv*+ba/b".into(),
            "-S".into(),
            sort,
            "--merge-output-format".into(),
            container.into(),
            "--remux-video".into(),
            container.into(),
        ]);
    }
    a
}

pub(super) fn download_args(
    tools: &Tools,
    cookies: Vec<String>,
    req: &DownloadRequest,
    opts: &JobOptions,
    section: Option<(f64, f64)>,
    out: &Path,
    work: &Path,
) -> Vec<String> {
    let mut a = tools::ytdlp_base_args(tools);
    a.extend(cookies);
    a.extend(format_args(req));
    if opts.rate_limit_kb > 0 {
        a.extend(["-r".into(), format!("{}K", opts.rate_limit_kb)]);
    } else {
        // HLS/DASH (تيك توك، إنستغرام، تويتر، البث المسجّل) تُجلب أجزاؤها أربعة معًا بدل واحد واحد (R2-18).
        // مع حد السرعة لا: الحد في yt-dlp لكل اتصال، فأربعة أجزاء تتجاوزه
        a.extend(["--concurrent-fragments".into(), "4".into()]);
    }
    // ملف واحد لكل مهمة: رابط قائمة أو قناة بدأ قبل وصول المعاينة كان يُنزّل القائمة كلها
    // ولا يُسلَّم منها إلا آخر ملف. أغنية سبوتيفاي (رابط بحث) تأخذ أول نتيجة بالقاعدة نفسها
    a.extend(single_item());
    let mut template = format!("{}.%(ext)s", opts.template);
    if let Some((s, e)) = section {
        // * = بالوقت (لا بالفصول). نجبر إطارات مفتاحية عند نقطتي القص حتى يكون القص دقيقًا بالإطار
        a.push("--download-sections".into());
        a.push(format!("*{}-{}", ts(s), ts(e)));
        if req.kind == "video" && !req.original {
            a.push("--force-keyframes-at-cuts".into());
        }
        template = format!("{} [{} - {}].%(ext)s", opts.template, ts_name(s), ts_name(e));
    }
    a.extend([
        "-P".into(),
        out.to_string_lossy().into_owned(),
        "-P".into(),
        format!("temp:{}", work.to_string_lossy()),
        "-o".into(),
        template,
        "--windows-filenames".into(), // أسماء ملفات تصلح على كل الأنظمة
        "--trim-filenames".into(),
        opts.max_name.to_string(),
        "--no-mtime".into(),          // تاريخ الملف = وقت التنزيل (أسهل للفرز في المجلد)
        "--newline".into(),
        "--progress".into(),
        "--no-simulate".into(),
        // أسطر تقدّم بصيغة نحن نحددها، لنقرأها بسهولة
        "--progress-template".into(),
        "download:KHAMA_DL %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.vcodec)s|%(info.acodec)s|%(progress.fragment_index)s|%(progress.fragment_count)s".into(),
        "--progress-template".into(),
        "postprocess:KHAMA_PP %(progress.status)s|%(progress.postprocessor)s".into(),
        "--print".into(),
        "after_move:KHAMA_FILE %(filepath)s".into(),
        // العنوان والصورة أثناء التنزيل، فلا نحتاج معاينة ثانية للسجلّ إن بدأ التنزيل قبلها (T-43)
        "--print".into(),
        "before_dl:KHAMA_META %(.{title,thumbnail})j".into(),
        "--".into(), // ما بعده رابط وليس خيارًا (حماية من روابط تبدأ بـ -)
        req.url.clone(),
    ]);
    a
}
