//! الأخطاء: نحوّل أخطاء yt-dlp و ffmpeg التقنية إلى "رمز" مفهوم (مثل privateVideo).
//!
//! لماذا رمز وليس نصًا؟ لأن الواجهة تدعم لغتين (الإنجليزية والعربية).
//! Rust يحدد نوع الخطأ فقط، والواجهة تعرضه بلغة المستخدم (انظر src/i18n.ts → errors).
//! ونحتفظ بالنص الأصلي في "detail" ليظهر تحت "تفاصيل تقنية".

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct AppError {
    /// رمز الخطأ، يُترجم في الواجهة
    pub code: &'static str,
    /// قيمة تُدرج في الرسالة إن لزم (مثل اسم الأداة الناقصة)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param: Option<String>,
    /// النص التقني الأصلي
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            param: None,
            detail: None,
        }
    }
    pub fn with_detail(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            param: None,
            detail: Some(detail.into()),
        }
    }
    pub fn with_param(code: &'static str, param: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code,
            param: Some(param.into()),
            detail: Some(detail.into()),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code)?;
        if let Some(d) = &self.detail {
            write!(f, ": {d}")?;
        }
        Ok(())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::with_detail("io", e.to_string())
    }
}

/// كل قاعدة: إن احتوى نص الخطأ (بأحرف صغيرة) على إحدى العبارات ككلمة كاملة، فهذا هو الرمز.
/// "كلمة كاملة" (T-30): "ssl" لا تطابق "classless" و"drm" لا تطابق جزءًا من كلمة أخرى.
/// الترتيب مهم: الأكثر تحديدًا أولًا. كل قاعدة لها مثال حقيقي في الاختبارات أسفل الملف.
const RULES: &[(&[&str], &str)] = &[
    (
        &["unsupported url", "is not a valid url", "no suitable extractor"],
        "unsupportedUrl",
    ),
    (&["drm"], "drm"),
    // --abort-on-unavailable-fragments (R3-F2): «fragment 12 not found, unable to continue»، أو جزء
    // لم يصل بعد كل المحاولات: «Got error: HTTP Error 404: File not found. Giving up after 15 retries»
    // (قبل قاعدة unavailable: الـ 404 هنا لجزء من الملف لا للفيديو)
    (&["not found, unable to continue", "giving up after"], "incomplete"),
    (&["private video", "this video is private"], "privateVideo"),
    (
        &["confirm your age", "age-restricted", "inappropriate for some users"],
        "ageRestricted",
    ),
    (&["not a bot", "sign in to confirm"], "botCheck"),
    (
        &["members-only", "join this channel", "requires payment", "premium", "subscriber"],
        "membersOnly",
    ),
    (
        &["login required", "log in", "login to", "requires authentication", "--cookies"],
        "loginRequired",
    ),
    (&["available in your country", "geo restrict", "geo-restrict"], "geoBlocked"),
    (
        &[
            "video unavailable",
            "video is unavailable",
            // «[dailymotion] x0000000: Not found.» (A-53)؛ بالنقطتين حتى لا تطابق «ffmpeg not found»
            ": not found.",
            "has been removed",
            "no longer available",
            "does not exist",
            "http error 404",
        ],
        "unavailable",
    ),
    (&["live event will begin", "premieres in", "this live"], "live"),
    (
        &["requested format is not available", "no video formats found"],
        "formatUnavailable",
    ),
    (&["http error 429", "too many requests", "rate-limit", "rate limit"], "rateLimited"),
    (&["http error 403", "forbidden"], "forbidden"),
    (
        &[
            "unable to download webpage",
            "getaddrinfo",
            "name or service not known",
            "connection refused",
            "timed out",
            "network is unreachable",
            "connection reset",
            "temporary failure in name resolution",
            "ssl",
        ],
        "network",
    ),
    (
        &[
            "cookie database",
            "cookies database",
            "failed to decrypt",
            "could not find firefox",
            "could not find chrome",
            "could not find edge",
            "could not find brave",
            "unsupported browser",
        ],
        "cookiesRead",
    ),
    (&["permission denied", "access is denied", "errno 13"], "permission"),
    (&["no space left", "errno 28", "not enough space"], "diskFull"),
    (&["ffmpeg", "postprocessing", "conversion failed"], "postprocess"),
    (
        &[
            "unable to extract",
            "nsig",
            "signature",
            "player response",
            "please report this issue",
        ],
        "extractorOutdated",
    ),
];

/// أسباب فشل FFmpeg الشائعة (U-42): بدل «فشل التحويل» العامة، سبب وحلّ.
/// تُفحص بالترتيب على stderr كاملًا بحروف صغيرة.
const FFMPEG_RULES: &[(&[&str], &str)] = &[
    (&["no space left", "not enough space", "disk full"], "diskFull"),
    (&["permission denied", "access is denied"], "permission"),
    (&["not divisible by 2", "width not divisible", "height not divisible"], "oddSize"),
    (&["moov atom not found", "invalid data found when processing input"], "fileCorrupt"),
    (
        &["does not contain any stream", "output file is empty", "matches no streams"],
        "noStreams",
    ),
    // آخرها: أي فشل والترميز بكرت الشاشة مستعمل، بعد استبعاد الأسباب المحددة فوقه
    (
        &[
            "no nvenc capable devices",
            "openencodesessionex failed",
            "cannot load nvcuda",
            "cannot load libcuda",
            "nvenc",
            "_amf",
            "_qsv",
            "videotoolbox",
        ],
        "hwEncoder",
    ),
];

