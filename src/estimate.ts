import type { ProbeInfo } from "./api";

/**
 * الحجم المتوقّع للتنزيل قبل بدئه (U-36)، من أحجام النسخ التي يعطيها yt-dlp.
 * فيديو: أكبر نسخة بالدقة المختارة (أو أقرب أقل منها) + الصوت. صوت فقط: نسخة الصوت.
 * fraction: نسبة المقاطع المختارة من المدة الكاملة. لا أحجام ← null (لا نخمّن).
 */
export function estimateDownload(
  info: Pick<ProbeInfo, "videoSizes" | "audioSize">,
  kind: "video" | "audio",
  quality: string,
  fraction = 1,
): number | null {
  const audio = info.audioSize ?? null;
  if (kind === "audio") return audio != null ? Math.round(audio * fraction) : null;
  const list = info.videoSizes ?? [];
  if (!list.length) return null;
  const want = quality === "best" ? list[0][0] : Number(quality);
  // القائمة من الأعلى: أول دقة لا تتجاوز المطلوب، وإلا الأصغر
  const pick = list.find(([h]) => h <= want) ?? list[list.length - 1];
  return Math.round((pick[1] + (audio ?? 0)) * fraction);
}
