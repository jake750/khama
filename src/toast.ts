/** زر فعل اختياري داخل الإشعار المنبثق، مثل «أظهر» بعد حفظ ملف (D-82) */
export interface ToastAction {
  label: string;
  run: () => void;
  /** مدة الإشعار (ms). «تراجع» يحتاج 5 ثوانٍ (U-20) */
  ms?: number;
}

export type Toast = (msg: string, action?: ToastAction) => void;
