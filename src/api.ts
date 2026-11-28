// الجسر بين الواجهة (React) والمحرّك (Rust).
// كل دالة هنا تستدعي أمرًا معرّفًا في src-tauri/src بالاسم نفسه.
import type { MobileBase } from "./platform";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Kind = "video" | "audio";
export type VideoFormat = "mp4" | "mov";
export type AudioFormat = "mp3" | "m4a" | "wav" | "original";
export type Theme = "dark" | "light" | "system";
export type Language = "en" | "ar";
export type { LayoutDir } from "./layoutDir";
import type { LayoutDir } from "./layoutDir";
export type CookiesMode = "none" | "browser" | "file";

export interface Settings {
  outputDir: string | null;
  language: Language;
  theme: Theme;
  /** اتجاه التخطيط، مستقل عن اللغة. auto = يتبع اللغة */
  layoutDir: LayoutDir;
  kind: Kind;
  videoFormat: VideoFormat;
  audioFormat: AudioFormat;
  quality: string;
  editorReady: boolean;
  cookiesMode: CookiesMode;
  cookiesBrowser: string;
  acceptedNotice: boolean;
  /** هل رأى المستخدم الترحيب وعرض الجولة */
  seenTour: boolean;
  convertDest: "source" | "output";
  convertPreset: string;
  convertHw: boolean;
  watchFolders: WatchFolder[];
  /** قالب اسم الملف: {title} {uploader} {date} {today} {site} {id} {res} {n} */
  filenameTemplate: string;
  siteFolders: boolean;
  /** مجلد فرعي لكل نوع: Video/ وAudio/ (U-88) */
  kindFolders: boolean;
  /** حدّ السرعة بالميغابايت/ثانية (0 = بلا حدّ) */
  /** كيلوبايت/ثانية، 0 = بلا حدّ */
  rateLimitKb: number;
  notify: boolean;
  closeToTray: boolean;
  watchClipboard: boolean;
  clipboardOnFocus: boolean;
  checkUpdates: boolean;
  /** نسخة بنية settings.json (M-36)، يديرها Rust */
  schemaVersion?: number;
  recentDirs: string[];
  wantSubs: boolean;
  subLangs: string[];
  wantThumb: boolean;
  wantInfo: boolean;
  projects: Project[];
  /** معرّف المشروع النشط */
  activeProject: string | null;
  /** عدد التنزيلات معًا، 1 إلى 5 (T-63) */
  parallelDownloads: number;
  /** فحص أسبوعي لتحديث yt-dlp بموافقة المستخدم (T-100) */
  ytdlpWeekly: boolean;
  ytdlpCheckedAt: number;
  /** أندرويد: المجلد العام للحفظ (U-76) */
  mobileBase: MobileBase;
  /** أندرويد: المجلد الفرعي داخله، فارغ = في المجلد العام مباشرة */
  mobileFolder: string;
}

/** مشروع: مجلد حفظ وإعدادات تنزيل خاصة به */
export interface Project {
  /** معرّف ثابت (لا يتغيّر بتغيّر الاسم) */
  id: string;
  name: string;
  outputDir: string | null;
  kind: Kind;
  videoFormat: VideoFormat;
  audioFormat: AudioFormat;
  quality: string;
  editorReady: boolean;
  filenameTemplate: string;
  siteFolders: boolean;
}

export interface SubLang {
  code: string;
  name: string;
  auto: boolean;
}

export interface HistoryEntry {
  id: number;
  title: string;
  url: string;
  file: string;
  /** "convert" = تحويل (url هو الملف المصدر، meta رقم الـ preset) (U-62) */
  kind: Kind | "convert";
  meta: string;
  thumbnail?: string | null;
  date: number;
  exists?: boolean;
}

export interface WatchFolder {
  dir: string;
  preset: string;
  enabled: boolean;
}

export interface VideoInfo {
  codec: string;
  profile?: string | null;
  width: number;
  height: number;
  fps?: number | null;
  vfr: boolean;
  pixFmt: string;
  bitDepth: number;
  hdr: boolean;
  interlaced: boolean;
}

export interface AudioInfo {
  codec: string;
  channels: number;
  sampleRate: number;
}

export type Issue =
  "vfr" | "hdr" | "interlaced" | "tenBit" | "heavyCodec" | "noAudio" | "resolveFreeAudio" | "editorAudio" | "editorContainer" | "pcmInMp4";

export interface MediaInfo {
  path: string;
  name: string;
  size: number;
  duration?: number | null;
  container: string;
  bitrate?: number | null;
  video?: VideoInfo | null;
  audio: AudioInfo[];
  subtitles: number;
  thumbnail?: string | null;
  issues: Issue[];
}

/** صورتا المعاينة قبل/بعد كـ data URL */
export interface PreviewFrames {
  source: string | null;
  output: string | null;
}

