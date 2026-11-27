// أخطاء لا نعرضها للمستخدم (عملية في الخلفية، أو زر بسيط مثل «افتح المجلد»):
// نسجّلها في وحدة التحكم بدل إسكاتها، حتى يظهر سببها عند التصحيح (T-58).
// وآخر عشرة منها تبقى في الذاكرة: تُرفق بـ«انسخ للتقرير» (R2-15)

const recent: string[] = [];

export function remember(where: string, e: unknown) {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "string" ? e : JSON.stringify(e);
  recent.push(`${new Date().toISOString()} ${where}: ${text}`.slice(0, 500));
  if (recent.length > 10) recent.shift();
}

/** آخر الأخطاء المسجّلة، الأحدث أخيرًا */
export const recentErrors = (): readonly string[] => recent;

export const logError =
  (where: string) =>
  (e: unknown): void => {
    remember(where, e);
    console.error(`[khama] ${where}:`, e);
  };

/** أخطاء لم يلتقطها أحد: تُسجَّل بدل أن تضيع (R2-15) */
export function installGlobalErrorLog() {
  window.addEventListener("error", (e) => {
    // تحذير المتصفح المعروف من ResizeObserver ليس خطأً في التطبيق
    if (String(e.message).includes("ResizeObserver loop")) return;
    logError("window")(e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => logError("unhandledrejection")(e.reason));
}
