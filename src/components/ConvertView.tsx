import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { api, asAppError, type AppError, type ConvertOptions, type ConvertRequest, type MediaInfo, type Settings } from "../api";
import { formatBytes, formatDuration } from "../format";
import { useI18n, type Dict } from "../i18n";
import {
  estimateSize,
  GROUPS,
  presetById,
  presetFits,
  PRESETS,
  suggestPreset,
  suggestReason,
  type PresetDef,
  type PresetGroup,
} from "../presets";
import { ErrorBox } from "./ErrorBox";
import { Icon, type IconName } from "./Icon";
import { AnimatedList, SlideSwitch } from "../motion";
import { Segmented, Toggle } from "./Segmented";
import { TrimRange } from "./TrimRange";
import { isMobile, MOBILE_SAVE_DIR } from "../platform";

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

type OptTab = "trim" | "picture" | "burn" | "audio";

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

/** اختيار واحد: حتى 5 خيارات أزرار مجزّأة، وأكثر قائمة منسدلة (D-23) */
function Pick<T extends string | number | null>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const idx = props.options.findIndex((o) => o.value === props.value);
  if (props.options.length <= 5) {
    return (
      <div className="pick">
        <span className="field-label">{props.label}</span>
        <Segmented<string>
          label={props.label}
          value={String(idx)}
          onChange={(v) => props.onChange(props.options[Number(v)].value)}
          options={props.options.map((o, i) => ({ value: String(i), label: o.label }))}
        />
      </div>
    );
  }
  return (
    <label className="pick">
      <span className="field-label">{props.label}</span>
      <select className="select" value={idx} onChange={(e) => props.onChange(props.options[Number(e.target.value)].value)}>
        {props.options.map((o, i) => (
          <option key={String(o.value)} value={i}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
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
}) {
  const { t, lang } = useI18n();
  const { settings: s, update, files } = props;
  const [opts, setOpts] = useState<ConvertOptions>(defaultOptions);
  const [more, setMore] = useState(false);
  const [tabPick, setTab] = useState<OptTab>("picture");
  const [trimOn, setTrimOn] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = presetById(s.convertPreset) ?? PRESETS[0];
  const [group, setGroup] = useState<PresetGroup>(preset.group);
  const set = (patch: Partial<ConvertOptions>) => setOpts((o) => ({ ...o, ...patch }));

  const ready = files.filter((f) => f.info);
  const audioOnly = ready.filter((f) => !f.info!.video).length;
  const loading = files.some((f) => !f.info && !f.error);
  const single = ready.length === 1 ? ready[0].info! : null;
  const fits = (p: PresetDef) => ready.every((f) => presetFits(p, f.info));
  const suggestion = single ? suggestPreset(single.issues) : null;
  const reason = single ? suggestReason(single.issues) : null;

  const kind = preset.kind;
  const showPicture = ["video", "gif", "frame", "sequence"].includes(kind);
  const showAudio = kind === "video" || kind === "audio";
  const showBurn = kind === "video";
  const canTrim = !!single?.duration;
  const move = (i: number, by: -1 | 1) =>
    props.setFiles((prev) => {
      const next = [...prev];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });
  const canMerge = ready.length > 1 && ["video", "audio", "gif"].includes(kind);
  const tabs = (
    [showPicture && "picture", canTrim && "trim", showBurn && "burn", (showAudio || kind === "copy") && "audio"] as (OptTab | false)[]
  ).filter((x): x is OptTab => !!x);
  const tab: OptTab | undefined = tabs.includes(tabPick) ? tabPick : tabs[0];
  // ما فُعّل داخل «خيارات إضافية» يظهر على زرها حتى وهي مطوية، فلا يُطبَّق LUT أو سرعة منسيّة بصمت (U-21)
  const o = opts;
  const activeOpts = [
    trimOn && canTrim && t.optTrim,
    showPicture &&
      (o.size || o.aspect || o.fps || o.rotate || o.deinterlace || o.denoise || o.tonemap || o.lut || (o.speed && o.speed !== 1)) &&
      t.optPicture,
    showBurn && (o.subtitles || o.watermark || o.timecode) && t.optBurn,
    showAudio && (o.loudness || o.replaceAudio || o.mute) && t.optAudio,
  ].filter((x): x is string => !!x);
  const resetOpts = () => {
    setOpts({ ...defaultOptions(), quality: opts.quality });
    setTrimOn(false);
  };

  /** نرسل فقط الخيارات المناسبة لنوع الـ Preset (الأقسام المخفية لا تؤثر) */
  const effective = (info?: MediaInfo | null): ConvertOptions => {
    const o: ConvertOptions = { ...defaultOptions(), quality: opts.quality, hw: preset.hw && s.convertHw };
    if (trimOn && canTrim && info === single) {
      o.start = opts.start ?? 0;
      o.end = opts.end ?? single?.duration ?? null;
    }
    if (kind === "copy") o.mute = opts.mute;
    if (kind === "stems") return o;
    if (showPicture) {
      Object.assign(o, {
        size: opts.size,
        aspect: opts.aspect,
        fps: kind === "frame" ? null : opts.fps,
        rotate: opts.rotate,
        deinterlace: opts.deinterlace,
        denoise: opts.denoise,
        tonemap: opts.tonemap,
        lut: opts.lut,
      });
      if (kind !== "frame") o.speed = opts.speed;
    }
    if (showAudio) {
      Object.assign(o, {
        loudness: opts.loudness,
        replaceAudio: opts.replaceAudio,
        mute: kind === "video" && opts.mute,
        speed: opts.speed,
      });
    }
    if (showBurn) {
      Object.assign(o, { subtitles: opts.subtitles, watermark: opts.watermark, watermarkPos: opts.watermarkPos, timecode: opts.timecode });
    }
    return o;
  };

  const estimate = useMemo(() => {
    let sum = 0;
    for (const f of ready) {
      const e = estimateSize(preset, f.info!, effective(f.info));
      if (e == null) return null;
      sum += e;
    }
    return sum || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, preset, opts, trimOn, s.convertHw]);

  // الصيغ بجودة ثابتة يتبع حجمها تعقيد الصورة: نقيسه بتحويل ثلاث شرائح قصيرة (A-30)
  const [measured, setMeasured] = useState<{ key: string; bytes: number } | null>(null);
  const sampleKey =
    !isMobile && ready.length === 1 && preset.kind === "video"
      ? JSON.stringify([ready[0].path, preset.id, effective(ready[0].info)])
      : null;
  useEffect(() => {
    if (!sampleKey) return;
    const [path, id, o] = JSON.parse(sampleKey) as [string, string, ConvertOptions];
    let live = true;
    const timer = setTimeout(() => {
      api
        .sampleEstimate(path, id, o)
        .then((b) => live && b && setMeasured({ key: sampleKey, bytes: b }))
        .catch(() => {});
    }, 800);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sampleKey]);
  const exact = measured && measured.key === sampleKey ? measured.bytes : null;
  const shown = exact ?? estimate;

  const meta = () =>
    [preset.name[lang], preset.quality ? { high: t.qualityHigh, balanced: t.qualityBalanced, small: t.qualitySmall }[opts.quality] : null]
      .filter(Boolean)
      .join(" · ");

  async function start(merge: boolean) {
    setError(null);
    setBusy(true);
    try {
      if (merge) {
        await props.onStart(
          { inputs: ready.map((f) => f.path), preset: preset.id, options: effective(null) },
          `${baseName(ready[0].path)} + ${ready.length - 1}`,
          meta(),
        );
      } else {
        for (const f of ready) {
          if (!presetFits(preset, f.info)) continue;
          await props.onStart({ inputs: [f.path], preset: preset.id, options: effective(f.info) }, baseName(f.path), meta());
        }
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
                {f.info ? <Specs m={f.info} /> : f.error ? null : <div className="faint">{t.analyzingFile}</div>}
                {f.info && f.info.issues.length > 0 && (
                  <div className="issues">
                    {f.info.issues.map((i) => (
                      <span key={i} className={`issue ${i === "noAudio" ? "" : "warn"}`} title={t.issues[i]}>
                        <Icon name={i === "noAudio" ? "info" : "alert"} size={16} /> {t.issues[i]}
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

      {/* ============ ماذا تريد؟ ============ */}
      <div className="card">
        <Segmented<PresetGroup>
          label={t.format}
          value={group}
          onChange={setGroup}
          options={GROUPS.map((g) => ({
            value: g,
            label:
              suggestion && g !== group && presetById(suggestion)?.group === g ? (
                <>
                  {groupName(t, g)} <span className="suggest-dot" title={t.suggested} />
                </>
              ) : (
                groupName(t, g)
              ),
          }))}
        />
        <SlideSwitch id={group} index={GROUPS.indexOf(group)} distance={40}>
          <div className="preset-grid">
            {PRESETS.filter((p) => p.group === group).map((p) => {
              const ok = fits(p);
              const tag = speedTag(p);
              return (
                <button
                  key={p.id}
                  className={`preset ${p.id === suggestion ? "suggested" : ""}`}
                  aria-pressed={p.id === preset.id}
                  disabled={!ok}
                  onClick={() => update({ convertPreset: p.id })}
                >
                  <span className="preset-head">
                    <Icon name={KIND_ICON[p.kind]} size={18} />
                    <b>{p.name[lang]}</b>
                    {tag && <span className={`preset-tag ${tag}`}>{tag === "fast" ? t.tagFast : t.tagHeavy}</span>}
                  </span>
                  <span>{p.desc[lang]}</span>
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
            })}
          </div>
        </SlideSwitch>

        {(preset.quality || preset.hw) && (
          <div className="options mt-4">
            {preset.quality && (
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
                    title: qualityRate(preset, q),
                  }))}
                />
              </div>
            )}
            {preset.hw && (
              <div>
                <Toggle
                  checked={s.convertHw && (props.hw?.length ?? 0) > 0}
                  onChange={(convertHw) => update({ convertHw })}
                  title={isMobile ? t.hwToggleMobile : t.hwToggle}
                  hint={props.hw == null ? t.analyzingFile : props.hw.length ? t.hwHint(hwLabel) : isMobile ? t.hwNoneMobile : t.hwNone}
                />
              </div>
            )}
          </div>
        )}

        {/* ============ خيارات إضافية: تبويب واحد ظاهر في كل مرة (D-22) ============ */}
        {tabs.length > 0 && (
          <div className="more-head">
            <button className="more-btn" aria-expanded={more} onClick={() => setMore((m) => !m)}>
              <Icon name="chevron" size={16} /> {t.moreOptions}
              {activeOpts.length > 0 && <span className="extras-count">{activeOpts.join(" · ")}</span>}
            </button>
            {activeOpts.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={resetOpts}>
                {t.resetOptions}
              </button>
            )}
          </div>
        )}
        <div className="collapse" data-open={more && tabs.length > 0}>
          <div>
            <div className="more">
              {tabs.length > 1 && (
                <Segmented<OptTab>
                  label={t.moreOptions}
                  value={tab!}
                  onChange={setTab}
                  options={tabs.map((v) => ({
                    value: v,
                    label: { trim: t.optTrim, picture: t.optPicture, burn: t.optBurn, audio: t.optAudio }[v],
                  }))}
                />
              )}

              {tab === "trim" && (
                <section>
                  <Toggle checked={trimOn} onChange={setTrimOn} title={t.optTrim} />
                  <div className="collapse" data-open={trimOn}>
                    <div>
                      <TrimRange
                        duration={single!.duration!}
                        fps={single!.video?.fps}
                        value={{ start: opts.start ?? 0, end: opts.end ?? single!.duration! }}
                        onChange={(r) => set({ start: r.start, end: r.end })}
                      />
                    </div>
                  </div>
                </section>
              )}

              {tab === "picture" && (
                <section>
                  {/* ملفات صوت فقط بين الفيديوهات: خيارات الصورة لا تمسّها (U-92) */}
                  {audioOnly > 0 && audioOnly < ready.length && <div className="faint mb-2">{t.pictureSkipsAudio(audioOnly)}</div>}
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
                    {kind !== "frame" && (
                      <Pick
                        label={t.fps}
                        value={opts.fps ?? null}
                        onChange={(fps) => set({ fps })}
                        options={[null, "23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].map((v) => ({
                          value: v,
                          label: v ?? t.original,
                        }))}
                      />
                    )}
                    {kind !== "frame" && (
                      <Pick
                        label={t.speed}
                        value={opts.speed ?? 1}
                        onChange={(speed) => set({ speed: speed === 1 ? null : speed })}
                        options={[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].map((v) => ({ value: v, label: `${v}×` }))}
                      />
                    )}
                  </div>
                  <RotatePick value={opts.rotate ?? null} onChange={(rotate) => set({ rotate })} />
                  <div className="toggle-grid">
                    <Toggle
                      checked={opts.deinterlace}
                      onChange={(deinterlace) => set({ deinterlace })}
                      title={t.deinterlace}
                      hint={t.deinterlaceHint}
                    />
                    <Toggle checked={opts.denoise} onChange={(denoise) => set({ denoise })} title={t.denoise} hint={t.denoiseHint} />
                    <Toggle checked={opts.tonemap} onChange={(tonemap) => set({ tonemap })} title={t.tonemap} hint={t.tonemapHint} />
                  </div>
                  <FilePick label={t.lut} value={opts.lut} extensions={["cube"]} onChange={(lut) => set({ lut })} />
                  {/* ما يفعله كل خيار بالضبط (F-45، F-46) */}
                  {opts.lut && <div className="faint mt-2">{t.lutHint}</div>}
                  {opts.speed != null && opts.speed !== 1 && <div className="faint mt-2">{t.speedHint}</div>}
                </section>
              )}

              {tab === "burn" && (
                <section>
                  <div className="pick-grid">
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
                  {opts.subtitles && <div className="faint mt-2">{t.subtitlesHint}</div>}
                  {opts.watermark && <div className="faint mt-2">{t.watermarkHint}</div>}
                  <Toggle checked={opts.timecode} onChange={(timecode) => set({ timecode })} title={t.timecode} hint={t.timecodeHint} />
                </section>
              )}

              {tab === "audio" && showAudio && (
                <section>
                  <div className="pick-grid">
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
                  {opts.loudness != null && <div className="faint mt-2">{t.loudHint}</div>}
                  {opts.replaceAudio && <div className="faint mt-2">{t.replaceAudioHint}</div>}
                  {kind === "video" && <Toggle checked={opts.mute} onChange={(mute) => set({ mute })} title={t.mute} />}
                </section>
              )}

              {tab === "audio" && kind === "copy" && (
                <section>
                  <Toggle checked={opts.mute} onChange={(mute) => set({ mute })} title={t.mute} />
                </section>
              )}
            </div>
          </div>
        </div>

        {error && <ErrorBox error={error} />}

        <div className="action-row">
          {isMobile ? (
            <div className="dest faint">
              <Icon name="folder" size={16} /> <span className="ltr">{MOBILE_SAVE_DIR}</span>
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
          {shown != null && (
            <span className="estimate ltr-num" title={exact ? t.estimateMeasuredHint : t.estimateHint}>
              {t.estimate(formatBytes(t, shown))}
            </span>
          )}
          {canMerge && (
            <button className="btn btn-lg" disabled={busy || loading} onClick={() => start(true)} title={t.mergeHint}>
              {t.mergeBtn}
            </button>
          )}
          <button
            className="btn btn-primary btn-lg"
            disabled={busy || loading || ready.length === 0 || !ready.some((f) => presetFits(preset, f.info))}
            onClick={() => start(false)}
          >
            <Icon name="convert" /> {t.convertBtn(ready.length)}
          </button>
        </div>
      </div>
    </>
  );
}
