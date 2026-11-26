import { describe, expect, it } from "vitest";
import conf from "../src-tauri/tauri.conf.json";

// 0.3.20 بُني بمفتاح تحديث فارغ فلم يستطع التحقق من أي تحديث بعده: لا يتكرر هذا
describe("updater config", () => {
  it("has a minisign public key and the latest.json endpoint", () => {
    const u = (conf as { plugins: { updater: { pubkey: string; endpoints: string[] } } }).plugins.updater;
    const text = atob(u.pubkey);
    expect(text).toContain("minisign public key");
    expect(u.endpoints[0]).toMatch(/releases\/latest\/download\/latest\.json$/);
  });
});
