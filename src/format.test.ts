import { describe, expect, it } from "vitest";
import { dictionaries } from "./i18n";
import {
  chapterStarts,
  timeTicks,
  extractUrls,
  formatBytes,
  formatDuration,
  formatEta,
  formatTimecode,
  isHttpUrl,
  parseTime,
  youtubeChapters,
} from "./format";

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

describe("frame timecode (U-16)", () => {
  it("formats HH:MM:SS:FF when fps is known", () => {
    expect(formatTimecode(75.5, 24)).toBe("00:01:15:12");
    expect(formatTimecode(3661, 25)).toBe("01:01:01:00");
    expect(formatTimecode(1.999, 30)).toBe("00:00:02:00");
  });
  it("parses HH:MM:SS:FF and rejects frames past the rate", () => {
    expect(parseTime("00:01:15:12", 24)).toBe(75.5);
    expect(parseTime("00:00:01:25", 25)).toBeNull();
    expect(parseTime("00:00:01:12")).toBeNull();
    expect(parseTime("1:15", 24)).toBe(75);
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
  it("يرفض الدقائق والثواني فوق 59 (T-71)", () => {
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
  it("يحذف علامات الترقيم في آخر الرابط (T-50)", () => {
    expect(extractUrls("شوف https://youtu.be/abc.")).toEqual(["https://youtu.be/abc"]);
    expect(extractUrls("(https://youtu.be/abc)")).toEqual(["https://youtu.be/abc"]);
    expect(extractUrls("https://a.com/x، https://b.com/y؟")).toEqual(["https://a.com/x", "https://b.com/y"]);
  });
  it("يبقي الأقواس المتوازنة داخل الرابط", () => {
    expect(extractUrls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });
  it("يقبل www. و youtu.be/ بلا https:// (R2-39)", () => {
    expect(extractUrls("شوف www.youtube.com/watch?v=abc")).toEqual(["https://www.youtube.com/watch?v=abc"]);
    expect(extractUrls("youtu.be/abc.")).toEqual(["https://youtu.be/abc"]);
    expect(extractUrls("https://www.a.com/x")).toEqual(["https://www.a.com/x"]);
    expect(extractUrls("me@www.a.com")).toEqual([]);
  });
  it("يزيل التكرار", () => {
    expect(extractUrls("https://a.com https://a.com")).toEqual(["https://a.com"]);
  });
  it("يُسقط روابط الحسابات حين يوجد معها فيديو (U-66)", () => {
    expect(extractUrls("by https://x.com/someone https://x.com/someone/status/123 on https://www.youtube.com/@chan")).toEqual([
      "https://x.com/someone/status/123",
    ]);
    expect(extractUrls("https://www.youtube.com/@chan")).toEqual(["https://www.youtube.com/@chan"]);
    expect(extractUrls("https://www.instagram.com/me https://www.instagram.com/reel/abc")).toEqual(["https://www.instagram.com/reel/abc"]);
  });
});

describe("isHttpUrl (T-70)", () => {
  it("يقبل روابط http/https كاملة", () => {
    expect(isHttpUrl(" https://youtu.be/abc ")).toBe(true);
    expect(isHttpUrl("http://example.com/a?b=c")).toBe(true);
  });
  it("يرفض غيرها", () => {
    for (const bad of ["https://", "ftp://x.com", "youtu.be/abc", "javascript:alert(1)", "https://a.com b", ""]) {
      expect(isHttpUrl(bad)).toBe(false);
    }
  });
});

describe("formatBytes (T-69)", () => {
  const t = dictionaries.en;
  it("وحدات 1024 مثل مستكشف Windows", () => {
    expect(formatBytes(t, 1024)).toBe(`1 ${t.bytes[1]}`);
    expect(formatBytes(t, 1536 * 1024)).toBe(`1.5 ${t.bytes[2]}`);
    expect(formatBytes(t, null)).toBe("");
  });
});

describe("youtubeChapters (U-60)", () => {
  it("starts at 0:00 and uses h:mm:ss past an hour", () => {
    expect(youtubeChapters([65, 3725], (n) => `Part ${n}`)).toBe("0:00 Part 1\n1:05 Part 2\n1:02:05 Part 3");
  });
  it("drops chapters shorter than 10 s, which make YouTube ignore all of them (R2-4)", () => {
    expect(chapterStarts([3, 9.5, 12, 15, 21.9, 22, 80])).toEqual([0, 12, 22, 80]);
    expect(chapterStarts([])).toEqual([0]);
  });
});

describe("formatBytes / formatEta at unit edges (R2-61, R2-62)", () => {
  const t = dictionaries.en;
  it("rolls 1023.7 KB over to MB", () => {
    expect(formatBytes(t, 1023.7 * 1024)).toBe(`1.0 ${t.bytes[2]}`);
    expect(formatBytes(t, 1023.4 * 1024)).toBe(`1023 ${t.bytes[1]}`);
  });
  it("never says 60 seconds or 60 minutes", () => {
    expect(formatEta(t, 59.6)).toBe(t.minLeft(1));
    expect(formatEta(t, 3590)).toBe(t.left(formatDuration(3590)));
    expect(formatEta(t, 30)).toBe(t.secLeft(30));
  });
});

describe("timeTicks (D-102)", () => {
  it("يختار خطوة مألوفة وعددًا معقولًا", () => {
    expect(timeTicks(0)).toEqual([]);
    expect(timeTicks(10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(timeTicks(212)).toEqual([0, 60, 120, 180]);
    expect(timeTicks(3600).length).toBeLessThanOrEqual(7);
  });
});
