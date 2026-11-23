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
/** حدود السرعة المعروضة (KB/s)، في الإعدادات وفي إضافات التنزيل (U-56) */
export const RATES = [0, 512, 1024, 5120, 10240, 25600];

export function scheduledAt(when: "now" | "later", atTime: string, now = new Date(), days = 0): number | undefined {
  if (when !== "later") return undefined;
  const [h, m] = atTime.split(":").map(Number);
  const d = new Date(now);
  // اليوم المختار (U-46) ثم الساعة بتوقيت الجهاز؛ setDate يحترم التوقيت الصيفي
  d.setDate(d.getDate() + days);
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
/** صف لكل مقطع حتى لا يغطّي مقطعٌ متداخل غيره على الخط الزمني الموحّد (D-103) */
export function laneClips(clips: Clip[]): { lane: number[]; count: number } {
  const ends: number[] = [];
  const lane: number[] = new Array(clips.length).fill(0);
  [...clips.keys()]
    .sort((a, b) => clips[a].start - clips[b].start)
    .forEach((i) => {
      let l = ends.findIndex((e) => e <= clips[i].start);
      if (l < 0) l = ends.length;
      ends[l] = clips[i].end;
      lane[i] = l;
    });
  return { lane, count: Math.max(1, ends.length) };
}

export function nextClip(duration: number, clips: Clip[], playhead?: number | null): Clip {
  const len = Math.max(Math.min(duration / 10, 60), Math.min(1, duration));
  const lastEnd = clips.length ? Math.max(...clips.map((c) => c.end)) : 0;
  // من موضع التشغيل في المعاينة إن وُجد (U-47)، وإلا بعد آخر مقطع
  const atHead = playhead != null && playhead > 0 && playhead < duration;
  const from = atHead ? playhead : lastEnd;
  // لا يتسع: قرب النهاية ينتهي عندها، وبعد آخر مقطع يرجع للبداية
  const start = from + len <= duration ? from : atHead ? Math.max(0, duration - len) : 0;
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
  /** قائمة تشغيل: مقاطع عنصر قُصّ (رقمه ← مدته ومقاطعه، وهل تُدمج) */
  entryClips?: Map<number, EntryClips>;
  timeline: boolean;
  /** ملف تايم لاين ممكن على هذه المنصة */
  canTimeline: boolean;
}

export interface EntryClips {
  duration: number;
  clips: Clip[];
  join: boolean;
}

/** حقول القص في الطلب: مقطع جزئي = start/end، وعدة مقاطع = clips (تُدمج أو تبقى منفصلة) */
function clipFields(duration: number | null, clips: Clip[], join: boolean) {
  const multi = clips.length > 1;
  const single = clips.length === 1 ? clips[0] : null;
  const partial = !!single && !!duration && (single.start > 0 || single.end < duration - 0.05);
  return {
    start: partial ? single.start : null,
    end: partial ? single.end : null,
    clips: multi ? clips.map((c) => [c.start, c.end] as [number, number]) : [],
    joinClips: multi && join,
  };
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
        const c = p.entryClips?.get(i);
        return {
          request: {
            ...base(e.url, original),
            ...(c ? clipFields(c.duration, c.clips, c.join) : {}),
            stems: removeHere ? stems : null,
            subdir: p.info!.title,
            expectDuration: e.duration ?? null,
            expectTitle: e.title || null,
          },
          title: e.title,
          thumbnail: e.thumbnail,
        };
      });
  }

  const cut = clipFields(p.info?.duration ?? null, p.clips ?? [], p.joinClips);
  return [
    {
      request: {
        ...base(url, original),
        ...cut,
        stems,
        timeline: cut.clips.length > 1 && !cut.joinClips && p.canTimeline && s.kind === "video" && p.timeline,
      },
      title: p.info?.title ?? url,
      thumbnail: p.info?.thumbnail,
    },
  ];
}

/**
 * «نزّله مرة أخرى» من السجلّ (U-40): نستعيد النوع والصيغة والجودة من نص البطاقة
 * («MP4 · 1080p»، «MP3»، «AAC»…). ما لا نفهمه يُترك كما هو في الإعدادات.
 */
export function optionsFromMeta(kind: Settings["kind"], meta: string): Partial<Settings> {
  const [fmt = "", q = ""] = meta.split("·").map((x) => x.trim().toLowerCase());
  if (kind === "audio") {
    const audioFormat = fmt === "aac" ? "m4a" : fmt === "original" || fmt === "الأصلي" ? "original" : fmt;
    return audioFormat === "mp3" || audioFormat === "m4a" || audioFormat === "wav" || audioFormat === "original"
      ? { kind, audioFormat }
      : { kind };
  }
  const out: Partial<Settings> = { kind };
  if (fmt === "mp4" || fmt === "mov") out.videoFormat = fmt;
  // «الأفضل» تُكتب في البطاقة بلغة الواجهة وقت التنزيل
  if (q === "best" || q === "الأفضل") out.quality = "best";
  else if (q === "4k") out.quality = "2160";
  else if (/^\d{3,4}p$/.test(q)) out.quality = q.slice(0, -1);
  return out;
}
