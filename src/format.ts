// تنسيق الأرقام للعرض، حسب لغة الواجهة
import type { Dict } from "./i18n";

/**
 * الحجم بوحدات 1024 (KB = 1024 بايت) عن قصد (T-69): نفس ما يعرضه مستكشف Windows،
 * فيطابق الرقم في خامة الرقم الذي يراه المستخدم في مجلده. (macOS ومواقع التخزين تستعمل 1000.)
 */
export function formatBytes(t: Dict, n?: number | null): string {
  if (n == null || !isFinite(n)) return "";
  let i = 0;
  while (n >= 1024 && i < t.bytes.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 2 ? 1 : 0)} ${t.bytes[i]}`;
}

export function formatSpeed(t: Dict, bps?: number | null): string {
  const b = formatBytes(t, bps);
  return b ? `${b}${t.perSecond}` : "";
}

/** 75 ← "1:15" ، 3725 ← "1:02:05" */
export function formatDuration(sec?: number | null): string {
  if (sec == null || !isFinite(sec)) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function formatEta(t: Dict, sec?: number | null): string {
  if (sec == null || !isFinite(sec)) return "";
  if (sec < 60) return t.secLeft(Math.max(1, Math.round(sec)));
  if (sec < 3600) return t.minLeft(Math.round(sec / 60));
  return t.left(formatDuration(sec));
}

/** رابط http/https صالح فيه اسم موقع (تحليل كامل بـ URL، لا مجرد البادئة — T-70) */
export function isHttpUrl(s: string): boolean {
  const text = s.trim();
  if (/\s/.test(text)) return false;
  try {
    const u = new URL(text);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/** يستخرج كل الروابط من نص ملصوق (قد يحتوي عدة روابط أو نصًا حولها) */
export function extractUrls(text: string): string[] {
  const found = (text.match(/https?:\/\/[^\s"'<>]+/gi) ?? []).map(trimUrlTail);
  return Array.from(new Set(found));
}

/** يحذف علامات الترقيم الملتصقة بآخر الرابط، ويُبقي القوس الختامي إن كان له قوس مفتوح داخل الرابط */
function trimUrlTail(url: string): string {
  for (;;) {
    const last = url[url.length - 1] ?? "";
    if (/[.,;:!?،؛؟»'"\]}]/.test(last)) url = url.slice(0, -1);
    else if (last === ")" && url.split("(").length < url.split(")").length) url = url.slice(0, -1);
    else return url;
  }
}

/** "1:15" أو "1:02:05" أو "75" أو "1:15.5" ← ثوانٍ. ومع fps يُقبل أيضًا HH:MM:SS:FF (U-16). نص غير صالح ← null */
export function parseTime(text: string, fps?: number | null): number | null {
  const parts = text
    .trim()
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .split(":");
  if (parts.length === 4 && fps) {
    // HH:MM:SS:FF كما في برامج المونتاج
    const n = Math.round(fps);
    const [h, m, s, f] = parts;
    if (![h, m, s, f].every((p) => /^\d+$/.test(p)) || Number(m) >= 60 || Number(s) >= 60 || Number(f) >= n) return null;
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(f) / fps;
  }
  if (parts.length > 3) return null;
  const last = parts.length - 1;
  // الكسر مسموح في الجزء الأخير فقط، والدقائق والثواني بعد الجزء الأول أقل من 60
  const valid = parts.every((p, i) => (i === last ? /^\d+(\.\d+)?$/ : /^\d+$/).test(p) && (i === 0 || Number(p) < 60));
  return valid ? parts.reduce((acc, p) => acc * 60 + Number(p), 0) : null;
}

/** مثل formatDuration لكن يُبقي أجزاء الثانية إن وُجدت: 75.5 ← "1:15.5".
 * ومع fps: كود زمني كامل بالإطارات 75.5 @ 24 ← "00:01:15:12" (U-16) */
export function formatTimecode(sec: number, fps?: number | null): string {
  if (fps) {
    const n = Math.round(fps);
    let whole = Math.floor(Math.max(0, sec) + 1e-6);
    let ff = Math.round((Math.max(0, sec) - whole) * fps);
    if (ff >= n) {
      whole += 1;
      ff = 0;
    }
    const p = (v: number) => String(v).padStart(2, "0");
    return `${p(Math.floor(whole / 3600))}:${p(Math.floor(whole / 60) % 60)}:${p(whole % 60)}:${p(ff)}`;
  }
  // التقريب إلى أعشار الثانية أولًا حتى لا يظهر 59.96 كـ "0:59.10"
  const tenths = Math.max(0, Math.round(sec * 10));
  const frac = tenths % 10;
  return formatDuration(Math.floor(tenths / 10)) + (frac ? `.${frac}` : "");
}

/**
 * فصول YouTube من نقاط القطع (U-60): «0:00 الجزء 1» سطرًا لكل فصل، ويبدأ الأول من 0:00 كما يشترط YouTube.
 * label(n) يعطي اسم الفصل بلغة المستخدم.
 */
export function youtubeChapters(starts: number[], label: (n: number) => string): string {
  const fmt = (sec: number) => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  };
  const points = [0, ...starts.filter((s) => s >= 1)].sort((a, b) => a - b);
  return points.map((s, i) => `${fmt(s)} ${label(i + 1)}`).join("\n");
}
