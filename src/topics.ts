import type { TimelineMarker, Topic } from "./api";
import type { TopicRow } from "./components/JobCard";
import { formatDuration, formatTimecode } from "./format";
import { silenceCuts, type Range, type TopicKind, type TopicPlan } from "./reels";

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

/** ما يبقى بعد الكلام وقبله عند حذف الصمت (ث)، إن لم يختر المستخدم غيره */
export const SILENCE_PAD = 0.15;

/** فترات الصمت التي تُحذف في الملف كله، بهامشي الكلام من خيارات التحليل (للتصدير والتشغيل «بلا صمت») */
export function removedSilences(
  silences: [number, number][] | null | undefined,
  o?: { silencePad?: number | null; silencePadBefore?: number | null } | null,
): [number, number][] {
  const pad = Math.max(0, o?.silencePad ?? SILENCE_PAD);
  return silenceCuts(silences ?? [], pad, 0, Infinity, Math.max(0, o?.silencePadBefore ?? pad));
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

// ======================= تعديل المواضيع (R3-U5) =======================

/** خطوة تعديل الحدّين (ث) */
export const NUDGE = 0.5;

/** حدّا المقطع بعد التعديل `d` (فرق البداية والنهاية): البداية لا تقل عن صفر، والمقطع نصف ثانية على الأقل */
export function adjusted([s, e]: Range, d: Range = [0, 0]): Range {
  const start = Math.max(0, s + d[0]);
  return [start, Math.max(start + NUDGE, e + d[1])];
}

/** يحرّك حدًّا واحدًا (0 البداية، 1 النهاية) بـ `by` ث، ويعيد الفرق الجديد عن الأصل */
export function nudged(base: Range, d: Range | undefined, edge: 0 | 1, by: number): Range {
  let [s, e] = adjusted(base, d);
  if (edge === 0) s = Math.min(Math.max(0, s + by), e - NUDGE);
  else e = Math.max(e + by, s + NUDGE);
  return [s - base[0], e - base[1]];
}

/**
 * المقاطع المختارة بالترتيب: موضوع كامل أو أجزاء منه (لا يجتمعان في موضوع واحد)، بحدودها بعد التعديل
 * `at`، واسم كل منها: عنوان الموضوع، و«عنوانه · جزء n» للجزء (R3-U5)
 */
export function selectedClips(
  rows: TopicRow[],
  plans: TopicPlan[],
  picked: Set<string>,
  at: (key: string, base: Range) => Range = (_k, r) => r,
  title: (i: number) => string = (i) => rows[i]?.title ?? "",
  part: (n: number) => string = (n) => `${n}`,
): { range: Range; name: string }[] {
  const out: { range: Range; name: string }[] = [];
  rows.forEach((r, i) => {
    const name = title(i).trim();
    if (picked.has(`${i}`)) out.push({ range: at(`${i}`, [r.start, r.end]), name });
    else
      plans[i]?.parts.forEach(
        (p, k) => picked.has(`${i}.${k}`) && out.push({ range: at(`${i}.${k}`, p), name: name && `${name} · ${part(k + 1)}` }),
      );
  });
  return out.sort((a, b) => a.range[0] - b.range[0]);
}
