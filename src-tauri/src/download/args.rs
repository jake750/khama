use super::*;

// ======================= بناء أوامر yt-dlp =======================

pub(super) fn validate_url(url: &str) -> Result<String, AppError> {
    // تحليل كامل للرابط (T-62) لا مجرد البادئة: http/https ومعه اسم موقع
    let url = url.trim();
    match tauri::Url::parse(url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty()) => Ok(url.to_string()),
        _ => Err(AppError::new("invalidUrl")),
    }
}

pub(super) fn cookie_args(app: &AppHandle, s: &Settings) -> Vec<String> {
    match s.cookies_mode.as_str() {
        "browser" if !s.cookies_browser.is_empty() => {
            vec!["--cookies-from-browser".into(), s.cookies_browser.clone()]
        }
        "file" => match settings::cookies_path(app) {
            Ok(p) if p.exists() => vec!["--cookies".into(), p.to_string_lossy().into_owned()],
            _ => vec![],
        },
        _ => vec![],
    }
}

/// خيارات اختيار الصيغة والجودة. منفصلة لتسهل قراءتها واختبارها.
pub fn format_args(req: &DownloadRequest) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    if req.original {
        // الملف الأصلي كما رفعه صاحبه (Google Drive: صيغة "source")
        a.extend(["-f", "source/b"].map(String::from));
    } else if req.kind == "audio" {
        let fmt = match req.audio_format.as_str() {
            "m4a" | "wav" => req.audio_format.as_str(),
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
    if opts.rate_limit > 0 {
        a.extend(["-r".into(), format!("{}M", opts.rate_limit)]);
    }
    // أغنية من سبوتيفاي: رابط بحث، نأخذ أول نتيجة فقط
    if req.url.starts_with(playlist::MUSIC_SEARCH) {
        a.extend(["--playlist-items".into(), "1".into()]);
    }
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
        "--".into(), // ما بعده رابط وليس خيارًا (حماية من روابط تبدأ بـ -)
        req.url.clone(),
    ]);
    a
}
