/** زر فعل اختياري داخل الإشعار المنبثق، مثل «أظهر» بعد حفظ ملف (D-82) */
export interface ToastAction {
  label: string;
  run: () => void;
}

export type Toast = (msg: string, action?: ToastAction) => void;
