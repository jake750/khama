// قائمة الـ Presets كما تظهر في المحوّل: مجمّعة حسب الهدف لا حسب الكودك.
// المعرّفات والأنواع والامتدادات تطابق src-tauri/src/convert/presets.rs، ويتحقق presets.test.ts من ذلك

import type { ConvertOptions, Issue, MediaInfo } from "./api";
import type { Lang } from "./i18n";

export type PresetGroup = "edit" | "publish" | "audio" | "tools";
export type PresetKind = "video" | "audio" | "frame" | "sequence" | "gif" | "copy" | "detect" | "stems";

export interface PresetDef {
  id: string;
  group: PresetGroup;
  kind: PresetKind;
  ext: string;
  /** هل لخيار الجودة (عالية/متوازنة/صغيرة) معنى هنا؟ */
  quality: boolean;
  /** هل يدعم كرت الشاشة؟ */
  hw: boolean;
  name: Record<Lang, string>;
  desc: Record<Lang, string>;
  /** معدل البت التقريبي (Mbps) لفيديو 1080p بـ 30 إطارًا — لتقدير الحجم */
  mbps1080?: number | Record<ConvertOptions["quality"], number>;
  /** للصوت: kbps */
  kbps?: number | Record<ConvertOptions["quality"], number>;
}

const P = (d: PresetDef) => d;

