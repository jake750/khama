// اختبارات الطرف للطرف (T-16): الواجهة الحقيقية في Chromium، وRust بدله dev-mock.ts.
// نستعمل الأدوار والتسميات (كما يراها قارئ الشاشة) لا CSS، فلا تنكسر مع تغيير التصميم.
import { expect, test, type Page } from "@playwright/test";

const OK_LINK = "https://youtu.be/ok";
const OK_TITLE = "كيف تصوّر لقطات سينمائية بهاتفك — دليل كامل للمبتدئين";

/** كل اختبار يبدأ بإعدادات معروفة: إنجليزي، والجولة التعريفية مرّت (الإعدادات يحفظها dev-mock في localStorage) */
async function open(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript(
    (s) => {
      if (!localStorage.getItem("khama.mock.settings")) localStorage.setItem("khama.mock.settings", JSON.stringify(s));
    },
    { language: "en", seenTour: true, ...settings },
  );
  await page.goto("/");
}

const tab = (page: Page, name: string) => page.getByRole("navigation").getByRole("button", { name, exact: true });

/** dev-mock يحفظ بعد 120ms والحفظات تتتابع: ننتظر وصول القيم إلى localStorage قبل إعادة التحميل وإلا سبقها */
async function saved(page: Page, expected: Record<string, unknown>) {
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("khama.mock.settings") ?? "{}"))).toMatchObject(expected);
}

async function paste(page: Page, url: string) {
  await page.getByRole("textbox", { name: "Video link" }).fill(url);
}

test("رابط ← معاينة ← تنزيل ← تنتهي البطاقة ويظهر في السجلّ", async ({ page }) => {
  await open(page);
  await paste(page, OK_LINK);
  await expect(page.getByText(OK_TITLE)).toBeVisible();
  await page.getByRole("button", { name: /^Download MP4/ }).click();
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
  await tab(page, "History").click();
  await expect(page.getByText(OK_TITLE)).toBeVisible();
});

test("قص مدى من الفيديو", async ({ page }) => {
  await open(page);
  await paste(page, OK_LINK);
  await page.getByText("Download only a part", { exact: true }).click();
  await page.getByRole("textbox", { name: "Start" }).fill("0:10");
  await page.getByRole("textbox", { name: "Start" }).blur();
  await page.getByRole("textbox", { name: "End" }).fill("0:40");
  await page.getByRole("textbox", { name: "End" }).blur();
  await expect(page.getByRole("slider", { name: "Start" })).toHaveValue("10");
  await expect(page.getByRole("slider", { name: "End" })).toHaveValue("40");
});

test("التحويل إلى صوت فقط يغيّر زر التنزيل", async ({ page }) => {
  await open(page);
  await paste(page, OK_LINK);
  await expect(page.getByRole("button", { name: /^Download MP4/ })).toBeVisible();
  await page.getByText("Format and quality").click();
  await page.getByRole("group", { name: "Type" }).getByRole("button", { name: "Audio only" }).click();
  await expect(page.getByRole("button", { name: /^Download MP3/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Download MP4/ })).toHaveCount(0);
});

test("المحوّل: إضافة ملف ثم اختيار إعداد ثم البدء", async ({ page }) => {
  await open(page);
  await tab(page, "Convert").click();
  await page.getByRole("button", { name: "Choose files" }).click();
  await expect(page.getByText("clip-phone.mp4").first()).toBeVisible();
  // البطاقة في قسم «الصيغة» (شارة الوصفة تحمل الاسم نفسه)
  const preset = page.locator(".cat-pane").getByRole("button", { name: /^H\.264 for editing/ });
  await preset.click();
  await expect(preset).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("main").getByRole("button", { name: "Convert", exact: true }).click();
  await expect(page.getByText("Done", { exact: true })).toBeVisible({ timeout: 30_000 });
});

test("اللغة والثيم يبقيان بعد إعادة التحميل", async ({ page }) => {
  await open(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await tab(page, "Settings").click();
  await page.getByRole("group", { name: "Appearance" }).getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await saved(page, { theme: "light", language: "ar" });

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "الثيم الفاتح. انقر للداكن" })).toBeVisible({ timeout: 15_000 });
});

test("نص عربي بتخطيط من اليسار لليمين يبقى بعد إعادة التحميل", async ({ page }) => {
  await open(page, { language: "ar" });
  const html = page.locator("html");
  await expect(html).toHaveAttribute("dir", "rtl");
  await tab(page, "الإعدادات").click();
  await page.getByRole("group", { name: "اتجاه الواجهة" }).getByRole("button", { name: "من اليسار لليمين" }).click();
  await expect(html).toHaveAttribute("dir", "ltr");
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(html).toHaveAttribute("data-mixed-dir", "");
  await saved(page, { layoutDir: "ltr" });

  await page.reload();
  await expect(html).toHaveAttribute("dir", "ltr");
  await expect(html).toHaveAttribute("lang", "ar");
  await tab(page, "الإعدادات").click();
  await expect(page.getByRole("group", { name: "اتجاه الواجهة" }).getByRole("button", { name: "من اليسار لليمين" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("رابط يفشل: رسالة مفهومة وزر إعادة المحاولة", async ({ page }) => {
  await open(page);
  await paste(page, "https://example.com/offline");
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  // التفاصيل التقنية مطويّة تحت الرسالة
  await expect(page.getByText("Technical details")).toBeVisible();
});
