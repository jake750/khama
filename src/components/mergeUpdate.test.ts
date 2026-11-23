import { describe, expect, it } from "vitest";
import { mergeUpdate, overallPercent, type Job } from "./JobCard";

const job = (title: string, thumbnail?: string): Job => ({ id: 1, type: "download", title, meta: "", state: "starting", thumbnail });

describe("mergeUpdate (T-43)", () => {
  it("عنوان yt-dlp يحلّ محلّ الرابط", () => {
    const j = mergeUpdate(job("https://youtu.be/abc"), { id: 1, state: "downloading", title: "عنوان", thumbnail: "t.jpg" });
    expect(j.title).toBe("عنوان");
    expect(j.thumbnail).toBe("t.jpg");
    expect(j.state).toBe("downloading");
  });
  it("لا يغيّر عنوان المعاينة ولا صورتها", () => {
    const j = mergeUpdate(job("من المعاينة", "p.jpg"), { id: 1, state: "downloading", title: "آخر", thumbnail: "t.jpg" });
    expect(j.title).toBe("من المعاينة");
    expect(j.thumbnail).toBe("p.jpg");
  });
  it("مرحلة جديدة بلا نسبة لا ترث نسبة التنزيل (انتظار الفصل لا يعرض 100%)", () => {
    const dl = mergeUpdate(job("x"), { id: 1, state: "downloading", percent: 100, speed: 5e6 });
    const wait = mergeUpdate(dl, { id: 1, state: "separating", stage: "wait" });
    expect(wait.percent).toBeUndefined();
    expect(wait.speed).toBeUndefined();
    expect(mergeUpdate(wait, { id: 1, state: "separating", percent: 12 }).percent).toBe(12);
  });
  it("تحديث التقدّم العادي يبقي العنوان", () => {
    expect(mergeUpdate(job("x"), { id: 1, state: "downloading", percent: 40 })).toMatchObject({ title: "x", percent: 40 });
  });
});

describe("overallPercent: جزءا التنزيل شريط واحد", () => {
  const dl = (stage: Job["stage"], percent: number, kind = "video") =>
    overallPercent({ state: "downloading", stage, percent, request: { kind } as Job["request"] });
  it("نهاية الصورة ليست نهاية الشريط", () => {
    expect(dl("video", 100)).toBe(85);
    expect(dl("audio", 0)).toBe(85);
    expect(dl("audio", 100)).toBe(100);
  });
  it("الشريط لا يرجع بين الجزأين", () => {
    expect(dl("audio", 10)!).toBeGreaterThan(dl("video", 99)!);
  });
  it("تنزيل صوت فقط وملف واحد كما هما", () => {
    expect(dl("audio", 40, "audio")).toBe(40);
    expect(dl("file", 40)).toBe(40);
  });
});
