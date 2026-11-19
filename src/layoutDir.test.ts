import { describe, expect, it } from "vitest";
import { isMixed, resolveDir } from "./layoutDir";

describe("resolveDir", () => {
  it("auto follows the language", () => {
    expect(resolveDir("auto", "ar")).toBe("rtl");
    expect(resolveDir("auto", "en")).toBe("ltr");
  });
  it("a fixed direction ignores the language", () => {
    expect(resolveDir("ltr", "ar")).toBe("ltr");
    expect(resolveDir("rtl", "en")).toBe("rtl");
    expect(resolveDir("rtl", "ar")).toBe("rtl");
    expect(resolveDir("ltr", "en")).toBe("ltr");
  });
  it("old or unknown values keep the right-to-left layout", () => {
    expect(resolveDir(undefined, "en")).toBe("rtl");
    expect(resolveDir("sideways", "ar")).toBe("rtl");
  });
  it("marks text that reads against the layout", () => {
    expect(isMixed("ltr", "ar")).toBe(true);
    expect(isMixed("rtl", "en")).toBe(true);
    expect(isMixed("auto", "en")).toBe(false);
    expect(isMixed("auto", "ar")).toBe(false);
  });
});
