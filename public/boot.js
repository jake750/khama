// R3-V3: قبل React يطبَّق آخر ثيم ولغة واتجاه، فلا وميض أبيض ولا انقلاب اتجاه عند الفتح.
// App يحفظ هذه القيم كلما طبّقها (localStorage)، والإعدادات الحقيقية تبقى في Rust.
try {
  var b = JSON.parse(localStorage.getItem("khama-boot") || "null");
  if (b) {
    var r = document.documentElement;
    if (b.lang) r.lang = b.lang;
    if (b.dir) r.dir = b.dir;
    if (b.theme) r.setAttribute("data-theme", b.theme);
    if (b.mixed) r.setAttribute("data-mixed-dir", "");
  }
} catch (e) {
  /* أول تشغيل أو تخزين معطّل: القيم الافتراضية في index.html */
}
