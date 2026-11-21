import type { Topic } from "./api";
import type { TopicRow } from "./components/JobCard";
import { formatDuration, formatTimecode } from "./format";

export const REEL_MIN = 15;
export const REEL_MAX = 90;

/** فترات الصمت التي تُحذف (يبقى `pad` من كل طرف حتى لا يلتصق الكلام)، مقصوصة على [start, end] */
export function silenceCuts(silences: [number, number][], pad: number, start = 0, end = Infinity): [number, number][] {
  return silences.map(([s, e]) => [Math.max(s + pad, start), Math.min(e - pad, end)] as [number, number]).filter(([s, e]) => e - s > 0.01);
}

/** مدة كل موضوع قبل حذف الصمت وبعده، وهل يصلح ريلًا (بمدته بعد الحذف) */
export function topicRows(topics: Topic[], silences: [number, number][], pad: number, reel: [number, number]): TopicRow[] {
  return topics.map((tp) => {
    const before = Math.max(0, tp.end - tp.start);
    const removed = silenceCuts(silences, pad, tp.start, tp.end).reduce((sum, [s, e]) => sum + (e - s), 0);
    const after = Math.max(0, before - removed);
    return { ...tp, before, after, reel: after >= reel[0] && after <= reel[1] };
  });
}

/** القائمة نصًا: سطر لكل موضوع، بأعمدة يفصلها Tab (تُلصق في جدول بيانات) */
export function topicsText(rows: TopicRow[], reelLabel: string): string {
  return rows
    .map((r) =>
      [
        formatTimecode(r.start),
        formatTimecode(r.end),
        formatDuration(r.before),
        formatDuration(r.after),
        r.reel ? reelLabel : "",
        r.title,
        r.text,
      ].join("\t"),
    )
    .join("\n");
}
