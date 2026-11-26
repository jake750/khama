use super::*;

// ======================= الطلب =======================

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase", default)]
pub struct ConvertOptions {
    /// "high" | "balanced" | "small"
    pub quality: String,
    /// استخدم كرت الشاشة إن توفر (H.264 / H.265)
    pub hw: bool,
    /// الضلع القصير للصورة: 2160 | 1440 | 1080 | 720 | 540 | 480
    pub size: Option<u32>,
    /// قص لنسبة: "9:16" | "1:1" | "4:5" | "16:9"
    pub aspect: Option<String>,
    /// "23.976" | "24" | "25" | "29.97" | "30" | "50" | "59.94" | "60"
    pub fps: Option<String>,
    /// سرعة التشغيل 0.25–4
    pub speed: Option<f64>,
    /// "90" | "180" | "270" | "hflip" | "vflip"
    pub rotate: Option<String>,
    pub deinterlace: bool,
    pub denoise: bool,
    /// HDR ← SDR
    pub tonemap: bool,
    pub lut: Option<String>,
    pub subtitles: Option<String>,
    pub watermark: Option<String>,
    /// "tl" | "tr" | "bl" | "br" | "c"
    pub watermark_pos: Option<String>,
    pub timecode: bool,
    /// LUFS: -14 (يوتيوب/سوشال) | -16 | -23 (بث)
    pub loudness: Option<f64>,
    pub replace_audio: Option<String>,
    pub mute: bool,
    pub start: Option<f64>,
    pub end: Option<f64>,
    /// تقسيم الناتج عند هذه الأوقات (بالثواني)
    pub split_at: Vec<f64>,
    /// حذف هذه الفترات [بداية، نهاية] (بثواني المصدر) ووصل ما بينها
    pub cut: Vec<[f64; 2]>,
    /// كشف الصمت: ما هو أهدأ من هذا المستوى (dB) يُعدّ صمتًا. فارغ = −40
    pub silence_db: Option<f64>,
    /// كشف الصمت: أقل مدة (ث) حتى يُعدّ السكوت صمتًا. فارغ = 0.6
    pub silence_min: Option<f64>,
    /// عند حذف الصمت: كم ثانية تبقى بعد الكلام (ومن كل طرف إن لم يُحدَّد silence_pad_before). فارغ = 0.15
    pub silence_pad: Option<f64>,
    /// عند حذف الصمت: كم ثانية تبقى قبل الكلام. فارغ = مثل silence_pad (تستعمله الواجهة فقط)
    pub silence_pad_before: Option<f64>,
    /// تحليل المواضيع: «موازنة الترجمة مع الصوت» (توقيت كل كلمة بـ whisper.cpp حتى مع ترجمة جاهزة)
    #[serde(default)]
    pub align_speech: bool,
    /// ترجمة SRT تُكتب بجانب الناتج بالاسم نفسه (توقيتها من صفر الناتج)
    pub sidecar_srt: Option<String>,
    /// تحليل المواضيع: رابط الصفحة التي نُزّل منها الملف، لأخذ ترجمتها بدل تفريغ الكلام
    pub source_url: Option<String>,
    /// تحليل المواضيع: المدة المناسبة لريل (ث). فارغ = 15 و90 (تستعملها الواجهة فقط)
    pub reel_min: Option<f64>,
    pub reel_max: Option<f64>,
    /// مجلد ناتج محدد (مثلًا من مجلد مراقَب). فارغ = حسب الإعدادات
    pub out_dir: Option<String>,
}

impl Default for ConvertOptions {
    fn default() -> Self {
        Self {
            quality: "balanced".into(),
            hw: false,
            size: None,
            aspect: None,
            fps: None,
            speed: None,
            rotate: None,
            deinterlace: false,
            denoise: false,
            tonemap: false,
            lut: None,
            subtitles: None,
            watermark: None,
            watermark_pos: None,
            timecode: false,
            loudness: None,
            replace_audio: None,
            mute: false,
            start: None,
            end: None,
            split_at: Vec::new(),
            cut: Vec::new(),
            silence_db: None,
            silence_min: None,
            silence_pad: None,
            silence_pad_before: None,
            align_speech: false,
            sidecar_srt: None,
            source_url: None,
            reel_min: None,
            reel_max: None,
            out_dir: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ConvertRequest {
    /// أكثر من ملف = دمجها بالترتيب في ملف واحد
    pub inputs: Vec<String>,
    pub preset: String,
    #[serde(default)]
    pub options: ConvertOptions,
}
