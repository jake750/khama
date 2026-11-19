# إعادة التصميم: قبل وبعد (M-97)

«قبل» = الإيداع `1ea1f54~1`، و«بعد» = الواجهة الحالية على `main` (تشمل أيقونات D-70 ومعاينة المحوّل D-84 اللتين جاءتا بعد إعادة التصميم نفسها). اللقطات من متصفح بحجم نافذة ثابت 1180×760 على `src/dev-mock.ts` (بيانات تجريبية)، والمصغّر 420×640. القبل في `docs/screenshots/before/` والبعد في `docs/screenshots/`.

## لماذا؟
المبادئ في [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md). باختصار ما غيّره إيداع `1ea1f54`:
- **بطل واحد لكل شاشة**: لوحة «الصق الرابط» أكبر شيء في التنزيل.
- **ألوان مصبوغة بفيروزي الشعار**: لا أسود ولا أبيض نقي؛ الفيروزي للتفاعل والأصفر للتمييز فقط.
- **إزالة الزخرفة**: لا توهّج ولا تدرّج على زر التنزيل وحالة الفراغ، ولا شريط جانبي في الإعدادات، ولا تعبئة مكرّرة للتقدّم؛ و«خ» المقصوصة في ثلاثة أماكن فقط.
- **نظام توكنز**: شبكة مسافات 4px، سبعة أحجام خط وثلاثة أوزان، أنصاف أقطار من سلّم واحد، أيقونات 16/20/24.
- **الهاتف**: تبويبات سفلية، حافة 16px، خيارات في سطر يتمرّر.

## الأزواج (عربي داكن)
| الشاشة | قبل | بعد |
|---|---|---|
| التنزيل (فارغ) | ![](screenshots/before/download-empty-ar-dark.png) | ![](screenshots/download-empty-ar-dark.png) |
| التنزيل (رابط جاهز) | ![](screenshots/before/download-ready-ar-dark.png) | ![](screenshots/download-ready-ar-dark.png) |
| التحويل (فارغ) | ![](screenshots/before/convert-empty-ar-dark.png) | ![](screenshots/convert-empty-ar-dark.png) |
| التحويل (ملف) | ![](screenshots/before/convert-file-ar-dark.png) | ![](screenshots/convert-file-ar-dark.png) |
| السجل | ![](screenshots/before/history-ar-dark.png) | ![](screenshots/history-ar-dark.png) |
| الإعدادات | ![](screenshots/before/settings-ar-dark.png) | ![](screenshots/settings-ar-dark.png) |
| المصغّر | ![](screenshots/before/compact-ready-ar-dark.png) | ![](screenshots/compact-ready-ar-dark.png) |

## الأزواج (إنجليزي فاتح)
| الشاشة | قبل | بعد |
|---|---|---|
| التنزيل (رابط جاهز) | ![](screenshots/before/download-ready-en-light.png) | ![](screenshots/download-ready-en-light.png) |
| التحويل (ملف) | ![](screenshots/before/convert-file-en-light.png) | ![](screenshots/convert-file-en-light.png) |
| السجل | ![](screenshots/before/history-en-light.png) | ![](screenshots/history-en-light.png) |
| الإعدادات | ![](screenshots/before/settings-en-light.png) | ![](screenshots/settings-en-light.png) |
| المصغّر | ![](screenshots/before/compact-ready-en-light.png) | ![](screenshots/compact-ready-en-light.png) |

بقية اللقطات (فارغ ومصغّر فارغ) في المجلدين بالأسماء نفسها.

## ملاحظات
- «قبل» التُقطت بعد حقن `dev-mock.ts` الحالي في الإيداع القديم (لم يكن فيه)، فالبيانات متطابقة والفرق في الواجهة فقط.
- الفروق بين الصورتين تشمل أيضًا D-70 وD-84 لأن «بعد» هي الحالة الحالية لا إيداع إعادة التصميم وحده.
- التخطيط من اليمين لليسار دائمًا حتى بالإنجليزية (قرار في `App.tsx`)؛ لذلك تبدو لقطات الإنجليزية معكوسة الترتيب عمّا في «قبل».
