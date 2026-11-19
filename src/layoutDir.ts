// اتجاه التخطيط مستقل عن اللغة: عربي بتخطيط من اليسار، أو إنجليزي معكوس.
// "auto" يتبع اللغة (العربية من اليمين، الإنجليزية من اليسار).
import type { Lang } from "./i18n";

export type LayoutDir = "auto" | "rtl" | "ltr";
export type Dir = "rtl" | "ltr";

export const langDir = (lang: Lang): Dir => (lang === "ar" ? "rtl" : "ltr");

/** الاتجاه الفعلي للصفحة. قيمة غير معروفة (ملف قديم) = من اليمين لليسار كما كان */
export function resolveDir(layout: string | undefined, lang: Lang): Dir {
  if (layout === "auto") return langDir(lang);
  return layout === "ltr" ? "ltr" : "rtl";
}

/** النص يُقرأ عكس التخطيط: كل نص يُرتَّب حسب لغته ويبقى محاذيًا لبداية التخطيط (bubbly.css) */
export const isMixed = (layout: string | undefined, lang: Lang) => resolveDir(layout, lang) !== langDir(lang);
