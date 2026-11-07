//! الأخطاء: نحوّل أخطاء yt-dlp و ffmpeg التقنية إلى "رمز" مفهوم (مثل privateVideo).
//!
//! لماذا رمز وليس نصًا؟ لأن الواجهة تدعم لغتين (الإنجليزية والعربية).
//! Rust يحدد نوع الخطأ فقط، والواجهة تعرضه بلغة المستخدم (انظر src/i18n.ts → errors).
//! ونحتفظ بالنص الأصلي في "detail" ليظهر تحت "تفاصيل تقنية".

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
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
        Self { code, param: None, detail: None }
    }
    pub fn with_detail(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, param: None, detail: Some(detail.into()) }
    }
    pub fn with_param(code: &'static str, param: impl Into<String>, detail: impl Into<String>) -> Self {
        Self { code, param: Some(param.into()), detail: Some(detail.into()) }
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

/// كل قاعدة: إن احتوى نص الخطأ (بأحرف صغيرة) على إحدى العبارات، فهذا هو الرمز.
/// الترتيب مهم: الأكثر تحديدًا أولًا.
const RULES: &[(&[&str], &str)] = &[
    (&["unsupported url", "is not a valid url", "no suitable extractor"], "unsupportedUrl"),
    (&["drm"], "drm"),
    (&["private video", "this video is private"], "privateVideo"),
    (&["confirm your age", "age-restricted", "inappropriate for some users"], "ageRestricted"),
    (&["not a bot", "sign in to confirm"], "botCheck"),
    (&["members-only", "join this channel", "requires payment", "premium", "subscriber"], "membersOnly"),
    (&["login required", "log in", "login to", "requires authentication", "--cookies"], "loginRequired"),
    (&["not available in your country", "geo restrict", "geo-restrict"], "geoBlocked"),
    (&["video unavailable", "has been removed", "no longer available", "does not exist", "http error 404"], "unavailable"),
    (&["live event will begin", "premieres in", "this live"], "live"),
    (&["requested format is not available", "no video formats found"], "formatUnavailable"),
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
    (&["unable to extract", "nsig", "signature", "player response", "please report this issue"], "extractorOutdated"),
];

/// يحوّل مخرجات الخطأ الخام من yt-dlp إلى رمز خطأ + التفاصيل.
pub fn friendly_ytdlp_error(raw: &str) -> AppError {
    // نأخذ سطور ERROR تحديدًا إن وُجدت، فهي الأدق
    let error_lines: Vec<&str> = raw.lines().filter(|l| l.contains("ERROR")).collect();
    let focus = if error_lines.is_empty() { raw.to_string() } else { error_lines.join("\n") };
    let lower = focus.to_lowercase();

    let code = RULES
        .iter()
        .find(|(needles, _)| needles.iter().any(|n| lower.contains(n)))
        .map(|(_, code)| *code)
        .unwrap_or("unknown");
    AppError::with_detail(code, tail(&focus, 12))
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

    #[test]
    fn maps_unsupported_url() {
        assert_eq!(friendly_ytdlp_error("ERROR: Unsupported URL: https://example.com/").code, "unsupportedUrl");
    }

    #[test]
    fn maps_private_video() {
        let e = friendly_ytdlp_error("ERROR: [youtube] abc: Private video. Sign in if you've been granted access");
        assert_eq!(e.code, "privateVideo");
    }

    #[test]
    fn maps_bot_check() {
        assert_eq!(friendly_ytdlp_error("ERROR: [youtube] x: Sign in to confirm you’re not a bot.").code, "botCheck");
    }

    #[test]
    fn unknown_error_has_fallback_and_detail() {
        let e = friendly_ytdlp_error("ERROR: something weird");
        assert_eq!(e.code, "unknown");
        assert_eq!(e.detail.as_deref(), Some("ERROR: something weird"));
    }
}
