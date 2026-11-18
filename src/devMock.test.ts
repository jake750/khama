/// <reference types="node" />
// العقد بين ثلاث نسخ من الـ API (T-77): أوامر Rust (lib.rs)، والجسر (api.ts)، والبيانات التجريبية
// (dev-mock.ts) التي تُعرض بها الواجهة في المتصفح. كانت تنحرف دون أن يلاحظ أحد.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const lib = read("../src-tauri/src/lib.rs");
const handlers = lib.slice(lib.indexOf("macro_rules! handlers_with"));
const rust = new Set([...handlers.matchAll(/\b[a-z_]+::([a-z_]+)\s*[,\]\n]/g)].map((m) => m[1]));
const api = new Set([...read("./api.ts").matchAll(/invoke(?:<[^(]*>)?\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
const mocked = new Set([...read("./dev-mock.ts").matchAll(/case "([a-z_]+)"/g)].map((m) => m[1]));

/** أوامر لا تحتاج بيانات تجريبية: الرد الافتراضي (null) يكفي لمعاينة الواجهة */
const NULL_IS_FINE = new Set([
  "save_settings",
  "save_scheduled",
  "save_cookies",
  "delete_cookies",
  "cancel_download",
  "remember_job",
  "list_jobs",
  "reveal_file",
  "open_file",
  "cancel_probe",
  "open_output_dir",
  "save_thumbnail",
  "free_space",
  "remove_history",
  "clear_history",
  "update_ytdlp",
  "import_files",
  "quit_app",
  "set_compact",
  "hide_main",
  "take_deep_link",
]);

describe("أوامر Rust والجسر والبيانات التجريبية (T-77)", () => {
  it("وجد الأوامر", () => {
    expect(rust.size).toBeGreaterThan(25);
    expect(api.size).toBeGreaterThan(25);
  });
  it("كل أمر في api.ts مسجّل في Rust", () => {
    expect([...api].filter((c) => !rust.has(c))).toEqual([]);
  });
  it("كل أمر في Rust إمّا له بيانات تجريبية أو مذكور أن null يكفيه", () => {
    expect([...rust].filter((c) => !mocked.has(c) && !NULL_IS_FINE.has(c))).toEqual([]);
  });
  it("لا بيانات تجريبية لأمر حُذف من Rust", () => {
    expect([...mocked].filter((c) => !rust.has(c))).toEqual([]);
  });
});
