import { describe, expect, it } from "vitest";
import { nextInCycle } from "./focusTrap";

describe("nextInCycle (M-29)", () => {
  const items = ["a", "b", "c"];
  it("يدور من الأخير إلى الأول ومن الأول إلى الأخير", () => {
    expect(nextInCycle(items, "c", false)).toBe("a");
    expect(nextInCycle(items, "a", true)).toBe("c");
  });
  it("يترك الخطوات الداخلية للمتصفح", () => {
    expect(nextInCycle(items, "a", false)).toBeNull();
    expect(nextInCycle(items, "b", true)).toBeNull();
  });
  it("التركيز خارج النافذة يعود إليها", () => {
    expect(nextInCycle(items, null, false)).toBe("a");
    expect(nextInCycle(items, null, true)).toBe("c");
  });
  it("نافذة بلا عناصر", () => {
    expect(nextInCycle([], null, false)).toBeNull();
  });
});
