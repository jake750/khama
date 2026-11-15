// أخطاء لا نعرضها للمستخدم (عملية في الخلفية، أو زر بسيط مثل «افتح المجلد»):
// نسجّلها في وحدة التحكم بدل إسكاتها، حتى يظهر سببها عند التصحيح (T-58).
export const logError =
  (where: string) =>
  (e: unknown): void => {
    console.error(`[khama] ${where}:`, e);
  };
