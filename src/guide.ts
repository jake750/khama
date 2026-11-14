// محتوى الدليل: مدخل قصير لكل خاصية (ماذا تفعل، متى تستعملها، خطوات).
// النص بالعربية والإنجليزية في نفس المكان، فلا يُنسى أحدهما (TypeScript يطلب الاثنين).

import type { IconName } from "./components/Icon";
import type { ArtName } from "./components/GuideArt";
import type { Lang } from "./i18n";

export type GuideTab = "download" | "convert" | "history" | "settings";
export type GuideGroup = "download" | "convert" | "organize" | "fix";

type Text = { title: string; what: string; when: string; steps: string[] };

export type GuideEntry = {
  id: string;
  group: GuideGroup;
  icon: IconName;
  art: ArtName;
  /** زر «أرني»: التبويب (وقسم الإعدادات إن وُجد) */
  go: { tab: GuideTab; section?: string };
  /** خاصية لا توجد إلا على الكمبيوتر أو الهاتف */
  only?: "desktop" | "mobile";
  text: Record<Lang, Text>;
  /** ما يختلف على الهاتف */
  mobile?: Partial<Record<Lang, Partial<Text>>>;
};

export const GUIDE: GuideEntry[] = [
  // ---------------- التنزيل ----------------
  {
    id: "link",
    group: "download",
    icon: "link",
    art: "link",
    go: { tab: "download" },
    text: {
      en: {
        title: "Download from a link",
        what: "Video or audio from YouTube, Instagram, TikTok, X and 1,000+ other sites.",
        when: "Any time you have a link to something you want to keep or edit.",
        steps: [
          "Copy the link in your browser or app.",
          "Press Ctrl+V anywhere in Khama, or use Paste in the link field.",
          "Wait for the preview, then press Download.",
        ],
      },
      ar: {
        title: "التنزيل من رابط",
        what: "فيديو أو صوت من يوتيوب وإنستغرام وتيك توك وX وأكثر من ألف موقع آخر.",
        when: "كلما كان معك رابط لشيء تريد الاحتفاظ به أو العمل عليه.",
        steps: [
          "انسخ الرابط من المتصفح أو التطبيق.",
          "اضغط Ctrl+V في أي مكان داخل خامة، أو زر «لصق» في حقل الرابط.",
          "انتظر ظهور المعاينة، ثم اضغط «تنزيل».",
        ],
      },
    },
    mobile: {
      en: { steps: ["Copy the link in your browser or app.", "Tap Paste in the link field.", "Wait for the preview, then tap Download. Files go to Download/Khama."] },
      ar: { steps: ["انسخ الرابط من المتصفح أو التطبيق.", "اضغط «لصق» في حقل الرابط.", "انتظر ظهور المعاينة، ثم اضغط «تنزيل». الملفات تُحفظ في Download/Khama."] },
    },
  },
  {
    id: "format",
    group: "download",
    icon: "film",
    art: "format",
    go: { tab: "download" },
    text: {
      en: {
        title: "Format, quality and edit-ready",
        what: "Choose video or audio only, the file type and the resolution. Edit-ready makes H.264 + AAC at a constant frame rate.",
        when: "Turn on Edit-ready when the file goes into Premiere, DaVinci or CapCut, so audio never drifts out of sync.",
        steps: ["Open “Format and quality” under the link.", "Pick Video or Audio only, then the format and quality.", "Keep “Edit-ready” on for editing."],
      },
      ar: {
        title: "الصيغة والجودة والجاهزية للمونتاج",
        what: "اختر فيديو أو صوتًا فقط، ونوع الملف، والدقة. خيار «جاهز للمونتاج» يعطيك H.264 وAAC بمعدل إطارات ثابت.",
        when: "فعّل «جاهز للمونتاج» إذا كان الملف ذاهبًا إلى Premiere أو DaVinci أو CapCut، فلا يتأخر الصوت عن الصورة.",
        steps: ["افتح «الصيغة والجودة» تحت حقل الرابط.", "اختر فيديو أو صوت فقط، ثم الصيغة والجودة.", "أبقِ «جاهز للمونتاج» مفعّلًا إن كنت ستعمل مونتاج."],
      },
    },
  },
  {
    id: "trim",
    group: "download",
    icon: "scissors",
    art: "trim",
    go: { tab: "download" },
    text: {
      en: {
        title: "Download only a part, or several clips",
        what: "Downloads just the seconds you need instead of the whole video. Faster and smaller.",
        when: "A long video, a stream recording or a podcast where you only need a few moments.",
        steps: [
          "Paste the link and wait for the preview.",
          "Turn on “Download only a part”.",
          "Set start and end, or play the preview and press “Set start here” / “Set end here”.",
          "Need more moments? “Add clip”, then save them as one video or separate files.",
        ],
      },
      ar: {
        title: "تنزيل جزء فقط أو عدة مقاطع",
        what: "ينزّل الثواني التي تحتاجها فقط بدل الفيديو كاملًا، فيكون أسرع وأصغر.",
        when: "فيديو طويل أو بث مسجّل أو بودكاست تحتاج منه لحظات قليلة.",
        steps: [
          "الصق الرابط وانتظر المعاينة.",
          "فعّل «تنزيل جزء فقط».",
          "حدّد البداية والنهاية، أو شغّل المعاينة واضغط «البداية من هنا» و«النهاية هنا».",
          "تريد لحظات أخرى؟ «إضافة مقطع»، ثم احفظها فيديو واحدًا أو ملفات منفصلة.",
        ],
      },
    },
  },
  {
    id: "playlist",
    group: "download",
    icon: "layers",
    art: "playlist",
    go: { tab: "download" },
    text: {
      en: {
        title: "Playlists and many links",
        what: "A playlist, a channel, a Google Drive folder, a Spotify playlist, or several links pasted at once.",
        when: "When you need a batch of files with the same settings.",
        steps: [
          "Paste a playlist link, or several links separated by spaces or new lines.",
          "Untick the items you don't want.",
          "Press “Download N”. Each item uses the options you chose.",
        ],
      },
      ar: {
        title: "قوائم التشغيل وعدة روابط",
        what: "قائمة تشغيل، أو قناة، أو مجلد Google Drive، أو قائمة سبوتيفاي، أو عدة روابط ملصوقة معًا.",
        when: "عندما تحتاج مجموعة ملفات بنفس الإعدادات.",
        steps: [
          "الصق رابط القائمة، أو عدة روابط بينها مسافة أو سطر جديد.",
          "ألغِ تحديد ما لا تريده.",
          "اضغط «تنزيل N». كل عنصر يُنزَّل بالخيارات التي اخترتها.",
        ],
      },
    },
  },
  {
    id: "stems",
    group: "download",
    icon: "music",
    art: "stems",
    go: { tab: "download" },
    text: {
      en: {
        title: "Remove music or voice (AI)",
        what: "An AI model splits the sound: “Remove music” keeps only the voice, “Remove voice” keeps only the music.",
        when: "A clean voiceover from a noisy video, or background music without the talking. Works on your own files too: Convert → Audio.",
        steps: [
          "Paste the link, then open “Extras”.",
          "Under “AI clean-up”, pick “Remove music” or “Remove voice”.",
          "Download. The model (about 140 MB) is downloaded once; separating takes about as long as the audio.",
        ],
      },
      ar: {
        title: "إزالة الموسيقى أو الصوت البشري (ذكاء اصطناعي)",
        what: "نموذج ذكاء اصطناعي يفصل الصوت: «إزالة الموسيقى» يُبقي الكلام فقط، و«إزالة الصوت البشري» يُبقي الموسيقى فقط.",
        when: "تعليق صوتي نظيف من فيديو مليء بالموسيقى، أو موسيقى خلفية بلا كلام. يعمل على ملفاتك أيضًا: التحويل ← صوت.",
        steps: [
          "الصق الرابط، ثم افتح «إضافات».",
          "تحت «تنظيف بالذكاء الاصطناعي» اختر «إزالة الموسيقى» أو «إزالة الصوت البشري».",
          "نزّل. النموذج (نحو 140 ميغابايت) يُنزَّل مرة واحدة، والفصل يأخذ تقريبًا مدة الصوت نفسه.",
        ],
      },
    },
    mobile: {
      en: { steps: ["Paste the link, then open “Extras”.", "Under “AI clean-up”, pick “Remove music” or “Remove voice”.", "Download. The model (about 67 MB) is downloaded once. On a phone it's slow and the phone gets warm."] },
      ar: { steps: ["الصق الرابط، ثم افتح «إضافات».", "تحت «تنظيف بالذكاء الاصطناعي» اختر «إزالة الموسيقى» أو «إزالة الصوت البشري».", "نزّل. النموذج (نحو 67 ميغابايت) يُنزَّل مرة واحدة. على الهاتف يكون بطيئًا ويسخن الجهاز."] },
    },
  },
  {
    id: "stills",
    group: "download",
    icon: "image",
    art: "stills",
    go: { tab: "download" },
    text: {
      en: {
        title: "Stills from the video",
        what: "Saves JPG frames in a folder next to the video: every few seconds, or one per shot. Khama finds the shot changes itself.",
        when: "Moodboards, thumbnails, references, or a quick overview of a long video.",
        steps: ["Paste the link, then open “Extras”.", "Under “Stills”, pick “Every 5s”, “Every 10s” or “At scene cuts”.", "Download. The stills land in their own folder."],
      },
      ar: {
        title: "لقطات ثابتة من الفيديو",
        what: "يحفظ صور JPG في مجلد بجانب الفيديو: كل بضع ثوانٍ، أو لقطة لكل مشهد. خامة تكتشف تغيّر المشاهد بنفسها.",
        when: "لوحات الإلهام، والصور المصغّرة، والمراجع، أو لمحة سريعة عن فيديو طويل.",
        steps: ["الصق الرابط، ثم افتح «إضافات».", "تحت «لقطات ثابتة» اختر كل 5 أو 10 ثوانٍ، أو «عند تغيّر المشهد».", "نزّل. اللقطات تُحفظ في مجلد خاص بها."],
      },
    },
  },
  {
    id: "extras",
    group: "download",
    icon: "captions",
    art: "extras",
    go: { tab: "download" },
    text: {
      en: {
        title: "Subtitles, thumbnail and source info",
        what: "Extra files saved next to the video: subtitles (SRT), the thumbnail (JPG), and a text file with the link and uploader for credits.",
        when: "Captioning, cover images, or keeping track of where footage came from.",
        steps: ["Open “Extras”.", "Turn on what you need. For subtitles, pick the languages.", "Download."],
      },
      ar: {
        title: "الترجمة والصورة المصغّرة ومعلومات المصدر",
        what: "ملفات إضافية بجانب الفيديو: الترجمة (SRT)، والصورة المصغّرة (JPG)، وملف نصي فيه الرابط والناشر لذكر المصدر.",
        when: "للترجمة على الفيديو، أو صورة الغلاف، أو لتعرف مصدر كل لقطة.",
        steps: ["افتح «إضافات».", "فعّل ما تحتاجه. للترجمة اختر اللغات.", "نزّل."],
      },
    },
  },
  {
    id: "timeline",
    group: "download",
    icon: "timeline",
    art: "timeline",
    go: { tab: "download" },
    only: "desktop",
    text: {
      en: {
        title: "Timeline file for your editor",
        what: "With several clips or links, Khama also writes an XML file that opens in Premiere and DaVinci Resolve with the clips already in order.",
        when: "You are pulling a batch of footage for one edit.",
        steps: ["Paste several links or a playlist (or add clips as separate files).", "In “Extras”, turn on “Timeline file (XML)”.", "Download, then import the XML in your editor."],
      },
      ar: {
        title: "ملف تايم لاين لبرنامج المونتاج",
        what: "مع عدة مقاطع أو روابط، تكتب خامة أيضًا ملف XML يفتح في Premiere وDaVinci Resolve والمقاطع مرتّبة فيه.",
        when: "عندما تجمع مجموعة لقطات لمونتاج واحد.",
        steps: ["الصق عدة روابط أو قائمة (أو أضف مقاطع كملفات منفصلة).", "في «إضافات» فعّل «ملف تايم لاين (XML)».", "نزّل، ثم استورد ملف XML في برنامج المونتاج."],
      },
    },
  },
  {
    id: "schedule",
    group: "download",
    icon: "clock",
    art: "schedule",
    go: { tab: "download" },
    text: {
      en: {
        title: "Start a download later",
        what: "Queues a download to start at a time you choose.",
        when: "Big files at night, or when the internet is less busy.",
        steps: ["Open “Extras”.", "Under “Start”, pick “At a time” and set the time.", "Press Download. Khama has to stay open until then."],
      },
      ar: {
        title: "جدولة التنزيل لوقت لاحق",
        what: "يضع التنزيل في الانتظار ليبدأ في الوقت الذي تختاره.",
        when: "الملفات الكبيرة في الليل، أو حين يكون الإنترنت أقل ازدحامًا.",
        steps: ["افتح «إضافات».", "تحت «البدء» اختر «في وقت محدد» وحدّد الساعة.", "اضغط «تنزيل». يجب أن تبقى خامة مفتوحة حتى ذلك الوقت."],
      },
    },
  },

  // ---------------- التحويل ----------------
  {
    id: "convert",
    group: "convert",
    icon: "convert",
    art: "convert",
    go: { tab: "convert" },
    text: {
      en: {
        title: "Convert your files",
        what: "Ready-made formats for editing (H.264, ProRes, DNxHR, proxies), publishing (YouTube, Reels, WhatsApp, GIF) and audio (MP3, WAV, AAC…). Files stay on your device.",
        when: "A file your editor won't open smoothly, a video too big to send, or audio you need on its own.",
        steps: [
          "Drop files on the Convert screen, or press “Choose files”.",
          "Pick a format from For editing, For publishing, Audio or Tools.",
          "Pick a quality: High, Balanced or Small.",
          "Press Convert. Several files? “Merge into one” joins them in order.",
        ],
      },
      ar: {
        title: "تحويل ملفاتك",
        what: "صيغ جاهزة للمونتاج (H.264 وProRes وDNxHR والبروكسي) وللنشر (يوتيوب وريلز وواتساب وGIF) وللصوت (MP3 وWAV وAAC…). الملفات لا تغادر جهازك.",
        when: "ملف لا يعمل بسلاسة في برنامج المونتاج، أو فيديو أكبر من أن يُرسل، أو صوت تحتاجه وحده.",
        steps: [
          "أفلت الملفات في شاشة التحويل، أو اضغط «اختر ملفات».",
          "اختر صيغة من: للمونتاج، للنشر، صوت، أدوات.",
          "اختر الجودة: عالية أو متوازنة أو حجم صغير.",
          "اضغط «حوّل». عدة ملفات؟ «ادمجها في ملف واحد» يضمّها بالترتيب.",
        ],
      },
    },
    mobile: {
      en: { steps: ["On the Convert screen, tap “Choose video or audio files”.", "Pick a format from For editing, For publishing, Audio or Tools.", "Pick a quality: High, Balanced or Small.", "Tap Convert."] },
      ar: { steps: ["في شاشة التحويل اضغط «اختر ملفات فيديو أو صوت».", "اختر صيغة من: للمونتاج، للنشر، صوت، أدوات.", "اختر الجودة: عالية أو متوازنة أو حجم صغير.", "اضغط «حوّل»."] },
    },
  },
  {
    id: "checks",
    group: "convert",
    icon: "alert",
    art: "checks",
    go: { tab: "convert" },
    text: {
      en: {
        title: "File checks and a suggested format",
        what: "Khama reads each file and flags what causes trouble in editors: variable frame rate from phones, HDR, interlacing, heavy codecs. Then it suggests the format that fixes it.",
        when: "Every time you add a file. Read the warnings under its name.",
        steps: ["Add a file to the converter.", "Read the warnings under its name.", "If a suggestion appears, press “Use it”."],
      },
      ar: {
        title: "فحص الملف واقتراح الصيغة",
        what: "تقرأ خامة كل ملف وتنبّهك لما يسبب مشاكل في المونتاج: معدل إطارات متغيّر من الهاتف، أو HDR، أو تشابك الأسطر، أو ترميز ثقيل. ثم تقترح الصيغة التي تحلّ المشكلة.",
        when: "كلما أضفت ملفًا. اقرأ التنبيهات تحت اسمه.",
        steps: ["أضف ملفًا للمحوّل.", "اقرأ التنبيهات تحت اسمه.", "إن ظهر اقتراح، اضغط «استخدمه»."],
      },
    },
  },
  {
    id: "hw",
    group: "convert",
    icon: "chip",
    art: "hw",
    go: { tab: "convert" },
    text: {
      en: {
        title: "Faster with the graphics card",
        what: "Uses the video encoder in your graphics card instead of the processor. Several times faster, with files slightly larger.",
        when: "Long videos or many files. Leave it on unless a conversion fails.",
        steps: ["Choose a format that supports it (H.264, YouTube, Reels…).", "Keep “Use the graphics card” on.", "If a conversion fails, turn it off and try again."],
      },
      ar: {
        title: "أسرع باستخدام كرت الشاشة",
        what: "يستعمل مشفّر الفيديو في كرت الشاشة بدل المعالج. أسرع بعدة مرات، والملف أكبر قليلًا.",
        when: "الفيديوهات الطويلة أو الملفات الكثيرة. أبقه مفعّلًا إلا إذا فشل التحويل.",
        steps: ["اختر صيغة تدعمه (H.264 أو يوتيوب أو ريلز…).", "أبقِ «استخدم كرت الشاشة» مفعّلًا.", "إن فشل التحويل، عطّله وحاول مرة أخرى."],
      },
    },
    mobile: {
      en: { title: "Faster with the phone's video chip", what: "Uses the phone's video chip instead of the processor. Much faster, with files slightly larger.", steps: ["Choose a format that supports it (H.264, YouTube, Reels…).", "Keep “Use the phone's video chip” on.", "If a conversion fails, turn it off and try again."] },
      ar: { title: "أسرع باستخدام شريحة الفيديو", what: "يستعمل شريحة الفيديو في الهاتف بدل المعالج. أسرع بكثير، والملف أكبر قليلًا.", steps: ["اختر صيغة تدعمها (H.264 أو يوتيوب أو ريلز…).", "أبقِ «استخدم شريحة الفيديو في الهاتف» مفعّلًا.", "إن فشل التحويل، عطّله وحاول مرة أخرى."] },
    },
  },
  {
    id: "more",
    group: "convert",
    icon: "settings",
    art: "more",
    go: { tab: "convert" },
    text: {
      en: {
        title: "Trim, crop and burn in",
        what: "Under “More options”: trim, crop to 9:16 or 1:1, speed, rotate, a color LUT, burned-in subtitles, a logo, timecode, loudness for YouTube or podcasts, and replacing or removing the audio.",
        when: "Turning a wide video into a Reel, a review copy with timecode, or evening out the volume.",
        steps: ["Add a file and pick a format.", "Open “More options”.", "Change only what you need, then Convert."],
      },
      ar: {
        title: "القصّ والاقتصاص والدمج في الصورة",
        what: "تحت «خيارات إضافية»: القصّ، والاقتصاص إلى 9:16 أو 1:1، والسرعة، والتدوير، وملف ألوان LUT، وحرق الترجمة، والشعار، والتايم كود، وضبط مستوى الصوت ليوتيوب أو البودكاست، واستبدال الصوت أو حذفه.",
        when: "تحويل فيديو عريض إلى ريل، أو نسخة مراجعة عليها تايم كود، أو توحيد مستوى الصوت.",
        steps: ["أضف ملفًا واختر صيغة.", "افتح «خيارات إضافية».", "غيّر ما تحتاجه فقط، ثم حوّل."],
      },
    },
  },
  {
    id: "detect",
    group: "convert",
    icon: "search",
    art: "detect",
    go: { tab: "convert" },
    text: {
      en: {
        title: "Find scene cuts, black frames and silences",
        what: "Khama scans the file and lists the times where the shot changes, the screen goes black, or the audio goes quiet.",
        when: "Splitting a long recording into its shots, or finding the pauses in an interview.",
        steps: [
          "Add a file and open the Tools group.",
          "Pick “Find scene cuts”, “Find black frames” or “Find silences”, then Convert.",
          "On the result: “Split at these points” makes one file per part, “Copy times” copies the list.",
        ],
      },
      ar: {
        title: "كشف تغيّر المشاهد والشاشات السوداء والصمت",
        what: "تفحص خامة الملف وتعطيك أوقات تغيّر اللقطة، أو الشاشة السوداء، أو الصمت.",
        when: "تقسيم تسجيل طويل إلى لقطاته، أو إيجاد الوقفات في مقابلة.",
        steps: [
          "أضف ملفًا وافتح مجموعة «أدوات».",
          "اختر «كشف تغيّر المشاهد» أو «كشف الشاشات السوداء» أو «كشف الصمت»، ثم حوّل.",
          "على النتيجة: «قسّم الملف عند هذه النقاط» يعطيك ملفًا لكل جزء، و«نسخ الأوقات» ينسخ القائمة.",
        ],
      },
    },
  },

  // ---------------- التنظيم ----------------
  {
    id: "history",
    group: "organize",
    icon: "history",
    art: "history",
    go: { tab: "history" },
    text: {
      en: {
        title: "History",
        what: "Every finished download, kept even after you close Khama.",
        when: "Finding a file from last week, or getting the same video again.",
        steps: ["Open History.", "Search by title, site or link.", "Show the file, copy its link, or “Download again”."],
      },
      ar: {
        title: "السجلّ",
        what: "كل تنزيل مكتمل، محفوظ حتى بعد إغلاق خامة.",
        when: "للعثور على ملف من الأسبوع الماضي، أو تنزيل نفس الفيديو مرة أخرى.",
        steps: ["افتح «السجلّ».", "ابحث بالعنوان أو الموقع أو الرابط.", "اعرض الملف، أو انسخ رابطه، أو «نزّله مرة أخرى»."],
      },
    },
  },
  {
    id: "drag",
    group: "organize",
    icon: "grip",
    art: "drag",
    go: { tab: "download" },
    only: "desktop",
    text: {
      en: {
        title: "Drag straight into your editor",
        what: "A finished file can be dragged from Khama into Premiere, DaVinci, CapCut or any folder.",
        when: "Right after a download, so you don't have to look for the file.",
        steps: ["Wait for the card to say Done.", "Drag the card into your editor's timeline or media bin.", "Or press “Convert…” on the card to send it to the converter."],
      },
      ar: {
        title: "اسحب الملف مباشرة إلى برنامج المونتاج",
        what: "الملف المكتمل يمكن سحبه من خامة إلى Premiere أو DaVinci أو CapCut أو أي مجلد.",
        when: "بعد التنزيل مباشرة، فلا تبحث عن الملف.",
        steps: ["انتظر حتى تقول البطاقة «اكتمل».", "اسحب البطاقة إلى التايم لاين أو مكتبة الوسائط.", "أو اضغط «تحويل…» على البطاقة لترسله للمحوّل."],
      },
    },
  },
  {
    id: "projects",
    group: "organize",
    icon: "folder",
    art: "projects",
    go: { tab: "settings", section: "projects" },
    text: {
      en: {
        title: "Projects",
        what: "A project remembers a save folder and download options. Switch between projects from the download screen.",
        when: "Working on several videos or clients at once, each with its own folder.",
        steps: ["Set the folder and options you want.", "Settings → Projects: name it and “Save current as project”.", "Switch projects from the menu next to the save folder."],
      },
      ar: {
        title: "المشاريع",
        what: "المشروع يتذكّر مجلد الحفظ وخيارات التنزيل. تنتقل بين المشاريع من شاشة التنزيل.",
        when: "حين تعمل على عدة فيديوهات أو عملاء معًا، لكل واحد مجلده.",
        steps: ["اضبط المجلد والخيارات التي تريدها.", "الإعدادات ← المشاريع: سمّه واضغط «احفظ الحالي كمشروع».", "بدّل المشروع من القائمة بجانب مجلد الحفظ."],
      },
    },
  },
  {
    id: "watch",
    group: "organize",
    icon: "eye",
    art: "watch",
    go: { tab: "settings", section: "watch" },
    only: "desktop",
    text: {
      en: {
        title: "Watch folders",
        what: "Every new file dropped into a watched folder is converted automatically into a “Converted” subfolder.",
        when: "Camera cards or phone footage you always convert the same way.",
        steps: ["Settings → Watch folders → “Add folder”.", "Pick the format for that folder.", "Copy files into it. Khama converts them while it runs."],
      },
      ar: {
        title: "المجلدات المراقَبة",
        what: "كل ملف جديد يوضع في مجلد مراقَب يُحوَّل تلقائيًا إلى مجلد فرعي اسمه «Converted».",
        when: "لقطات الكاميرا أو الهاتف التي تحوّلها دائمًا بنفس الطريقة.",
        steps: ["الإعدادات ← المجلدات المراقَبة ← «إضافة مجلد».", "اختر الصيغة لهذا المجلد.", "انسخ الملفات إليه. خامة تحوّلها ما دامت تعمل."],
      },
    },
  },
  {
    id: "mini",
    group: "organize",
    icon: "minimize",
    art: "mini",
    go: { tab: "download" },
    only: "desktop",
    text: {
      en: {
        title: "Mini window",
        what: "Shrinks Khama to a small window that stays on top of other programs.",
        when: "Pasting links while you browse or edit, without switching windows.",
        steps: ["Press the mini window button at the top.", "Paste links as usual.", "Press it again to get the full window back."],
      },
      ar: {
        title: "النافذة المصغّرة",
        what: "تصغّر خامة إلى نافذة صغيرة تبقى فوق البرامج الأخرى.",
        when: "للصق الروابط وأنت تتصفح أو تعمل مونتاج، بلا تبديل بين النوافذ.",
        steps: ["اضغط زر النافذة المصغّرة في الأعلى.", "الصق الروابط كالعادة.", "اضغط الزر مرة أخرى لتعود النافذة كاملة."],
      },
    },
  },
  {
    id: "background",
    group: "organize",
    icon: "bell",
    art: "background",
    go: { tab: "settings", section: "background" },
    text: {
      en: {
        title: "Notifications, tray and copied links",
        what: "A notification when a download finishes. On a computer, Khama can also keep working in the tray and suggest links you copy.",
        when: "Long downloads while you do something else.",
        steps: ["Open Settings → Background.", "Turn on what you want."],
      },
      ar: {
        title: "الإشعارات وشريط المهام والروابط المنسوخة",
        what: "إشعار عند انتهاء التنزيل. وعلى الكمبيوتر يمكن أن تبقى خامة تعمل في شريط المهام وتقترح الروابط التي تنسخها.",
        when: "التنزيلات الطويلة وأنت مشغول بشيء آخر.",
        steps: ["افتح الإعدادات ← الخلفية.", "فعّل ما تريده."],
      },
    },
    mobile: {
      en: { title: "Notifications", what: "A notification when a download finishes, also when Khama is in the background." },
      ar: { title: "الإشعارات", what: "إشعار عند انتهاء التنزيل، حتى وخامة في الخلفية." },
    },
  },
  {
    id: "names",
    group: "organize",
    icon: "file",
    art: "names",
    go: { tab: "settings", section: "downloads" },
    text: {
      en: {
        title: "File names, folders and speed",
        what: "Name files from parts like {title}, {uploader}, {date} or a counter, put each site in its own folder, and cap the download speed.",
        when: "Keeping a big library tidy, or leaving bandwidth for a video call.",
        steps: ["Open Settings → Downloads.", "Edit the file name pattern. The example below it updates as you type.", "Turn on site folders or a speed limit if you want them."],
      },
      ar: {
        title: "أسماء الملفات والمجلدات والسرعة",
        what: "سمِّ الملفات من أجزاء مثل {title} و{uploader} و{date} أو عدّاد، وضع كل موقع في مجلده، وحدّد سرعة التنزيل.",
        when: "لتبقى مكتبة كبيرة مرتّبة، أو لتترك سرعة كافية لمكالمة فيديو.",
        steps: ["افتح الإعدادات ← التنزيل.", "عدّل نمط اسم الملف. المثال تحته يتغيّر وأنت تكتب.", "فعّل مجلد كل موقع أو حدّ السرعة إن أردت."],
      },
    },
  },

  // ---------------- عند المشاكل ----------------
  {
    id: "cookies",
    group: "fix",
    icon: "file",
    art: "cookies",
    go: { tab: "settings", section: "cookies" },
    text: {
      en: {
        title: "Videos that need you signed in",
        what: "Age-restricted videos, or YouTube asking “are you a bot?”, need your own signed-in session. Cookies give Khama that session; they never leave your device.",
        when: "Only when a download fails with a sign-in or bot message. Khama's error links you here.",
        steps: ["Open Settings → Cookies.", "Read them from your browser, or paste a cookies.txt file.", "Try the download again."],
      },
      ar: {
        title: "فيديوهات تحتاج تسجيل الدخول",
        what: "الفيديوهات المقيّدة بالعمر، أو حين يسألك يوتيوب «هل أنت روبوت؟»، تحتاج جلستك أنت. الكوكيز تعطي خامة هذه الجلسة، ولا تغادر جهازك.",
        when: "فقط عندما يفشل التنزيل برسالة تسجيل دخول أو روبوت. رسالة الخطأ في خامة توصلك إلى هنا.",
        steps: ["افتح الإعدادات ← الكوكيز.", "اقرأها من متصفحك، أو الصق ملف cookies.txt.", "أعد محاولة التنزيل."],
      },
    },
    mobile: {
      en: { steps: ["Open Settings → Cookies.", "Paste or import a cookies.txt file.", "Try the download again."] },
      ar: { steps: ["افتح الإعدادات ← الكوكيز.", "الصق ملف cookies.txt أو استورده.", "أعد محاولة التنزيل."] },
    },
  },
  {
    id: "ytdlp",
    group: "fix",
    icon: "retry",
    art: "update",
    go: { tab: "settings", section: "tools" },
    text: {
      en: {
        title: "Downloads suddenly failing",
        what: "Sites change often. yt-dlp is the tool inside Khama that understands them, and updating it fixes most failures.",
        when: "A site that used to work starts failing.",
        steps: ["Open Settings → Tools.", "Press “Update yt-dlp”.", "Try the download again."],
      },
      ar: {
        title: "التنزيل صار يفشل فجأة",
        what: "المواقع تتغيّر كثيرًا. yt-dlp هي الأداة داخل خامة التي تفهمها، وتحديثها يحلّ أغلب حالات الفشل.",
        when: "موقع كان يعمل ثم صار التنزيل منه يفشل.",
        steps: ["افتح الإعدادات ← الأدوات.", "اضغط «تحديث yt-dlp».", "أعد محاولة التنزيل."],
      },
    },
  },
];

/** نص المدخل بلغة الواجهة، مع ما يختلف على الهاتف */
export function entryText(e: GuideEntry, lang: Lang, mobile: boolean): Text {
  const base = e.text[lang];
  return mobile && e.mobile?.[lang] ? { ...base, ...e.mobile[lang] } : base;
}
