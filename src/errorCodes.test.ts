/// <reference types="node" />
// عقد بين Rust والواجهة (T-30): كل رمز خطأ يرسله Rust له ترجمة في اللغتين.
// Rust يرسل الرمز نصًا (AppError::new("x"))، فلو أُضيف رمز بلا ترجمة لظهر للمستخدم "unknown" بصمت.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dictionaries } from "./i18n";

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? rustFiles(p) : p.endsWith(".rs") ? [p] : [];
  });
}

function rustErrorCodes(): Set<string> {
  const root = fileURLToPath(new URL("../src-tauri/src", import.meta.url));
  const codes = new Set<string>();
  for (const file of rustFiles(root)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/AppError::(?:new|with_detail|with_param)\(\s*"([A-Za-z]+)"/g)) codes.add(m[1]);
    // جدول القواعد في errors.rs: (&[...], "code")
    if (file.endsWith("errors.rs")) {
      const rules = src.slice(src.indexOf("const RULES"), src.indexOf("];", src.indexOf("const RULES")));
      for (const m of rules.matchAll(/\],\s*"([A-Za-z]+)",?\s*\)/g)) codes.add(m[1]);
    }
  }
  return codes;
}

describe("رموز الأخطاء (T-30)", () => {
  const codes = rustErrorCodes();
  it("وجد رموزًا في Rust", () => {
    expect(codes.size).toBeGreaterThan(20);
    expect(codes.has("network")).toBe(true);
  });
  for (const lang of ["en", "ar"] as const) {
    it(`لكل رمز ترجمة (${lang})`, () => {
      const errors = dictionaries[lang].errors as Record<string, string>;
      const missing = [...codes].filter((c) => !(c in errors));
      expect(missing).toEqual([]);
    });
  }
});
