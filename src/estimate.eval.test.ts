/**
 * تقييم تقدير الحجم في المحوّل مقابل الحجم الحقيقي (A-30). لا يعمل إلا مع نتائج presets_eval:
 *   KHAMA_EVAL_OUT=<ملف jsonl> npx vitest run src/estimate.eval.test.ts
 * ويطبع جدولًا: الحجم المقدَّر والحقيقي والخطأ النسبي لكل صيغة، وSSIM ومتوسط الزمن وانحرافه.
 */
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import type { MediaInfo } from "./api";
import { defaultOptions } from "./components/ConvertView";
import { estimateSize, PRESETS } from "./presets";

const file = process.env.KHAMA_EVAL_OUT;

type Row = {
  file: string;
  preset: string;
  quality: "high" | "balanced" | "small";
  media: MediaInfo;
  bytes: number;
  secs: number[];
  ssim: number | null;
};

const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const sd = (x: number[]) => (x.length < 2 ? 0 : Math.sqrt(x.reduce((a, b) => a + (b - mean(x)) ** 2, 0) / (x.length - 1)));

describe.skipIf(!file)("estimateSize على ملفات حقيقية (A-30)", () => {
  it("يطبع الجدول", () => {
    const rows: Row[] = readFileSync(file!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const byPreset = new Map<string, { err: number[]; ssim: number[]; speed: number[] }>();
    const lines = ["file | preset | quality | estimate MB | actual MB | error % | SSIM | seconds (mean ± sd)"];
    for (const r of rows) {
      const p = PRESETS.find((x) => x.id === r.preset)!;
      const est = estimateSize(p, r.media, { ...defaultOptions(), quality: r.quality });
      const err = est == null ? NaN : ((est - r.bytes) / r.bytes) * 100;
      const key = `${r.preset} ${r.quality}`;
      const agg = byPreset.get(key) ?? { err: [], ssim: [], speed: [] };
      if (!Number.isNaN(err)) agg.err.push(err);
      if (r.ssim != null) agg.ssim.push(r.ssim);
      agg.speed.push((r.media.duration ?? 0) / mean(r.secs));
      byPreset.set(key, agg);
      lines.push(
        `${r.file} | ${r.preset} | ${r.quality} | ${est == null ? "—" : (est / 1e6).toFixed(1)} | ${(r.bytes / 1e6).toFixed(1)} | ${err.toFixed(0)} | ${r.ssim?.toFixed(3) ?? "—"} | ${mean(r.secs).toFixed(2)} ± ${sd(r.secs).toFixed(2)}`,
      );
    }
    lines.push("", "preset | n | mean error % | mean |error| % | SSIM mean ± sd | speed × realtime mean ± sd");
    for (const [k, a] of byPreset)
      lines.push(
        `${k} | ${a.err.length} | ${mean(a.err).toFixed(0)} | ${mean(a.err.map(Math.abs)).toFixed(0)} | ${a.ssim.length ? `${mean(a.ssim).toFixed(3)} ± ${sd(a.ssim).toFixed(3)}` : "—"} | ${mean(a.speed).toFixed(1)} ± ${sd(a.speed).toFixed(1)}`,
      );
    console.log(lines.join("\n"));
  });
});
