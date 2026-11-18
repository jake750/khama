# الملخص

## بالعربية

يقضي محرّر الفيديو جزءًا من وقته في جمع المقاطع المرجعية من الإنترنت ثم تجهيزها لبرنامج المونتاج: تنزيل المقطع، وقصّ الجزء المطلوب، وتحويله إلى صيغة يقرؤها البرنامج دون مشاكل تزامن. الأدوات المتاحة إمّا عامة لا تراعي حاجات المونتاج، أو بواجهات إنجليزية فقط، أو تتطلب سطر الأوامر. يقدّم هذا المشروع «خامة»، وهو تطبيق مفتوح المصدر لسطح المكتب (Windows وmacOS وLinux) وأندرويد، مبني على إطار Tauri 2 بواجهة React ومنطق بلغة Rust، يدمج أداتي yt-dlp وFFmpeg ليجعل هذا المسار خطوة واحدة: لصق رابط، واختيار الجزء والصيغة، ثم ملف جاهز للتايم لاين. يضيف التطبيق محوّلًا بصيغ للمونتاج (ProRes وDNxHR وH.264 بمعدل إطارات ثابت) وللنشر، وفصلًا محليًا للصوت البشري عن الموسيقى بنموذج MDX-Net عبر ONNX Runtime دون إرسال أي بيانات، وواجهة عربية كاملة من اليمين إلى اليسار. قِيس الأداء على حاسوب محمول متوسط: تظهر النافذة في 0.75 ث، ويفصل النموذج الصوت بسرعة قريبة من زمن التشغيل (1.06 ث لكل ثانية صوت) ويرفع نسبة الإشارة إلى الضجيج للصوت من −2.1 dB إلى 23.6 dB على عيّنة اختبار. يناقش التقرير المتطلبات والمعمارية والقرارات التقنية، ويقيّم الجودة والأداء ودقة تقدير الأحجام، ويعرض الحدود والجوانب الأخلاقية والقانونية لأدوات التنزيل.

**الكلمات المفتاحية**: تنزيل الوسائط، المونتاج، yt-dlp، FFmpeg، Tauri، فصل مصادر الصوت، التعريب RTL.

## Abstract

Video editors spend part of their time collecting reference clips from the web and preparing them for their editing software: downloading, trimming the useful part, and converting it to a format the editor reads without sync problems. Existing tools are either generic, English-only, or command-line based. This project presents Khama, an open-source desktop (Windows, macOS, Linux) and Android application built with Tauri 2, a React interface and a Rust core, which wraps yt-dlp and FFmpeg so that the whole path becomes one step: paste a link, choose the part and the format, and get a timeline-ready file. It adds a converter with editing presets (ProRes, DNxHR, constant-frame-rate H.264) and publishing presets, local voice/music separation with an MDX-Net model through ONNX Runtime with no data leaving the device, and a complete right-to-left Arabic interface. Measured on a mid-range laptop, the window appears in 0.75 s, and separation runs close to real time (1.06 s per second of audio) while raising the voice signal-to-noise ratio from −2.1 dB to 23.6 dB on a test mix. The report covers requirements, architecture and technical decisions, evaluates quality, performance and size-estimate accuracy, and discusses the limits and the ethical and legal aspects of download tools.

**Keywords**: media download, video editing, yt-dlp, FFmpeg, Tauri, audio source separation, right-to-left localisation.

## Résumé

**[يكتبه الطالب]** إن طلبت الجامعة ملخصًا بالفرنسية: ترجمة الملخص أعلاه مع الكلمات المفتاحية.
