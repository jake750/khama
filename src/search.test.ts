import { describe, expect, it } from "vitest";
import { matches, searchText } from "./search";

describe("البحث العربي (R2-33، R2-92)", () => {
  it("يوحّد الهمزات والتاء المربوطة والألف المقصورة ويحذف التشكيل", () => {
    expect(searchText("أُغنيّة")).toBe("اغنيه");
    expect(searchText("إلى مستشفى")).toBe("الي مستشفي");
    expect(searchText("ســلام")).toBe("سلام");
  });
  it("يطابق بلا اعتبار لطريقة الكتابة ولا لحالة الأحرف", () => {
    expect(matches("اغنية", ["أُغنية جديدة"])).toBe(true);
    expect(matches("مدرسه", ["فيديو المدرسة"])).toBe(true);
    expect(matches("Cat", ["funny cats"])).toBe(true);
    expect(matches("كلب", ["قطة"])).toBe(false);
    expect(matches("  ", ["x"])).toBe(true);
  });
});
