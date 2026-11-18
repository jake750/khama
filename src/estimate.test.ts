import { describe, expect, it } from "vitest";
import { convertMinutes, estimateDownload } from "./estimate";

const info = {
  videoSizes: [
    [2160, 900],
    [1080, 300],
    [720, 150],
  ] as [number, number][],
  audioSize: 20,
};

describe("estimateDownload (U-36)", () => {
  it("adds audio to the chosen height, or the nearest lower one", () => {
    expect(estimateDownload(info, "video", "1080")).toBe(320);
    expect(estimateDownload(info, "video", "1440")).toBe(320);
    expect(estimateDownload(info, "video", "best")).toBe(920);
    expect(estimateDownload(info, "video", "480")).toBe(170);
  });
  it("uses only audio for audio downloads, and scales by the trimmed part", () => {
    expect(estimateDownload(info, "audio", "1080")).toBe(20);
    expect(estimateDownload(info, "video", "720", 0.5)).toBe(85);
  });
  it("returns null when yt-dlp gave no sizes", () => {
    expect(estimateDownload({ videoSizes: [], audioSize: null }, "video", "1080")).toBeNull();
    expect(estimateDownload({ videoSizes: [], audioSize: null }, "audio", "1080")).toBeNull();
  });
});

describe("convertMinutes (U-14)", () => {
  it("scales with length and resolution", () => {
    expect(convertMinutes(600, 2160)).toBe(12);
    expect(convertMinutes(600, 1440)).toBe(7);
    expect(convertMinutes(20, 2160)).toBe(1);
    expect(convertMinutes(null, 2160)).toBeNull();
  });
});
