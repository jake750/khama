import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// <select> الأصلية يرسمها النظام: زوايا حادة وبلا حركة ولا تتبع ثيم التطبيق. نستعمل <Select> بدلها
describe("لا قوائم منسدلة أصلية", () => {
  it("لا يوجد <select> في واجهة التطبيق", () => {
    // والمجلدات الفرعية (components/download): أربع قوائم أصلية بقيت هناك دون أن يراها الاختبار (R2-14)
    const dir = join(__dirname, "components");
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" });
    const bad = files
      .filter((f) => f.endsWith(".tsx") && !f.endsWith("Select.tsx"))
      .filter((f) => /<select[\s>]/.test(readFileSync(join(dir, f), "utf8")));
    expect(bad).toEqual([]);
  });
});
