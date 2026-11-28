// R3-V17: إحساس تطبيق لا صفحة ويب.
// قائمة WebView الافتراضية (رجوع، تحديث، حفظ، طباعة) لا معنى لها في خامة، فتُمنع
// إلا حيث يحتاجها المستخدم: حقول الكتابة والنص القابل للتحديد (لنسخه) وأثناء التطوير.

const KEEP_MENU = "input, textarea, [contenteditable], pre, code, .selectable";

export function installNativeFeel() {
  if (import.meta.env.DEV) return;
  document.addEventListener("contextmenu", (e) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest(KEEP_MENU)) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
  // الشعار والصور المصغّرة لا تُسحب كصور ويب (سحب الملفات إلى برنامج المونتاج له زر خاص)
  document.addEventListener("dragstart", (e) => {
    const el = e.target as HTMLElement | null;
    if (el instanceof HTMLImageElement && !el.closest("[draggable='true']")) e.preventDefault();
  });
}
