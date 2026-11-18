import { describe, expect, it } from "vitest";
import { dictionaries } from "./i18n";

/** كل النصوص الثابتة في القاموس مع مساراتها (الدوال تُستثنى) */
function strings(o: unknown, path = ""): [string, string][] {
  if (typeof o === "string") return [[path, o]];
  if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

const en = new Map(strings(dictionaries.en));
const ar = strings(dictionaries.ar);

// كلمات لاتينية تبقى كما هي في العربية: أسماء برامج وصيغ ومواقع
const KEEP = new Set(
  "khama yt-dlp ffmpeg deno youtube instagram tiktok twitter facebook vimeo reels shorts whatsapp premiere resolve davinci final cut capcut avid after effects prores dnxhr proxy windows macos linux android github opus flac webm vp9 hevc lut cube srt xml json netscape chrome firefox edge safari brave cookies.txt ctrl shift enter".split(
    " ",
  ),
);

describe("نصوص القاموس", () => {
  it("لا ثلاث نقاط بدل … (M-23)", () => {
    const bad = [...en, ...ar].filter(([, s]) => s.includes("...")).map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it("لا نص إنجليزي منسي في القاموس العربي (M-50)", () => {
    const bad = ar
      .filter(([k, s]) => {
        const words = s.toLowerCase().match(/[a-z][a-z.-]{3,}/g) ?? [];
        return s === en.get(k) && words.some((w) => !KEEP.has(w));
      })
      .map(([k, s]) => `${k}: ${s}`);
    expect(bad).toEqual([]);
  });
});
