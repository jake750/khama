import { describe, expect, it } from "vitest";
import { arCount, dictionaries } from "./i18n";

const files = { one: "ملف واحد", two: "ملفان", few: "# ملفات", many: "# ملفًا", other: "# ملف" };

describe("arCount (T-58)", () => {
  it("يختار الصيغة العربية الصحيحة", () => {
    expect(arCount(1, files)).toBe("ملف واحد");
    expect(arCount(2, files)).toBe("ملفان");
    expect(arCount(3, files)).toBe("3 ملفات");
    expect(arCount(10, files)).toBe("10 ملفات");
    expect(arCount(11, files)).toBe("11 ملفًا");
    expect(arCount(99, files)).toBe("99 ملفًا");
    expect(arCount(100, files)).toBe("100 ملف");
    expect(arCount(103, files)).toBe("103 ملفات");
  });
  it("صيغة الصفر اختيارية", () => {
    expect(arCount(0, files)).toBe("0 ملف");
    expect(arCount(0, { ...files, zero: "لا ملفات" })).toBe("لا ملفات");
  });
});

describe("القاموس العربي", () => {
  const ar = dictionaries.ar;
  it("يستخدم الصيغ الصحيحة", () => {
    expect(ar.filesTitle(100)).toBe("100 ملف");
    expect(ar.historyCount(0)).toBe("لا تنزيلات");
    expect(ar.historyCount(2)).toBe("تنزيلان");
    expect(ar.downloadN(2)).toBe("تنزيل عنصرين");
    expect(ar.convertBtn(2)).toBe("حوّل الملفين");
    expect(ar.markersFound(15)).toBe("وُجدت 15 نقطة");
  });
});
