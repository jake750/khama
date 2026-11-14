import { describe, expect, it } from "vitest";
import { extractUrls, formatDuration, formatTimecode, parseTime } from "./format";

describe("formatTimecode", () => {
  it("يعرض أجزاء الثانية", () => {
    expect(formatTimecode(75.5)).toBe("1:15.5");
    expect(formatTimecode(75)).toBe("1:15");
  });
  it("لا يُنتج .10 عند التقريب إلى الثانية التالية (T-2)", () => {
    expect(formatTimecode(59.96)).toBe("1:00");
    expect(formatTimecode(12.98)).toBe("0:13");
  });
  it("لا يقبل القيم السالبة", () => {
    expect(formatTimecode(-3)).toBe("0:00");
  });
});

describe("formatDuration", () => {
  it("دقائق وساعات", () => {
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(null)).toBe("");
  });
});

describe("parseTime", () => {
  it("الصيغ الصالحة", () => {
    expect(parseTime("75")).toBe(75);
    expect(parseTime("1:15")).toBe(75);
    expect(parseTime("1:02:05")).toBe(3725);
    expect(parseTime("1:15.5")).toBe(75.5);
    expect(parseTime("١:١٥")).toBe(75);
    expect(parseTime("۱:۱۵")).toBe(75);
  });
  it("يرفض الدقائق والثواني فوق 59 (T-50)", () => {
    expect(parseTime("1:99")).toBeNull();
    expect(parseTime("1:60:00")).toBeNull();
  });
  it("يرفض الكسر في غير الجزء الأخير", () => {
    expect(parseTime("1.5:10")).toBeNull();
  });
  it("يرفض النص الفارغ وغير الصالح", () => {
    expect(parseTime("")).toBeNull();
    expect(parseTime("abc")).toBeNull();
    expect(parseTime("1::2")).toBeNull();
  });
});

describe("extractUrls", () => {
  it("يحذف علامات الترقيم في آخر الرابط (T-71)", () => {
    expect(extractUrls("شوف https://youtu.be/abc.")).toEqual(["https://youtu.be/abc"]);
    expect(extractUrls("(https://youtu.be/abc)")).toEqual(["https://youtu.be/abc"]);
    expect(extractUrls("https://a.com/x، https://b.com/y؟")).toEqual(["https://a.com/x", "https://b.com/y"]);
  });
  it("يبقي الأقواس المتوازنة داخل الرابط", () => {
    expect(extractUrls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });
  it("يزيل التكرار", () => {
    expect(extractUrls("https://a.com https://a.com")).toEqual(["https://a.com"]);
  });
});
