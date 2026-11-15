// منطق شاشة التنزيل بلا React (M-25): أيّ طلبات تُرسل لـ Rust، ومتى، وبأي خيارات.
// الشاشة تجمع اختيارات المستخدم وتعرضها؛ القرار هنا، وله اختبارات في downloadPlan.test.ts.
import type { DownloadRequest, PlaylistEntry, ProbeInfo, Settings, SubLang } from "./api";

export type Stills = "off" | "5" | "10" | "scene";
export type Stems = "off" | "voice" | "music";
export interface Clip {
  start: number;
  end: number;
}

/** وقت البدء المجدول بتوقيت الجهاز: اليوم، أو غدًا إن مضى الوقت. "now" ← undefined */
export function scheduledAt(when: "now" | "later", atTime: string, now = new Date()): number | undefined {
  if (when !== "later") return undefined;
  const [h, m] = atTime.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * لغات الترجمة المطلوبة: لفيديو واحد نختار من المتاح فيه (المختارة سابقًا، وإلا أول لغة)،
 * ولقائمة تشغيل أو رابط لم يُعاين بعد نرسل المختارة (أو en+ar).
 */
export function subtitleLangs(s: Pick<Settings, "wantSubs" | "subLangs">, info: ProbeInfo | null): string[] {
  if (!s.wantSubs) return [];
  if (info && !info.entries) {
    const available: SubLang[] = info.subtitles ?? [];
    const chosen = available.filter((l) => s.subLangs.includes(l.code)).map((l) => l.code);
    return chosen.length ? chosen : available.slice(0, 1).map((l) => l.code);
  }
  return s.subLangs.length ? s.subLangs : ["en", "ar"];
}

/** مقطع جديد بعد آخر مقطع (أو من البداية إن لم يبقَ وقت)، بطول 10% من الفيديو (1 إلى 60 ثانية) */
export function nextClip(duration: number, clips: Clip[]): Clip {
  const len = Math.max(Math.min(duration / 10, 60), Math.min(1, duration));
  const lastEnd = clips.length ? Math.max(...clips.map((c) => c.end)) : 0;
  const start = lastEnd + len <= duration ? lastEnd : 0;
  return { start, end: Math.min(start + len, duration) };
}

/** كل ما تحتاجه الخطة من اختيارات المستخدم */
export interface PlanInput {
  settings: Pick<
    Settings,
    "kind" | "videoFormat" | "audioFormat" | "quality" | "editorReady" | "wantSubs" | "subLangs" | "wantThumb" | "wantInfo"
  >;
  /** الروابط في الحقل (أكثر من واحد = تنزيل كل رابط بنفس الخيارات) */
  urls: string[];
  /** معاينة الرابط الواحد إن اكتملت */
  info: ProbeInfo | null;
  stills: Stills;
  stems: Stems;
  /** قائمة تشغيل: العناصر المحدَّدة، ومن تُزال منها الموسيقى */
  selected: Set<number>;
  stemsScope: "all" | "pick";
  picked: Set<number>;
  /** المقاطع المفعّلة لفيديو واحد (null = الملف كاملًا) */
  clips: Clip[] | null;
  joinClips: boolean;
  timeline: boolean;
  /** ملف تايم لاين ممكن على هذه المنصة */
  canTimeline: boolean;
}

export interface PlannedDownload {
  request: DownloadRequest;
  title: string;
  thumbnail?: string | null;
}

/** طلبات التنزيل لما في الحقل الآن: رابط واحد، أو عدة روابط، أو عناصر قائمة تشغيل */
export function planDownloads(p: PlanInput): PlannedDownload[] {
  const s = p.settings;
  const original = !!p.info?.original;
  const stems = p.stems === "off" ? null : p.stems;
  const base = (url: string, isOriginal = false): DownloadRequest => ({
    url,
    kind: s.kind,
    videoFormat: s.videoFormat,
    audioFormat: s.audioFormat,
    quality: s.quality,
    editorReady: s.editorReady && !isOriginal,
    start: null,
    end: null,
    stems: null,
    clips: [],
    joinClips: false,
    subs: subtitleLangs(s, p.urls.length > 1 ? null : p.info),
    thumbnail: s.wantThumb,
    infoFile: s.wantInfo,
    stills: p.stills !== "off" && s.kind === "video" ? p.stills : null,
    original: isOriginal,
  });

  if (p.urls.length > 1) {
    return p.urls.map((u) => ({ request: { ...base(u), stems }, title: u }));
  }

  const url = p.urls[0];
  if (!url) return [];
  const entries: PlaylistEntry[] | null = p.info?.entries ?? null;
  if (entries && p.info) {
    // قائمة تشغيل: عملية لكل عنصر محدَّد بالترتيب (Rust يشغّل 3 معًا والباقي ينتظر)
    return [...p.selected]
      .sort((a, b) => a - b)
      .filter((i) => entries[i])
      .map((i) => {
        const e = entries[i];
        const removeHere = !!stems && (p.stemsScope === "all" || p.picked.has(i));
        return {
          request: { ...base(e.url, original), stems: removeHere ? stems : null, subdir: p.info!.title },
          title: e.title,
          thumbnail: e.thumbnail,
        };
      });
  }

  const duration = p.info?.duration ?? null;
  const clips = p.clips ?? [];
  const multi = clips.length > 1;
  const single = clips.length === 1 ? clips[0] : null;
  const partial = !!single && !!duration && (single.start > 0 || single.end < duration - 0.05);
  const join = multi && p.joinClips;
  return [
    {
      request: {
        ...base(url, original),
        start: partial ? single.start : null,
        end: partial ? single.end : null,
        stems,
        clips: multi ? clips.map((c) => [c.start, c.end] as [number, number]) : [],
        joinClips: join,
        timeline: multi && !join && p.canTimeline && s.kind === "video" && p.timeline,
      },
      title: p.info?.title ?? url,
      thumbnail: p.info?.thumbnail,
    },
  ];
}
