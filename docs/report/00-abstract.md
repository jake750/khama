# الملخص

## بالعربية

يجمع محرّر الفيديو مقاطع مرجعية من الإنترنت ثم يجهّزها لبرنامج المونتاج: تنزيل، وقصّ، وتحويل إلى صيغة تُقرأ دون مشاكل تزامن، بأدوات متفرقة أغلبها بالإنجليزية أو تتطلب سطر الأوامر. يقدّم المشروع «خامة»، تطبيقًا مفتوح المصدر لسطح المكتب وأندرويد (Tauri 2 وReact وRust) يجمع yt-dlp وFFmpeg ونموذجًا محليًا لفصل الصوت في مسار واحد بواجهة عربية. واتّبع العمل منهج علم التصميم: في أربعة مواضع كان سلوك الأدوات محكومًا بثابت مُخمَّن، فاستُبدل كلٌّ منها بقيمة أو خوارزمية قيست على بيانات مفتوحة، بسكربتات تعيد كل رقم، مع فصل بيانات الضبط عن بيانات الاختبار.

النتائج: يقدّر نموذج مستوى المفاتيح (KLM) مهمة «جزء من فيديو جاهز لـ Premiere» بـ 23.5 ث مقابل 62 و81 ث بطريقتين شائعتين. ورفع كاشف خاص لتغيّر اللقطات، بلا نموذج مدرَّب، مقياس F₁ من 0.55 (عتبة FFmpeg الثابتة) إلى 0.95 على 204 انتقالات. وصغّرت معايرة جودة الترميز بالعتاد، من 636 ترميزًا مقيسًا بـ VMAF، الملفات 14–17% بالجودة نفسها. ولم يتفوّق أيٌّ من عشرة إعدادات بديلة للفصل على الإعداد الحالي على MUSDB18 ‏(SDR الصوت 10.8 dB)، فأُبقي. وخفّض شدّ بدايات الكلمات إلى نهاية الوقفة خطأ توقيت الترجمة بعد الوقفات من 0.15 إلى 0.11 ث. ورفض التقييم فرضية تقدير الحجم من معدل بت نموذجي، إذ يخطئ بأكثر من 50% في نحو نصف تحويلات الجودة الثابتة.

الخلاصة: الإسهام ليس أداة جديدة، بل استبدال ثوابت مُخمَّنة بقيم مقيسة قابلة للإعادة، مع توثيق النتائج السلبية. ويبقى اختبار التطبيق مع مستخدمين حقيقيين، ومقارنة الكاشف بالكواشف العميقة.

**الكلمات المفتاحية**: كشف تغيّر اللقطات، ترميز الفيديو بالعتاد، VMAF، فصل مصادر الصوت، محاذاة الكلمات زمنيًا، نموذج مستوى المفاتيح KLM، منهج علم التصميم.

## Abstract

Video editors collect reference clips from the web and prepare them for their editing software, downloading, trimming and converting each clip with scattered tools that are mostly English-only or command-line based. Khama is an open-source desktop and Android application (Tauri 2, React, Rust) that combines yt-dlp, FFmpeg and a local source-separation model in one path with an Arabic interface. Following design science research, it replaces four guessed constants in the tools' behaviour with values or algorithms measured on open data, using scripts that reproduce every number and keep tuning and test data apart.

Results: a keystroke-level model (KLM) estimates the task "a video part ready for Premiere" at 23.5 s, against 62 s and 81 s with two common alternatives. A shot-boundary detector without a trained model raises F₁ from 0.55 (FFmpeg's fixed threshold) to 0.95 on 204 transitions. Calibrating hardware encoder quality from 636 VMAF-scored encodes makes files 14–17 % smaller at the same quality. None of ten alternative separation settings beats the current one on MUSDB18 (vocals SDR 10.8 dB). Snapping word starts to the end of the preceding pause lowers the subtitle timing error after pauses from 0.15 s to 0.11 s. The evaluation also rejected one hypothesis: size estimates from a typical bitrate are off by over 50 % for about half of constant-quality conversions.

Conclusion: the contribution is not a new tool but reproducible measured values in place of guessed constants, negative results included; testing with real users and a comparison with deep detectors remain.

**Keywords**: shot-boundary detection, hardware video encoding, VMAF, audio source separation, word-level alignment, keystroke-level model, design science research.

## Résumé

**[يكتبه الطالب]** إن طلبت الجامعة ملخصًا بالفرنسية: ترجمة الملخص أعلاه مع الكلمات المفتاحية.
