// تنسيق الأرقام للعرض، حسب لغة الواجهة
import type { Dict } from "./i18n";

/**
 * الحجم بوحدات 1024 (KB = 1024 بايت) عن قصد (T-69): نفس ما يعرضه مستكشف Windows،
 * فيطابق الرقم في خامة الرقم الذي يراه المستخدم في مجلده. (macOS ومواقع التخزين تستعمل 1000.)
 */
export function formatBytes(t: Dict, n?: number | null): string {
  if (n == null || !isFinite(n)) return "";
  let i = 0;
  const digits = (k: number) => (k >= 2 ? 1 : 0);
  // بعد التقريب لا قبله: 1023.7 KB تُكتب «1.0 MB» لا «1024 KB» (R2-61)
  while (Number(n.toFixed(digits(i))) >= 1024 && i < t.bytes.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(digits(i))} ${t.bytes[i]}`;
}

export function formatSpeed(t: Dict, bps?: number | null): string {
  const b = formatBytes(t, bps);
  return b ? `${b}${t.perSecond}` : "";
}

/** 75 ← "1:15" ، 3725 ← "1:02:05" */
/** علامات زمنية مستديرة تحت شريط القص: ما بين 3 و6 علامات بخطوة مألوفة (D-102) */
export function timeTicks(duration: number): number[] {
  if (!(duration > 0)) return [];
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
  const step = steps.find((x) => duration / x <= 6) ?? Math.ceil(duration / 6);
  const out: number[] = [];
  for (let v = 0; v <= duration + 1e-9; v += step) out.push(v);
  return out;
}

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
  // الحدود بعد التقريب: 59.6 ث = «دقيقة»، و3590 ث = «0:59:50» لا «60 دقيقة» (R2-62)
  if (Math.round(sec) < 60) return t.secLeft(Math.max(1, Math.round(sec)));
  if (Math.round(sec / 60) < 60) return t.minLeft(Math.round(sec / 60));
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

/** R3-U11: مفتاح واحد للرابط نفسه بصيغه المختلفة: youtu.be/ID وwatch?v=ID وshorts/ID واحد،
 * وبلا www أو m. أو / أخيرة أو # أو بارامترات التتبّع (utm_، si، igsh، fbclid، feature) */
export function mediaKey(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
    if (host === "youtu.be") return `yt:${u.pathname.slice(1).split("/")[0]}`;
    if (host === "youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return `yt:${v}`;
      const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/);
      if (m) return `yt:${m[1]}`;
    }
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|si$|igsh|fbclid$|feature$)/.test(k)) u.searchParams.delete(k);
    return `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}

/** يستخرج كل الروابط من نص ملصوق (قد يحتوي عدة روابط أو نصًا حولها) */
export function extractUrls(text: string): string[] {
  // رابط منسوخ من رسالة بلا https:// (www.… أو youtu.be/…) يُقبل ويُكمَل (R2-39)
  const raw = text.match(/(?:https?:\/\/|(?<![\w./@])(?:www\.|youtu\.be\/))[^\s"'<>]+/gi) ?? [];
  const found = Array.from(new Set(raw.map((u) => trimUrlTail(/^https?:/i.test(u) ? u : `https://${u}`))));
  // فقرة ملصوقة فيها رابط الفيديو ورابط صاحبه: نُسقط روابط الحسابات والقنوات (U-66).
  // رابط قناة وحده يبقى (قد يريد المستخدم تنزيل القناة كلها)
  if (found.length < 2) return found;
  const media = found.filter((u) => !isProfileUrl(u));
  return media.length ? media : found;
}

/** صفحة حساب أو قناة، لا فيديو: youtube.com/@x، x.com/user، instagram.com/user، tiktok.com/@user */
function isProfileUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^(www|m|mobile)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "youtube.com")
    return (parts.length === 1 && parts[0].startsWith("@")) || (parts.length === 2 && ["channel", "c", "user"].includes(parts[0]));
  if (host === "x.com" || host === "twitter.com" || host === "instagram.com") return parts.length === 1;
  if (host === "tiktok.com") return parts.length === 1 && parts[0].startsWith("@");
  return false;
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
  return chapterStarts(starts)
    .map((s, i) => `${fmt(s)} ${label(i + 1)}`)
    .join("\n");
}

/** أقصر فصل يقبله YouTube، وأقل عدد فصول (وإلا تجاهلها كلها) (R2-4) */
export const CHAPTER_MIN_SECS = 10;
export const CHAPTER_MIN_COUNT = 3;

/** بدايات الفصول: من 0:00، وكل فصل 10 ثوانٍ على الأقل (نقطة أقرب من ذلك إلى سابقتها تُسقط) */
export function chapterStarts(starts: number[]): number[] {
  const out = [0];
  for (const s of [...starts].sort((a, b) => a - b)) if (s - out[out.length - 1] >= CHAPTER_MIN_SECS) out.push(s);
  return out;
}
