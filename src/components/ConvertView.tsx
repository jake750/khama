import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import { api, asAppError, type AppError, type ConvertOptions, type ConvertRequest, type MediaInfo, type Settings } from "../api";
import { formatBytes, formatDuration } from "../format";
import { useI18n, type Dict } from "../i18n";
import { estimateSize, GROUPS, presetById, presetFits, PRESETS, suggestPreset, type PresetDef, type PresetGroup } from "../presets";
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./Icon";
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

/** ملف في قائمة المحوّل */
export interface SourceFile {
  path: string;
  info?: MediaInfo;
  error?: AppError;
}

export const MEDIA_FILTER = {
  name: "Media",
  extensions: [
    "mp4", "mov", "mkv", "avi", "mxf", "m4v", "webm", "mts", "m2ts", "wmv", "flv", "3gp", "mpg", "mpeg", "ts",
    "wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "aiff", "aif", "wma",
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

function specLine(t: Dict, m: MediaInfo): string {
  const v = m.video;
  const a = m.audio[0];
  return [
    v ? `${v.codec.toUpperCase()} ${v.width}×${v.height}` : null,
    v?.fps ? `${Math.round(v.fps * 100) / 100} fps${v.vfr ? " (VFR)" : ""}` : null,
    v && v.bitDepth > 8 ? `${v.bitDepth}-bit` : null,
    a ? `${a.codec.toUpperCase()} ${a.channels === 1 ? t.mono : a.channels === 2 ? t.stereo : t.channels(a.channels)}` : null,
    formatDuration(m.duration),
    formatBytes(t, m.size),
  ]
    .filter(Boolean)
    .join(" · ");
}

function groupName(t: Dict, g: PresetGroup) {
  return { edit: t.groupEdit, publish: t.groupPublish, audio: t.groupAudio, tools: t.groupTools }[g];
}

/** حقل لاختيار ملف مساعد (LUT، ترجمة، شعار، صوت) */
function FilePick(props: {
  label: string;
  value?: string | null;
  extensions: string[];
  onChange: (path: string | null) => void;
}) {
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
          <button className="icon-btn" style={{ width: 30, height: 30 }} title={t.unpick} aria-label={t.unpick} onClick={() => props.onChange(null)}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

/** قائمة منسدلة بسيطة */
function Pick<T extends string | number | null>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const idx = props.options.findIndex((o) => o.value === props.value);
  return (
    <label className="pick">
      <span className="field-label">{props.label}</span>
      <select className="select" value={idx} onChange={(e) => props.onChange(props.options[Number(e.target.value)].value)}>
        {props.options.map((o, i) => (
          <option key={i} value={i}>
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
  onStart: (req: ConvertRequest, title: string, meta: string) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const { settings: s, update, files } = props;
  const [opts, setOpts] = useState<ConvertOptions>(defaultOptions);
  const [more, setMore] = useState(false);
  const [trimOn, setTrimOn] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = presetById(s.convertPreset) ?? PRESETS[0];
  const [group, setGroup] = useState<PresetGroup>(preset.group);
  const set = (patch: Partial<ConvertOptions>) => setOpts((o) => ({ ...o, ...patch }));

  const ready = files.filter((f) => f.info);
  const loading = files.some((f) => !f.info && !f.error);
  const single = ready.length === 1 ? ready[0].info! : null;
  const fits = (p: PresetDef) => ready.every((f) => presetFits(p, f.info));
  const suggestion = single ? suggestPreset(single.issues) : null;

  const kind = preset.kind;
  const showPicture = ["video", "gif", "frame", "sequence"].includes(kind);
  const showAudio = kind === "video" || kind === "audio";
  const showBurn = kind === "video";
  const canTrim = !!single?.duration;
  const canMerge = ready.length > 1 && ["video", "audio", "gif"].includes(kind);

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
        size: opts.size, aspect: opts.aspect, fps: kind === "frame" ? null : opts.fps, rotate: opts.rotate,
        deinterlace: opts.deinterlace, denoise: opts.denoise, tonemap: opts.tonemap, lut: opts.lut,
      });
      if (kind !== "frame") o.speed = opts.speed;
    }
    if (showAudio) {
      Object.assign(o, { loudness: opts.loudness, replaceAudio: opts.replaceAudio, mute: kind === "video" && opts.mute, speed: opts.speed });
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
      setError(e as AppError);
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
          <h2>{props.dragging ? t.dropHere : t.filesTitle(files.length)}</h2>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={chooseFiles}>
            <Icon name="plus" size={16} /> {t.chooseFiles}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => props.setFiles(() => [])}>
            {t.clearFiles}
          </button>
        </div>
        <AnimatedList className="file-list">
          {files.map((f) => (
            <div className="file-row" key={f.path}>
              {f.info?.thumbnail ? (
                <img className="file-thumb" src={f.info.thumbnail} alt="" />
              ) : (
                <div className={`file-thumb ${!f.info && !f.error ? "skeleton" : ""}`}>
                  {f.info && <Icon name={f.info.video ? "film" : "music"} />}
                </div>
              )}
              <div className="file-body">
                <div className="file-name" title={f.path}>{baseName(f.path)}</div>
                <div className="faint ltr-num">{f.info ? specLine(t, f.info) : f.error ? null : t.analyzingFile}</div>
                {f.info && f.info.issues.length > 0 && (
                  <div className="issues">
                    {f.info.issues.map((i) => (
                      <span key={i} className={`issue ${i === "noAudio" ? "" : "warn"}`} title={t.issues[i]}>
                        <Icon name="alert" size={16} /> {t.issues[i]}
                      </span>
                    ))}
                  </div>
                )}
                {f.error && <ErrorBox error={f.error} compact />}
              </div>
              <button
                className="icon-btn"
                style={{ width: 32, height: 32 }}
                title={t.removeFile}
                aria-label={t.removeFile}
                onClick={() => props.setFiles((prev) => prev.filter((x) => x.path !== f.path))}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </AnimatedList>
        {suggestion && suggestion !== preset.id && (
          <div className="alert info suggestion">
            <Icon name="check" size={16} />
            <span style={{ flex: 1 }}>
              {t.suggested}: <b>{presetById(suggestion)!.name[lang]}</b> — {presetById(suggestion)!.desc[lang]}
            </span>
            <button
              className="btn btn-sm"
              onClick={() => {
                update({ convertPreset: suggestion });
                setGroup(presetById(suggestion)!.group);
              }}
            >
              {t.useSuggestion}
            </button>
          </div>
        )}
      </div>

      {/* ============ ماذا تريد؟ ============ */}
      <div className="card">
        <Segmented<PresetGroup>
          label={t.format}
          value={group}
          onChange={setGroup}
          options={GROUPS.map((g) => ({ value: g, label: groupName(t, g) }))}
        />
        <SlideSwitch id={group} index={GROUPS.indexOf(group)} distance={40}>
        <div className="preset-grid">
          {PRESETS.filter((p) => p.group === group).map((p) => {
            const ok = fits(p);
            return (
              <button
                key={p.id}
                className="preset"
                aria-pressed={p.id === preset.id}
                disabled={!ok}
                title={ok ? undefined : t.notFit}
                onClick={() => update({ convertPreset: p.id })}
              >
                <b>{p.name[lang]}</b>
                <span>{p.desc[lang]}</span>
              </button>
            );
          })}
        </div>
        </SlideSwitch>

        {(preset.quality || preset.hw) && (
          <div className="options" style={{ marginTop: 16 }}>
            {preset.quality && (
              <div>
                <span className="field-label">{t.quality}</span>
                <Segmented<ConvertOptions["quality"]>
                  label={t.quality}
                  value={opts.quality}
                  onChange={(quality) => set({ quality })}
                  options={[
                    { value: "high", label: t.qualityHigh },
                    { value: "balanced", label: t.qualityBalanced },
                    { value: "small", label: t.qualitySmall },
                  ]}
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

        {/* ============ خيارات إضافية ============ */}
        <button className="more-btn" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          <Icon name="chevron" size={16} /> {t.moreOptions}
        </button>
        <div className="collapse" data-open={more}>
          <div>
            <div className="more">
              {canTrim && (
                <section>
                  <Toggle checked={trimOn} onChange={setTrimOn} title={t.optTrim} />
                  <div className="collapse" data-open={trimOn}>
                    <div>
                      <TrimRange
                        duration={single!.duration!}
                        value={{ start: opts.start ?? 0, end: opts.end ?? single!.duration! }}
                        onChange={(r) => set({ start: r.start, end: r.end })}
                      />
                    </div>
                  </div>
                </section>
              )}

              {showPicture && (
                <section>
                  <h4>{t.optPicture}</h4>
                  <div className="pick-grid">
                    <Pick
                      label={t.size}
                      value={opts.size ?? null}
                      onChange={(size) => set({ size })}
                      options={[null, 2160, 1440, 1080, 720, 540, 480].map((v) => ({ value: v, label: v ? (v === 2160 ? "4K" : `${v}p`) : t.original }))}
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
                        options={[null, "23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].map((v) => ({ value: v, label: v ?? t.original }))}
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
                    <Pick
                      label={t.rotate}
                      value={opts.rotate ?? null}
                      onChange={(rotate) => set({ rotate })}
                      options={[
                        { value: null, label: "—" },
                        { value: "90", label: "90° ↻" },
                        { value: "180", label: "180°" },
                        { value: "270", label: "90° ↺" },
                        { value: "hflip", label: t.flipH },
                        { value: "vflip", label: t.flipV },
                      ]}
                    />
                  </div>
                  <div className="toggle-grid">
                    <Toggle checked={opts.deinterlace} onChange={(deinterlace) => set({ deinterlace })} title={t.deinterlace} hint={t.deinterlaceHint} />
                    <Toggle checked={opts.denoise} onChange={(denoise) => set({ denoise })} title={t.denoise} hint={t.denoiseHint} />
                    <Toggle checked={opts.tonemap} onChange={(tonemap) => set({ tonemap })} title={t.tonemap} hint={t.tonemapHint} />
                  </div>
                  <FilePick label={t.lut} value={opts.lut} extensions={["cube"]} onChange={(lut) => set({ lut })} />
                </section>
              )}

              {showBurn && (
                <section>
                  <h4>{t.optBurn}</h4>
                  <div className="pick-grid">
                    <FilePick label={t.subtitles} value={opts.subtitles} extensions={["srt", "ass", "ssa", "vtt"]} onChange={(subtitles) => set({ subtitles })} />
                    <FilePick label={t.watermark} value={opts.watermark} extensions={["png", "jpg", "jpeg", "webp"]} onChange={(watermark) => set({ watermark })} />
                    {opts.watermark && (
                      <Pick
                        label={t.watermarkPos}
                        value={opts.watermarkPos ?? "br"}
                        onChange={(watermarkPos) => set({ watermarkPos })}
                        options={[
                          { value: "tl", label: t.posTl },
                          { value: "tr", label: t.posTr },
                          { value: "bl", label: t.posBl },
                          { value: "br", label: t.posBr },
                          { value: "c", label: t.posC },
                        ]}
                      />
                    )}
                  </div>
                  <Toggle checked={opts.timecode} onChange={(timecode) => set({ timecode })} title={t.timecode} hint={t.timecodeHint} />
                </section>
              )}

              {showAudio && (
                <section>
                  <h4>{t.optAudio}</h4>
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
                  {kind === "video" && <Toggle checked={opts.mute} onChange={(mute) => set({ mute })} title={t.mute} />}
                </section>
              )}

              {kind === "copy" && (
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
              <span className="field-label" style={{ margin: 0 }}>{t.saveTo2}</span>
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
          {estimate != null && (
            <span className="estimate ltr-num" title={t.estimateHint}>
              {t.estimate(formatBytes(t, estimate))}
            </span>
          )}
          {canMerge && (
            <button className="btn btn-lg" disabled={busy || loading} onClick={() => start(true)} title={t.mergeHint}>
              {t.mergeBtn}
            </button>
          )}
          <button className="btn btn-primary btn-lg" disabled={busy || loading || ready.length === 0 || !ready.some((f) => presetFits(preset, f.info))} onClick={() => start(false)}>
            <Icon name="convert" /> {t.convertBtn(ready.length)}
          </button>
        </div>
      </div>
    </>
  );
}
