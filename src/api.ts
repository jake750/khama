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
}

export type JobState =
  | "starting"
  | "downloading"
  | "processing"
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
};
