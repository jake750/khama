import type { Topic } from "./api";
import type { TopicRow } from "./components/JobCard";
import { formatDuration, formatTimecode } from "./format";
import { silenceCuts } from "./reels";

export { silenceCuts };

export const REEL_MIN = 15;
export const REEL_MAX = 90;

/** مدة كل موضوع قبل حذف الصمت وبعده، وهل يصلح ريلًا (بمدته بعد الحذف) */
export function topicRows(topics: Topic[], silences: [number, number][], pad: number, reel: [number, number], padBefore = pad): TopicRow[] {
  return topics.map((tp) => {
    const before = Math.max(0, tp.end - tp.start);
    const removed = silenceCuts(silences, pad, tp.start, tp.end, padBefore).reduce((sum, [s, e]) => sum + (e - s), 0);
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
