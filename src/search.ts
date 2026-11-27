/**
 * نص للبحث: بلا تشكيل ولا تطويل، والهمزات على الألف ألفًا، والتاء المربوطة هاءً، والألف المقصورة ياءً،
 * وبأحرف صغيرة. فـ«اغنية» تجد «أُغنيّة»، و«مدرسه» تجد «مدرسة» (R2-33).
 */
export function searchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

/** هل في أحد الحقول ما يطابق البحث (بعد التطبيع)؟ */
export function matches(query: string, fields: string[]): boolean {
  const q = searchText(query.trim());
  return !q || fields.some((f) => searchText(f).includes(q));
}
