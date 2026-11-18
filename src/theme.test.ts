import { describe, expect, it } from "vitest";
import { nextTheme } from "./theme";

describe("nextTheme (U-70)", () => {
  it("flips the look on every click", () => {
    expect(nextTheme("dark", false)).toBe("light");
    expect(nextTheme("light", true)).toBe("dark");
  });
  it("goes back to following the system instead of pinning its choice", () => {
    expect(nextTheme("light", false)).toBe("system");
    expect(nextTheme("dark", true)).toBe("system");
  });
});