/// سبب فشل FFmpeg إن عرفناه، وإلا fallback (encodeFailed أو convertFailed أو postprocess)
pub fn ffmpeg_error(stderr: &str, fallback: &'static str, detail_lines: usize) -> AppError {
    let lower = stderr.to_lowercase();
    let code = FFMPEG_RULES
        .iter()
        .find(|(needles, _)| needles.iter().any(|n| lower.contains(n)))
        .map_or(fallback, |(_, code)| *code);
    AppError::with_detail(code, tail(stderr, detail_lines))
}

/// يحوّل مخرجات الخطأ الخام من yt-dlp إلى رمز خطأ + التفاصيل.
pub fn friendly_ytdlp_error(raw: &str) -> AppError {
    // نأخذ سطور ERROR تحديدًا إن وُجدت، فهي الأدق
    let error_lines: Vec<&str> = raw.lines().filter(|l| l.contains("ERROR")).collect();
    let focus = if error_lines.is_empty() {
        raw.to_string()
    } else {
        error_lines.join("\n")
    };
    let lower = focus.to_lowercase();

    let code = RULES
        .iter()
        .find(|(needles, _)| needles.iter().any(|n| contains_word(&lower, n)))
        .map(|(_, code)| *code)
        .unwrap_or("unknown");
    // فشل المعالجة بعد التنزيل: FFmpeg يطبع سببه في السطور التي قبل ERROR (U-42)
    if code == "postprocess" {
        return ffmpeg_error(raw, "postprocess", 12);
    }
    AppError::with_detail(code, tail(&focus, 12))
}

/// هل في النص العبارة `needle` بحيث لا يلتصق بطرفيها حرف أو رقم؟
fn contains_word(hay: &str, needle: &str) -> bool {
    let is_word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    let edge_start = is_word(needle.chars().next());
    let edge_end = is_word(needle.chars().next_back());
    hay.match_indices(needle).any(|(i, _)| {
        let before = hay[..i].chars().next_back();
        let after = hay[i + needle.len()..].chars().next();
        !(edge_start && is_word(before)) && !(edge_end && is_word(after))
    })
}

