// تنسيق الأرقام للعرض، حسب لغة الواجهة
import type { Dict } from "./i18n";

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

export const isHttpUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

/** يستخرج كل الروابط من نص ملصوق (قد يحتوي عدة روابط أو نصًا حولها) */
export function extractUrls(text: string): string[] {
  const found = (text.match(/https?:\/\/[^\s"'<>]+/gi) ?? []).map(trimUrlTail);
  return Array.from(new Set(found));
}

/** يحذف علامات الترقيم الملتصقة بآخر الرابط، ويُبقي القوس الختامي إن كان له قوس مفتوح داخل الرابط */
function trimUrlTail(url: string): string {
  for (;;) {
    const last = url.at(-1) ?? "";
    if (/[.,;:!?،؛؟»'"\]}]/.test(last)) url = url.slice(0, -1);
    else if (last === ")" && url.split("(").length < url.split(")").length) url = url.slice(0, -1);
    else return url;
  }
}

/** "1:15" أو "1:02:05" أو "75" أو "1:15.5" ← ثوانٍ. نص غير صالح ← null */
export function parseTime(text: string): number | null {
  const parts = text
    .trim()
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .split(":");
  if (parts.length > 3) return null;
  const last = parts.length - 1;
  // الكسر مسموح في الجزء الأخير فقط، والدقائق والثواني بعد الجزء الأول أقل من 60
  const valid = parts.every((p, i) => (i === last ? /^\d+(\.\d+)?$/ : /^\d+$/).test(p) && (i === 0 || Number(p) < 60));
  return valid ? parts.reduce((acc, p) => acc * 60 + Number(p), 0) : null;
}

/** مثل formatDuration لكن يُبقي أجزاء الثانية إن وُجدت: 75.5 ← "1:15.5" */
export function formatTimecode(sec: number): string {
  // التقريب إلى أعشار الثانية أولًا حتى لا يظهر 59.96 كـ "0:59.10"
  const tenths = Math.max(0, Math.round(sec * 10));
  const frac = tenths % 10;
  return formatDuration(Math.floor(tenths / 10)) + (frac ? `.${frac}` : "");
}
