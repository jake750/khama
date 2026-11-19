/// <reference types="node" />
// اتجاه الصفحة (T-95): الواجهة تنقلب كاملة بين التخطيطين (إعداد layoutDir) بخصائص CSS المنطقية
// (inline-start/end، inset-inline). أي left/right أو margin-left جديد يبقى في مكانه ولا ينقلب،
// فيظهر خطأً في إحدى اللغتين فقط. هذا الاختبار يمنعه، إلا القائمة أدناه وكلٌّ بسببه.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PHYSICAL = /^\s*((?:margin|padding|border)-(?:left|right)|left|right|float|text-align)\s*:\s*([^;]+);/;

/** المقصود عمدًا: «ملف ← المحدِّد ← الخاصية» وسببه */
const ALLOWED: Record<string, string> = {
  'bubbly.css|:root[data-mixed-dir][dir="rtl"] body,:root[data-mixed-dir][dir="rtl"] :is(.guide-row,.menu-item,.settings-nav button,.preset,.more-menu-list button)|text-align':
    "نص يُقرأ عكس التخطيط (plaintext) يُحاذى لبداية التخطيط صراحةً، فـ start يتبع الفقرة لا التخطيط",
  'bubbly.css|:root[data-mixed-dir][dir="ltr"] body,:root[data-mixed-dir][dir="ltr"] :is(.guide-row,.menu-item,.settings-nav button,.preset,.more-menu-list button)|text-align':
    "كذلك",
  'bubbly.css|:root[data-mixed-dir][dir="rtl"] .trim-fields .time-field:last-child|text-align': "حقل نهاية القص يُحاذى مع طرف الصف",
  'bubbly.css|:root[data-mixed-dir][dir="ltr"] .trim-fields .time-field:last-child|text-align': "كذلك",
  "redesign.css|.motif::before,.motif::after|left": "زخرفة أفقية متكرّرة لا اتجاه لها",
  "styles.css|details.tech pre|text-align": "تفاصيل الخطأ بالإنجليزية والخط الثابت دائمًا",
  "styles.css|.toast|left": "توسيط أفقي (left: 50% مع translateX)",
  "styles.css|.trim-track::before|left": "شريط القص زمني من اليسار لليمين دائمًا (dir=ltr)",
  "styles.css|.trim-track::before|right": "كذلك",
  "redesign.css|.trim-ticks span::before|left": "تدريج شريط القص (dir=ltr) يتبع الزمن لا اللغة",
  "redesign.css|.trim-ticks span:first-child::before|left": "كذلك",
  "redesign.css|.trim-ticks span.end::before|left": "كذلك",
  "redesign.css|.trim-ticks span.end::before|right": "كذلك",
  "styles.css|.tab-pill,.seg-pill|left": "الموضع يُحسب بـ offsetLeft الفيزيائي في motion.tsx",
  'styles.css|:root[dir="rtl"] [dir="auto"]|text-align': "محاذاة النص المختلط مع الصفحة",
  'styles.css|:root[dir="ltr"] [dir="auto"]|text-align': "كذلك",
};

function physicalRules(): string[] {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(dir + file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    let selector = "";
    for (const line of css.split(/\r?\n/)) {
      if (line.includes("{")) selector = (selector + line.slice(0, line.indexOf("{"))).replace(/\s*,\s*/g, ",").trim();
      else if (/,\s*$/.test(line)) selector += line.trim();
      const m = PHYSICAL.exec(line);
      if (m && !(m[1] === "text-align" && !/left|right/.test(m[2])) && !(m[1] === "float" && /none/.test(m[2])))
        found.push(`${file}|${selector}|${m[1]}`);
      if (line.includes("}")) selector = "";
    }
  }
  return found;
}

describe("اتجاه الصفحة (T-95)", () => {
  it("لا left/right فيزيائية إلا المقصودة", () => {
    const unexpected = physicalRules().filter((k) => !(k in ALLOWED));
    expect(unexpected).toEqual([]);
  });
  it("قائمة الاستثناءات لا تحمل قواعد حُذفت", () => {
    const now = new Set(physicalRules());
    expect(Object.keys(ALLOWED).filter((k) => !now.has(k))).toEqual([]);
  });
});