/// آخر n سطر من نص (لعرض التفاصيل دون إغراق الواجهة)
pub fn tail(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// دقة تصنيف الأخطاء على رسائل yt-dlp حقيقية (A-53). كل ملف في المجلد: <رقم>_<الرمز المتوقع>.txt
    /// وفيه stderr كما خرج من yt-dlp. KHAMA_ERRS=<مجلد> cargo test -- --ignored classify_real_errors --nocapture
    #[test]
    #[ignore]
    fn classify_real_errors() {
        let dir = std::env::var("KHAMA_ERRS").expect("KHAMA_ERRS");
        let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        let (mut n, mut right) = (0, 0);
        for f in files {
            let text = std::fs::read_to_string(&f).unwrap();
            let name = f.file_stem().unwrap().to_string_lossy().into_owned();
            let expected = name.split_once('_').map(|x| x.1).unwrap_or("");
            if expected == "ok" || text.trim().is_empty() {
                continue;
            }
            let got = friendly_ytdlp_error(&text).code;
            n += 1;
            right += usize::from(got == expected);
            println!("{} {name:<28} -> {got}", if got == expected { "✓" } else { "✗" });
        }
        println!("{right}/{n} correct");
    }

    /// رسائل حقيقية صُنّفت «unknown» في تقييم A-53
    #[test]
    fn maps_real_unavailable_messages() {
        assert_eq!(
            friendly_ytdlp_error("ERROR: [youtube] aaaaaaaaaaa: This video is unavailable").code,
            "unavailable"
        );
        assert_eq!(
            friendly_ytdlp_error("ERROR: [dailymotion] x0000000: Not found.").code,
            "unavailable"
        );
        assert_ne!(
            friendly_ytdlp_error("ERROR: ffmpeg not found. Please install or provide the path").code,
            "unavailable"
        );
    }

    #[test]
    fn maps_unsupported_url() {
        assert_eq!(
            friendly_ytdlp_error("ERROR: Unsupported URL: https://example.com/").code,
            "unsupportedUrl"
        );
    }

    #[test]
    fn maps_private_video() {
        let e = friendly_ytdlp_error("ERROR: [youtube] abc: Private video. Sign in if you've been granted access");
        assert_eq!(e.code, "privateVideo");
    }

    #[test]
    fn maps_bot_check() {
        assert_eq!(
            friendly_ytdlp_error("ERROR: [youtube] x: Sign in to confirm you’re not a bot.").code,
            "botCheck"
        );
    }

    /// مثال حقيقي (من رسائل yt-dlp) لكل قاعدة، فلا تُضاف قاعدة أو تُغيَّر بلا اختبار (T-30)
    #[test]
    fn every_rule_has_a_real_example() {
        let cases = [
            ("ERROR: [generic] Unsupported URL: https://example.com/", "unsupportedUrl"),
            ("ERROR: [generic] x: This video is DRM protected", "drm"),
            ("ERROR: fragment 12 not found, unable to continue", "incomplete"),
            (
                "ERROR: [download] Got error: HTTP Error 404: File not found. Giving up after 15 retries",
                "incomplete",
            ),
            (
                "ERROR: [youtube] x: Private video. Sign in if you've been granted access",
                "privateVideo",
            ),
            (
                "ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.",
                "ageRestricted",
            ),
            ("ERROR: [youtube] x: Sign in to confirm you’re not a bot.", "botCheck"),
            (
                "ERROR: [youtube] x: Join this channel to get access to members-only content like this video",
                "membersOnly",
            ),
            (
                "ERROR: [instagram] x: Requested content is not available, rate-limit reached or login required",
                "loginRequired",
            ),
            (
                "ERROR: [youtube] x: The uploader has not made this video available in your country",
                "geoBlocked",
            ),
            (
                "ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader",
                "unavailable",
            ),
            ("ERROR: [youtube] x: This live event will begin in 3 hours.", "live"),
            (
                "ERROR: [youtube] x: Requested format is not available. Use --list-formats",
                "formatUnavailable",
            ),
            (
                "ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests",
                "rateLimited",
            ),
            ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "forbidden"),
            (
                "ERROR: [youtube] x: Unable to download API page: <urlopen error [Errno 11001] getaddrinfo failed>",
                "network",
            ),
            ("ERROR: [generic] x: <urlopen error [SSL: CERTIFICATE_VERIFY_FAILED]>", "network"),
            (
                "ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271",
                "cookiesRead",
            ),
            ("ERROR: unable to open for writing: [Errno 13] Permission denied", "permission"),
            ("ERROR: unable to write data: [Errno 28] No space left on device", "diskFull"),
            ("ERROR: Postprocessing: Conversion failed!", "postprocess"),
            (
                "ERROR: [youtube] x: Unable to extract nsig function code; please report this issue",
                "extractorOutdated",
            ),
        ];
        for (raw, code) in cases {
            assert_eq!(friendly_ytdlp_error(raw).code, code, "{raw}");
        }
        // كل رمز في الجدول له مثال
        for (_, code) in RULES {
            assert!(cases.iter().any(|(_, c)| c == code), "لا مثال لـ {code}");
        }
    }

    #[test]
    fn needles_match_whole_words_only() {
        assert_eq!(
            friendly_ytdlp_error("ERROR: [youtube] x: Classless video failed oddly").code,
            "unknown"
        );
        assert_eq!(friendly_ytdlp_error("ERROR: [x] Hydrma premiumness").code, "unknown");
        assert!(contains_word("errno 13] permission denied", "permission denied"));
        assert!(contains_word("use --cookies to", "--cookies"));
        assert!(!contains_word("signatures", "signature"));
    }

    #[test]
    fn ffmpeg_causes() {
        let code = |e: &str| ffmpeg_error(e, "encodeFailed", 5).code;
        assert_eq!(
            code(
                "[mov] moov atom not found
x.mp4: Invalid data found when processing input"
            ),
            "fileCorrupt"
        );
        assert_eq!(code("[h264_nvenc] OpenEncodeSessionEx failed: out of memory"), "hwEncoder");
        assert_eq!(
            code(
                "[libx264] width not divisible by 2 (1081x720)
Error while opening encoder"
            ),
            "oddSize"
        );
        assert_eq!(code("av_interleaved_write_frame(): No space left on device"), "diskFull");
        assert_eq!(code("something else entirely"), "encodeFailed");
        assert_eq!(
            friendly_ytdlp_error(
                "[h264_nvenc] No NVENC capable devices found
ERROR: Postprocessing: Conversion failed!"
            )
            .code,
            "hwEncoder"
        );
    }

    #[test]
    fn unknown_error_has_fallback_and_detail() {
        let e = friendly_ytdlp_error("ERROR: something weird");
        assert_eq!(e.code, "unknown");
        assert_eq!(e.detail.as_deref(), Some("ERROR: something weird"));
    }
}

/// قفل لا يُسقط التطبيق (T-28): إن انهارت مهمة وهي تمسك القفل نكمل بالقيمة الموجودة
/// بدل أن ينهار كل من يحاول القفل بعدها.
pub trait LockExt<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockExt<T> for std::sync::Mutex<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod lock_tests {
    use super::LockExt;
    use std::sync::{Arc, Mutex};

    #[test]
    fn lock_ok_recovers_after_a_panic_while_locked() {
        let m = Arc::new(Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("مهمة انهارت وهي تمسك القفل");
        })
        .join();
        assert!(m.is_poisoned());
        *m.lock_ok() += 1;
        assert_eq!(*m.lock_ok(), 2);
    }
}
