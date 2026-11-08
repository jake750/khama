/** نسخة الهاتف (أندرويد الآن): تنزيل فقط، والملفات تُحفظ في Download/Khama */
export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** مكان الحفظ كما يراه المستخدم على الهاتف */
export const MOBILE_SAVE_DIR = "Download/Khama";
