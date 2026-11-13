/** نسخة الهاتف (أندرويد الآن): تنزيل فقط، والملفات تُحفظ في Download/Khama */
export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** مكان الحفظ كما يراه المستخدم على الهاتف */
export const MOBILE_SAVE_DIR = "Download/Khama";

/** نظام الكمبيوتر: macOS يبقي أزرار النافذة الأصلية (الإشارات الثلاث)، وWindows وLinux نرسم أزرارنا */
export const isMac = !isMobile && /Macintosh|Mac OS X/i.test(navigator.userAgent);
