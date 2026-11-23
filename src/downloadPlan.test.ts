import { describe, expect, it } from "vitest";
import type { ProbeInfo } from "./api";
import { laneClips, nextClip, optionsFromMeta, planDownloads, scheduledAt, subtitleLangs, type PlanInput } from "./downloadPlan";

const settings: PlanInput["settings"] = {
  kind: "video",
  videoFormat: "mp4",
  audioFormat: "mp3",
  quality: "1080",
  editorReady: true,
  wantSubs: false,
  subLangs: [],
  wantThumb: false,
  wantInfo: false,
};

const info = (over: Partial<ProbeInfo> = {}): ProbeInfo =>
  ({
    title: "فيديو",
    thumbnail: "t.jpg",
    duration: 100,
    isLive: false,
    subtitles: [],
    original: false,
    heights: [1080],
    ...over,
  }) as ProbeInfo;

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  settings,
  urls: ["https://youtu.be/a"],
  info: info(),
  stills: "off",
  stems: "off",
  selected: new Set(),
  stemsScope: "all",
  picked: new Set(),
  clips: null,
  joinClips: true,
  timeline: true,
  canTimeline: true,
  ...over,
});

describe("scheduledAt", () => {
  const now = new Date(2026, 10, 15, 14, 30);
  it("الآن = بلا جدولة", () => expect(scheduledAt("now", "16:00", now)).toBeUndefined());
  it("وقت لاحق اليوم", () => expect(scheduledAt("later", "16:00", now)).toBe(new Date(2026, 10, 15, 16, 0).getTime()));
  it("وقت مضى ← غدًا", () => expect(scheduledAt("later", "09:15", now)).toBe(new Date(2026, 10, 16, 9, 15).getTime()));
  it("بعد يومين (U-46)", () => expect(scheduledAt("later", "09:15", now, 2)).toBe(new Date(2026, 10, 17, 9, 15).getTime()));
  it("نهاية الشهر", () => expect(scheduledAt("later", "08:00", new Date(2026, 10, 30, 9), 1)).toBe(new Date(2026, 11, 1, 8).getTime()));
});

describe("subtitleLangs", () => {
  const subs = [
    { code: "fr", name: "French", auto: false },
    { code: "ar", name: "Arabic", auto: false },
  ];
  it("بلا ترجمة", () => expect(subtitleLangs({ wantSubs: false, subLangs: ["ar"] }, null)).toEqual([]));
  it("المختارة المتاحة في الفيديو", () =>
    expect(subtitleLangs({ wantSubs: true, subLangs: ["ar", "de"] }, info({ subtitles: subs }))).toEqual(["ar"]));
  it("لا مختارة متاحة ← أول لغة", () =>
    expect(subtitleLangs({ wantSubs: true, subLangs: ["de"] }, info({ subtitles: subs }))).toEqual(["fr"]));
  it("بلا معاينة ← المختارة أو en+ar", () => {
    expect(subtitleLangs({ wantSubs: true, subLangs: [] }, null)).toEqual(["en", "ar"]);
    expect(subtitleLangs({ wantSubs: true, subLangs: ["de"] }, null)).toEqual(["de"]);
  });
});

describe("nextClip", () => {
  it("بعد آخر مقطع بطول 10%", () => expect(nextClip(100, [{ start: 0, end: 20 }])).toEqual({ start: 20, end: 30 }));
  it("من البداية إن لم يبقَ وقت", () => expect(nextClip(100, [{ start: 0, end: 95 }])).toEqual({ start: 0, end: 10 }));
  it("لا يتجاوز 60 ثانية", () => expect(nextClip(3600, []).end).toBe(60));
  it("من موضع التشغيل (U-47)", () => expect(nextClip(100, [{ start: 0, end: 20 }], 50)).toEqual({ start: 50, end: 60 }));
  it("موضع قرب النهاية ينتهي عندها", () => expect(nextClip(100, [], 97)).toEqual({ start: 90, end: 100 }));
});

