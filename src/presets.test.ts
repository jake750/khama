/// <reference types="node" />
// عقد بين الواجهة وRust (T-54): الـ Presets معرّفة في presets.ts (الأسماء والأوصاف والتقدير)
// وفي convert/presets.rs (أوامر FFmpeg). هذا الاختبار يفشل إن اختلف معرّف أو نوع أو امتداد بينهما.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESETS } from "./presets";

function rustPresets() {
  const src = readFileSync(new URL("../src-tauri/src/convert/presets.rs", import.meta.url), "utf8");
  const start = src.indexOf("const PRESETS: &[Preset] = &[");
  const block = src.slice(start, src.indexOf("\n];", start));
  const re = /Preset \{\s*id: "([^"]+)",\s*kind: PKind::(\w+),\s*ext: "([^"]*)",/g;
  return [...block.matchAll(re)].map(([, id, kind, ext]) => ({ id, kind: kind.toLowerCase(), ext }));
}

describe("Presets: الواجهة وRust متطابقان", () => {
  const rust = rustPresets();
  const ui = PRESETS.map((p) => ({ id: p.id, kind: p.kind, ext: p.ext }));

  it("قرأنا جدول Rust", () => {
    expect(rust.length).toBeGreaterThan(20);
  });
  it("نفس المعرّفات والأنواع والامتدادات", () => {
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...ui].sort(byId)).toEqual([...rust].sort(byId));
  });
  it("لا معرّف مكرر", () => {
    expect(new Set(ui.map((p) => p.id)).size).toBe(ui.length);
  });
});
