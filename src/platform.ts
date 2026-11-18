import { platform } from "@tauri-apps/plugin-os";

/** المنصة من Tauri مباشرة (T-78). في معاينة المتصفح (npm run dev) لا يوجد Tauri فنرجع لـ userAgent. */
function detectMobile(): boolean {
  try {
    const p = platform();
    return p === "android" || p === "ios";
  } catch {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }
}

/** نسخة الهاتف (أندرويد): تنزيل وتحويل وفصل بالذكاء الاصطناعي مثل الكمبيوتر، والملفات تُحفظ في Download/Khama أو مجلد عام يختاره المستخدم.
 * الفرق في ما يخص سطح المكتب فقط: المجلدات المراقَبة والوضع المصغّر والخلفية (T-80) */
export const isMobile = detectMobile();

/** Windows: يهمّ لتنبيه كوكيز Chrome (U-19) */
export const isWindows = (() => {
  try {
    return platform() === "windows";
  } catch {
    return /Windows/i.test(navigator.userAgent);
  }
})();

/** المجلدات العامة التي يحفظ فيها التطبيق على الهاتف دون صلاحيات إضافية (U-76) */
export const MOBILE_BASES = ["Download", "Movies", "Music", "DCIM", "Pictures"] as const;
export type MobileBase = (typeof MOBILE_BASES)[number];

/** مكان الحفظ كما يراه المستخدم على الهاتف: المجلد العام وفرعه من الإعدادات (Download/Khama افتراضيًا) */
export function mobileSaveDir(s?: { mobileBase?: string; mobileFolder?: string } | null): string {
  const base = s?.mobileBase || "Download";
  const folder = s?.mobileFolder ?? "Khama";
  return folder ? `${base}/${folder}` : base;
}