export const PRESETS: PresetDef[] = [
  // ---------- للمونتاج ----------
  P({
    id: "edit_h264",
    group: "edit",
    kind: "video",
    ext: "mp4",
    quality: true,
    hw: true,
    name: { en: "H.264 for editing", ar: "H.264 للمونتاج" },
    desc: {
      en: "Always re-encodes to H.264 at a constant frame rate. Opens everywhere and fixes phone VFR sync issues.",
      ar: "يعيد الترميز دائمًا إلى H.264 بمعدل إطارات ثابت. يفتح في كل البرامج ويصلح مشاكل تزامن فيديو الجوال.",
    },
    mbps1080: { high: 16, balanced: 11, small: 6 },
  }),
  P({
    id: "prores_422",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "ProRes 422", ar: "ProRes 422" },
    desc: {
      en: "Smooth scrubbing in Premiere and Final Cut. Big files. On Windows it opens in Premiere and Resolve but not in the built-in video player.",
      ar: "تقليب سلس في Premiere وFinal Cut. ملفات كبيرة. على Windows يُفتح في Premiere وResolve لكن لا يعمل في مشغّل الفيديو المدمج.",
    },
    mbps1080: 147,
  }),
  P({
    id: "prores_hq",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "ProRes 422 HQ", ar: "ProRes 422 HQ" },
    desc: {
      en: "Higher quality for grading and heavy effects. On Windows it opens in Premiere and Resolve but not in the built-in video player.",
      ar: "جودة أعلى للتلوين والمؤثرات الثقيلة. على Windows يُفتح في Premiere وResolve لكن لا يعمل في مشغّل الفيديو المدمج.",
    },
    mbps1080: 220,
  }),
  P({
    id: "prores_lt",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "ProRes LT", ar: "ProRes LT" },
    desc: {
      en: "Lighter ProRes for long timelines. On Windows it opens in Premiere and Resolve but not in the built-in video player.",
      ar: "ProRes أخف للتايملاين الطويل. على Windows يُفتح في Premiere وResolve لكن لا يعمل في مشغّل الفيديو المدمج.",
    },
    mbps1080: 102,
  }),
  P({
    id: "prores_4444",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "ProRes 4444", ar: "ProRes 4444" },
    desc: {
      en: "Keeps transparency (alpha). For motion graphics. On Windows it opens in Premiere and Resolve but not in the built-in video player.",
      ar: "يحافظ على الشفافية (Alpha). للموشن جرافيك. على Windows يُفتح في Premiere وResolve لكن لا يعمل في مشغّل الفيديو المدمج.",
    },
    mbps1080: 330,
  }),
  P({
    id: "dnxhr_sq",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "DNxHR SQ", ar: "DNxHR SQ" },
    desc: {
      en: "Best choice for free DaVinci Resolve on Windows and Linux: the free version can't read H.264 or AAC on Linux, and DNxHR edits smoothly everywhere.",
      ar: "أفضل خيار لـ DaVinci Resolve المجاني على Windows وLinux: النسخة المجانية لا تقرأ H.264 ولا AAC على Linux، وDNxHR سلس في كل مكان.",
    },
    mbps1080: 145,
  }),
  P({
    id: "dnxhr_hq",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "DNxHR HQ", ar: "DNxHR HQ" },
    desc: { en: "Higher-quality DNxHR (8-bit).", ar: "DNxHR بجودة أعلى (\u20668-bit\u2069)." },
    mbps1080: 220,
  }),
  P({
    id: "dnxhr_hqx",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "DNxHR HQX 10-bit", ar: "DNxHR HQX 10-bit" },
    desc: {
      en: "Keeps 10-bit color for HDR and log footage. From an ordinary 8-bit source it only makes a bigger file: use HQ instead.",
      ar: "يحافظ على ألوان \u206610-bit\u2069 للقطات HDR وLog. من مصدر \u20668-bit\u2069 عادي لا يعطي إلا ملفًا أكبر: استعمل HQ بدله.",
    },
    mbps1080: 220,
  }),
  P({
    id: "dnxhr_lb",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "DNxHR LB", ar: "DNxHR LB" },
    desc: { en: "Light DNxHR, good as an offline proxy.", ar: "DNxHR خفيف، مناسب كبروكسي." },
    mbps1080: 45,
  }),
  P({
    id: "prores_proxy",
    group: "edit",
    kind: "video",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "ProRes Proxy", ar: "ProRes Proxy" },
    desc: { en: "Full-res proxy that edits fast on any machine.", ar: "بروكسي بنفس الدقة، يعمل بسرعة على أي جهاز." },
    mbps1080: 45,
  }),
  P({
    id: "proxy",
    group: "edit",
    kind: "video",
    ext: "mp4",
    quality: false,
    hw: true,
    name: { en: "Light proxy (540p)", ar: "بروكسي خفيف (540p)" },
    desc: { en: "Tiny H.264 with frequent keyframes for laptops.", ar: "H.264 صغير جدًا وسريع التقليب، للابتوب." },
    mbps1080: 2.2,
  }),

  // ---------- للنشر ----------
  P({
    id: "youtube",
    group: "publish",
    kind: "video",
    ext: "mp4",
    quality: true,
    hw: true,
    name: { en: "YouTube", ar: "يوتيوب" },
    desc: { en: "High-bitrate H.264 that survives YouTube's re-compression.", ar: "H.264 بمعدل بت عالٍ يصمد أمام ضغط يوتيوب." },
    mbps1080: { high: 18, balanced: 13, small: 8 },
  }),
  P({
    id: "vertical",
    group: "publish",
    kind: "video",
    ext: "mp4",
    quality: true,
    hw: true,
    name: { en: "Reels / TikTok / Shorts", ar: "ريلز / تيك توك / شورتس" },
    desc: { en: "Crops to 9:16 and sizes to 1080 wide.", ar: "يقص إلى 9:16 بعرض 1080." },
    mbps1080: { high: 14, balanced: 10, small: 6 },
  }),
  P({
    id: "whatsapp",
    group: "publish",
    kind: "video",
    ext: "mp4",
    quality: true,
    hw: true,
    name: { en: "Small (WhatsApp, email)", ar: "حجم صغير (واتساب، بريد)" },
    desc: { en: "720p, as small as it reasonably gets.", ar: "720p بأصغر حجم معقول." },
    mbps1080: { high: 4, balanced: 2.6, small: 1.6 },
  }),
  P({
    id: "h265",
    group: "publish",
    kind: "video",
    ext: "mp4",
    quality: true,
    hw: true,
    name: { en: "H.265 / HEVC", ar: "H.265 / HEVC" },
    desc: { en: "Same quality at about half the size. For archiving and sharing.", ar: "نفس الجودة بنصف الحجم تقريبًا. للأرشفة والمشاركة." },
    mbps1080: { high: 9, balanced: 5.5, small: 3 },
  }),
  P({
    id: "av1",
    group: "publish",
    kind: "video",
    ext: "mp4",
    quality: true,
    hw: false,
    name: { en: "AV1", ar: "AV1" },
    desc: { en: "Smallest files for the web. Slow to edit.", ar: "أصغر ملفات للويب. ثقيل في المونتاج." },
    mbps1080: { high: 6, balanced: 3.5, small: 2 },
  }),
  P({
    id: "webm",
    group: "publish",
    kind: "video",
    ext: "webm",
    quality: true,
    hw: false,
    name: { en: "WebM (VP9)", ar: "WebM ‏(VP9)" },
    desc: { en: "For websites and browsers.", ar: "للمواقع والمتصفحات." },
    mbps1080: { high: 7, balanced: 4, small: 2.2 },
  }),
  P({
    id: "gif",
    group: "publish",
    kind: "gif",
    ext: "gif",
    quality: false,
    hw: false,
    name: { en: "GIF", ar: "GIF" },
    desc: {
      en: "256-color palette built from the clip, 15 fps, 360p. Change the frame rate and size below. Keep it short: GIFs get big fast.",
      ar: "لوحة 256 لونًا مبنية من المقطع، 15 إطارًا، 360p. غيّر الإطارات والمقاس في الأسفل. اجعله قصيرًا: GIF يكبر بسرعة.",
    },
  }),

  // ---------- صوت ----------
  P({
    id: "stem_voice",
    group: "audio",
    kind: "stems",
    ext: "wav",
    quality: false,
    hw: false,
    name: { en: "Remove music (AI)", ar: "إزالة الموسيقى (ذكاء اصطناعي)" },
    desc: {
      en: "Keeps only voices. Video stays as is with the new audio.",
      ar: "يُبقي الأصوات البشرية فقط. الفيديو يبقى كما هو بالصوت الجديد.",
    },
  }),
  P({
    id: "stem_music",
    group: "audio",
    kind: "stems",
    ext: "wav",
    quality: false,
    hw: false,
    name: { en: "Remove voice (AI)", ar: "إزالة الصوت البشري (ذكاء اصطناعي)" },
    desc: { en: "Keeps only the music — an instant instrumental.", ar: "يُبقي الموسيقى فقط، نسخة بلا غناء." },
  }),
  // R3-F21: مرور واحد للنموذج بدل اثنين. الفيديو بمسارين، والصوت ملفان
  P({
    id: "stem_both",
    group: "audio",
    kind: "stems",
    ext: "wav",
    quality: false,
    hw: false,
    name: { en: "Voice and music apart (AI)", ar: "الحوار والموسيقى منفصلين (ذكاء اصطناعي)" },
    desc: {
      en: "One pass, both parts: a video gets two audio tracks, an audio file becomes two WAVs.",
      ar: "مرور واحد يُخرج الجزأين: الفيديو بمسارين صوتيين، والملف الصوتي ملفّا WAV.",
    },
  }),
  P({
    id: "stem_lead",
    group: "audio",
    kind: "stems",
    ext: "wav",
    quality: false,
    hw: false,
    name: { en: "Lead voice only (AI)", ar: "الصوت الأساسي وحده (ذكاء اصطناعي)" },
    desc: {
      en: "Keeps the main singer or speaker and drops the music, the chorus and backing voices (KARA_2, a 53 MB model downloaded once). Best for nasheeds and songs with a choir.",
      ar: "يُبقي المنشد أو المتكلم الأساسي ويُسقط الموسيقى والمرددين والأصوات الخلفية (KARA_2، نموذج 53 MB يُنزَّل مرة واحدة). الأنسب للأناشيد والأغاني التي فيها كورال.",
    },
  }),
  P({
    id: "denoise_voice",
    group: "audio",
    kind: "stems",
    ext: "wav",
    quality: false,
    hw: false,
    name: { en: "Remove noise from speech", ar: "إزالة الضجيج من الكلام" },
    desc: {
      en: "RNNoise cleans room noise, hum and hiss between and under the words (a 300 KB model, downloaded once). Fast: about a minute of audio per second. Video is copied as is.",
      ar: "RNNoise يزيل ضجيج الغرفة والطنين والهسهسة بين الكلمات وتحتها (نموذج 300 KB يُنزَّل مرة واحدة). سريع: نحو دقيقة صوت في الثانية. الفيديو يُنسخ كما هو.",
    },
  }),
  P({
    id: "wav",
    group: "audio",
    kind: "audio",
    ext: "wav",
    quality: false,
    hw: false,
    name: { en: "WAV", ar: "WAV" },
    desc: { en: "Uncompressed. Best for editing and mixing.", ar: "بلا ضغط. الأفضل للمونتاج والمكس." },
  }),
  P({
    id: "mp3",
    group: "audio",
    kind: "audio",
    ext: "mp3",
    quality: true,
    hw: false,
    name: { en: "MP3", ar: "MP3" },
    desc: { en: "Plays everywhere.", ar: "يعمل في كل مكان." },
    kbps: { high: 320, balanced: 256, small: 160 },
  }),
  P({
    id: "aac",
    group: "audio",
    kind: "audio",
    ext: "m4a",
    quality: true,
    hw: false,
    name: { en: "AAC (M4A)", ar: "AAC ‏(M4A)" },
    desc: { en: "Better than MP3 at the same size.", ar: "أفضل من MP3 بنفس الحجم." },
    kbps: { high: 320, balanced: 256, small: 160 },
  }),
  P({
    id: "flac",
    group: "audio",
    kind: "audio",
    ext: "flac",
    quality: false,
    hw: false,
    name: { en: "FLAC", ar: "FLAC" },
    desc: { en: "Lossless and about half the size of WAV.", ar: "بلا فقدان وبنصف حجم WAV تقريبًا." },
  }),
  P({
    id: "opus",
    group: "audio",
    kind: "audio",
    ext: "opus",
    quality: true,
    hw: false,
    name: { en: "Opus", ar: "Opus" },
    desc: { en: "Very small for voice and podcasts.", ar: "صغير جدًا للصوت والبودكاست." },
    kbps: { high: 192, balanced: 128, small: 96 },
  }),

  // ---------- أدوات ----------
  P({
    id: "rewrap_mp4",
    group: "tools",
    kind: "copy",
    ext: "mp4",
    quality: false,
    hw: false,
    name: { en: "Rewrap to MP4", ar: "تغيير الحاوية إلى MP4" },
    desc: {
      en: "No re-encoding, takes seconds. A trim lands on the nearest keyframe, which can be a few seconds off.",
      ar: "بلا إعادة ترميز، ثوانٍ فقط. القص يقع على أقرب إطار مفتاحي، وقد يبتعد بضع ثوانٍ.",
    },
  }),
  P({
    id: "rewrap_mov",
    group: "tools",
    kind: "copy",
    ext: "mov",
    quality: false,
    hw: false,
    name: { en: "Rewrap to MOV", ar: "تغيير الحاوية إلى MOV" },
    desc: {
      en: "Same streams in a MOV file, no re-encoding. A trim lands on the nearest keyframe.",
      ar: "نفس المحتوى داخل ملف MOV بلا إعادة ترميز. القص يقع على أقرب إطار مفتاحي.",
    },
  }),
  P({
    id: "rewrap_mkv",
    group: "tools",
    kind: "copy",
    ext: "mkv",
    quality: false,
    hw: false,
    name: { en: "Rewrap to MKV", ar: "تغيير الحاوية إلى MKV" },
    desc: {
      en: "Holds any codec, no re-encoding. A trim lands on the nearest keyframe.",
      ar: "يقبل أي كودك، بلا إعادة ترميز. القص يقع على أقرب إطار مفتاحي.",
    },
  }),
  P({
    id: "frame_png",
    group: "tools",
    kind: "frame",
    ext: "png",
    quality: false,
    hw: false,
    name: { en: "Grab a frame (PNG)", ar: "التقاط إطار (PNG)" },
    desc: { en: "Saves the frame at the start point as a full-res still.", ar: "يحفظ الإطار عند نقطة البداية كصورة بالدقة الكاملة." },
  }),
  P({
    id: "sequence_png",
    group: "tools",
    kind: "sequence",
    ext: "png",
    quality: false,
    hw: false,
    name: { en: "Image sequence (PNG)", ar: "سلسلة صور (PNG)" },
    desc: {
      en: "Every frame as a PNG (name_00001.png …) in a new folder named after the file. 10 s at 30 fps is 300 files.",
      ar: "كل إطار كصورة PNG (الاسم_00001.png …) في مجلد جديد باسم الملف. 10 ث بـ 30 إطارًا = 300 ملف.",
    },
  }),
  P({
    id: "detect_scenes",
    group: "tools",
    kind: "detect",
    ext: "",
    quality: false,
    hw: false,
    name: { en: "Find scene cuts", ar: "كشف تغيّر المشاهد" },
    desc: {
      en: "Lists the time of every cut (a picture change above 32%) under the file in the jobs list. Copy them, or split the file there.",
      ar: "يكتب وقت كل قطع (تغيّر في الصورة فوق 32%) تحت الملف في قائمة المهام. انسخها، أو قسّم الملف عندها.",
    },
  }),
  P({
    id: "detect_black",
    group: "tools",
    kind: "detect",
    ext: "",
    quality: false,
    hw: false,
    name: { en: "Find black frames", ar: "كشف الشاشات السوداء" },
    desc: {
      en: "Finds black gaps of 0.3 s or more (dropped signal, leftover slates), lists their times under the file in the jobs list, and can cut them out.",
      ar: "يجد الفراغات السوداء من 0.3 ث فأكثر (انقطاع، أو بقايا في البداية والنهاية)، ويكتب أوقاتها تحت الملف في قائمة المهام، ويحذفها إن أردت.",
    },
  }),
  P({
    id: "detect_silence",
    group: "tools",
    kind: "detect",
    ext: "",
    quality: false,
    hw: false,
    name: { en: "Find silences", ar: "كشف الصمت" },
    desc: {
      en: "Finds pauses of 0.6 s or longer, measured against each file’s own background noise (or a level you pick), lists them under the file in the jobs list, and can cut them out. Handy for talking-head videos.",
      ar: "يجد فترات السكوت من 0.6 ث فأكثر، مقيسة على ضجيج الخلفية في الملف نفسه (أو مستوى تختاره)، ويكتبها تحت الملف في قائمة المهام، ويحذفها إن أردت. مفيد لفيديوهات الكلام.",
    },
  }),
  P({
    id: "topics",
    group: "tools",
    kind: "detect",
    ext: "",
    quality: false,
    hw: false,
    name: { en: "Find topics (for Reels)", ar: "استخراج المواضيع (للريلز)" },
    desc: {
      en: "Reads the speech (subtitles, or transcribes it), splits it into topics with start and end times, marks the ones that fit a Reel, and shows each one's length before and after removing silences. Export any topic as a clip.",
      ar: "يقرأ الكلام (من الترجمة، أو يفرّغه)، ويقسّمه إلى مواضيع ببدايتها ونهايتها، ويحدّد ما يصلح منها ريلًا، ويعرض مدة كل موضوع قبل حذف الصمت وبعده. صدّر أي موضوع مقطعًا مستقلًا.",
    },
  }),
];

