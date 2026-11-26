import { describe, expect, it } from "vitest";
import { exportCues, keptPieces, planTopic, silenceCuts, timeline, toSrt, wordsToLines, type Cue, type Word } from "./reels";

const cue = (start: number, end: number, text: string): Cue => ({ start, end, text });

describe("silenceCuts", () => {
  it("keeps a different margin before and after speech", () => {
    // صمت 10–12: يبقى 0.1 بعد الكلام و0.4 قبل التالي
    expect(silenceCuts([[10, 12]], 0.1, 0, Infinity, 0.4)).toEqual([[10.1, 11.6]]);
    expect(silenceCuts([[10, 12]], 0.2)).toEqual([[10.2, 11.8]]);
    expect(silenceCuts([[10, 10.3]], 0.2)).toEqual([]);
  });
});

describe("timeline", () => {
  it("joins sections and drops the cuts", () => {
    expect(
      keptPieces(0, 10, [
        [2, 3],
        [5, 6],
      ]),
    ).toEqual([
      [0, 2],
      [3, 5],
      [6, 10],
    ]);
    const tl = timeline(
      [
        [0, 4],
        [10, 12],
      ],
      [[1, 2]],
    );
    expect(tl).toEqual([
      { src: [0, 1], at: 0 },
      { src: [2, 4], at: 1 },
      { src: [10, 12], at: 3 },
    ]);
  });
});

describe("exportCues", () => {
  const cues = [cue(1, 3, "السلام عليكم."), cue(5, 8, "اليوم نتكلم عن الصبر."), cue(20, 22, "شيء آخر.")];

  it("starts at the clip's zero", () => {
    const out = exportCues(cues, [[4, 9]], []);
    expect(out).toEqual([cue(1, 4, "اليوم نتكلم عن الصبر.")]);
    expect(toSrt(out)).toBe("1\n00:00:01,000 --> 00:00:04,000\nاليوم نتكلم عن الصبر.\n");
  });

  it("moves the times back by the removed silence", () => {
    // الصمت 3–5 حُذف: الجملة الثانية تبدأ عند 3 بدل 5
    const out = exportCues(cues, [[0, 9]], [[3, 5]]);
    expect(out.map((c) => [c.start, c.end])).toEqual([
      [1, 3],
      [3, 6],
    ]);
  });

  it("joins several sections into one timeline", () => {
    const out = exportCues(
      cues,
      [
        [0, 4],
        [19, 23],
      ],
      [],
    );
    expect(out.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 3, "السلام عليكم."],
      [5, 7, "شيء آخر."],
    ]);
  });

  it("breaks long sentences into short lines that never overlap", () => {
    const long = [cue(0, 6, "هذا كلام طويل جدا عن موضوع مهم نريد أن نقسمه إلى أسطر قصيرة.")];
    const out = exportCues(long, [[0, 6]], [], { maxWords: 4, maxSecs: 3 });
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const c of out) expect(c.text.split(" ").length).toBeLessThanOrEqual(4);
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
  });
});

