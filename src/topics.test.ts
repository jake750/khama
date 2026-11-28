import { describe, expect, it } from "vitest";
import { silenceCuts, topicMarkers, topicRows, topicsText } from "./topics";

const topics = [
  { start: 0, end: 40, title: "a · b", text: "first" },
  { start: 40, end: 200, title: "c", text: "second" },
];
const silences: [number, number][] = [
  [10, 20],
  [38, 42],
  [100, 100.2],
];

describe("تحليل المواضيع", () => {
  it("يقص الصمت على حدود الموضوع ويبقي الحافة", () => {
    expect(silenceCuts(silences, 0.5, 0, 40)).toEqual([
      [10.5, 19.5],
      [38.5, 40],
    ]);
    // صمت أقصر من الحافتين لا يُحذف
    expect(silenceCuts([[100, 100.2]], 0.15)).toEqual([]);
  });

  it("المدة بعد حذف الصمت تحدد الريل", () => {
    const rows = topicRows(topics, silences, 0.5, [15, 90]);
    expect(rows[0].before).toBe(40);
    expect(rows[0].after).toBeCloseTo(40 - 9 - 1.5);
    expect(rows[0].reel).toBe(true);
    expect(rows[1].after).toBeCloseTo(160 - 1.5);
    expect(rows[1].reel).toBe(false);
  });

  it("ينسخ سطرًا لكل موضوع بأعمدة", () => {
    const text = topicsText(topicRows(topics, [], 0, [15, 90]), "Reel");
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].split("\t")).toEqual(["0:00", "0:40", "0:40", "0:40", "Reel", "a · b", "first"]);
    expect(lines[1].split("\t")[4]).toBe("");
  });

  it("يجعل المواضيع علامات بأسمائها وألوان صلاحيتها (R3-F11)", () => {
    const rows = topicRows([...topics, { start: 200, end: 210, title: " ", text: "" }], [], 0, [15, 90]);
    const marks = topicMarkers(
      rows,
      [
        { kind: "reel", parts: [] },
        {
          kind: "split",
          parts: [
            [40, 100],
            [100, 160],
          ],
        },
      ],
      { topic: (n) => `Topic ${n}`, part: (n) => `Part ${n}`, kind: { reel: "Reel", split: "Split", no: "No" } },
    );
    expect(marks.map((m) => [m.name, m.start, m.end, m.color])).toEqual([
      ["a · b", 0, 40, "Green"],
      ["c", 40, 200, "Yellow"],
      ["c · Part 1", 40, 100, "Green"],
      ["c · Part 2", 100, 160, "Green"],
      // بلا عنوان ولا خطة: برقمه، ولا يصلح (أقصر من الريل)
      ["Topic 3", 200, 210, "Red"],
    ]);
    expect(marks[0].note).toBe("Reel · 0:40 · first");
    expect(marks[4].note).toBe("No · 0:10");
  });
});
