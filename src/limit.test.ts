import { describe, expect, it } from "vitest";
import { limiter } from "./limit";

describe("limiter (U-93)", () => {
  it("never runs more than max at once and still runs everything", async () => {
    const run = limiter(3);
    let now = 0;
    let peak = 0;
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        run(async () => {
          now++;
          peak = Math.max(peak, now);
          await tick();
          now--;
          if (i === 5) throw new Error("boom");
          return i;
        }).catch(() => -1),
      ),
    );
    expect(peak).toBe(3);
    expect(results.filter((r) => r === -1)).toHaveLength(1);
    expect(results[19]).toBe(19);
  });
});
