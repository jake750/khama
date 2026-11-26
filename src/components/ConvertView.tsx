import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  api,
  asAppError,
  type AppError,
  type ConvertOptions,
  type ConvertRequest,
  type Issue,
  type MediaInfo,
  type PreviewFrames,
  type Settings,
} from "../api";
import { formatBytes, formatDuration } from "../format";
import { Pick } from "./Pick";
import { useI18n, type Dict } from "../i18n";
import { estimateSize, presetById, presetFits, PRESETS, suggestPreset, suggestReason, type PresetDef, type PresetGroup } from "../presets";
import { ErrorBox } from "./ErrorBox";
import { Hint, splitHint } from "./Hint";
import { Icon, type IconName } from "./Icon";
import { AnimatedList, SlideSwitch } from "../motion";
import { Segmented, Toggle } from "./Segmented";
import { TrimRange } from "./TrimRange";
import { isMobile, mobileSaveDir } from "../platform";

/**
 * يختار ملفات. على الهاتف يعطينا أندرويد روابط content:// بلا اسم ملف حقيقي،
 * فننسخها داخل التطبيق أولًا (ffmpeg يقرأ ملفات عادية فقط).
 */
async function pickFiles(multiple: boolean, filter: { name: string; extensions: string[] }): Promise<string[]> {
  // فلاتر الامتدادات على أندرويد تتحوّل لأنواع MIME، وبعضها (مثل .cube) غير معروف فيُخفي الملف
  const p = await open({ multiple, filters: isMobile ? undefined : [filter] });
  const list = Array.isArray(p) ? p : typeof p === "string" ? [p] : [];
  if (!list.length || !isMobile) return list;
  return api.importFiles(list);
}

/** معدل البت التقريبي لمستوى الجودة: «≈ 16 Mbps عند 1080p» أو «320 kbps» */
function qualityRate(p: PresetDef, q: ConvertOptions["quality"]): string | undefined {
  const v = typeof p.mbps1080 === "object" ? p.mbps1080[q] : undefined;
  if (v != null) return `≈ ${v} Mbps @ 1080p`;
  const a = typeof p.kbps === "object" ? p.kbps[q] : undefined;
  return a != null ? `${a} kbps` : undefined;
}

/** ملف في قائمة المحوّل */
export interface SourceFile {
  path: string;
  info?: MediaInfo;
  error?: AppError;
}

export const MEDIA_FILTER = {
  name: "Media",
  extensions: [
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
    "mpg",
    "mpeg",
    "ts",
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
  ],
};

