import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// <select> الأصلية يرسمها النظام: زوايا حادة وبلا حركة ولا تتبع ثيم التطبيق. نستعمل <Select> بدلها
describe("لا قوائم منسدلة أصلية", () => {
  it("لا يوجد <select> في واجهة التطبيق", () => {
    const dir = join(__dirname, "components");
    const bad = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx") && f !== "Select.tsx")
      .filter((f) => /<select[\s>]/.test(readFileSync(join(dir, f), "utf8")));
    expect(bad).toEqual([]);
  });
});
