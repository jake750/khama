import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import type { Dict } from "./i18n";
import { logError } from "./log";
import type { Toast } from "./toast";

const KEY = "khama.lastVersion";

/**
 * «ما الجديد» مرة واحدة بعد كل تحديث (U-59): نقارن النسخة الحالية بآخر نسخة فُتحت.
 * أول تشغيل على الإطلاق لا يعرض شيئًا. التخزين المحلي راحة فقط: إن فشل لا يظهر الإشعار.
 */
export async function announceUpdate(t: Dict, toast: Toast) {
  let prev: string | null;
  let current: string;
  try {
    current = await getVersion();
    prev = localStorage.getItem(KEY);
    localStorage.setItem(KEY, current);
  } catch {
    return;
  }
  if (!prev || prev === current) return;
  const url = `https://github.com/jake750/khama/releases/tag/v${current}`;
  toast(t.appUpdatedTo(current), {
    label: t.whatsNew,
    run: () => void invoke("plugin:opener|open_url", { url }).catch(logError("openUrl")),
    ms: 10_000,
  });
}