export const defaultOptions = (): ConvertOptions => ({
  quality: "balanced",
  hw: false,
  deinterlace: false,
  denoise: false,
  tonemap: false,
  timecode: false,
  mute: false,
  splitAt: [],
  cut: [],
});

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** مواصفات الملف جدولًا صغيرًا: عنوان وقيمة لكل سطر (D-83) */
function Specs({ m }: { m: MediaInfo }) {
  const { t } = useI18n();
  const v = m.video;
  const a = m.audio[0];
  const rows: [string, string | null][] = [
    [
      t.specVideo,
      v
        ? [
            `${v.codec.toUpperCase()} ${v.width}×${v.height}`,
            v.fps ? `${Math.round(v.fps * 100) / 100} fps${v.vfr ? " (VFR)" : ""}` : null,
            v.bitDepth > 8 ? `${v.bitDepth}-bit` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : null,
    ],
    [
      t.specAudio,
      a ? `${a.codec.toUpperCase()} ${a.channels === 1 ? t.mono : a.channels === 2 ? t.stereo : t.channels(a.channels)}` : null,
    ],
    [t.specLength, m.duration ? formatDuration(m.duration) : null],
    [t.specSize, formatBytes(t, m.size)],
  ];
  return (
    <dl className="specs">
      {rows
        .filter(([, val]) => val)
        .map(([k, val]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="ltr-num">{val}</dd>
          </div>
        ))}
    </dl>
  );
}

/** أيقونة نوع المخرَج على بطاقة الـ Preset (D-21) */
const ISSUE_ICON: Record<Issue, IconName> = {
  vfr: "gauge",
  hdr: "contrast",
  interlaced: "interlace",
  tenBit: "drop",
  heavyCodec: "weight",
  noAudio: "mute",
  resolveFreeAudio: "block",
  editorAudio: "musicOff",
  editorContainer: "box",
  pcmInMp4: "wave",
};

const KIND_ICON: Record<PresetDef["kind"], IconName> = {
  video: "film",
  gif: "film",
  audio: "music",
  frame: "image",
  sequence: "image",
  copy: "scissors",
  detect: "search",
  stems: "layers",
};

/** «سريع»: نسخ بلا إعادة ترميز أو تحليل فقط. «ثقيل»: نموذج ذكاء اصطناعي يعمل على المعالج */
function speedTag(p: PresetDef): "fast" | "heavy" | null {
  if (p.kind === "copy" || p.kind === "detect" || p.kind === "frame") return "fast";
  if (p.kind === "stems") return "heavy";
  return null;
}

/** خيارات نطاق واحد: المشتركة لكل الملفات أو ملف بعينه (U-22) */
interface Scoped {
  opts: ConvertOptions;
  trimOn: boolean;
}

/** ما لا يغيّر إطارًا ثابتًا: تغييره لا يطلب معاينة جديدة */
const stillOnly = (o: ConvertOptions): ConvertOptions => ({
  ...o,
  quality: "balanced",
  hw: false,
  fps: null,
  speed: null,
  loudness: null,
  replaceAudio: null,
  mute: false,
  end: null,
  splitAt: [],
  cut: [],
});

/**
 * إطار المصدر بجانب إطار الناتج بسلسلة الفلاتر نفسها (D-84).
 * يُطلب بعد توقف التعديل قليلًا، والطلب الأحدث يلغي السابق في Rust.
 */
function BeforeAfter(props: { path: string; presetId: string; options: ConvertOptions; at: number }) {
  const { t } = useI18n();
  const key = JSON.stringify([props.path, props.presetId, stillOnly(props.options), Math.round(props.at * 10) / 10]);
  const [got, setGot] = useState<{ key: string; frames: PreviewFrames | null } | null>(null);
  useEffect(() => {
    const [path, id, o, at] = JSON.parse(key) as [string, string, ConvertOptions, number];
    let live = true;
    const timer = setTimeout(() => {
      api
        .previewFrame(path, id, o, at)
        .then((frames) => live && frames && setGot({ key, frames }))
        .catch(() => live && setGot({ key, frames: { source: null, output: null } }));
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]);
  const fresh = got?.key === key;
  // الصورة السابقة تبقى باهتة أثناء التحميل بدل فراغ يرمش
  const frames = got?.frames;
  const pane = (label: string, src: string | null | undefined, failed: boolean) => (
    <figure className="ba-pane">
      <div className={`ba-frame ${!frames ? "skeleton" : ""} ${frames && !fresh ? "stale" : ""}`}>
        {src ? <img src={src} alt={label} /> : failed && <span className="faint">{t.previewFailed}</span>}
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
  return (
    <div className="before-after" aria-busy={!fresh}>
      <div className="ba-row">
        {pane(t.previewBefore, frames?.source, false)}
        {pane(t.previewAfter, frames?.output, fresh && !frames?.output)}
      </div>
      <div className="faint ltr-num">{t.previewAt(formatDuration(props.at))}</div>
    </div>
  );
}

/** التدوير والقلب بأيقونات مرسومة بدل أسهم نصية (D-54) */
function RotatePick(props: { value: ConvertOptions["rotate"] | null; onChange: (v: ConvertOptions["rotate"] | null) => void }) {
  const { t } = useI18n();
  const opts: { value: string; icon?: IconName; label: string }[] = [
    { value: "none", label: t.rotateNone },
    { value: "90", icon: "rotateCw", label: t.rotateCw },
    { value: "180", icon: "rotate180", label: t.rotate180 },
    { value: "270", icon: "rotateCcw", label: t.rotateCcw },
    { value: "hflip", icon: "flipH", label: t.flipH },
    { value: "vflip", icon: "flipV", label: t.flipV },
  ];
  return (
    <div className="pick">
      <span className="field-label">{t.rotate}</span>
      <Segmented<string>
        label={t.rotate}
        value={props.value ?? "none"}
        onChange={(v) => props.onChange(v === "none" ? null : (v as ConvertOptions["rotate"]))}
        options={opts.map((o) => ({
          value: o.value,
          title: o.label,
          label: o.icon ? (
            <span className="icon-choice">
              <Icon name={o.icon} size={18} />
              <span className="sr-only">{o.label}</span>
            </span>
          ) : (
            o.label
          ),
        }))}
      />
    </div>
  );
}

/** موضع العلامة المائية: شبكة 3×3، الزوايا والوسط فقط قابلة للاختيار (D-53) */
function PosGrid(props: { value: string; onChange: (v: NonNullable<ConvertOptions["watermarkPos"]>) => void }) {
  const { t } = useI18n();
  const cells: (NonNullable<ConvertOptions["watermarkPos"]> | null)[] = ["tl", null, "tr", null, "c", null, "bl", null, "br"];
  const names: Record<string, string> = { tl: t.posTl, tr: t.posTr, bl: t.posBl, br: t.posBr, c: t.posC };
  return (
    <div className="pick">
      <span className="field-label">{t.watermarkPos}</span>
      <div className="pos-grid" role="group" aria-label={t.watermarkPos}>
        {cells.map((c, i) =>
          c ? (
            <button
              key={c}
              type="button"
              aria-pressed={props.value === c}
              title={names[c]}
              aria-label={names[c]}
              onClick={() => props.onChange(c)}
            >
              <span className="pos-dot" />
            </button>
          ) : (
            <span key={i} aria-hidden="true" />
          ),
        )}
      </div>
    </div>
  );
}

function groupName(t: Dict, g: PresetGroup) {
  return { edit: t.groupEdit, publish: t.groupPublish, audio: t.groupAudio, tools: t.groupTools }[g];
}

/** حقل لاختيار ملف مساعد (LUT، ترجمة، شعار، صوت) */
function FilePick(props: { label: string; value?: string | null; extensions: string[]; onChange: (path: string | null) => void }) {
  const { t } = useI18n();
  const [copying, setCopying] = useState(false);
  const pick = async () => {
    setCopying(true);
    try {
      const [p] = await pickFiles(false, { name: props.label, extensions: props.extensions });
      if (p) props.onChange(p);
    } catch {
      // إلغاء الاختيار أو فشل النسخ: نترك القيمة كما هي
    } finally {
      setCopying(false);
    }
  };
  return (
    <div className="file-pick">
      <span className="field-label">{props.label}</span>
      <div className="file-pick-row">
        <button className="btn btn-sm" onClick={pick} disabled={copying}>
          <Icon name="file" size={16} /> {copying ? t.importing : props.value ? baseName(props.value) : t.pick}
        </button>
        {props.value && (
          <button
            className="icon-btn sm"

            title={t.unpick}
            aria-label={t.unpick}
            onClick={() => props.onChange(null)}
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/** أقسام مساحة العمل: الملف يُضاف مرة، والأدوات من كل قسم تُجمع في «وصفة» واحدة */
type Cat = "format" | "enhance" | "audio" | "frame" | "text" | "analysis";
const CATS: { id: Cat; icon: IconName }[] = [
  { id: "format", icon: "convert" },
  { id: "enhance", icon: "contrast" },
  { id: "audio", icon: "wave" },
  { id: "frame", icon: "gauge" },
  { id: "text", icon: "captions" },
  { id: "analysis", icon: "search" },
];
/** مجموعات الصيغ داخل قسم «الصيغة» (أدوات النسخ بلا ترميز تُعدّ صيغة) */
type FmtGroup = "edit" | "publish" | "audio" | "tools";
const isFormat = (p: PresetDef) => ["video", "gif", "audio", "copy"].includes(p.kind);
const isAi = (p: PresetDef) => p.kind === "stems";
const isAnalysis = (p: PresetDef) => ["detect", "frame", "sequence"].includes(p.kind);

/** صيغة من عائلة المصدر حين تُطلب أدوات دون صيغة: ProRes يبقى ProRes، والصوت يبقى صوتًا */
function familyPreset(f: SourceFile): string {
  const v = f.info?.video;
  if (!v) {
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "";
    return ({ mp3: "mp3", m4a: "aac", aac: "aac", flac: "flac", opus: "opus", ogg: "opus" } as Record<string, string>)[ext] ?? "wav";
  }
  return v.codec === "prores" ? "prores_hq" : v.codec === "dnxhd" ? "dnxhr_hq" : "edit_h264";
}

/** عملية واحدة سيبدؤها «ابدأ»، و`then` خطوة تعمل على ناتجها (ملف واحد) */
interface Step {
  req: ConvertRequest;
  title: string;
  meta: string;
  then?: { preset: string; options: ConvertOptions; meta: string };
}

export function ConvertView(props: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  files: SourceFile[];
  addFiles: (paths: string[]) => void;
  setFiles: (f: (prev: SourceFile[]) => SourceFile[]) => void;
  hw: string[] | null;
  dragging: boolean;
  /** «امسح القائمة» مع «تراجع» (U-98) */
  onClearFiles: () => void;
  onStart: (req: ConvertRequest, title: string, meta: string) => Promise<void>;
  /** خطوتان على ملف واحد: الثانية تبدأ على ناتج الأولى حين تكتمل */
  onChain: (
    first: ConvertRequest,
    title: string,
    meta: string,
    next: (file: string) => { req: ConvertRequest; meta: string },
  ) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const { settings: s, update, files } = props;
  const [shared, setShared] = useState<Scoped>(() => ({ opts: defaultOptions(), trimOn: false }));
  // خيارات خاصة بملف واحد تتقدّم على المشتركة (U-22)
  const [overrides, setOverrides] = useState<Record<string, Scoped>>({});
  const [editPath, setEditPath] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  // الصيغة المحفوظة قد تكون أداة (من نسخة سابقة): تنتقل لقسمها
  const saved = presetById(s.convertPreset) ?? PRESETS[0];
  const fmt = isFormat(saved) ? saved : PRESETS[0];
  const [formatOn, setFormatOn] = useState(isFormat(saved));
  const [ai, setAi] = useState<string[]>(isAi(saved) ? [saved.id] : []);
  const [analysis, setAnalysis] = useState<string[]>(isAnalysis(saved) ? [saved.id] : []);
  const [oneFile, setOneFile] = useState(true);
  const [cat, setCat] = useState<Cat>(isAi(saved) ? "audio" : isAnalysis(saved) ? "analysis" : "format");
  const [fmtGroup, setFmtGroup] = useState<FmtGroup>(fmt.group);

  const ready = files.filter((f) => f.info);
  const editFile = (editPath && ready.find((f) => f.path === editPath)) || null;
  /** نقطة بداية خيارات ملف: المشتركة بلا القص (القص يخص ملفًا بعينه) */
  const fromShared = (): Scoped => ({ opts: { ...shared.opts, start: null, end: null }, trimOn: false });
  const scope = editFile ? (overrides[editFile.path] ?? fromShared()) : shared;
  const { opts, trimOn } = scope;
  const setScope = (f: (sc: Scoped) => Scoped) =>
    editFile ? setOverrides((m) => ({ ...m, [editFile.path]: f(m[editFile.path] ?? fromShared()) })) : setShared(f);
  const set = (patch: Partial<ConvertOptions>) => setScope((sc) => ({ ...sc, opts: { ...sc.opts, ...patch } }));
  const setTrimOn = (trimOn: boolean) => setScope((sc) => ({ ...sc, trimOn }));
  // ملف أُزيل من القائمة: تُنسى خياراته الخاصة
  useEffect(() => {
    setOverrides((m) => {
      const keep = Object.entries(m).filter(([p]) => files.some((f) => f.path === p));
      return keep.length === Object.keys(m).length ? m : Object.fromEntries(keep);
    });
  }, [files]);
  const audioOnly = ready.filter((f) => !f.info!.video).length;
  const anyVideo = ready.some((f) => f.info!.video);
  const loading = files.some((f) => !f.info && !f.error);
  const single = ready.length === 1 ? ready[0].info! : null;
  const fits = (p: PresetDef) => ready.every((f) => presetFits(p, f.info));
  const suggestion = single ? suggestPreset(single.issues) : null;
  const reason = single ? suggestReason(single.issues) : null;
  const trimInfo = editFile ? editFile.info! : single;
  const canTrim = !!trimInfo?.duration;
  const move = (i: number, by: -1 | 1) =>
    props.setFiles((prev) => {
      const next = [...prev];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  // ما فُعّل في كل قسم (للعدّاد على القائمة الجانبية وشارات الوصفة)
  const o = opts;
  const fmtPicture = ["video", "gif"].includes(fmt.kind) || !formatOn;
  const fmtAudio = fmt.kind === "video" || fmt.kind === "audio" || !formatOn;
  const enhanceOn = [
    o.enhance && `${t.enhance}: ${enhanceName(t, o.enhance)}`,
    o.denoise && t.denoise,
    o.deinterlace && t.deinterlace,
    o.tonemap && t.tonemap,
    o.lut && t.lut,
  ].filter((x): x is string => !!x);
  const frameOn = [
    o.size && (o.size === 2160 ? "4K" : `${o.size}p`),
    o.aspect,
    o.fps && `${o.fps} fps`,
    o.speed && o.speed !== 1 && `${o.speed}×`,
    o.rotate && t.rotate,
  ].filter((x): x is string => !!x);
  const textOn = [trimOn && canTrim && t.optTrim, o.subtitles && t.subtitles, o.watermark && t.watermark, o.timecode && t.timecode].filter(
    (x): x is string => !!x,
  );
  const audioOptsOn = [o.loudness != null && t.loudness, o.replaceAudio && t.replaceAudio, o.mute && t.mute].filter(
    (x): x is string => !!x,
  );
  // أدوات تحتاج تمريرة تحويل حتى لو لم تُختر صيغة (القص وحده لا، إن كانت معه أداة أخرى تقص)
  const pictureMods = fmtPicture && enhanceOn.length + frameOn.length + (textOn.length - (trimOn && canTrim ? 1 : 0)) > 0;
  const convNeeded =
    formatOn || pictureMods || (fmtAudio && audioOptsOn.length > 0) || (trimOn && canTrim && ai.length === 0 && analysis.length === 0);
  const conv = (f: SourceFile | null): PresetDef => (formatOn ? fmt : presetById(familyPreset(f ?? ready[0]))!);
  const counts: Record<Cat, number> = {
    format: formatOn ? 1 : 0,
    enhance: fmtPicture ? enhanceOn.length : 0,
    audio: ai.length + (fmtAudio ? audioOptsOn.length : 0),
    frame: fmtPicture ? frameOn.length : 0,
    text: textOn.length,
    analysis: analysis.length,
  };
  // «ملف واحد / ملف لكل أداة» لا يهم إلا حين تجتمع أداة ذكاء اصطناعي مع تحويل، أو أكثر من أداة ذكاء
  const askMode = ai.length > 0 && (convNeeded || ai.length > 1);
  const chain = oneFile && ai.length === 1 && convNeeded;

  /**
   * الخيارات التي تخص صيغة بعينها (الأقسام التي لا تنطبق لا تؤثر).
   * `f` = ملف بعينه (خياراته الخاصة إن وُجدت)، أو null للدمج (المشتركة). `trim` = هل يُقص في هذه الخطوة.
   */
  const effective = (p: PresetDef, f: SourceFile | null, trim = true, sc: Scoped = (f && overrides[f.path]) || shared): ConvertOptions => {
    const opts = sc.opts;
    const info = f?.info;
    const kind = p.kind;
    const o: ConvertOptions = { ...defaultOptions(), quality: opts.quality, hw: p.hw && s.convertHw };
    // القص المشترك لا يصح إلا لملف واحد؛ الخاص يصح لملفه
    const own = sc !== shared || (info != null && info === single);
    if (trim && sc.trimOn && own && info?.duration) {
      o.start = opts.start ?? 0;
      o.end = opts.end ?? info.duration;
    }
    if (kind === "copy") o.mute = opts.mute;
    if (p.id === "detect_silence" || p.id === "topics")
      Object.assign(o, {
        silenceDb: opts.silenceDb ?? null,
        silenceMin: opts.silenceMin ?? null,
        silencePad: opts.silencePad ?? null,
        silencePadBefore: opts.silencePadBefore ?? null,
      });
    if (p.id === "topics")
      Object.assign(o, { reelMin: opts.reelMin ?? null, reelMax: opts.reelMax ?? null, alignSpeech: !!opts.alignSpeech });
    if (kind === "stems" || kind === "detect") return o;
    if (["video", "gif", "frame", "sequence"].includes(kind)) {
      Object.assign(o, {
        size: opts.size,
        aspect: opts.aspect,
        fps: kind === "frame" ? null : opts.fps,
        rotate: opts.rotate,
        deinterlace: opts.deinterlace,
        denoise: opts.denoise,
        enhance: opts.enhance ?? null,
        tonemap: opts.tonemap,
        lut: opts.lut,
      });
      if (kind !== "frame") o.speed = opts.speed;
    }
    if (kind === "video" || kind === "audio") {
      Object.assign(o, {
        loudness: opts.loudness,
        replaceAudio: opts.replaceAudio,
        mute: kind === "video" && opts.mute,
        speed: opts.speed,
      });
    }
    if (kind === "video") {
      Object.assign(o, { subtitles: opts.subtitles, watermark: opts.watermark, watermarkPos: opts.watermarkPos, timecode: opts.timecode });
    }
    return o;
  };
  const resetOpts = () => setScope(() => ({ opts: { ...defaultOptions(), quality: opts.quality }, trimOn: false }));

  // التقدير والمعاينة لتمريرة التحويل
  const convPreset = ready.length ? conv(ready[0]) : fmt;
  const estimate = useMemo(() => {
    if (!convNeeded) return null;
    let sum = 0;
    for (const f of ready) {
      const e = estimateSize(conv(f), f.info!, effective(conv(f), f));
      if (e == null) return null;
      sum += e;
    }
    return sum || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fmt, formatOn, convNeeded, shared, overrides, s.convertHw]);
  // المعاينة لملف واحد: الذي تُعدَّل خياراته، أو أول فيديو في القائمة
  const previewFile = fmtPicture ? (editFile ?? ready.find((f) => f.info!.video)) : undefined;
  const previewPreset = previewFile ? conv(previewFile) : convPreset;
  const previewAt = previewFile ? (effective(previewPreset, previewFile).start ?? (previewFile.info!.duration ?? 0) / 3) : 0;
  /** ملف خياراته الخاصة تختلف فعلًا عن المشتركة (العلامة على صفّه) */
  const differs = (f: SourceFile) =>
    !!overrides[f.path] && JSON.stringify(effective(conv(f), f)) !== JSON.stringify(effective(conv(f), f, true, shared));

  // الصيغ بجودة ثابتة يتبع حجمها تعقيد الصورة: نقيسه بتحويل ثلاث شرائح قصيرة (A-30)
  const [measured, setMeasured] = useState<{ key: string; bytes: number; seconds: number } | null>(null);
  const sampleKey =
    !isMobile && convNeeded && ready.length === 1 && convPreset.kind === "video"
      ? JSON.stringify([ready[0].path, convPreset.id, effective(convPreset, ready[0])])
      : null;
  useEffect(() => {
    if (!sampleKey) return;
    const [path, id, o] = JSON.parse(sampleKey) as [string, string, ConvertOptions];
    let live = true;
    const timer = setTimeout(() => {
      api
        .sampleEstimate(path, id, o)
        .then((m) => live && m && setMeasured({ key: sampleKey, ...m }))
        .catch(() => {});
    }, 800);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sampleKey]);
  const exact = measured && measured.key === sampleKey ? measured.bytes : null;
  // الوقت المتوقع على المعالج (مقيس من الشرائح نفسها): يظهر حين يتجاوز نصف دقيقة
  const expectedSecs = measured && measured.key === sampleKey && measured.seconds >= 30 ? measured.seconds : null;
  const shown = exact ?? estimate;

  const meta = (p: PresetDef, q: ConvertOptions["quality"] = shared.opts.quality) =>
    [p.name[lang], p.quality ? { high: t.qualityHigh, balanced: t.qualityBalanced, small: t.qualitySmall }[q] : null]
      .filter(Boolean)
      .join(" · ");

  /** كل ما سيبدأ لملف واحد: أداة الذكاء (وبعدها التحويل إن كان «ملفًا واحدًا»)، والتحويل، والتحليل */
  const stepsFor = (f: SourceFile): Step[] => {
    const out: Step[] = [];
    const name = baseName(f.path);
    const aiFit = ai.map((id) => presetById(id)!).filter((p) => presetFits(p, f.info));
    const c = conv(f);
    const convFits = convNeeded && presetFits(c, f.info);
    if (chain && aiFit.length === 1 && convFits) {
      // القص في الخطوة الأولى، فالثانية تعمل على الجزء المقصوص وحده
      const first = aiFit[0];
      out.push({
        req: { inputs: [f.path], preset: first.id, options: effective(first, f) },
        title: name,
        meta: `${meta(first)} → ${meta(c, effective(c, f).quality)}`,
        then: { preset: c.id, options: effective(c, f, false), meta: `${meta(first)} → ${meta(c, effective(c, f).quality)}` },
      });
    } else {
      for (const p of aiFit) out.push({ req: { inputs: [f.path], preset: p.id, options: effective(p, f) }, title: name, meta: meta(p) });
      if (convFits)
        out.push({
          req: { inputs: [f.path], preset: c.id, options: effective(c, f) },
          title: name,
          meta: meta(c, effective(c, f).quality),
        });
    }
    for (const id of analysis) {
      const p = presetById(id)!;
      if (presetFits(p, f.info))
        out.push({ req: { inputs: [f.path], preset: p.id, options: effective(p, f) }, title: name, meta: meta(p) });
    }
    return out;
  };
  const stepCount = ready.reduce((n, f) => n + stepsFor(f).reduce((m, st) => m + (st.then ? 2 : 1), 0), 0);
  const canMerge =
    ready.length > 1 && convNeeded && ai.length === 0 && analysis.length === 0 && ["video", "audio", "gif"].includes(convPreset.kind);

  async function start(merge: boolean) {
    setError(null);
    setBusy(true);
    try {
      if (merge) {
        await props.onStart(
          { inputs: ready.map((f) => f.path), preset: convPreset.id, options: effective(convPreset, null) },
          `${baseName(ready[0].path)} + ${ready.length - 1}`,
          meta(convPreset),
        );
      } else {
        // ملف يفشل بدؤه لا يوقف بقية الدفعة: نكمل ونعرض أول خطأ في النهاية (FE6)
        let first: unknown = null;
        for (const f of ready)
          for (const st of stepsFor(f)) {
            try {
              const next = st.then;
              if (next)
                await props.onChain(st.req, st.title, st.meta, (file) => ({
                  req: { inputs: [file], preset: next.preset, options: next.options },
                  meta: next.meta,
                }));
              else await props.onStart(st.req, st.title, st.meta);
            } catch (e) {
              first ??= e;
            }
          }
        if (first) throw first;
      }
    } catch (e) {
      setError(asAppError(e));
    } finally {
      setBusy(false);
    }
  }

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<AppError | null>(null);
  const chooseFiles = async () => {
    setImporting(true);
    setImportError(null);
    try {
      const paths = await pickFiles(true, MEDIA_FILTER);
      if (paths.length) props.addFiles(paths);
    } catch (e) {
      setImportError(asAppError(e));
    } finally {
      setImporting(false);
    }
  };

  const hwNames = (props.hw ?? []).map((e) => e.split("_").pop()!.toUpperCase());
  const hwLabel = [...new Set(hwNames)].join(" / ");

  const toggleAi = (id: string) =>
    setAi((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : oneFile && convNeeded ? [id] : [...cur, id]));
  const toggleAnalysis = (id: string) => setAnalysis((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const pickFormat = (id: string) => {
    update({ convertPreset: id });
    setFormatOn(true);
  };

  /** بطاقة صيغة أو أداة (نفس الشكل في كل الأقسام) */
  const card = (p: PresetDef, on: boolean, onClick: () => void) => {
    const ok = fits(p);
    const tag = speedTag(p);
    return (
      <button key={p.id} className={`preset ${p.id === suggestion ? "suggested" : ""}`} aria-pressed={on} disabled={!ok} onClick={onClick}>
        <span className="preset-head">
          <Icon name={KIND_ICON[p.kind]} size={18} />
          <b>{p.name[lang]}</b>
          {tag && <span className={`preset-tag ${tag}`}>{tag === "fast" ? t.tagFast : t.tagHeavy}</span>}
        </span>
        {/* أول جملة فقط، والوصف كامل حين تُختار البطاقة: لا تصبح كل بطاقة فقرة */}
        <span className="preset-desc">{on ? p.desc[lang] : splitHint(p.desc[lang])[0]}</span>
        {p.id === suggestion && (
          <span className="preset-suggested">
            <Icon name="check" size={16} /> {t.suggestedFor}
            {reason && ` · ${t.suggestWhy[reason.issue]}`}
          </span>
        )}
        {/* سبب التعطيل مكتوب لا في title، فيظهر على الهاتف أيضًا (D-86) */}
        {!ok && <span className="preset-why">{t.notFit}</span>}
      </button>
    );
  };
  /** قسم لا ينطبق على الصيغة المختارة: جملة تقول لماذا بدل خيارات بلا أثر */
  const notHere = (why: string) => <div className="cat-note faint">{why}</div>;

  // ============ بلا ملفات: منطقة الإفلات ============
  if (files.length === 0) {
    return (
      <div className={`card dropzone motif ${props.dragging ? "over" : ""}`}>
        <div className="drop-icon">
          <Icon name="convert" size={24} />
        </div>
        <h2>{props.dragging ? t.dropHere : isMobile ? t.pickTitleMobile : t.dropTitle}</h2>
        <p className="faint">{t.dropSub}</p>
        <button className="btn btn-primary btn-lg" onClick={chooseFiles} disabled={importing}>
          <Icon name="plus" /> {importing ? t.importing : t.chooseFiles}
        </button>
        {importError && <ErrorBox error={importError} />}
      </div>
    );
  }

  const catLabel = (c: Cat) => t.cat[c];
  const recipe: { cat: Cat; label: string; clear: () => void }[] = [
    ...ai.map((id) => ({
      cat: "audio" as Cat,
      label: presetById(id)!.name[lang],
      clear: () => setAi((cur) => cur.filter((x) => x !== id)),
    })),
    ...(fmtPicture && enhanceOn.length
      ? [
          {
            cat: "enhance" as Cat,
            label: enhanceOn.join("، "),
            clear: () => set({ enhance: null, denoise: false, deinterlace: false, tonemap: false, lut: null }),
          },
        ]
      : []),
    ...(fmtPicture && frameOn.length
      ? [
          {
            cat: "frame" as Cat,
            label: frameOn.join("، "),
            clear: () => set({ size: null, aspect: null, fps: null, speed: null, rotate: null }),
          },
        ]
      : []),
    ...(textOn.length
      ? [
          {
            cat: "text" as Cat,
            label: textOn.join("، "),
            clear: () => {
              set({ subtitles: null, watermark: null, timecode: false });
              setTrimOn(false);
            },
          },
        ]
      : []),
    ...(fmtAudio && audioOptsOn.length
      ? [{ cat: "audio" as Cat, label: audioOptsOn.join("، "), clear: () => set({ loudness: null, replaceAudio: null, mute: false }) }]
      : []),
    ...(formatOn ? [{ cat: "format" as Cat, label: fmt.name[lang], clear: () => setFormatOn(false) }] : []),
    ...analysis.map((id) => ({
      cat: "analysis" as Cat,
      label: presetById(id)!.name[lang],
      clear: () => setAnalysis((cur) => cur.filter((x) => x !== id)),
    })),
  ];

  return (
    <>
      {/* ============ الملفات ============ */}
      <div className={`card ${props.dragging ? "drop-over" : ""}`}>
        <div className="section-head">
          <h2>
            {props.dragging ? (
              t.dropHere
            ) : (
              <>
                {t.filesHeading} <span className="count-badge ltr-num">{files.length}</span>
              </>
            )}
          </h2>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={chooseFiles}>
            <Icon name="plus" size={16} /> {t.addFiles}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={props.onClearFiles}>
            {t.clearFiles}
          </button>
        </div>
        <AnimatedList className="file-list">
          {files.map((f, i) => (
            <div className="file-row" key={f.path}>
              {f.info?.thumbnail ? (
                <img className="file-thumb" src={f.info.thumbnail} alt="" />
              ) : (
                <div className={`file-thumb ${!f.info && !f.error ? "skeleton" : ""}`}>
                  {f.info && <Icon name={f.info.video ? "film" : "music"} />}
                </div>
              )}
              <div className="file-body">
                <div className="file-name" dir="auto" title={f.path}>
                  {baseName(f.path)}
                </div>
                {differs(f) && (
                  <span className="own-opts">
                    <Icon name="settings" size={16} /> {t.customOpts}
                  </span>
                )}
                {f.info ? <Specs m={f.info} /> : f.error ? null : <div className="faint">{t.analyzingFile}</div>}
                {f.info && f.info.issues.length > 0 && (
                  <div className="issues">
                    {f.info.issues.map((i) => (
                      <span key={i} className={`issue ${i === "noAudio" ? "" : "warn"}`} title={t.issues[i]}>
                        <Icon name={ISSUE_ICON[i]} size={16} /> {t.issues[i]}
                      </span>
                    ))}
                  </div>
                )}
                {f.error && <ErrorBox error={f.error} compact />}
              </div>
              {/* «دمج» يجمعها بهذا الترتيب، فيمكن تغييره (U-50) */}
              {files.length > 1 && (
                <div className="file-order">
                  <button className="icon-btn sm" title={t.moveUp} aria-label={t.moveUp} disabled={i === 0} onClick={() => move(i, -1)}>
                    <span className="flip-y">
                      <Icon name="chevron" size={16} />
                    </span>
                  </button>
                  <button
                    className="icon-btn sm"
                    title={t.moveDown}
                    aria-label={t.moveDown}
                    disabled={i === files.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <Icon name="chevron" size={16} />
                  </button>
                </div>
              )}
              {ready.length > 1 && f.info && (
                <button
                  className="icon-btn sm"
                  title={t.editFileOpts}
                  aria-label={t.editFileOpts}
                  aria-pressed={editFile?.path === f.path}
                  onClick={() => setEditPath(editFile?.path === f.path ? null : f.path)}
                >
                  <Icon name="settings" size={16} />
                </button>
              )}
              <button
                className="icon-btn sm"
                title={t.removeFile}
                aria-label={t.removeFile}
                onClick={() => props.setFiles((prev) => prev.filter((x) => x.path !== f.path))}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </AnimatedList>
      </div>

      {/* ============ مساحة العمل: الأقسام على الجانب، وأدوات القسم المختار في الوسط ============ */}
      <div className="card workspace">
        <nav className="cat-nav" aria-label={t.toolsHeading}>
          {CATS.map((c) => (
            <button key={c.id} aria-current={cat === c.id ? "true" : undefined} onClick={() => setCat(c.id)}>
              <Icon name={c.icon} size={16} />
              <span className="cat-name">{catLabel(c.id)}</span>
              {counts[c.id] > 0 && <span className="cat-count ltr-num">{counts[c.id]}</span>}
              {suggestion &&
                cat !== c.id &&
                c.id === (isFormat(presetById(suggestion)!) ? "format" : isAi(presetById(suggestion)!) ? "audio" : "analysis") && (
                  <span className="suggest-dot" title={t.suggested} />
                )}
            </button>
          ))}
        </nav>

        <div className={`cat-body ${editFile ? "scoped" : ""}`}>
          {editFile && (
            <div className="scoped-head">
              <div>
                <b dir="auto">{t.editingFor(baseName(editFile.path))}</b>
                <div className="faint">{t.editingNote}</div>
              </div>
              <span className="spacer" />
              {overrides[editFile.path] && (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setOverrides(({ [editFile.path]: _drop, ...rest }) => rest);
                    setEditPath(null);
                  }}
                >
                  {t.useShared}
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setEditPath(null)}>
                {t.doneEditing}
              </button>
            </div>
          )}

          <SlideSwitch id={cat} index={CATS.findIndex((c) => c.id === cat)} distance={24} fade>
            <div className="cat-pane">
              <div className="cat-head">
                <h3>{catLabel(cat)}</h3>
                <span className="faint">{t.catHint[cat]}</span>
              </div>

              {cat === "format" && (
                <>
                  <Segmented<FmtGroup>
                    label={t.format}
                    value={fmtGroup}
                    onChange={setFmtGroup}
                    options={(["edit", "publish", "audio", "tools"] as FmtGroup[]).map((g) => ({
                      value: g,
                      label: g === "tools" ? t.groupCopy : groupName(t, g),
                    }))}
                  />
                  <div className="preset-grid">
                    {PRESETS.filter((p) => p.group === fmtGroup && isFormat(p)).map((p) =>
                      card(p, formatOn && p.id === fmt.id, () => pickFormat(p.id)),
                    )}
                  </div>
                  {!formatOn && <div className="cat-note faint">{convNeeded ? t.noFormatFamily : t.noFormat}</div>}
                  {formatOn && (fmt.quality || fmt.hw) && (
                    <div className="options mt-4">
                      {fmt.quality && (
                        <div>
                          <span className="field-label">{t.quality}</span>
                          <Segmented<ConvertOptions["quality"]>
                            label={t.quality}
                            value={opts.quality}
                            onChange={(quality) => set({ quality })}
                            // الرقم خلف كل مستوى للمحترف: معدل البت التقريبي عند 1080p أو للصوت (F-13)
                            options={(["high", "balanced", "small"] as const).map((q) => ({
                              value: q,
                              label: { high: t.qualityHigh, balanced: t.qualityBalanced, small: t.qualitySmall }[q],
                              title: qualityRate(fmt, q),
                            }))}
                          />
                        </div>
                      )}
                      {fmt.hw && (
                        <div>
                          <Toggle
                            checked={s.convertHw && (props.hw?.length ?? 0) > 0}
                            onChange={(convertHw) => update({ convertHw })}
                            title={isMobile ? t.hwToggleMobile : t.hwToggle}
                            hint={
                              props.hw == null
                                ? t.analyzingFile
                                : props.hw.length
                                  ? t.hwHint(hwLabel)
                                  : isMobile
                                    ? t.hwNoneMobile
                                    : t.hwNone
                            }
                          />
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {cat === "enhance" &&
                (!anyVideo || !fmtPicture ? (
                  notHere(anyVideo ? t.needVideoFormat : t.needVideoFile)
                ) : (
                  <section>
                    {previewFile && (
                      <BeforeAfter
                        path={previewFile.path}
                        presetId={previewPreset.id}
                        options={effective(previewPreset, previewFile)}
                        at={previewAt}
                      />
                    )}
                    {audioOnly > 0 && <div className="faint mb-2">{t.pictureSkipsAudio(audioOnly)}</div>}
                    {/* تحسين بلا نموذج (فلاتر FFmpeg): المعاينة «قبل وبعد» تعرضه، والتقدير المقيس يعرض وقته */}
                    <span className="field-label">{t.enhance}</span>
                    <Segmented<string>
                      label={t.enhance}
                      value={opts.enhance ?? "off"}
                      onChange={(v) => set({ enhance: v === "off" ? null : v })}
                      options={[
                        { value: "off", label: t.enhanceOff },
                        { value: "light", label: t.enhanceLight },
                        { value: "strong", label: t.enhanceStrong },
                        { value: "sharpen", label: t.enhanceSharpen },
                      ]}
                    />
                    {opts.enhance && <Hint className="mt-2" icon="contrast" text={t.enhanceHint} />}
                    <div className="toggle-grid">
                      <Toggle checked={opts.denoise} onChange={(denoise) => set({ denoise })} title={t.denoise} hint={t.denoiseHint} />
                      <Toggle
                        checked={opts.deinterlace}
                        onChange={(deinterlace) => set({ deinterlace })}
                        title={t.deinterlace}
                        hint={t.deinterlaceHint}
                      />
                      <Toggle checked={opts.tonemap} onChange={(tonemap) => set({ tonemap })} title={t.tonemap} hint={t.tonemapHint} />
                    </div>
                    <FilePick label={t.lut} value={opts.lut} extensions={["cube"]} onChange={(lut) => set({ lut })} />
                    {/* ما يفعله كل خيار بالضبط (F-45، F-46) */}
                    {opts.lut && <Hint className="mt-2" icon="contrast" text={t.lutHint} />}
                  </section>
                ))}

              {cat === "audio" && (
                <section>
                  <span className="field-label">{t.aiAudio}</span>
                  <div className="preset-grid mt-0">
                    {PRESETS.filter(isAi).map((p) => card(p, ai.includes(p.id), () => toggleAi(p.id)))}
                  </div>
                  {oneFile && convNeeded && <Hint className="mt-2" icon="info" text={t.aiOneAtATime} />}
                  {fmtAudio ? (
                    <>
                      <div className="pick-grid mt-4">
                        <Pick
                          label={t.loudness}
                          value={opts.loudness ?? null}
                          onChange={(loudness) => set({ loudness })}
                          options={[
                            { value: null, label: t.loudOff },
                            { value: -14, label: t.loudSocial },
                            { value: -16, label: t.loudPodcast },
                            { value: -23, label: t.loudBroadcast },
                          ]}
                        />
                        <FilePick
                          label={t.replaceAudio}
                          value={opts.replaceAudio}
                          extensions={MEDIA_FILTER.extensions}
                          onChange={(replaceAudio) => set({ replaceAudio })}
                        />
                      </div>
                      {/* ما يكلّفه كل خيار مكتوبًا تحته (F-40، F-41) */}
                      {opts.loudness != null && <Hint className="mt-2" icon="volume" text={t.loudHint} />}
                      {opts.replaceAudio && <Hint className="mt-2" icon="music" text={t.replaceAudioHint} />}
                      {anyVideo && <Toggle checked={opts.mute} onChange={(mute) => set({ mute })} title={t.mute} />}
                    </>
                  ) : (
                    fmt.kind === "copy" && <Toggle checked={opts.mute} onChange={(mute) => set({ mute })} title={t.mute} />
                  )}
                </section>
              )}

              {cat === "frame" &&
                (!anyVideo || !fmtPicture ? (
                  notHere(anyVideo ? t.needVideoFormat : t.needVideoFile)
                ) : (
                  <section>
                    {previewFile && (
                      <BeforeAfter
                        path={previewFile.path}
                        presetId={previewPreset.id}
                        options={effective(previewPreset, previewFile)}
                        at={previewAt}
                      />
                    )}
                    <div className="pick-grid">
                      <Pick
                        label={t.size}
                        value={opts.size ?? null}
                        onChange={(size) => set({ size })}
                        options={[null, 2160, 1440, 1080, 720, 540, 480].map((v) => ({
                          value: v,
                          label: v ? (v === 2160 ? "4K" : `${v}p`) : t.original,
                        }))}
                      />
                      <Pick
                        label={t.aspect}
                        value={opts.aspect ?? null}
                        onChange={(aspect) => set({ aspect })}
                        options={[null, "16:9", "9:16", "1:1", "4:5", "21:9"].map((v) => ({ value: v, label: v ?? t.original }))}
                      />
                      <Pick
                        label={t.fps}
                        value={opts.fps ?? null}
                        onChange={(fps) => set({ fps })}
                        options={[null, "23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].map((v) => ({
                          value: v,
                          label: v ?? t.original,
                        }))}
                      />
                      <Pick
                        label={t.speed}
                        value={opts.speed ?? 1}
                        onChange={(speed) => set({ speed: speed === 1 ? null : speed })}
                        options={[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((v) => ({ value: v, label: `${v}×` }))}
                      />
                    </div>
                    <RotatePick value={opts.rotate ?? null} onChange={(rotate) => set({ rotate })} />
                    {opts.speed != null && opts.speed !== 1 && <Hint className="mt-2" icon="gauge" text={t.speedHint} />}
                  </section>
                ))}

              {cat === "text" && (
                <section>
                  {canTrim ? (
                    <>
                      <Toggle checked={trimOn} onChange={setTrimOn} title={t.optTrim} hint={t.trimToolsHint} />
                      <div className="collapse" data-open={trimOn} inert={!trimOn || undefined}>
                        <div>
                          <TrimRange
                            duration={trimInfo!.duration!}
                            fps={trimInfo!.video?.fps}
                            value={{ start: opts.start ?? 0, end: opts.end ?? trimInfo!.duration! }}
                            onChange={(r) => set({ start: r.start, end: r.end })}
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    ready.length > 1 && <Hint className="mb-2" icon="scissors" text={t.trimOneFile} />
                  )}
                  {anyVideo && (formatOn ? fmt.kind === "video" : true) ? (
                    <>
                      <div className="pick-grid mt-4">
                        <FilePick
                          label={t.subtitles}
                          value={opts.subtitles}
                          extensions={["srt", "ass", "ssa", "vtt"]}
                          onChange={(subtitles) => set({ subtitles })}
                        />
                        <FilePick
                          label={t.watermark}
                          value={opts.watermark}
                          extensions={["png", "jpg", "jpeg", "webp"]}
                          onChange={(watermark) => set({ watermark })}
                        />
                        {opts.watermark && <PosGrid value={opts.watermarkPos ?? "br"} onChange={(watermarkPos) => set({ watermarkPos })} />}
                      </div>
                      {opts.subtitles && <Hint className="mt-2" icon="captions" text={t.subtitlesHint} />}
                      {opts.watermark && <Hint className="mt-2" icon="image" text={t.watermarkHint} />}
                      <Toggle checked={opts.timecode} onChange={(timecode) => set({ timecode })} title={t.timecode} hint={t.timecodeHint} />
                    </>
                  ) : (
                    notHere(anyVideo ? t.needVideoFormat : t.needVideoFile)
                  )}
                </section>
              )}

              {cat === "analysis" && (
                <section>
                  <div className="preset-grid mt-0">
                    {PRESETS.filter(isAnalysis).map((p) => card(p, analysis.includes(p.id), () => toggleAnalysis(p.id)))}
                  </div>
                  {/* كشف الصمت: ما يُعدّ صمتًا، وكم يبقى من طرفيه عند حذفه */}
                  {(analysis.includes("detect_silence") || analysis.includes("topics")) && (
                    <div className="mt-4">
                      <div className="pick-grid">
                        {analysis.includes("topics") && (
                          <>
                            <Pick
                              label={`${t.reelLength} · ${t.reelMin}`}
                              value={opts.reelMin ?? 15}
                              onChange={(v) => set({ reelMin: v === 15 ? null : v })}
                              options={[5, 10, 15, 20, 30, 45, 60].map((v) => ({ value: v, label: t.secs(v) }))}
                            />
                            <Pick
                              label={`${t.reelLength} · ${t.reelMax}`}
                              value={opts.reelMax ?? 90}
                              onChange={(v) => set({ reelMax: v === 90 ? null : v })}
                              options={[30, 45, 60, 90, 120, 180].map((v) => ({ value: v, label: t.secs(v) }))}
                            />
                          </>
                        )}
                        {/* تلقائي = عتبة تُقاس من ضجيج الملف نفسه؛ -40 الثابتة لم تجد شيئًا في تسجيلات فيها ضجيج غرفة */}
                        <Pick<number | null>
                          label={t.silenceLevel}
                          value={opts.silenceDb ?? null}
                          onChange={(v) => set({ silenceDb: v })}
                          options={[
                            { value: null, label: t.silenceAuto },
                            ...[-25, -30, -35, -40, -50, -60].map((v) => ({ value: v, label: `${v} dB` })),
                          ]}
                        />
                        <Pick
                          label={t.silenceMin}
                          value={opts.silenceMin ?? 0.6}
                          onChange={(v) => set({ silenceMin: v === 0.6 ? null : v })}
                          options={[0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.5, 2, 3].map((v) => ({ value: v, label: t.secs(v) }))}
                        />
                        {/* ما يبقى قبل الكلام منفصل عمّا يبقى بعده (كما في auto-editor): النَّفَس قبل الجملة غير ذيلها */}
                        <Pick<number | null>
                          label={t.silencePadBefore}
                          value={opts.silencePadBefore ?? null}
                          onChange={(v) => set({ silencePadBefore: v })}
                          options={[
                            { value: null, label: t.sameAsAfter },
                            ...[0, 0.05, 0.1, 0.2, 0.3, 0.5].map((v) => ({ value: v, label: t.secs(v) })),
                          ]}
                        />
                        <Pick
                          label={t.silencePad}
                          value={opts.silencePad ?? 0.15}
                          onChange={(v) => set({ silencePad: v === 0.15 ? null : v })}
                          options={[0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5].map((v) => ({ value: v, label: t.secs(v) }))}
                        />
                      </div>
                      <Hint className="mt-2" icon="wave" text={t.silenceHint} />
                      {analysis.includes("topics") && <Hint className="mt-2" icon="list" text={t.topicsHint} />}
                      {analysis.includes("topics") && (
                        <div className="mt-2">
                          <Toggle
                            checked={!!opts.alignSpeech}
                            onChange={(alignSpeech) => set({ alignSpeech })}
                            title={t.alignSpeech}
                            hint={t.alignSpeechHint}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>
          </SlideSwitch>
        </div>
      </div>

      {/* ============ الوصفة: كل ما اختير من كل الأقسام، ثم البدء ============ */}
      <div className="card recipe-card">
        <div className="recipe" aria-label={t.recipe}>
          <span className="field-label m-0">{t.recipe}</span>
          {recipe.length === 0 ? (
            <span className="faint">{t.recipeEmpty}</span>
          ) : (
            recipe.map((r, i) => (
              <span key={`${r.cat}-${r.label}`} className="recipe-chip" style={{ "--i": i } as CSSProperties}>
                <button className="recipe-go" onClick={() => setCat(r.cat)} title={catLabel(r.cat)}>
                  {r.label}
                </button>
                <button className="recipe-x" aria-label={`${t.unpick}: ${r.label}`} title={t.unpick} onClick={r.clear}>
                  <Icon name="x" size={14} />
                </button>
              </span>
            ))
          )}
          {recipe.length > 0 && (
            <button
              className="btn btn-sm btn-ghost recipe-reset"
              onClick={() => {
                resetOpts();
                setAi([]);
                setAnalysis([]);
              }}
            >
              {t.resetOptions}
            </button>
          )}
        </div>

        {error && <ErrorBox error={error} />}

        <div className="action-row">
          {askMode && (
            <div className="dest">
              <Segmented<"one" | "each">
                label={t.outputMode}
                value={oneFile ? "one" : "each"}
                onChange={(v) => {
                  setOneFile(v === "one");
                  // ملف واحد: أداة ذكاء واحدة فقط قبل التحويل (لا يُجمع صوتان متعارضان)
                  if (v === "one" && convNeeded) setAi((cur) => cur.slice(0, 1));
                }}
                options={[
                  { value: "one", label: t.modeOne, title: t.modeOneHint },
                  { value: "each", label: t.modeEach, title: t.modeEachHint },
                ]}
              />
            </div>
          )}
          {isMobile ? (
            <div className="dest faint">
              <Icon name="folder" size={16} /> <span className="ltr">{mobileSaveDir(s)}</span>
            </div>
          ) : (
            <div className="dest">
              <span className="field-label m-0">{t.saveTo2}</span>
              <Segmented<Settings["convertDest"]>
                label={t.saveTo2}
                value={s.convertDest}
                onChange={(convertDest) => update({ convertDest })}
                options={[
                  { value: "source", label: t.destSource },
                  { value: "output", label: t.destOutput },
                ]}
              />
            </div>
          )}
          <span className="spacer" />
          {(shown != null || stepCount > 1) && (
            <span className="estimate ltr-num" title={exact ? t.estimateMeasuredHint : t.estimateHint}>
              {[
                stepCount > 1 && t.steps(stepCount),
                shown != null && t.estimate(formatBytes(t, shown)),
                expectedSecs != null && t.estimateTime(formatDuration(expectedSecs)),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          {canMerge && (
            <button
              className="btn btn-lg"
              disabled={busy || loading}
              onClick={() => start(true)}
              title={Object.keys(overrides).length ? `${t.mergeHint} ${t.mergeShared}` : t.mergeHint}
            >
              {t.mergeBtn}
            </button>
          )}
          <button className="btn btn-primary btn-lg" disabled={busy || loading || stepCount === 0} onClick={() => start(false)}>
            <Icon name="convert" /> {t.convertBtn(ready.length)}
          </button>
        </div>
      </div>
    </>
  );
}

function enhanceName(t: Dict, v: string) {
  return ({ light: t.enhanceLight, strong: t.enhanceStrong, sharpen: t.enhanceSharpen } as Record<string, string>)[v] ?? v;
}