// قاعدة الأسماء (F-95): أسماء الصيغ والكودكات تبقى كما هي (ProRes 422 HQ، DNxHR SQ)،
// والأسماء التي تصف غرضًا تُترجم (H.264 للمونتاج، يوتيوب)، والأوصاف تُترجم دائمًا.
export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

export const GROUPS: PresetGroup[] = ["edit", "publish", "audio", "tools"];

/** هل يمكن تطبيق هذا الـ Preset على هذا الملف؟ */
export function presetFits(p: PresetDef, m?: MediaInfo | null): boolean {
  if (!m) return true;
  if (p.id === "detect_silence" || p.id === "topics") return m.audio.length > 0;
  if (p.kind === "audio" || p.kind === "stems") return m.audio.length > 0;
  if (p.kind === "copy") return true;
  return !!m.video;
}

/** اقتراح تلقائي حسب مشاكل الملف */
export function suggestPreset(issues: Issue[]): string | null {
  return suggestReason(issues)?.preset ?? null;
}

/** الاقتراح وسببه: المشكلة التي جعلتنا نقترحه، لتُكتب بجانبه (F-38) */
export function suggestReason(issues: Issue[]): { preset: string; issue: Issue } | null {
  for (const [issue, preset] of [
    ["resolveFreeAudio", "dnxhr_sq"],
    ["hdr", "dnxhr_hqx"],
    ["vfr", "edit_h264"],
    ["heavyCodec", "edit_h264"],
  ] as const) {
    if (issues.includes(issue)) return { preset, issue };
  }
  return null;
}

