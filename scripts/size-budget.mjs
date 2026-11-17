// ميزانية حجم الواجهة (T-103): يقيس dist/ بعد vite build ويفشل إن تجاوز جزء حدّه.
// الأرقام الحالية والسبب في docs/PERFORMANCE.md. ارفع الحد عن قصد فقط، مع سطر في ذلك الملف.
import { readdirSync, statSync } from "node:fs";

const BUDGET_KB = { js: 600, css: 140, woff2: 320, woff: 0 };
const dir = new URL("../dist/assets/", import.meta.url);
const sum = {};
for (const f of readdirSync(dir)) {
  const ext = f.split(".").pop();
  sum[ext] = (sum[ext] ?? 0) + statSync(new URL(f, dir)).size / 1024;
}
let ok = true;
for (const [ext, max] of Object.entries(BUDGET_KB)) {
  const kb = Math.round(sum[ext] ?? 0);
  const over = kb > max;
  ok &&= !over;
  console.log(`${over ? "✗" : "✓"} ${ext.padEnd(6)} ${String(kb).padStart(5)} KB  (max ${max})`);
}
process.exit(ok ? 0 : 1);