describe("planDownloads", () => {
  it("رابط واحد كامل", () => {
    const [d] = planDownloads(input());
    expect(d.title).toBe("فيديو");
    expect(d.request).toMatchObject({ url: "https://youtu.be/a", start: null, end: null, clips: [], stems: null, editorReady: true });
  });

  it("مقطع واحد جزئي ← start/end", () => {
    const [d] = planDownloads(input({ clips: [{ start: 10, end: 40 }] }));
    expect(d.request).toMatchObject({ start: 10, end: 40, clips: [] });
  });

  it("مقطع يغطي الفيديو كله ← الملف كاملًا", () => {
    const [d] = planDownloads(input({ clips: [{ start: 0, end: 100 }] }));
    expect(d.request).toMatchObject({ start: null, end: null });
  });

  it("عدة مقاطع: دمج أو ملفات منفصلة مع تايم لاين", () => {
    const clips = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ];
    expect(planDownloads(input({ clips }))[0].request).toMatchObject({
      clips: [
        [0, 10],
        [20, 30],
      ],
      joinClips: true,
      timeline: false,
    });
    expect(planDownloads(input({ clips, joinClips: false }))[0].request).toMatchObject({ joinClips: false, timeline: true });
    expect(planDownloads(input({ clips, joinClips: false, canTimeline: false }))[0].request.timeline).toBe(false);
  });

  it("عدة روابط: طلب لكل رابط بالرابط عنوانًا", () => {
    const urls = ["https://a.com/1", "https://a.com/2"];
    const plan = planDownloads(input({ urls, info: null, stems: "voice" }));
    expect(plan.map((p) => p.title)).toEqual(urls);
    expect(plan.every((p) => p.request.stems === "voice")).toBe(true);
  });

  it("قائمة تشغيل: المحدَّد فقط بالترتيب، في مجلد باسمها، والموسيقى من المختار", () => {
    const entries = [0, 1, 2].map((i) => ({ url: `https://a.com/${i}`, title: `عنصر ${i}`, thumbnail: null }));
    const plan = planDownloads(
      input({
        info: info({ title: "قائمتي", entries } as Partial<ProbeInfo>),
        selected: new Set([2, 0]),
        stems: "music",
        stemsScope: "pick",
        picked: new Set([2]),
      }),
    );
    expect(plan.map((p) => p.title)).toEqual(["عنصر 0", "عنصر 2"]);
    expect(plan.map((p) => p.request.stems)).toEqual([null, "music"]);
    expect(plan[0].request.subdir).toBe("قائمتي");
  });

  it("قائمة تشغيل: كل عنصر بمقاطعه (جزء، عدة مقاطع، أو كاملًا)", () => {
    const entries = [0, 1, 2].map((i) => ({ url: `https://a.com/${i}`, title: `عنصر ${i}`, thumbnail: null, duration: 100 }));
    const plan = planDownloads(
      input({
        info: info({ title: "قائمتي", entries } as Partial<ProbeInfo>),
        selected: new Set([0, 1, 2]),
        entryClips: new Map([
          [0, { duration: 100, clips: [{ start: 10, end: 40 }], join: true }],
          [
            1,
            {
              duration: 100,
              clips: [
                { start: 0, end: 10 },
                { start: 50, end: 60 },
              ],
              join: false,
            },
          ],
        ]),
      }),
    );
    expect(plan[0].request).toMatchObject({ start: 10, end: 40, clips: [], joinClips: false });
    expect(plan[1].request).toMatchObject({
      start: null,
      end: null,
      clips: [
        [0, 10],
        [50, 60],
      ],
      joinClips: false,
    });
    expect(plan[2].request).toMatchObject({ start: null, end: null, clips: [] });
    // مطابقة أغنية سبوتيفاي تبقى على مدة الأغنية كاملة لا المقطع
    expect(plan[0].request.expectDuration).toBe(100);
  });

  it("الملف الأصلي (Drive) بلا تحويل للمونتاج", () => {
    expect(planDownloads(input({ info: info({ original: true }) }))[0].request).toMatchObject({ original: true, editorReady: false });
  });

  it("اللقطات للفيديو فقط", () => {
    expect(planDownloads(input({ stills: "10" }))[0].request.stills).toBe("10");
    expect(planDownloads(input({ stills: "10", settings: { ...settings, kind: "audio" } }))[0].request.stills).toBeNull();
  });
});

describe("optionsFromMeta (U-40)", () => {
  it("restores kind, format and quality from the history line", () => {
    expect(optionsFromMeta("video", "MP4 · 1080p")).toEqual({ kind: "video", videoFormat: "mp4", quality: "1080" });
    expect(optionsFromMeta("video", "MOV · 4K")).toEqual({ kind: "video", videoFormat: "mov", quality: "2160" });
    expect(optionsFromMeta("audio", "AAC")).toEqual({ kind: "audio", audioFormat: "m4a" });
    expect(optionsFromMeta("audio", "WAV")).toEqual({ kind: "audio", audioFormat: "wav" });
  });
  it("leaves what it can't read", () => {
    expect(optionsFromMeta("video", "ملف Drive")).toEqual({ kind: "video" });
    expect(optionsFromMeta("video", "MP4 · Best")).toEqual({ kind: "video", videoFormat: "mp4" });
  });
});

describe("laneClips (D-103)", () => {
  it("يضع المتداخل في صف جديد ويعيد استعمال الصف الفارغ", () => {
    const r = laneClips([
      { start: 0, end: 60 },
      { start: 30, end: 90 },
      { start: 70, end: 100 },
    ]);
    expect(r.lane).toEqual([0, 1, 0]);
    expect(r.count).toBe(2);
    expect(laneClips([]).count).toBe(1);
  });
});