describe("wordsToLines", () => {
  const w = (word: string, start: number, end: number): Word => ({ w: word, start, end });

  it("breaks at a pause and at the end of a sentence, and lines start on their first word", () => {
    const words = [w("أهلا", 0, 0.4), w("بكم.", 0.45, 0.9), w("اليوم", 0.95, 1.3), w("نبدأ", 2.2, 2.6), w("الدرس", 2.65, 3)];
    const out = wordsToLines(words, { maxWords: 7 });
    expect(out.map((c) => c.text)).toEqual(["أهلا بكم.", "اليوم", "نبدأ الدرس"]);
    expect(out[2].start).toBe(2.2);
    // فجوة صغيرة تُسدّ، والكبيرة تبقى
    expect(out[0].end).toBe(0.95);
    expect(out[1].end).toBeLessThan(2.2);
  });

  it("breaks a full line at its longest pause", () => {
    const words = [w("أ", 0, 0.2), w("ب", 0.25, 0.4), w("ج", 0.45, 0.6), w("د", 0.9, 1.1), w("هـ", 1.15, 1.3), w("و", 1.35, 1.5)];
    // الحد 5: الوقفة الطويلة بين «ج» و«د» أولى بالكسر من الكلمة الخامسة
    expect(wordsToLines(words, { maxWords: 5 }).map((c) => c.text)).toEqual(["أ ب ج", "د هـ و"]);
  });

  it("finds the pauses that whisper word ends hide", () => {
    const words = [w("أ", 0, 0.5), w("ب", 0.5, 1.0), w("ج", 1.0, 2.0), w("د", 2.0, 2.4)];
    expect(exportCues([], [[0, 3]], [], { maxWords: 10 }, words).map((c) => c.text)).toEqual(["أ ب ج د"]);
    // صمت 1.3–1.9 داخل «ج»: السطر ينكسر بعدها
    expect(exportCues([], [[0, 3]], [], { maxWords: 10 }, words, [[1.3, 1.9]]).map((c) => c.text)).toEqual(["أ ب ج", "د"]);
  });

  it("never runs past the end of the clip", () => {
    const out = exportCues([cue(0, 2, "كلمة أخيرة")], [[0, 2]], [], { maxWords: 5 });
    expect(out[out.length - 1].end).toBeLessThanOrEqual(2);
  });

  it("respects the maximum duration", () => {
    const words = Array.from({ length: 10 }, (_, i) => w(`ك${i}`, i * 0.5, i * 0.5 + 0.45));
    const out = wordsToLines(words, { maxSecs: 2 });
    for (const c of out) expect(c.end - c.start).toBeLessThanOrEqual(2.3);
  });

  it("does not leave a single word alone at the end of a full line", () => {
    const words = [w("واحد", 0, 0.3), w("اثنان", 0.35, 0.6), w("ثلاثة", 0.65, 0.9), w("أربعة.", 0.95, 1.2)];
    const out = wordsToLines(words, { maxWords: 3 });
    expect(out.map((c) => c.text.split(" ").length)).toEqual([2, 2]);
  });
});

describe("planTopic", () => {
  const reel: [number, number] = [15, 60];

  it("classifies short, fitting and long topics", () => {
    expect(planTopic(0, 10, [], [], [], reel).kind).toBe("no");
    expect(planTopic(0, 40, [], [], [], reel).kind).toBe("reel");
    // 100 ث بلا وقفات: لا يُقسَّم
    expect(planTopic(0, 100, [], [], [], reel)).toEqual({ kind: "no", parts: [], reason: "long" });
  });

  it("splits a long topic at a pause after a full sentence", () => {
    const cues = [cue(0, 49, "الفكرة الأولى انتهت."), cue(51, 100, "الفكرة الثانية تبدأ هنا.")];
    const plan = planTopic(0, 100, cues, [[49, 51]], [], reel);
    expect(plan.kind).toBe("split");
    expect(plan.parts).toEqual([
      [0, 50],
      [50, 100],
    ]);
  });

  it("avoids a part that starts with a connective", () => {
    const cues = [cue(0, 30, "أول."), cue(31, 60, "لكن هذا يكمل ما قبله."), cue(61, 100, "موضوع جديد.")];
    const plan = planTopic(
      0,
      100,
      cues,
      [
        [30, 31],
        [60, 61],
      ],
      [],
      [15, 70],
    );
    expect(plan.kind).toBe("split");
    expect(plan.parts).toEqual([
      [0, 60.5],
      [60.5, 100],
    ]);
  });

  it("counts the length after removing silence", () => {
    // 80 ث فيها 30 ث صمت محذوف: 50 ث تصلح ريلًا
    expect(planTopic(0, 80, [], [[10, 40]], [[10, 40]], reel).kind).toBe("reel");
  });
});
