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
  return Array.from(new Set(text.match(/https?:\/\/[^\s"'<>]+/gi) ?? []));
}