export interface ConvertOptions {
  quality: "high" | "balanced" | "small";
  hw: boolean;
  size?: number | null;
  aspect?: string | null;
  fps?: string | null;
  speed?: number | null;
  rotate?: string | null;
  deinterlace: boolean;
  denoise: boolean;
  tonemap: boolean;
  lut?: string | null;
  subtitles?: string | null;
  watermark?: string | null;
  watermarkPos?: string | null;
  timecode: boolean;
  loudness?: number | null;
  replaceAudio?: string | null;
  mute: boolean;
  start?: number | null;
  end?: number | null;
  splitAt: number[];
  /** حذف هذه الفترات [بداية، نهاية] ووصل الباقي */
  cut: [number, number][];
  silenceDb?: number | null;
  silenceMin?: number | null;
  /** عند حذف الصمت: كم ثانية تبقى بعد الكلام (ومن كل طرف إن لم يُحدَّد silencePadBefore) */
  silencePad?: number | null;
  /** عند حذف الصمت: كم ثانية تبقى قبل الكلام. فارغ = مثل silencePad */
  silencePadBefore?: number | null;
  /** تحسين الصورة بلا نموذج: light | strong | sharpen */
  enhance?: string | null;
  /** تحليل المواضيع: توقيت كل كلمة بـ whisper حتى مع ترجمة جاهزة */
  alignSpeech?: boolean;
  /** ترجمة SRT تُكتب بجانب الناتج (توقيتها من صفره) */
  sidecarSrt?: string | null;
  /** تحليل المواضيع: رابط الصفحة التي نُزّل منها الملف، لأخذ ترجمتها */
  sourceUrl?: string | null;
  /** تحليل المواضيع: المدة المناسبة لريل (ث). فارغ = 15 و90 */
  reelMin?: number | null;
  reelMax?: number | null;
  outDir?: string | null;
}

export interface ConvertRequest {
  inputs: string[];
  preset: string;
  options: ConvertOptions;
}

/** الخطأ كما يرسله Rust: رمز يُترجم في الواجهة (انظر i18n.ts) + تفاصيل تقنية */
export interface AppError {
  code: string;
  param?: string | null;
  detail?: string | null;
}

export interface ProbeInfo {
  title: string;
  thumbnail?: string | null;
  duration?: number | null;
  uploader?: string | null;
  site?: string | null;
  heights: number[];
  isLive: boolean;
  /** رابط قائمة تشغيل: عناصرها (والحقول أعلاه تصف القائمة نفسها) */
  entries?: PlaylistEntry[];
  subtitles: SubLang[];
  /** نسخة صغيرة تُشغَّل داخل التطبيق لمعاينة القص */
  previewUrl?: string | null;
  /** ملفات Google Drive: تُنزَّل كما هي */
  original: boolean;
  /** الحجم التقريبي لكل دقة [الارتفاع، البايتات]، من الأعلى (U-36) */
  videoSizes?: [number, number][];
  audioSize?: number | null;
}

export interface PlaylistEntry {
  /** رابط العنصر (لأغاني سبوتيفاي: رابط بحث في YouTube Music) */
  url: string;
  title: string;
  uploader?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
}

export interface DownloadRequest {
  url: string;
  /** عنوان الأغنية ومدتها في سبوتيفاي: Rust يختار نتيجة بحث YouTube Music المطابقة لهما */
  expectDuration?: number | null;
  expectTitle?: string | null;
  kind: Kind;
  videoFormat: VideoFormat;
  audioFormat: AudioFormat;
  quality: string;
  editorReady: boolean;
  /** تحميل جزء فقط (بالثواني) */
  start?: number | null;
  end?: number | null;
  /** إزالة بالذكاء الاصطناعي: "voice" = أبقِ الصوت البشري (احذف الموسيقى) | "music" = أبقِ الموسيقى */
  stems?: "voice" | "music" | null;
  /** عدة مقاطع [بداية، نهاية] بالثواني (تتقدّم على start/end) */
  clips?: [number, number][];
  /** مع عدة مقاطع: true = فيديو واحد، false = ملف لكل مقطع */
  joinClips?: boolean;
  /** مجلد فرعي داخل مجلد الحفظ (اسم قائمة التشغيل) */
  subdir?: string | null;
  /** لغات الترجمة (SRT بجانب الملف) */
  subs?: string[];
  thumbnail?: boolean;
  infoFile?: boolean;
  /** لقطات ثابتة: "5" | "10" (كل N ثانية) | "scene" */
  stills?: string | null;
  /** مع مقاطع منفصلة: ملف تايم لاين XML */
  timeline?: boolean;
  /** الملف الأصلي بلا تحويل (Google Drive) */
  original?: boolean;
  /** ما يُكتب في السجلّ عند الانتهاء (يكتبه Rust) */
  history?: { title: string; meta: string; thumbnail?: string | null };
}

