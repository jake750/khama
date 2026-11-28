/**
 * «ما الجديد» داخل التطبيق بلغة الواجهة (R3-U36)، بدل صفحة الإصدار على GitHub.
 * الأحدث أولًا. أضف سطورًا للإصدار القادم قبل `npm run release` (docs/RELEASING.md):
 * ما يلاحظه المستخدم بكلماته، لا أسماء الملفات ولا رموز المراجعة.
 */
export type ReleaseNotes = { version: string; en: string[]; ar: string[] };

export const CHANGELOG: ReleaseNotes[] = [
  {
    version: "0.3.48",
    en: [
      "Export a timeline or markers for Premiere and DaVinci Resolve from silence removal, topics and scene detection, with no conversion.",
      "Watch and adjust topics before exporting: ▶ on each topic, nudge its start and end, and a title that becomes the file name.",
      "Analysing the same file again is instant: the transcript and silences are remembered.",
      "Unfinished work comes back after a restart, and so does the converter's file list.",
      "Add a whole folder to the converter, and burn each video's own subtitles in a batch.",
      "A link you downloaded before says when, and in which format.",
      "Editing shortcuts in the trim bar: Space/K, I/O, J/L and the arrow keys.",
      "Use your browser's cookies in one click from the error message, then it tries again.",
      "One notification when a batch ends, the Convert button stays in view, and theme preview cards.",
      "Downloads try again on their own after a dropped connection, get past more sites that refuse, and no longer arrive with silent gaps.",
      "With weekly yt-dlp checks on, a site that stops working updates yt-dlp and retries that download.",
      "Voice and music apart in one pass: a video with two audio tracks, or two WAV files.",
      "HDR videos no longer look washed out, a second microphone track is kept, and edit-ready files use your graphics card.",
      "Quick conversions no longer wait behind a long ProRes job, and the speed limit is shared by all downloads.",
    ],
    ar: [
      "«صدّر تايم لاين» و«صدّر العلامات» لـ Premiere وDaVinci Resolve من حذف الصمت والمواضيع والمشاهد، بلا تحويل.",
      "المواضيع تُشاهَد وتُضبط قبل التصدير: ▶ لكل موضوع، وتقديم البداية والنهاية وتأخيرهما، وعنوان يصير اسم الملف.",
      "تحليل الملف نفسه مرة ثانية فوري: النص والصمت محفوظان.",
      "ما لم يكتمل يعود بعد إعادة التشغيل، ومعه قائمة ملفات المحوّل.",
      "«أضف مجلدًا» في المحوّل، وحرق ترجمة كل فيديو باسمه في الدفعة.",
      "رابط نزّلته من قبل يقول متى وبأي صيغة.",
      "اختصارات المونتاج في شريط القص: المسافة/K، وI/O، وJ/L، والأسهم.",
      "كوكيز متصفحك بنقرة من رسالة الخطأ، ثم يعيد المحاولة.",
      "إشعار واحد في آخر الدفعة، وزر «حوّل» يبقى ظاهرًا، والمظهر ببطاقات معاينة.",
      "التنزيل يعيد المحاولة وحده بعد انقطاع الاتصال، ويتجاوز مواقع أكثر كانت ترفض، ولا يصل بفجوات صامتة.",
      "مع «افحص تحديثات yt-dlp أسبوعيًا»، الموقع الذي يتعطّل يحدّث yt-dlp ويعيد ذلك التنزيل.",
      "الحوار والموسيقى منفصلين من مرور واحد: فيديو بمسارين صوتيين، أو ملفّا WAV.",
      "فيديو HDR لم يعد باهتًا، ومسار الميكروفون الثاني يبقى، و«جاهز للمونتاج» يستعمل كرت الشاشة.",
      "التحويلات الخفيفة لا تنتظر خلف ترميز ProRes طويل، وحدّ السرعة صار لكل التنزيلات معًا.",
    ],
  },
];

/** -1 أو 0 أو 1 بمقارنة أرقام النسخة (0.3.10 بعد 0.3.9) */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** ما صدر بعد النسخة السابقة حتى الحالية (قفزة عدة إصدارات تجمعها كلها)، الأحدث أولًا */
export function notesSince(prev: string, current: string, list: ReleaseNotes[] = CHANGELOG): ReleaseNotes[] {
  return list.filter((n) => compareVersions(n.version, prev) > 0 && compareVersions(n.version, current) <= 0);
}
