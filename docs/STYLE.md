# Writing style · أسلوب النصوص

All interface text lives in `src/i18n.ts` (English first, then Arabic with the same keys). These rules keep the two languages saying the same thing in the same voice.

كل نصوص الواجهة في `src/i18n.ts`. هذه القواعد تجعل اللغتين تقولان الشيء نفسه بالنبرة نفسها.

## Voice · النبرة

- Talk to one person, plainly, as a friend who edits video would. «أنت» not «حضرتك»; "you" not "the user".
- Arabic is Modern Standard Arabic that a Gulf or Levantine editor reads without effort. Use the editors' own loanwords where they are what people say (تايم لاين، ProRes، كودك).
- Say what happens, not how it works inside: "Couldn't reach the site", not "HTTP 503".
- Every error says what happened and what to do next ([ERRORS.md](ERRORS.md)).
- No exclamation marks, no "please", no "simply" or "just".
- Buttons are verbs: Download, Convert, Choose folder · تنزيل، تحويل، اختر مجلدًا.

## Terms · المصطلحات

| English | العربية | Not · لا تستعمل |
|---|---|---|
| Download | تنزيل | تحميل (it also means "upload" for many readers) |
| Converter / Convert | المحوّل / تحويل | التصدير، الترميز (as a verb) |
| Video editor (the person) | محرّر الفيديو | ممنتج، المونتير |
| Editing (the work) | المونتاج | التحرير |
| Timeline | تايم لاين | الخط الزمني |
| Timecode | التايم كود | الرمز الزمني |
| Preset | صيغة | قالب، إعداد مسبق |
| Codec | كودك | مرمّز |
| Trim | قص | تشذيب |
| Clip | مقطع | كليب |
| Subtitles | ترجمة | سب، الترجمة النصية |
| Playlist | قائمة تشغيل | بلاي لِست |
| Watch folder | مجلد مراقَب | |
| History | السجلّ | التاريخ |
| AI clean-up | التنظيف بالذكاء الاصطناعي | |

## Typography · الطباعة

- Arabic punctuation in Arabic text: «» quotes, ، comma, ؛ semicolon, ؟ question mark.
- Wrap file names, paths, codes and Latin terms inside Arabic in `<bdi>` or the `ltr` class so they don't flip.
- Ellipsis is the single character … (a test fails on three dots).
- Numbers stay Western digits (0–9) in both languages, so sizes and timecodes match what other apps show.
- Sizes: `MB`, `GB` with a space (`140 MB`).

## Adding text · إضافة نص

1. Add the key to the English dictionary; TypeScript then requires it in the Arabic one.
2. Write the Arabic as Arabic, not word-for-word from the English.
3. Check it fits: Arabic is often shorter, German-length English is the risk in buttons.
