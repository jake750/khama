// T-53: الأنواع في api.ts مكتوبة يدويًا (بأنواع اتحاد أدق من String في Rust)، والأنواع في
// src/bindings/ مولّدة من هياكل Rust بـ ts-rs عند `cargo test`. هذا الملف لا يعمل وقت التشغيل:
// tsc يفشل إن اختلفت أسماء الحقول بين الجهتين، فيظهر الحقل الناقص في رسالة الخطأ.
import type * as api from "./api";
import type * as rs from "./bindings";

type Keys<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never]
  ? true
  : { onlyInApiTs: Exclude<keyof A, keyof B>; onlyInRust: Exclude<keyof B, keyof A> };

export const checks: true[] = [
  true as Keys<api.Settings, rs.Settings>,
  true as Keys<api.Project, rs.Project>,
  true as Keys<api.WatchFolder, rs.WatchFolder>,
  true as Keys<api.HistoryEntry, rs.HistoryEntry>,
  true as Keys<api.VideoInfo, rs.VideoInfo>,
  true as Keys<api.AudioInfo, rs.AudioInfo>,
  true as Keys<api.MediaInfo, rs.MediaInfo>,
  true as Keys<api.ConvertOptions, rs.ConvertOptions>,
  true as Keys<api.ConvertRequest, rs.ConvertRequest>,
  true as Keys<api.PreviewFrames, rs.PreviewFrames>,
  true as Keys<api.AppError, rs.AppError>,
  true as Keys<api.ProbeInfo, rs.ProbeInfo>,
  true as Keys<api.PlaylistEntry, rs.Entry>,
  // tzOffsetMin يضيفه api.startDownload عند الإرسال
  true as Keys<api.DownloadRequest, Omit<rs.DownloadRequest, "tzOffsetMin">>,
  true as Keys<api.JobUpdate, rs.JobUpdate>,
  true as Keys<api.ToolsInfo, rs.ToolsInfo>,
  true as Keys<api.SubLang, rs.SubLang>,
];
