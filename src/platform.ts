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

/** نسخة الهاتف (أندرويد): تنزيل وتحويل وفصل بالذكاء الاصطناعي مثل الكمبيوتر، والملفات تُحفظ في Download/Khama.
 * الفرق في ما يخص سطح المكتب فقط: المجلدات المراقَبة والوضع المصغّر والخلفية (T-80) */
export const isMobile = detectMobile();

/** مكان الحفظ كما يراه المستخدم على الهاتف */
export const MOBILE_SAVE_DIR = "Download/Khama";
