import type { Settings } from "./api";

/**
 * زر الثيم في الشريط: يقلب الشكل في كل نقرة، ولا يُضيّع «حسب النظام» (U-70).
 * إن كان المطلوب يطابق ما يختاره النظام نرجع إلى "system" بدل تثبيته،
 * فمن كان يتبع النظام يعود إليه بنقرتين.
 */
export function nextTheme(resolved: "dark" | "light", systemLight: boolean): Settings["theme"] {
  const want = resolved === "light" ? "dark" : "light";
  return (want === "light") === systemLight ? "system" : want;
}
