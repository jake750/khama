/**
 * امتدادات الوسائط التي يقبلها المحوّل (إفلات، اختيار، مجلدات مراقَبة). كلها يقرؤها FFmpeg المضمَّن.
 * نسختها في Rust: MEDIA_EXT في src-tauri/src/convert/watcher.rs، ويطابقهما mediaExt.test.ts.
 */
export const MEDIA_EXTENSIONS = [
  // فيديو
  "mp4",
  "mov",
  "mkv",
  "avi",
  "mxf",
  "m4v",
  "webm",
  "mts",
  "m2ts",
  "wmv",
  "flv",
  "3gp",
  "3g2",
  "mpg",
  "mpeg",
  "m2v",
  "ts",
  "vob",
  "ogv",
  "f4v",
  // صوت
  "wav",
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "aiff",
  "aif",
  "wma",
  "mka",
  "ac3",
  "caf",
  "mp2",
  "amr",
];
