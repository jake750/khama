# Error codes · رموز الأخطاء

Rust never sends a sentence to the screen. Every failure becomes an `AppError` (`src-tauri/src/errors.rs`):

```json
{ "code": "privateVideo", "param": "optional value for the message", "detail": "the raw yt-dlp / FFmpeg text" }
```

The interface looks the code up in `t.errors` (`src/i18n.ts`, English and Arabic) and `ErrorBox` shows the message, the button below, and `detail` under "Technical details". A code with no message falls back to `unknown`.

Failed job cards show the same fix button (cookies, update yt-dlp) as the main error box, without "Try again" since the card has its own retry. "Copy for report" includes the app version and the operating system.

لا يرسل Rust جملة إلى الشاشة: كل فشل يصبح رمزًا، والواجهة تترجمه وتعرض الزر المناسب، والنص التقني الأصلي تحت «تفاصيل تقنية».

## Adding a code · إضافة رمز

1. Return `AppError::new("myCode")` (or map the tool's output in `errors.rs`, with a test).
2. Add `myCode` to `errors` in **both** dictionaries in `src/i18n.ts`. The message says what happened and what to do next.
3. If the fix is in the cookies settings or a yt-dlp update, add the code to `COOKIE_CODES` or `YTDLP_CODES` in `src/components/ErrorBox.tsx`.
4. Regenerate this table.

## All codes (English text)

| Code | Message | Button |
|---|---|---|
| `aiUnsupported` | AI clean-up isn't available on this system yet. You can still download the file and clean it up on another computer. | — |
| `aiDownload` | Couldn't download the AI model. Check your internet connection and try again. | — |
| `aiChecksum` | The downloaded AI model is damaged (checksum mismatch). Try again. | — |
| `transcribeUnsupported` | This file has no subtitles, and turning speech into text isn't available on this system yet. Put a .srt or .vtt file with the same name next to it and try again. | — |
| `transcribeFailed` | Couldn't turn the speech into text. Try again; if it keeps failing, add a subtitle file with the same name next to the video. | — |
| `noSpeech` | No speech was found in this file, so there are no topics to show. | — |
| `aiLoad` | Couldn't load the AI engine. Restarting the app usually fixes this. | — |
| `aiRun` | The AI model failed while processing this file. Try again; if it keeps failing, convert the file to WAV first, then run AI clean-up on that. | — |
| `badInput` | This file couldn't be read. It may be damaged or not a media file. | — |
| `noVideoStream` | This file has no video, so this option can't be used. Pick an audio option. | — |
| `noAudioStream` | This file has no audio track. Pick a video-only option, or add sound with “Replace audio”. | — |
| `fileCorrupt` | The file is damaged or incomplete (maybe it was still being copied). Copy it again, or try another copy. | — |
| `hwEncoder` | The graphics card encoder failed. Turn off the graphics card option and try again. | — |
| `noStreams` | This file has no video or audio that this format can use. | — |
| `oddSize` | This format needs an even width and height. Pick a size from the list instead of the original. | — |
| `encodeFailed` | The conversion failed. Check the technical details, and try turning off the graphics card option. | — |
| `loudnessFailed` | Couldn't measure the audio loudness. Turn loudness off and try again, or check the file plays with sound. | — |
| `mergeCopy` | Files can't be merged without re-encoding. Pick a format like H.264 for editing. | — |
| `unknownPreset` | Unknown option: {param} | — |
| `linksFile` | Khama reads links only from .txt files up to 1 MB. | — |
| `unsupportedUrl` | This link isn't supported. Make sure it's the video page itself, not a search page or shortened link. | — |
| `drm` | This content is DRM-protected and can't be downloaded. Look for the same video on a site without DRM, like YouTube. | — |
| `privateVideo` | This video is private — only people with access can download it. | Cookies settings |
| `ageRestricted` | This video is age-restricted. Enable cookies in Settings (while signed in to your browser) and try again. | Cookies settings |
| `botCheck` | YouTube wants to check you're not a bot. Enable cookies in Settings, or wait a bit and try again. | Cookies settings |
| `membersOnly` | This is members-only or paid content, and Khama won't bypass that. | Cookies settings |
| `loginRequired` | The site requires signing in to see this. If you have access, enable cookies in Settings. | Cookies settings |
| `geoBlocked` | This content isn't available in your region. Only the site or the uploader can change that. | — |
| `unavailable` | Video unavailable: it may have been removed, the link may be wrong, or it's blocked in your country. | — |
| `live` | This is a live stream that hasn't started or is still running. Try again after it ends. | — |
| `formatUnavailable` | That quality or format isn't available for this video. Try “Best” or a lower quality. | Update yt-dlp |
| `rateLimited` | The site is temporarily refusing requests (too many). Wait a few minutes and try again. | Try again |
| `forbidden` | The site refused the download (403). Updating yt-dlp in Settings → Tools usually fixes this. | Update yt-dlp |
| `network` | Couldn't reach the site. Check your internet connection and try again. | Try again |
| `incomplete` | The download arrived with parts missing (the connection dropped or the site skipped pieces), so Khama didn't save it. Try again: it continues from where it stopped. | Try again (job card) |
| `cookiesRead` | Couldn't read cookies from the browser. Fully close the browser and retry, use Firefox, or paste cookies manually. | Cookies settings |
| `permission` | No permission to write to the save folder. Choose another folder in Settings. | — |
| `diskFull` | Not enough disk space. Free some space, or choose a save folder on another drive. | — |
| `postprocess` | The download finished but processing the file (merge/convert) failed. Try again with Edit-ready off, or check the technical details. | — |
| `history` | Couldn't read the download history. Your files are safe; clearing the history in this tab starts a fresh one. | — |
| `extractorOutdated` | The site changed and this yt-dlp version no longer understands it. Update yt-dlp in Settings → Tools and retry. | Update yt-dlp |
| `settingsFile` | This file isn't a Khama settings backup, or it's damaged. Choose the file you exported from Settings. | — |
| `unknown` | Something unexpected went wrong. Check the technical details, and try updating yt-dlp in Settings. | Update yt-dlp |
| `io` | A file couldn't be read or written. Check the drive is connected and has space, then try again. | — |
| `dataDir` | Couldn't locate the app data folder. | — |
| `resourceDir` | Couldn't locate the app resources folder. | — |
| `configDir` | Couldn't locate the app settings folder. | — |
| `cacheDir` | Couldn't locate the temporary folder. | — |
| `noDownloadsDir` | Couldn't find your Downloads folder. Choose a save folder in Settings. | — |
| `outputDirCreate` | Couldn't create the save folder. Choose another one in Settings. | — |
| `invalidUrl` | Paste a valid link starting with http:// or https:// | — |
| `toolMissing` | The {param} tool is missing. Please reinstall Khama. | — |
| `probeFileFailed` | Couldn't inspect the file after downloading. The file is saved; try opening it, or download it again. | — |
| `convertFailed` | The download finished but converting it for editing failed. Try again with Edit-ready off to keep the original file, then convert it in the Convert tab. | — |
| `moveFailed` | Couldn't move the file to the save folder. Check write permission and free space. | — |
| `processStalled` | The process stopped responding for 15 minutes, so Khama stopped it. Try again; if it keeps happening, copy the details for the report. | — |
| `noOutputFile` | The download finished but the output file wasn't found. | — |
| `joinFailed` | The clips downloaded but joining them into one video failed. | — |
| `timeout` | The site took too long to respond. Check your connection and try again. | Try again |
| `canceled` | Canceled. | — |
| `probeParse` | Couldn't read this link's information. | — |
| `playlist` | This is a playlist link. | — |
| `playlistEmpty` | This playlist is empty, private, or couldn't be read. | — |
| `spotifyFailed` | Couldn't read this Spotify link. Make sure the playlist is public and try again. | — |
| `openFolder` | Couldn't open the folder. | — |
| `updateFailed` | Couldn't update yt-dlp. Check your internet connection and try again. | — |
| `toolsSetup` | Couldn't prepare the download tools on this phone. Restart the app and try again. | — |
| `saveFailed` | The download finished but couldn't be saved to Download/Khama. Check free storage and try again. | — |
| `cookiesInvalid` | That isn't a valid cookies file. Khama needs the Netscape cookies.txt format (e.g. from “Get cookies.txt LOCALLY”). | — |
| `cookiesExpired` | All the cookies in this file have expired. Sign in to the site again in your browser, then export fresh cookies. | — |
| `clipboard` | Couldn't access the clipboard. Paste with Ctrl+V inside the field. | — |
| `noMediaInFolder` | No video or audio files in this folder (or its subfolders). | — |
| `interrupted` | Stopped when Khama was closed. Try again to finish it (a download carries on from where it stopped). | — |
| `noThumbnail` | This link has no thumbnail. | — |
| `stillsFailed` | The download worked, but grabbing stills from it failed. | — |
| `window` | Couldn't resize the window. | — |
| `resolveFreeAudio` | لأن Resolve المجاني على Linux لا يقرأ صوته أو صورته | — |
| `hdr` | لأنه HDR | — |
| `vfr` | لأن معدل إطاراته متغيّر فينزاح الصوت | — |
| `heavyCodec` | لأن الكودك ثقيل على المونتاج | — |
| `title` | العنوان | — |
| `uploader` | القناة | — |
| `date` | تاريخ النشر | — |
| `today` | تاريخ اليوم | — |
| `site` | الموقع | — |
| `id` | معرّف الفيديو | — |
| `res` | الدقة | — |
| `n` | رقم | — |
| `Preset` | مجموعة إعدادات تحويل جاهزة لغرض واحد، مثل يوتيوب أو Premiere. | — |
| `LUT` | ملف ألوان (‎.cube) يحوّل مجموعة ألوان إلى أخرى، مثل Log إلى الطبيعي. | — |
| `LUFS` | مقياس علوّ الصوت الكلّي. مواقع التواصل −14، والبودكاست −16، والتلفزيون −23. | — |
| `Proxy` | نسخة خفيفة من ملف ثقيل لمونتاج سلس، ثم تعود للأصل عند التصدير. | — |
| `Keyframe` | إطار كامل في الفيديو. القص بلا إعادة ترميز لا يبدأ إلا عند واحد منها. | — |
| `Cookies` | ملفات صغيرة يحفظها المتصفح ليتذكّر الموقع أنك مسجّل الدخول. | — |
