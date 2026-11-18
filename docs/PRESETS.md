# Converter presets · صيغ المحوّل

Size is per minute of 1080p video at the "Balanced" quality (High is about 1.5× bigger, Small about half). Sizes come from typical bitrates, so busy or very calm footage can be half or double. Speed is on the processor; with the graphics card option, H.264, H.265 and AV1 are several times faster.

الحجم لكل دقيقة من فيديو 1080p بجودة «متوازنة» (العالية نحو 1.5 ضعف، والصغيرة نحو النصف). الأحجام من معدلات بت نموذجية، فقد تكون اللقطات المزدحمة أو الهادئة جدًا نصفها أو ضعفها. السرعة على المعالج، ومع كرت الشاشة يصبح H.264 وH.265 وAV1 أسرع بعدة مرات.

## For editing · للمونتاج

| Preset | Size / min | Speed | Opens in | Notes |
|---|---|---|---|---|
| H.264 for editing | ~80 MB | Medium | Everything (Premiere, Resolve, Final Cut, CapCut) | Always re-encodes to a constant frame rate. Fixes phone VFR audio drift. |
| ProRes Proxy | ~340 MB | Fast | Premiere, Resolve, Final Cut | Light edit copy at full resolution. |
| ProRes LT | ~770 MB | Fast | Premiere, Resolve, Final Cut | Long timelines. |
| ProRes 422 | ~1.1 GB | Fast | Premiere, Resolve, Final Cut | Smooth scrubbing. On Windows it doesn't play in the built-in player. |
| ProRes 422 HQ | ~1.65 GB | Fast | Premiere, Resolve, Final Cut | Grading and heavy effects. |
| ProRes 4444 | ~2.5 GB | Fast | Premiere, Resolve, Final Cut, After Effects | Keeps transparency (alpha). |
| DNxHR LB | ~340 MB | Fast | Resolve, Premiere, Avid | Light DNxHR. |
| DNxHR SQ | ~1.1 GB | Fast | Resolve (free too), Premiere, Avid | Best for free Resolve on Linux, which can't read H.264 or AAC. |
| DNxHR HQ | ~1.65 GB | Fast | Resolve, Premiere, Avid | 8-bit, higher quality. |
| DNxHR HQX 10-bit | ~1.65 GB | Fast | Resolve, Premiere, Avid | Only worth it for 10-bit HDR or Log sources. |
| Light proxy (540p) | ~17 MB | Fast | Everything | Tiny copy for slow computers; relink to the original to export. |

## For publishing · للنشر

| Preset | Size / min | Speed | Plays on | Notes |
|---|---|---|---|---|
| YouTube | ~100 MB | Medium | Everywhere | High bitrate H.264 for upload; YouTube re-encodes it anyway. |
| Reels / TikTok / Shorts | ~75 MB | Medium | Everywhere | Vertical 9:16. |
| Small (WhatsApp, email) | ~20 MB | Medium | Everywhere | Lower quality to fit size limits. |
| H.265 / HEVC | ~40 MB | Slow | Modern phones and computers | Half the size of H.264; heavier to edit. |
| AV1 | ~26 MB | Slowest | Recent browsers and devices | Smallest file; older devices can't play it. |
| WebM (VP9) | ~30 MB | Slow | Browsers | For websites. |
| GIF | depends | Fast | Everywhere | 256 colors, 15 fps, 360p by default. Keep it short. |

## Audio · الصوت

| Preset | Size / min | Notes |
|---|---|---|
| WAV | ~11 MB | Uncompressed (48 kHz, 16-bit). Bigger, not better than a compressed source. |
| FLAC | ~5–7 MB | Lossless and smaller than WAV. Some older editors can't read it. |
| MP3 | ~1.9 MB | 256 kbps (High 320, Small 160). Plays everywhere. |
| AAC (M4A) | ~1.9 MB | 256 kbps. Better than MP3 at the same size. |
| Opus | ~1 MB | 128 kbps. Best quality per size; Premiere can't read it. |
| Remove music / voice (AI) | ~11 MB | WAV output. Takes about as long as the audio. |

## Tools · أدوات

| Preset | What it does |
|---|---|
| Rewrap to MP4 / MOV / MKV | Same streams in a new container. Seconds, no quality loss; trims land on the nearest keyframe. |
| Grab a frame (PNG) | One full-resolution frame. |
| Image sequence (PNG) | Every frame as a PNG in a folder. 10 s at 30 fps is 300 files. |
| Find scene cuts / black frames / silences | Lists the points as marks on the file's card, to copy or split at. |
