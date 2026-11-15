// ======================= الـ Presets =======================

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PKind {
    /// فيديو (+ صوت)
    Video,
    /// صوت فقط
    Audio,
    /// إطار واحد كصورة
    Frame,
    /// سلسلة صور
    Sequence,
    Gif,
    /// نسخ بلا إعادة ترميز (تغيير الحاوية / قص سريع)
    Copy,
    /// كشف (مشاهد / سواد / صمت) بلا ملف ناتج
    Detect,
    /// فصل الصوت البشري عن الموسيقى بالذكاء الاصطناعي
    Stems,
}

#[derive(Debug, Clone, Copy)]
pub struct Preset {
    pub id: &'static str,
    pub kind: PKind,
    pub ext: &'static str,
    pub suffix: &'static str,
}

pub(super) const PRESETS: &[Preset] = &[
    // للمونتاج
    Preset {
        id: "edit_h264",
        kind: PKind::Video,
        ext: "mp4",
        suffix: "edit",
    },
    Preset {
        id: "prores_proxy",
        kind: PKind::Video,
        ext: "mov",
        suffix: "ProRes Proxy",
    },
    Preset {
        id: "prores_lt",
        kind: PKind::Video,
        ext: "mov",
        suffix: "ProRes LT",
    },
    Preset {
        id: "prores_422",
        kind: PKind::Video,
        ext: "mov",
        suffix: "ProRes 422",
    },
    Preset {
        id: "prores_hq",
        kind: PKind::Video,
        ext: "mov",
        suffix: "ProRes HQ",
    },
    Preset {
        id: "prores_4444",
        kind: PKind::Video,
        ext: "mov",
        suffix: "ProRes 4444",
    },
    Preset {
        id: "dnxhr_lb",
        kind: PKind::Video,
        ext: "mov",
        suffix: "DNxHR LB",
    },
    Preset {
        id: "dnxhr_sq",
        kind: PKind::Video,
        ext: "mov",
        suffix: "DNxHR SQ",
    },
    Preset {
        id: "dnxhr_hq",
        kind: PKind::Video,
        ext: "mov",
        suffix: "DNxHR HQ",
    },
    Preset {
        id: "dnxhr_hqx",
        kind: PKind::Video,
        ext: "mov",
        suffix: "DNxHR HQX",
    },
    Preset {
        id: "proxy",
        kind: PKind::Video,
        ext: "mp4",
        suffix: "proxy",
    },
    // للنشر
    Preset {
        id: "youtube",
        kind: PKind::Video,
        ext: "mp4",
        suffix: "YouTube",
    },
    Preset {
        id: "vertical",
        kind: PKind::Video,
        ext: "mp4",
        suffix: "vertical",
    },
    Preset {
        id: "whatsapp",
        kind: PKind::Video,
        ext: "mp4",
        suffix: "small",
    },
    Preset {
        id: "h265",
        kind: PKind::Video,
        ext: "mp4",
        suffix: "H265",
    },
    Preset {
        id: "av1",
        kind: PKind::Video,
        ext: "mp4",
        suffix: "AV1",
    },
    Preset {
        id: "webm",
        kind: PKind::Video,
        ext: "webm",
        suffix: "VP9",
    },
    Preset {
        id: "gif",
        kind: PKind::Gif,
        ext: "gif",
        suffix: "gif",
    },
    // صوت
    Preset {
        id: "wav",
        kind: PKind::Audio,
        ext: "wav",
        suffix: "audio",
    },
    Preset {
        id: "mp3",
        kind: PKind::Audio,
        ext: "mp3",
        suffix: "audio",
    },
    Preset {
        id: "aac",
        kind: PKind::Audio,
        ext: "m4a",
        suffix: "audio",
    },
    Preset {
        id: "flac",
        kind: PKind::Audio,
        ext: "flac",
        suffix: "audio",
    },
    Preset {
        id: "opus",
        kind: PKind::Audio,
        ext: "opus",
        suffix: "audio",
    },
    // ext هنا افتراضي: الفيديو يبقى بحاويته، والصوت يخرج WAV
    Preset {
        id: "stem_voice",
        kind: PKind::Stems,
        ext: "wav",
        suffix: "no music",
    },
    Preset {
        id: "stem_music",
        kind: PKind::Stems,
        ext: "wav",
        suffix: "music only",
    },
    // أدوات
    Preset {
        id: "rewrap_mp4",
        kind: PKind::Copy,
        ext: "mp4",
        suffix: "rewrap",
    },
    Preset {
        id: "rewrap_mov",
        kind: PKind::Copy,
        ext: "mov",
        suffix: "rewrap",
    },
    Preset {
        id: "rewrap_mkv",
        kind: PKind::Copy,
        ext: "mkv",
        suffix: "rewrap",
    },
    Preset {
        id: "frame_png",
        kind: PKind::Frame,
        ext: "png",
        suffix: "frame",
    },
    Preset {
        id: "sequence_png",
        kind: PKind::Sequence,
        ext: "png",
        suffix: "frames",
    },
    Preset {
        id: "detect_scenes",
        kind: PKind::Detect,
        ext: "",
        suffix: "",
    },
    Preset {
        id: "detect_black",
        kind: PKind::Detect,
        ext: "",
        suffix: "",
    },
    Preset {
        id: "detect_silence",
        kind: PKind::Detect,
        ext: "",
        suffix: "",
    },
];

pub fn preset(id: &str) -> Option<Preset> {
    PRESETS.iter().copied().find(|p| p.id == id)
}
