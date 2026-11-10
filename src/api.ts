// الجسر بين الواجهة (React) والمحرّك (Rust).
// كل دالة هنا تستدعي أمرًا معرّفًا في src-tauri/src بالاسم نفسه.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Kind = "video" | "audio";
export type VideoFormat = "mp4" | "mov";
export type AudioFormat = "mp3" | "m4a" | "wav";
export type Theme = "dark" | "light" | "system";
export type Language = "en" | "ar";
export type CookiesMode = "none" | "browser" | "file";

export interface Settings {
  outputDir: string | null;
  language: Language;
  theme: Theme;
  kind: Kind;
  videoFormat: VideoFormat;
  audioFormat: AudioFormat;
  quality: string;
  editorReady: boolean;
  cookiesMode: CookiesMode;
  cookiesBrowser: string;
  acceptedNotice: boolean;
  convertDest: "source" | "output";
  convertPreset: string;
  convertHw: boolean;
  watchFolders: WatchFolder[];
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

export type Issue = "vfr" | "hdr" | "interlaced" | "tenBit" | "heavyCodec" | "noAudio" | "resolveFreeAudio";

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
}

export type JobState =
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

export interface JobUpdate {
  id: number;
  state: JobState;
  stage?: "video" | "audio" | "file";
  percent?: number;
  speed?: number;
  eta?: number;
  file?: string;
  error?: AppError;
  markers?: [number, number][];
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
  defaultOutputDir: () => invoke<string | null>("default_output_dir"),
  hasSavedCookies: () => invoke<boolean>("has_saved_cookies"),
  saveCookies: (content: string) => invoke<void>("save_cookies", { content }),
  deleteCookies: () => invoke<void>("delete_cookies"),
  toolsInfo: () => invoke<ToolsInfo>("tools_info"),
  updateYtdlp: () => invoke<{ version?: string; updated: boolean }>("update_ytdlp"),
  probe: (url: string) => invoke<ProbeInfo>("probe", { url }),
  startDownload: (request: DownloadRequest) => invoke<number>("start_download", { request }),
  cancelDownload: (id: number) => invoke<void>("cancel_download", { id }),
  revealFile: (path: string) => invoke<void>("reveal_file", { path }),
  openOutputDir: () => invoke<void>("open_output_dir"),
  onJobUpdate: (cb: (u: JobUpdate) => void): Promise<UnlistenFn> =>
    listen<JobUpdate>("job-update", (e) => cb(e.payload)),
  analyzeFile: (path: string) => invoke<MediaInfo>("analyze_file", { path }),
  hwEncoders: () => invoke<string[]>("hw_encoders"),
  startConvert: (request: ConvertRequest) => invoke<number>("start_convert", { request }),
  onWatchFile: (cb: (hit: { path: string; preset: string; outDir: string }) => void): Promise<UnlistenFn> =>
    listen<{ path: string; preset: string; outDir: string }>("watch-file", (e) => cb(e.payload)),
};
