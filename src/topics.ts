import type { TimelineMarker, Topic } from "./api";
import type { TopicRow } from "./components/JobCard";
import { formatDuration, formatTimecode } from "./format";
import { silenceCuts, type TopicKind, type TopicPlan } from "./reels";

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

/** ألوان العلامات (أسماء ألوان Resolve): الأخضر يصلح ريلًا، والأصفر بعد تقسيمه، والأحمر لا يصلح */
export const MARKER_COLORS: Record<TopicKind, string> = { reel: "Green", split: "Yellow", no: "Red" };

/**
 * المواضيع علاماتٍ لبرنامج المونتاج (R3-F11): علامة بمدى كل موضوع، باسمه ولون نوعه، وفي تعليقها
 * نوعه ومدته بعد حذف الصمت وأول كلامه. وأجزاء «يصلح بعد تقسيمه» علامات خضراء بأسمائها
 */
export function topicMarkers(
  rows: TopicRow[],
  plans: TopicPlan[],
  names: { topic: (n: number) => string; part: (n: number) => string; kind: Record<TopicKind, string> },
): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  rows.forEach((r, i) => {
    const plan = plans[i] ?? { kind: r.reel ? "reel" : "no", parts: [] };
    const name = r.title.trim() || names.topic(i + 1);
    const note = [names.kind[plan.kind], formatDuration(r.after), r.text.trim()].filter(Boolean).join(" · ");
    out.push({ start: r.start, end: r.end, name, note, color: MARKER_COLORS[plan.kind] });
    plan.parts.forEach(([s, e], k) =>
      out.push({ start: s, end: e, name: `${name} · ${names.part(k + 1)}`, note: names.kind.reel, color: MARKER_COLORS.reel }),
    );
  });
  return out;
}
