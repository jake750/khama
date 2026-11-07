// قائمة الـ Presets كما تظهر في المحوّل: مجمّعة حسب الهدف لا حسب الكودك.
// المعرّفات (id) نفسها الموجودة في src-tauri/src/convert.rs

import type { ConvertOptions, Issue, MediaInfo } from "./api";
import type { Lang } from "./i18n";

export type PresetGroup = "edit" | "publish" | "audio" | "tools";
export type PresetKind = "video" | "audio" | "frame" | "sequence" | "gif" | "copy" | "detect";

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
    id: "edit_h264", group: "edit", kind: "video", ext: "mp4", quality: true, hw: true,
    name: { en: "Edit-ready H.264", ar: "H.264 جاهز للمونتاج" },
    desc: { en: "Constant frame rate, opens everywhere. Fixes phone VFR sync issues.", ar: "معدل إطارات ثابت ويفتح في كل البرامج. يصلح مشاكل تزامن فيديو الجوال." },
    mbps1080: { high: 16, balanced: 11, small: 6 },
  }),
  P({
    id: "prores_422", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "ProRes 422", ar: "ProRes 422" },
    desc: { en: "Smooth scrubbing in Premiere and Final Cut. Big files.", ar: "تقليب سلس في Premiere وFinal Cut. ملفات كبيرة." },
    mbps1080: 147,
  }),
  P({
    id: "prores_hq", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "ProRes 422 HQ", ar: "ProRes 422 HQ" },
    desc: { en: "Higher quality for grading and heavy effects.", ar: "جودة أعلى للتلوين والمؤثرات الثقيلة." },
    mbps1080: 220,
  }),
  P({
    id: "prores_lt", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "ProRes LT", ar: "ProRes LT" },
    desc: { en: "Lighter ProRes for long timelines.", ar: "ProRes أخف للتايملاين الطويل." },
    mbps1080: 102,
  }),
  P({
    id: "prores_4444", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "ProRes 4444", ar: "ProRes 4444" },
    desc: { en: "Keeps transparency (alpha). For motion graphics.", ar: "يحافظ على الشفافية (Alpha). للموشن جرافيك." },
    mbps1080: 330,
  }),
  P({
    id: "dnxhr_sq", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "DNxHR SQ", ar: "DNxHR SQ" },
    desc: { en: "Best choice for free DaVinci Resolve on Windows and Linux.", ar: "أفضل خيار لـ DaVinci Resolve المجاني على Windows وLinux." },
    mbps1080: 145,
  }),
  P({
    id: "dnxhr_hq", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "DNxHR HQ", ar: "DNxHR HQ" },
    desc: { en: "Higher-quality DNxHR (8-bit).", ar: "DNxHR بجودة أعلى (8-bit)." },
    mbps1080: 220,
  }),
  P({
    id: "dnxhr_hqx", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "DNxHR HQX 10-bit", ar: "DNxHR HQX ‏10-bit" },
    desc: { en: "Keeps 10-bit color for HDR and log footage.", ar: "يحافظ على ألوان 10-bit للقطات HDR وLog." },
    mbps1080: 220,
  }),
  P({
    id: "dnxhr_lb", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "DNxHR LB", ar: "DNxHR LB" },
    desc: { en: "Light DNxHR, good as an offline proxy.", ar: "DNxHR خفيف، مناسب كبروكسي." },
    mbps1080: 45,
  }),
  P({
    id: "prores_proxy", group: "edit", kind: "video", ext: "mov", quality: false, hw: false,
    name: { en: "ProRes Proxy", ar: "ProRes Proxy" },
    desc: { en: "Full-res proxy that edits fast on any machine.", ar: "بروكسي بنفس الدقة، يشتغل بسرعة على أي جهاز." },
    mbps1080: 45,
  }),
  P({
    id: "proxy", group: "edit", kind: "video", ext: "mp4", quality: false, hw: true,
    name: { en: "Light proxy (540p)", ar: "بروكسي خفيف (540p)" },
    desc: { en: "Tiny H.264 with frequent keyframes for laptops.", ar: "H.264 صغير جدًا وسريع التقليب، للابتوب." },
    mbps1080: 2.2,
  }),

  // ---------- للنشر ----------
  P({
    id: "youtube", group: "publish", kind: "video", ext: "mp4", quality: true, hw: true,
    name: { en: "YouTube", ar: "يوتيوب" },
    desc: { en: "High-bitrate H.264 that survives YouTube's re-compression.", ar: "H.264 بمعدل بت عالٍ يصمد أمام ضغط يوتيوب." },
    mbps1080: { high: 18, balanced: 13, small: 8 },
  }),
  P({
    id: "vertical", group: "publish", kind: "video", ext: "mp4", quality: true, hw: true,
    name: { en: "Reels / TikTok / Shorts", ar: "ريلز / تيك توك / شورتس" },
    desc: { en: "Crops to 9:16 and sizes to 1080 wide.", ar: "يقص إلى 9:16 بعرض 1080." },
    mbps1080: { high: 14, balanced: 10, small: 6 },
  }),
  P({
    id: "whatsapp", group: "publish", kind: "video", ext: "mp4", quality: true, hw: true,
    name: { en: "Small (WhatsApp, email)", ar: "حجم صغير (واتساب، بريد)" },
    desc: { en: "720p, as small as it reasonably gets.", ar: "720p بأصغر حجم معقول." },
    mbps1080: { high: 4, balanced: 2.6, small: 1.6 },
  }),
  P({
    id: "h265", group: "publish", kind: "video", ext: "mp4", quality: true, hw: true,
    name: { en: "H.265 / HEVC", ar: "H.265 / HEVC" },
    desc: { en: "Same quality at about half the size. For archiving and sharing.", ar: "نفس الجودة بنصف الحجم تقريبًا. للأرشفة والمشاركة." },
    mbps1080: { high: 9, balanced: 5.5, small: 3 },
  }),
  P({
    id: "av1", group: "publish", kind: "video", ext: "mp4", quality: true, hw: false,
    name: { en: "AV1", ar: "AV1" },
    desc: { en: "Smallest files for the web. Slow to edit.", ar: "أصغر ملفات للويب. ثقيل في المونتاج." },
    mbps1080: { high: 6, balanced: 3.5, small: 2 },
  }),
  P({
    id: "webm", group: "publish", kind: "video", ext: "webm", quality: true, hw: false,
    name: { en: "WebM (VP9)", ar: "WebM ‏(VP9)" },
    desc: { en: "For websites and browsers.", ar: "للمواقع والمتصفحات." },
    mbps1080: { high: 7, balanced: 4, small: 2.2 },
  }),
  P({
    id: "gif", group: "publish", kind: "gif", ext: "gif", quality: false, hw: false,
    name: { en: "GIF", ar: "GIF" },
    desc: { en: "Optimized palette, 15 fps, 360p.", ar: "ألوان محسّنة، 15 إطارًا، 360p." },
  }),

  // ---------- صوت ----------
  P({
    id: "wav", group: "audio", kind: "audio", ext: "wav", quality: false, hw: false,
    name: { en: "WAV", ar: "WAV" },
    desc: { en: "Uncompressed. Best for editing and mixing.", ar: "بلا ضغط. الأفضل للمونتاج والمكس." },
  }),
  P({
    id: "mp3", group: "audio", kind: "audio", ext: "mp3", quality: true, hw: false,
    name: { en: "MP3", ar: "MP3" },
    desc: { en: "Plays everywhere.", ar: "يشتغل في كل مكان." },
    kbps: { high: 320, balanced: 256, small: 160 },
  }),
  P({
    id: "aac", group: "audio", kind: "audio", ext: "m4a", quality: true, hw: false,
    name: { en: "AAC (M4A)", ar: "AAC ‏(M4A)" },
    desc: { en: "Better than MP3 at the same size.", ar: "أفضل من MP3 بنفس الحجم." },
    kbps: { high: 320, balanced: 256, small: 160 },
  }),
  P({
    id: "flac", group: "audio", kind: "audio", ext: "flac", quality: false, hw: false,
    name: { en: "FLAC", ar: "FLAC" },
    desc: { en: "Lossless and about half the size of WAV.", ar: "بلا فقدان وبنصف حجم WAV تقريبًا." },
  }),
  P({
    id: "opus", group: "audio", kind: "audio", ext: "opus", quality: true, hw: false,
    name: { en: "Opus", ar: "Opus" },
    desc: { en: "Very small for voice and podcasts.", ar: "صغير جدًا للصوت والبودكاست." },
    kbps: { high: 192, balanced: 128, small: 96 },
  }),

  // ---------- أدوات ----------
  P({
    id: "rewrap_mp4", group: "tools", kind: "copy", ext: "mp4", quality: false, hw: false,
    name: { en: "Rewrap to MP4", ar: "تغيير الحاوية إلى MP4" },
    desc: { en: "No re-encoding, takes seconds. Trims cut at the nearest keyframe.", ar: "بلا إعادة ترميز، ثوانٍ فقط. القص عند أقرب إطار مفتاحي." },
  }),
  P({
    id: "rewrap_mov", group: "tools", kind: "copy", ext: "mov", quality: false, hw: false,
    name: { en: "Rewrap to MOV", ar: "تغيير الحاوية إلى MOV" },
    desc: { en: "Same streams in a MOV file.", ar: "نفس المحتوى داخل ملف MOV." },
  }),
  P({
    id: "rewrap_mkv", group: "tools", kind: "copy", ext: "mkv", quality: false, hw: false,
    name: { en: "Rewrap to MKV", ar: "تغيير الحاوية إلى MKV" },
    desc: { en: "Holds any codec.", ar: "يقبل أي كودك." },
  }),
  P({
    id: "frame_png", group: "tools", kind: "frame", ext: "png", quality: false, hw: false,
    name: { en: "Grab a frame (PNG)", ar: "التقاط إطار (PNG)" },
    desc: { en: "Saves the frame at the start point as a full-res still.", ar: "يحفظ الإطار عند نقطة البداية كصورة بالدقة الكاملة." },
  }),
  P({
    id: "sequence_png", group: "tools", kind: "sequence", ext: "png", quality: false, hw: false,
    name: { en: "Image sequence (PNG)", ar: "سلسلة صور (PNG)" },
    desc: { en: "Every frame as a PNG in a folder.", ar: "كل إطار كصورة PNG داخل مجلد." },
  }),
  P({
    id: "detect_scenes", group: "tools", kind: "detect", ext: "", quality: false, hw: false,
    name: { en: "Find scene cuts", ar: "كشف تغيّر المشاهد" },
    desc: { en: "Lists every cut. Then split the file at those points.", ar: "يعرض كل قطع، ويمكنك تقسيم الملف عندها." },
  }),
  P({
    id: "detect_black", group: "tools", kind: "detect", ext: "", quality: false, hw: false,
    name: { en: "Find black frames", ar: "كشف الشاشات السوداء" },
    desc: { en: "Finds black gaps (dropped signal, leftover slates).", ar: "يجد الفراغات السوداء (انقطاع، أو بقايا في البداية والنهاية)." },
  }),
  P({
    id: "detect_silence", group: "tools", kind: "detect", ext: "", quality: false, hw: false,
    name: { en: "Find silences", ar: "كشف الصمت" },
    desc: { en: "Finds pauses — handy for cutting talking-head videos.", ar: "يجد فترات السكوت، مفيد لتقطيع فيديوهات الكلام." },
  }),
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

export const GROUPS: PresetGroup[] = ["edit", "publish", "audio", "tools"];

/** هل يمكن تطبيق هذا الـ Preset على هذا الملف؟ */
export function presetFits(p: PresetDef, m?: MediaInfo | null): boolean {
  if (!m) return true;
  if (p.id === "detect_silence") return m.audio.length > 0;
  if (p.kind === "audio") return m.audio.length > 0;
  if (p.kind === "copy") return true;
  return !!m.video;
}

/** اقتراح تلقائي حسب مشاكل الملف */
export function suggestPreset(issues: Issue[]): string | null {
  if (issues.includes("resolveFreeAudio")) return "dnxhr_sq";
  if (issues.includes("hdr")) return "dnxhr_hqx";
  if (issues.includes("vfr") || issues.includes("heavyCodec")) return "edit_h264";
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
  } else if (p.kind === "copy") {
    return m.duration ? (m.size * span) / m.duration : null;
  } else if (p.kind !== "audio") {
    return null;
  }
  return ((videoMbps * 1e6 + audioKbps * 1e3) / 8) * span;
}