export type JobState =
  | "scheduled"
  | "queued"
  | "starting"
  | "analyzing"
  | "downloading"
  | "processing"
  | "preparing"
  | "separating"
  | "converting"
  | "done"
  | "error"
  | "canceled";

/** تنزيل مجدول محفوظ في scheduled.json */
export interface ScheduledItem {
  at: number;
  request: DownloadRequest;
  title: string;
  meta: string;
  thumbnail?: string | null;
}

/** موضوع من تحليل المواضيع (بثواني الملف) */
export interface Topic {
  start: number;
  end: number;
  /** أكثر الكلمات تميّزًا */
  title: string;
  /** أول الكلام */
  text: string;
}

/** ما قيس في الملف عند كشف الصمت (dB) */
export interface SilenceLevels {
  noise: number;
  speech: number;
  /** فارغ = لا فرق واضح بين الكلام والضجيج */
  threshold?: number | null;
  manual: boolean;
  /** مستوى الصوت عبر الزمن مصغّرًا (dB)، ووقت أول خانة ومدة كل خانة (ث) */
  envelope?: number[];
  envStart?: number;
  envStep?: number;
}

/** جملة من الترجمة بأوقاتها (بثواني الملف) */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** الحجم والوقت المتوقعان من تحويل ثلاث شرائح قصيرة */
export interface SampleEstimate {
  bytes: number;
  seconds: number;
}

/** كلمة بوقتها (بثواني الملف) */
export interface Word {
  w: string;
  start: number;
  end: number;
  last?: boolean;
}

export interface JobUpdate {
  id: number;
  state: JobState;
  stage?: "video" | "audio" | "file" | "wait";
  percent?: number;
  speed?: number;
  eta?: number;
  file?: string;
  error?: AppError;
  markers?: [number, number][];
  /** تحليل المواضيع (الصمت المكتشف في markers) */
  topics?: Topic[];
  /** كشف الصمت: المستويات المقيسة والعتبة */
  levels?: SilenceLevels;
  /** تحليل المواضيع: النص بأوقاته */
  cues?: Cue[];
  /** تحليل المواضيع: وقت كل كلمة (json3 أو whisper مع DTW) */
  words?: Word[];
  /** من أين جاء النص */
  transcript?: "subtitles" | "captions" | "speech";
  /** العنوان والصورة من yt-dlp أثناء التنزيل */
  title?: string;
  thumbnail?: string;
}

export interface ToolsInfo {
  ytdlp?: string | null;
  ffmpeg?: string | null;
  deno?: string | null;
}

