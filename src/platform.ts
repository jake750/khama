import { platform } from "@tauri-apps/plugin-os";

/** المنصة من Tauri مباشرة (T-74). في معاينة المتصفح (npm run dev) لا يوجد Tauri فنرجع لـ userAgent. */
function detectMobile(): boolean {
  try {
    const p = platform();
    return p === "android" || p === "ios";
  } catch {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }
}

/** نسخة الهاتف (أندرويد الآن): تنزيل فقط، والملفات تُحفظ في Download/Khama */
export const isMobile = detectMobile();

/** مكان الحفظ كما يراه المستخدم على الهاتف */
export const MOBILE_SAVE_DIR = "Download/Khama";
