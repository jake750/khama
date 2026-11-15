/// <reference types="node" />
// رقم الإصدار مصدره package.json وحده (tauri.conf.json يقرؤه منه).
// Cargo.toml يحتاج رقمه الخاص، فهذا الاختبار يمنع اختلافهما (M-100).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("رقم الإصدار", () => {
  it("Cargo.toml يطابق package.json", () => {
    const pkg = JSON.parse(read("../package.json")).version;
    const cargo = read("../src-tauri/Cargo.toml").match(/^version = "(.+)"/m)?.[1];
    expect(cargo).toBe(pkg);
  });
  it("tauri.conf.json يطابق package.json", () => {
    expect(JSON.parse(read("../src-tauri/tauri.conf.json")).version).toBe(JSON.parse(read("../package.json")).version);
  });
});
