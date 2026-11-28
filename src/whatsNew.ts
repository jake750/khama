import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { Dict } from "./i18n";
import { logError } from "./log";
import { notesSince } from "./changelog";
import type { Toast } from "./toast";

const KEY = "khama.lastVersion";

/**
 * «ما الجديد» مرة واحدة بعد كل تحديث (U-59): نقارن النسخة الحالية بآخر نسخة فُتحت.
 * أول تشغيل على الإطلاق لا يعرض شيئًا. التخزين المحلي راحة فقط: إن فشل لا يظهر الإشعار.
 */
export async function announceUpdate(t: Dict, toast: Toast, show?: (from: string, to: string) => void) {
  let prev: string | null;
  let current: string;
  try {
    current = await getVersion();
    // بلا نسخة معروفة (بيئة التطوير مثلًا) لا نعلن شيئًا ولا نحفظ
    if (!current) return;
    prev = localStorage.getItem(KEY);
    localStorage.setItem(KEY, current);
  } catch {
    return;
  }
  if (!prev || prev === current) return;
  const url = `https://github.com/jake750/khama/releases/tag/v${current}`;
  const to = current;
  const from = prev;
  // R3-U36: نافذة داخل التطبيق بلغة الواجهة إن كُتبت سطور لهذا الإصدار، وإلا صفحة الإصدار
  const inApp = show && notesSince(from, to).length > 0;
  toast(t.appUpdatedTo(current), {
    label: t.whatsNew,
    run: () => (inApp ? show(from, to) : openReleasePage(url)),
    ms: 10_000,
  });
}

export function openReleasePage(url = "https://github.com/jake750/khama/releases") {
  void invoke("plugin:opener|open_url", { url }).catch(logError("openUrl"));
}