/** تقدير الحجم بالبايت (تقريبي جدًا للكودكات بجودة متغيرة) */
export function estimateSize(p: PresetDef, m: MediaInfo, o: ConvertOptions): number | null {
  const span = Math.max(0, (o.end ?? m.duration ?? 0) - (o.start ?? 0)) / (o.speed || 1);
  if (!span) return null;
  const pick = (v: number | Record<string, number> | undefined) => (typeof v === "object" ? v[o.quality] : v);
  let audioKbps = 0;
  if (!o.mute && m.audio.length) {
    if (p.kind === "audio") {
      const k = pick(p.kbps);
      if (k) audioKbps = k;
      else {
        const a = m.audio[0];
        const pcm = ((a.sampleRate || 48000) * Math.max(1, a.channels) * 16) / 1000;
        audioKbps = p.id === "flac" ? pcm * 0.55 : pcm;
      }
    } else if (p.kind === "video") {
      audioKbps = p.ext === "mov" ? 1536 : p.id === "whatsapp" ? 128 : 256;
    }
  }
  let videoMbps = 0;
  if (p.kind === "video" && m.video) {
    const base = pick(p.mbps1080);
    if (base == null) return null;
    let { width: w, height: h } = m.video;
    if (o.aspect) {
      const [x, y] = o.aspect.split(":").map(Number);
      if (w / h > x / y) w = (h * x) / y;
      else h = (w * y) / x;
    }
    const short = o.size ?? (p.id === "proxy" ? 540 : p.id === "whatsapp" ? 720 : p.id === "vertical" ? 1080 : null);
    if (short && (o.size || short < Math.min(w, h))) {
      const k = short / Math.min(w, h);
      w *= k;
      h *= k;
    }
    const fps = Number(o.fps) || m.video.fps || 30;
    videoMbps = base * ((w * h * fps) / (1920 * 1080 * 30));
  } else if (p.kind === "gif" && m.video) {
    videoMbps = 4;
  } else if (p.kind === "stems") {
    if (m.video) return m.duration ? (m.size * span) / m.duration : null;
    return 44100 * 2 * 2 * span;
  } else if (p.kind === "copy") {
    return m.duration ? (m.size * span) / m.duration : null;
  } else if (p.kind !== "audio") {
    return null;
  }
  return ((videoMbps * 1e6 + audioKbps * 1e3) / 8) * span;
}
