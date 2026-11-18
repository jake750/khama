/**
 * حبس التركيز في النافذة المفتوحة (M-29): Tab وShift+Tab يدوران داخل آخر عنصر aria-modal،
 * فلا يصل مستخدم لوحة المفاتيح أو قارئ الشاشة إلى ما خلف الخلفية المعتمة.
 * مستمع واحد على المستند يكفي كل النوافذ (Dialog، الترحيب، الجولة، التحديث).
 */
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** العنصر التالي في الدورة: من الأخير إلى الأول، ومن خارج النافذة إلى أولها */
export function nextInCycle<T>(items: T[], current: T | null, back: boolean): T | null {
  if (!items.length) return null;
  const i = current == null ? -1 : items.indexOf(current);
  if (i === -1) return back ? items[items.length - 1] : items[0];
  if (back) return i === 0 ? items[items.length - 1] : null;
  return i === items.length - 1 ? items[0] : null;
}

export function installFocusTrap(doc: Document = document) {
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const modals = doc.querySelectorAll<HTMLElement>('[aria-modal="true"]:not([inert])');
    const modal = modals[modals.length - 1];
    if (!modal) return;
    const items = [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === doc.activeElement);
    const active = doc.activeElement as HTMLElement | null;
    const target = nextInCycle(items, active && modal.contains(active) ? active : null, e.shiftKey);
    // null داخل النافذة = خطوة عادية يتركها المتصفح
    if (target) {
      e.preventDefault();
      target.focus();
    } else if (!items.length) e.preventDefault();
  });
}
