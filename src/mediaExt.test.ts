/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEDIA_EXTENSIONS } from "./mediaExt";

// المجلدات المراقَبة (Rust) تقبل ما يقبله المحوّل (الواجهة) بالضبط (R2-72، R2-95)
describe("قائمة امتدادات الوسائط", () => {
  it("Rust MEDIA_EXT = MEDIA_EXTENSIONS", () => {
    const src = readFileSync(fileURLToPath(new URL("../src-tauri/src/convert/watcher.rs", import.meta.url)), "utf8");
    const block = src.slice(src.indexOf("MEDIA_EXT: &[&str] = &["), src.indexOf("];", src.indexOf("MEDIA_EXT: &[&str] = &[")));
    const rust = [...block.matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
    expect([...rust].sort()).toEqual([...MEDIA_EXTENSIONS].sort());
    expect(new Set(MEDIA_EXTENSIONS).size).toBe(MEDIA_EXTENSIONS.length);
  });
});
