import { describe, expect, it } from "vitest";
import { CHANGELOG, compareVersions, notesSince } from "./changelog";

describe("changelog (R3-U36)", () => {
  it("compares versions by number, not text", () => {
    expect(compareVersions("0.3.10", "0.3.9")).toBe(1);
    expect(compareVersions("0.3.9", "0.3.10")).toBe(-1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });

  it("collects every release after the last opened one, up to the current", () => {
    const list = [
      { version: "0.4.0", en: ["d"], ar: ["د"] },
      { version: "0.3.12", en: ["c"], ar: ["ج"] },
      { version: "0.3.11", en: ["b"], ar: ["ب"] },
      { version: "0.3.10", en: ["a"], ar: ["أ"] },
    ];
    expect(notesSince("0.3.10", "0.3.12", list).map((n) => n.version)).toEqual(["0.3.12", "0.3.11"]);
    expect(notesSince("0.3.12", "0.3.12", list)).toEqual([]);
  });

  it("is newest first, with the same number of lines in both languages", () => {
    for (let i = 1; i < CHANGELOG.length; i++) expect(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version)).toBe(1);
    for (const n of CHANGELOG) expect(n.ar.length).toBe(n.en.length);
  });
});