/** يحوّل أي خطأ (من Rust أو من JavaScript) إلى AppError */
export function asAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e) return e as AppError;
  return { code: "unknown", detail: String(e) };
}

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  /** نسخة احتياطية من الإعدادات في ملف (M-99) */
  exportSettings: (path: string) => invoke<void>("export_settings", { path }),
  readSettingsFile: (path: string) => invoke<Settings>("read_settings_file", { path }),
  defaultOutputDir: () => invoke<string | null>("default_output_dir"),
  hasSavedCookies: () => invoke<boolean>("has_saved_cookies"),
  saveCookies: (content: string) => invoke<void>("save_cookies", { content }),
  deleteCookies: () => invoke<void>("delete_cookies"),
  /** رقم {n} القادم في المشروع النشط، وتصفيره (T-66) */
  counterNext: () => invoke<number>("counter_next"),
  resetCounter: () => invoke<number>("reset_counter"),
  getScheduled: () => invoke<ScheduledItem[]>("get_scheduled"),
  saveScheduled: (items: ScheduledItem[]) => invoke<void>("save_scheduled", { items }),
  toolsInfo: () => invoke<ToolsInfo>("tools_info"),
  updateYtdlp: () => invoke<{ version?: string; updated: boolean }>("update_ytdlp"),
  /** replace: معاينة شاشة التنزيل؛ كل معاينة جديدة توقف السابقة في Rust */
  probe: (url: string, opts?: { replace?: boolean }) => invoke<ProbeInfo>("probe", { url, replace: opts?.replace ?? false }),
  /** على الهاتف: ينسخ ملفات اختارها المستخدم (content://) داخل التطبيق ويعيد مساراتها */
  importFiles: (paths: string[]) => invoke<string[]>("import_files", { paths }),
  /** نرسل فرق التوقيت ليكون {today} في اسم الملف تاريخ اليوم المحلي */
  startDownload: (request: DownloadRequest, id?: number) =>
    invoke<number>("start_download", { request: { ...request, tzOffsetMin: -new Date().getTimezoneOffset() }, id }),
  /** رقم لعملية ستبدأ: نضيف بطاقتها أولًا ثم نبدأها به، فلا يسبق تحديثٌ البطاقة (T-18) */
  newJobId: () => invoke<number>("new_job_id"),
  cancelDownload: (id: number) => invoke<void>("cancel_download", { id }),
  /** بطاقة العملية تُحفظ في Rust لتُستعاد بعد إعادة تحميل الواجهة (T-17) */
  rememberJob: (id: number, card: object) => invoke<void>("remember_job", { id, card }),
  /** العمليات التي ما زالت تعمل في Rust (بطاقتها + آخر تحديث) */
  listJobs: () => invoke<Record<string, unknown>[]>("list_jobs"),
  revealFile: (path: string) => invoke<void>("reveal_file", { path }),
  openFile: (path: string) => invoke<void>("open_file", { path }),
  /** يسمح بتشغيل ملف وسائط واحد في الواجهة (asset://) */
  allowMedia: (path: string) => invoke<void>("allow_media", { path }),
  aiReady: () => invoke<boolean>("ai_ready"),
  cancelProbe: () => invoke<void>("cancel_probe"),
  startNow: (id: number) => invoke<void>("start_now", { id }),
  readLinksFile: (path: string) => invoke<string>("read_links_file", { path }),
  /** R3-U13: المجلدات تُستبدل بما فيها من وسائط (الكمبيوتر فقط) */
  expandMediaPaths: (paths: string[]) => invoke<string[]>("expand_media_paths", { paths }),
  /** ملف الترجمة الذي يحمل اسم كل فيديو، بالترتيب نفسه (null إن لم يوجد) (R3-U39) */
  findSubtitles: (paths: string[]) => invoke<(string | null)[]>("find_subtitles", { paths }),
  openOutputDir: () => invoke<void>("open_output_dir"),
  onJobUpdate: (cb: (u: JobUpdate) => void): Promise<UnlistenFn> => listen<JobUpdate>("job-update", (e) => cb(e.payload)),
  analyzeFile: (path: string) => invoke<MediaInfo>("analyze_file", { path }),
  /** الحجم المتوقع بتحويل ثلاث شرائح قصيرة (null إن أُلغي بطلب أحدث) */
  sampleEstimate: (path: string, presetId: string, options: ConvertOptions) =>
    invoke<SampleEstimate | null>("sample_estimate", { path, presetId, options }),
  /** إطار المصدر وإطار الناتج عند `at` ثانية بفلاتر الصورة نفسها (D-84)؛ null إن أُلغي بطلب أحدث */
  previewFrame: (path: string, presetId: string, options: ConvertOptions, at: number) =>
    invoke<PreviewFrames | null>("preview_frame", { path, presetId, options, at }),
  hwEncoders: () => invoke<string[]>("hw_encoders"),
  startConvert: (request: ConvertRequest, id?: number) => invoke<number>("start_convert", { request, id }),
  saveThumbnail: (url: string) => invoke<string>("save_thumbnail", { url }),
  getHistory: () => invoke<HistoryEntry[]>("get_history"),
  removeHistory: (id: number) => invoke<void>("remove_history", { id }),
  removeHistoryMany: (ids: number[]) => invoke<void>("remove_history_many", { ids }),
  clearHistory: () => invoke<void>("clear_history"),
  setCompact: (compact: boolean) => invoke<void>("set_compact", { compact }),
  quitApp: () => invoke<void>("quit_app"),
  /** «أكمل في الخلفية»: إخفاء النافذة */
  hideMain: () => invoke<void>("hide_main"),
  /** المساحة الحرة على قرص المجلد (بايت)، أو null إن تعذّرت معرفتها (T-96) */
  freeSpace: (path: string) => invoke<number | null>("free_space", { path }),
  /** رابط khama:// فتح التطبيق قبل أن تجهز الواجهة (T-101) */
  takeDeepLink: () => invoke<string | null>("take_deep_link"),
  onDeepLink: (cb: (url: string) => void): Promise<UnlistenFn> => listen<string>("deep-link", (e) => cb(e.payload)),
  /** إغلاق النافذة وفيها عمليات جارية (U-27) */
  onCloseRequested: (cb: () => void): Promise<UnlistenFn> => listen("close-requested", () => cb()),
  onClipboardUrl: (cb: (url: string) => void): Promise<UnlistenFn> => listen<string>("clipboard-url", (e) => cb(e.payload)),
  /** ملف جديد في مجلد مراقَب: Rust بدأ تحويله برقم id */
  onWatchFile: (cb: (hit: { id: number; path: string; preset: string }) => void): Promise<UnlistenFn> =>
    listen<{ id: number; path: string; preset: string }>("watch-file", (e) => cb(e.payload)),
};
