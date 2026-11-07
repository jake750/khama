//! ترجمة أخطاء yt-dlp و ffmpeg التقنية إلى رسائل عربية مفهومة.
//!
//! الفكرة: نقرأ آخر سطور الخطأ من yt-dlp، ونبحث فيها عن عبارات معروفة.
//! نعرض للمستخدم الرسالة العربية، ونحتفظ بالنص الأصلي في "تفاصيل تقنية"
//! لمن أراد أن يبحث عنه أو يرسله في بلاغ.

use serde::Serialize;

/// الخطأ كما يصل للواجهة: رسالة عربية + التفاصيل التقنية الأصلية (اختيارية)
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub message: String,
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), detail: None }
    }
    pub fn with_detail(message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self { message: message.into(), detail: Some(detail.into()) }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::with_detail("حدث خطأ في قراءة أو كتابة الملفات.", e.to_string())
    }
}

/// كل قاعدة: إن احتوى نص الخطأ (بأحرف صغيرة) على إحدى العبارات، نعرض هذه الرسالة.
/// الترتيب مهم: الأكثر تحديدًا أولًا.
const RULES: &[(&[&str], &str)] = &[
    (
        &["unsupported url", "is not a valid url", "no suitable extractor"],
        "هذا الرابط غير مدعوم. تأكد أنه رابط صفحة الفيديو نفسها وليس رابطًا مختصرًا أو صفحة بحث.",
    ),
    (
        &["drm", "this video is drm protected"],
        "هذا المحتوى محمي بنظام DRM، ولا تدعم الأداة تنزيله.",
    ),
    (
        &["private video", "this video is private"],
        "هذا الفيديو خاص، ولا يمكن تنزيله إلا لمن يملك صلاحية مشاهدته.",
    ),
    (
        &["confirm your age", "age-restricted", "inappropriate for some users"],
        "هذا الفيديو مقيّد بالعمر. فعّل الكوكيز من الإعدادات (بعد تسجيل دخولك في المتصفح) ثم أعد المحاولة.",
    ),
    (
        &["not a bot", "sign in to confirm"],
        "يوتيوب يطلب التحقق من أنك لست برنامجًا آليًا. فعّل الكوكيز من الإعدادات، أو انتظر قليلًا ثم أعد المحاولة.",
    ),
    (
        &["members-only", "join this channel", "requires payment", "premium", "subscriber"],
        "هذا المحتوى للأعضاء أو المشتركين المدفوعين فقط، ولا تتحايل الأداة على ذلك.",
    ),
    (
        &["login required", "log in", "login to", "requires authentication", "--cookies"],
        "الموقع يطلب تسجيل الدخول لعرض هذا المحتوى. يمكنك تفعيل الكوكيز من الإعدادات إن كان لك حق الوصول إليه.",
    ),
    (
        &["video unavailable", "has been removed", "no longer available", "does not exist", "http error 404"],
        "الفيديو غير متاح: ربما حُذف، أو أن الرابط خاطئ، أو أنه غير متاح في بلدك.",
    ),
    (
        &["not available in your country", "geo restrict", "geo-restrict"],
        "هذا المحتوى غير متاح في منطقتك الجغرافية.",
    ),
    (
        &["live event will begin", "premieres in", "is_live", "this live"],
        "هذا بث مباشر لم يبدأ بعد أو ما زال جاريًا. انتظر حتى ينتهي ثم أعد المحاولة.",
    ),
    (
        &["requested format is not available", "no video formats found"],
        "الجودة أو الصيغة المطلوبة غير متوفرة لهذا الفيديو. جرّب «الأفضل» أو جودة أقل.",
    ),
    (
        &["http error 429", "too many requests", "rate-limit", "rate limit"],
        "الموقع رفض الطلبات مؤقتًا بسبب كثرتها. انتظر بضع دقائق ثم أعد المحاولة.",
    ),
    (
        &["http error 403", "forbidden"],
        "الموقع رفض التنزيل (403). غالبًا يحل المشكلة تحديث yt-dlp من الإعدادات ← الأدوات.",
    ),
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
        "تعذّر الاتصال بالموقع. تحقق من اتصالك بالإنترنت ثم أعد المحاولة.",
    ),
    (
        &["cookie database", "cookies database", "failed to decrypt", "could not find firefox", "could not find chrome", "could not find edge", "could not find brave", "unsupported browser"],
        "تعذّرت قراءة الكوكيز من المتصفح. أغلق المتصفح تمامًا ثم أعد المحاولة، أو استخدم Firefox، أو الصق الكوكيز يدويًا.",
    ),
    (
        &["permission denied", "access is denied", "errno 13"],
        "لا توجد صلاحية للكتابة في مجلد الحفظ. اختر مجلدًا آخر من الإعدادات.",
    ),
    (
        &["no space left", "errno 28", "not enough space"],
        "لا توجد مساحة كافية على القرص.",
    ),
    (
        &["ffmpeg", "postprocessing", "conversion failed"],
        "اكتمل التنزيل لكن فشلت معالجة الملف (الدمج أو التحويل).",
    ),
    (
        &["unable to extract", "nsig", "signature", "player response", "please report this issue"],
        "الموقع غيّر طريقة عمله ولم تعد النسخة الحالية من yt-dlp تفهمه. حدّث yt-dlp من الإعدادات ← الأدوات ثم أعد المحاولة.",
    ),
];

/// يحوّل مخرجات الخطأ الخام من yt-dlp إلى رسالة عربية.
pub fn friendly_ytdlp_error(raw: &str) -> AppError {
    // نأخذ سطور ERROR تحديدًا إن وُجدت، فهي الأدق
    let error_lines: Vec<&str> = raw.lines().filter(|l| l.contains("ERROR")).collect();
    let focus = if error_lines.is_empty() { raw.to_string() } else { error_lines.join("\n") };
    let lower = focus.to_lowercase();

    let message = RULES
        .iter()
        .find(|(needles, _)| needles.iter().any(|n| lower.contains(n)))
        .map(|(_, msg)| *msg)
        .unwrap_or("حدث خطأ غير متوقع أثناء التنزيل. اطّلع على التفاصيل التقنية، وجرّب تحديث yt-dlp من الإعدادات.");

    let detail = tail(&focus, 12);
    AppError::with_detail(message, detail)
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
        let e = friendly_ytdlp_error("ERROR: Unsupported URL: https://example.com/");
        assert!(e.message.contains("غير مدعوم"));
    }

    #[test]
    fn maps_private_video() {
        let e = friendly_ytdlp_error("ERROR: [youtube] abc: Private video. Sign in if you've been granted access");
        assert!(e.message.contains("خاص"));
    }

    #[test]
    fn maps_bot_check() {
        let e = friendly_ytdlp_error("ERROR: [youtube] x: Sign in to confirm you’re not a bot.");
        assert!(e.message.contains("آليًا"));
    }

    #[test]
    fn unknown_error_has_fallback_and_detail() {
        let e = friendly_ytdlp_error("ERROR: something weird");
        assert!(e.message.contains("غير متوقع"));
        assert_eq!(e.detail.as_deref(), Some("ERROR: something weird"));
    }
}
