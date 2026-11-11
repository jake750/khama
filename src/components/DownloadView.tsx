import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  asAppError,
  type AppError,
  type AudioFormat,
  type DownloadRequest,
  type Kind,
  type PlaylistEntry,
  type ProbeInfo,
  type Settings,
  type VideoFormat,
} from "../api";
import { extractUrls, formatDuration, isHttpUrl } from "../format";
import { useI18n } from "../i18n";
import { ErrorBox, type ErrorFix } from "./ErrorBox";
import { Icon } from "./Icon";
import { Segmented, Toggle } from "./Segmented";
import { SlideSwitch } from "../motion";
import { isMobile, MOBILE_SAVE_DIR } from "../platform";
import { TrimRange, type PreviewLink, type Range } from "./TrimRange";
import { PlaylistPanel } from "./PlaylistPanel";
import { FolderPicker } from "./FolderPicker";

const QUALITIES = ["best", "2160", "1440", "1080", "720", "480"] as const;

type ProbeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; info: ProbeInfo }
  | { status: "error"; error: AppError };

type Stills = "off" | "5" | "10" | "scene";

/** آخر رابط لصقناه تلقائيًا من الحافظة: لا نلصقه مرة ثانية بعد أن يمسحه المستخدم */
let lastAutoPasted = "";

export interface StartMeta {
  title: string;
  thumbnail?: string | null;
}

export function DownloadView(props: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  outputDir: string;
  onChooseDir: () => void;
  onPickDir: (dir: string) => void;
  /** at = وقت البدء (ms) للتنزيل المجدول */
  onStart: (req: DownloadRequest, meta: StartMeta, at?: number) => Promise<void>;
  /** رابط نسخه المستخدم وخامة تراقب الحافظة */
  clipUrl: string | null;
  onClipDone: () => void;
  /** رابط من خارج الشاشة (السجلّ: «نزّله مرة أخرى») */
  inject: { url: string; n: number } | null;
  onOpenSettings: (section: string) => void;
  toast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  const [url, setUrl] = useState("");
  const [autoPasted, setAutoPasted] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const [reprobe, setReprobe] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<AppError | null>(null);
  const probeToken = useRef(0);
  const [trimOn, setTrimOn] = useState(false);
  // المقاطع المختارة (null = مقطع واحد يغطي الفيديو كله، قبل أن يحرّك المستخدم شيئًا)
  const [clips, setClips] = useState<Range[] | null>(null);
  const [joinClips, setJoinClips] = useState(true);
  const [timeline, setTimeline] = useState(true);
  const [stems, setStems] = useState<"off" | "voice" | "music">("off");
  const [stills, setStills] = useState<Stills>("off");
  // قائمة التشغيل: العناصر المحدَّدة للتنزيل، وأيّها تُزال منه الموسيقى (إن اختار "عناصر أحدّدها")
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [stemsScope, setStemsScope] = useState<"all" | "pick">("all");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [when, setWhen] = useState<"now" | "later">("now");
  const [atTime, setAtTime] = useState(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  });
  const [savingThumb, setSavingThumb] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const urls = useMemo(() => extractUrls(url), [url]);
  const multiLinks = urls.length > 1;

  // عند تغيّر الرابط: ننتظر نصف ثانية (حتى ينتهي اللصق/الكتابة) ثم نجلب معلوماته.
  // probeToken يمنع ردًّا قديمًا من الكتابة فوق رد أحدث.
  useEffect(() => {
    const clean = url.trim();
    setStartError(null);
    setClips(null);
    if (!isHttpUrl(clean)) {
      probeToken.current++;
      setProbe({ status: "idle" });
      return;
    }
    const token = ++probeToken.current;
    const timer = setTimeout(async () => {
      setProbe({ status: "loading" });
      try {
        const info = await api.probe(clean);
        if (token === probeToken.current) {
          setSelected(new Set(info.entries?.map((_, i) => i) ?? []));
          setPicked(new Set());
          setProbe({ status: "ok", info });
        }
      } catch (e) {
        if (token === probeToken.current) setProbe({ status: "error", error: asAppError(e) });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [url, reprobe]);

  // رابط من السجلّ
  useEffect(() => {
    if (props.inject) setUrl(props.inject.url);
  }, [props.inject]);

  /** يقرأ أول رابط في الحافظة (عبر Tauri: يعمل على الكمبيوتر والهاتف) */
  async function clipboardUrl(): Promise<string | null> {
    try {
      return extractUrls(await readText()).join(" ") || null;
    } catch {
      return null;
    }
  }

  // لصق تلقائي: عند فتح خامة أو الرجوع إليها، إن كان الحقل فارغًا وفي الحافظة رابط جديد
  const urlRef = useRef(url);
  urlRef.current = url;
  useEffect(() => {
    const check = async () => {
      if (urlRef.current.trim()) return;
      const found = await clipboardUrl();
      if (found && found !== lastAutoPasted && !urlRef.current.trim()) {
        lastAutoPasted = found;
        setUrl(found);
        setAutoPasted(true);
      }
    };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  // Ctrl+V في أي مكان من النافذة (خارج حقول الكتابة) يلصق في حقل الرابط
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        paste();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const info = probe.status === "ok" && !multiLinks ? probe.info : null;
  const entries = info?.entries ?? null;
  const maxHeight = info?.heights[0];
  const duration = info && !entries && !info.isLive && info.duration ? info.duration : null;
  const activeClips = trimOn && duration ? (clips ?? [{ start: 0, end: duration }]) : null;
  const stemsOn = stems !== "off" && !isMobile;
  const stemsLabel = stems === "music" ? t.stemsMusic : t.stemsVoice;
  // العناصر المحدَّدة التي ستُزال منها الموسيقى
  const stemsCount = !entries || !stemsOn ? 0 : stemsScope === "all" ? selected.size : [...picked].filter((i) => selected.has(i)).length;
  const multi = !!activeClips && activeClips.length > 1;
  const single = activeClips?.length === 1 ? activeClips[0] : null;
  const isPartial = !!single && !!duration && (single.start > 0 || single.end < duration - 0.05);
  // الدمج يحتاج ffmpeg على الكمبيوتر؛ على الهاتف تُحفظ المقاطع ملفات منفصلة
  const willJoin = multi && joinClips && !isMobile;
  const original = !!info?.original;
  const ready = !!info || multiLinks;

  // لغات الترجمة لهذا الفيديو: المختارة سابقًا إن توفرت، وإلا الأولى
  const available = info?.subtitles ?? [];
  const chosenSubs = info
    ? available.filter((l) => s.subLangs.includes(l.code)).map((l) => l.code)
    : s.subLangs;
  const subsForRequest = !s.wantSubs
    ? []
    : info && !entries
      ? chosenSubs.length
        ? chosenSubs
        : available.slice(0, 1).map((l) => l.code)
      : s.subLangs.length
        ? s.subLangs
        : ["en", "ar"];
  const toggleLang = (code: string) =>
    update({ subLangs: s.subLangs.includes(code) ? s.subLangs.filter((c) => c !== code) : [...s.subLangs, code] });

  const preview: PreviewLink | null =
    info?.previewUrl && trimOn
      ? {
          now: () => video.current?.currentTime ?? null,
          seek: (v) => {
            if (video.current) video.current.currentTime = v;
          },
        }
      : null;

  const setClip = (i: number, r: Range) => setClips((activeClips ?? []).map((c, j) => (j === i ? r : c)));
  const removeClip = (i: number) => setClips((activeClips ?? []).filter((_, j) => j !== i));
  function addClip() {
    if (!duration || !activeClips) return;
    // المقطع الجديد يبدأ بعد آخر مقطع (أو من البداية إن لم يبقَ وقت)، بطول 10% من الفيديو
    const len = Math.max(Math.min(duration / 10, 60), Math.min(1, duration));
    const lastEnd = Math.max(...activeClips.map((c) => c.end));
    const start = lastEnd + len <= duration ? lastEnd : 0;
    setClips([...activeClips, { start, end: Math.min(start + len, duration) }]);
  }

  async function paste() {
    const found = await clipboardUrl();
    if (found) {
      setUrl(found);
      setAutoPasted(false);
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      setUrl(extractUrls(text).join(" ") || text.trim());
    } catch {
      setStartError({ code: "clipboard" });
    }
  }

  async function fix(f: ErrorFix) {
    if (f === "cookies") return props.onOpenSettings("cookies");
    if (f === "ytdlp") {
      try {
        const r = await api.updateYtdlp();
        props.toast(r.updated ? t.updatedTo(r.version ?? "") : t.upToDate(r.version ?? ""));
      } catch (e) {
        setStartError(asAppError(e));
        return;
      }
    }
    setReprobe((n) => n + 1);
  }

  async function saveThumb() {
    if (!info || savingThumb) return;
    setSavingThumb(true);
    try {
      await api.saveThumbnail(url.trim());
      props.toast(t.toastThumbSaved);
    } catch (e) {
      setStartError(asAppError(e));
    } finally {
      setSavingThumb(false);
    }
  }

  /** وقت البدء المجدول (اليوم، أو غدًا إن مضى الوقت) */
  function scheduledAt(): number | undefined {
    if (when !== "later") return undefined;
    const [h, m] = atTime.split(":").map(Number);
    const d = new Date();
    d.setHours(h || 0, m || 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /** الخيارات المشتركة لكل تنزيل */
  const base = (u: string, opts?: { original?: boolean }): DownloadRequest => ({
    url: u,
    kind: s.kind,
    videoFormat: s.videoFormat,
    audioFormat: s.audioFormat,
    quality: s.quality,
    editorReady: s.editorReady && !isMobile && !opts?.original,
    start: null,
    end: null,
    stems: null,
    clips: [],
    joinClips: false,
    subs: subsForRequest,
    thumbnail: s.wantThumb,
    infoFile: s.wantInfo,
    stills: stills !== "off" && !isMobile && s.kind === "video" ? stills : null,
    original: !!opts?.original,
  });

  /** قائمة تشغيل: عملية تنزيل لكل عنصر محدَّد (Rust يشغّل 3 معًا والباقي ينتظر) */
  async function startPlaylist(list: PlaylistEntry[], folder: string, at?: number) {
    let firstError: AppError | null = null;
    for (const i of [...selected].sort((a, b) => a - b)) {
      const e = list[i];
      if (!e) continue;
      const removeHere = stemsOn && (stemsScope === "all" || picked.has(i));
      try {
        await props.onStart(
          { ...base(e.url, { original }), stems: removeHere ? (stems as "voice" | "music") : null, subdir: folder },
          { title: e.title, thumbnail: e.thumbnail },
          at,
        );
      } catch (err) {
        firstError ??= asAppError(err);
      }
    }
    if (firstError) throw firstError;
  }

  async function start() {
    const clean = url.trim();
    if (starting || (!multiLinks && !isHttpUrl(clean))) return;
    if (entries && selected.size === 0) return;
    setStarting(true);
    setStartError(null);
    const at = scheduledAt();
    try {
      if (multiLinks) {
        // عدة روابط: كل رابط عملية مستقلة بنفس الخيارات (العنوان يظهر حين يبدأ)
        let firstError: AppError | null = null;
        for (const u of urls) {
          try {
            await props.onStart({ ...base(u), stems: stemsOn ? (stems as "voice" | "music") : null }, { title: u }, at);
          } catch (e) {
            firstError ??= asAppError(e);
          }
        }
        if (firstError) throw firstError;
      } else if (entries && info) {
        await startPlaylist(entries, info.title, at);
      } else {
        await props.onStart(
          {
            ...base(clean, { original }),
            start: isPartial ? single!.start : null,
            end: isPartial ? single!.end : null,
            stems: stemsOn ? (stems as "voice" | "music") : null,
            clips: multi ? activeClips!.map((c) => [c.start, c.end] as [number, number]) : [],
            joinClips: willJoin,
            timeline: multi && !willJoin && !isMobile && s.kind === "video" && timeline,
          },
          { title: info?.title ?? clean, thumbnail: info?.thumbnail },
          at,
        );
      }
      setUrl("");
      setAutoPasted(false);
      setTrimOn(false);
    } catch (e) {
      setStartError(asAppError(e));
    } finally {
      setStarting(false);
    }
  }

  const qualityLabel = (q: string) => (q === "best" ? t.best : q === "2160" ? "4K" : `${q}p`);
  const qualityHint =
    s.kind !== "video"
      ? null
      : maxHeight && s.quality !== "best" && Number(s.quality) > maxHeight
        ? t.qualityAboveMax(maxHeight)
        : s.editorReady && (s.quality === "best" || Number(s.quality) > 1080) && (maxHeight ?? 2160) > 1080
          ? t.qualityNeedsConvert
          : null;
  const canStart = (multiLinks || isHttpUrl(url)) && !starting && !(entries && selected.size === 0);
  const startCount = multiLinks ? urls.length : entries ? selected.size : 0;

  return (
    <div className="card download-card">
      <div className="card-head">
        <h2>{t.pasteTitle}</h2>
        <p className="faint">{t.pasteSub}</p>
      </div>

      {props.clipUrl && props.clipUrl !== url.trim() && (
        <div className="clip-banner" role="status">
          <Icon name="link" size={16} />
          <span className="clip-banner-text">
            <b>{t.clipboardBanner}</b>
            <span className="ltr">{props.clipUrl}</span>
          </span>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              setUrl(props.clipUrl!);
              props.onClipDone();
            }}
          >
            {t.useLink}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={props.onClipDone}>{t.dismiss}</button>
        </div>
      )}

      <div className={`url-field ${probe.status === "error" || startError ? "has-error" : ""}`}>
        <Icon name="link" size={20} />
        <input
          ref={input}
          className="url-input ltr"
          placeholder={t.urlPlaceholder}
          value={url}
          spellCheck={false}
          autoFocus
          onChange={(e) => {
            setUrl(e.target.value);
            setAutoPasted(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && start()}
          aria-label={t.urlAria}
        />
        {url ? (
          <button
            className="url-action"
            onClick={() => {
              setUrl("");
              setAutoPasted(false);
              input.current?.focus();
            }}
            title={t.remove}
            aria-label={t.remove}
          >
            <Icon name="x" size={18} />
          </button>
        ) : (
          <button className="url-action paste" onClick={paste} title={t.pasteTooltip}>
            <Icon name="paste" size={18} /> <span>{t.paste}</span>
          </button>
        )}
      </div>
      {autoPasted && url && <div className="faint url-note"><Icon name="check" size={14} /> {t.autoPasted}</div>}

      {probe.status === "error" && !multiLinks && <ErrorBox error={probe.error} inline onFix={fix} />}

      {multiLinks && (
        <div className="link-list">
          <div className="faint">{t.multiLinks(urls.length)}</div>
          {urls.map((u) => (
            <div className="link-item" key={u}>
              <Icon name="link" size={14} />
              <span className="ltr">{u}</span>
              <button
                className="icon-btn sm"
                aria-label={t.removeLink}
                title={t.removeLink}
                onClick={() => setUrl(urls.filter((x) => x !== u).join(" "))}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {probe.status === "loading" && !multiLinks && (
        <div className="preview" aria-busy="true">
          <div className="thumb skeleton" />
          <div style={{ flex: 1, display: "grid", gap: 8 }}>
            <div className="skeleton" style={{ height: 14, width: "70%" }} />
            <div className="skeleton" style={{ height: 12, width: "40%" }} />
          </div>
        </div>
      )}

      {info && (
        <div className="preview">
          {info.thumbnail ? <img className="thumb" src={info.thumbnail} alt="" /> : <div className="thumb" />}
          <div className="preview-body">
            <div className="preview-title">{info.title}</div>
            <div className="faint">
              {(entries
                ? [t.plItems(entries.length), info.uploader, info.site]
                : [info.uploader, formatDuration(info.duration), info.site, maxHeight ? t.upTo(maxHeight) : null]
              )
                .filter(Boolean)
                .join(" · ")}
            </div>
            {info.thumbnail && !entries && (
              <button className="btn btn-sm btn-ghost preview-action" onClick={saveThumb} disabled={savingThumb}>
                <Icon name="image" size={14} /> {t.saveThumb}
              </button>
            )}
          </div>
        </div>
      )}

      {entries && info?.site === "Spotify" && (
        <div className="alert info">
          <Icon name="music" size={16} />
          <span>{t.spotifyHint}</span>
        </div>
      )}
      {original && (
        <div className="alert info">
          <Icon name="file" size={16} />
          <span>{t.driveHint}</span>
        </div>
      )}

      {entries && (
        <PlaylistPanel
          entries={entries}
          selected={selected}
          onSelected={setSelected}
          pickLabel={stemsOn && stemsScope === "pick" ? stemsLabel : null}
          picked={picked}
          onPicked={setPicked}
        />
      )}

      <div className={`options-wrap ${ready ? "" : "dim"}`}>
        {!original && (
          <div className="options">
            <div>
              <span className="field-label">{t.kind}</span>
              <Segmented<Kind>
                label={t.kind}
                value={s.kind}
                onChange={(kind) => update({ kind })}
                options={[
                  { value: "video", label: <><Icon name="film" size={16} /> {t.video}</> },
                  { value: "audio", label: <><Icon name="music" size={16} /> {t.audio}</> },
                ]}
              />
            </div>

            <div>
              <span className="field-label">{t.format}</span>
              <SlideSwitch id={s.kind} index={s.kind === "video" ? 0 : 1} distance={28}>
                {s.kind === "video" ? (
                  <Segmented<VideoFormat>
                    label={t.format}
                    value={s.videoFormat}
                    onChange={(videoFormat) => update({ videoFormat })}
                    options={[
                      { value: "mp4", label: "MP4" },
                      { value: "mov", label: "MOV" },
                    ]}
                  />
                ) : (
                  <Segmented<AudioFormat>
                    label={t.format}
                    value={s.audioFormat}
                    onChange={(audioFormat) => update({ audioFormat })}
                    options={[
                      { value: "mp3", label: "MP3" },
                      { value: "m4a", label: "AAC", title: t.aacTooltip },
                      { value: "wav", label: "WAV" },
                    ]}
                  />
                )}
              </SlideSwitch>
            </div>

            <div className="collapse slide-x" data-open={s.kind === "video"} aria-hidden={s.kind !== "video" || undefined}>
              <div>
                <div className="video-only">
                  <div>
                    <span className="field-label">{t.quality}</span>
                    <Segmented<string>
                      label={t.quality}
                      value={s.quality}
                      onChange={(quality) => update({ quality })}
                      options={QUALITIES.map((q) => ({
                        value: q,
                        label: qualityLabel(q),
                        // بعد جلب معلومات الرابط: نعطّل الدقات الأعلى من المتاح
                        disabled: q !== "best" && maxHeight != null && Number(q) > maxHeight && s.quality !== q,
                      }))}
                    />
                    {qualityHint && <div className="faint" style={{ marginTop: 6 }}>{qualityHint}</div>}
                  </div>
                  {!isMobile && (
                    <div>
                      <Toggle checked={s.editorReady} onChange={(editorReady) => update({ editorReady })} title={t.editorReady} hint={t.editorReadyHint} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {info && !entries && (
          <div className="trim-box">
            <Toggle checked={trimOn && !info.isLive} onChange={setTrimOn} title={t.trimToggle} hint={info.isLive ? t.trimLive : t.trimHint} />
            <div className="collapse" data-open={!!activeClips}>
              <div>
                {activeClips && info.previewUrl && (
                  <video
                    ref={video}
                    className="trim-video"
                    src={info.previewUrl}
                    poster={info.thumbnail ?? undefined}
                    controls
                    preload="metadata"
                    aria-label={t.previewLabel}
                  />
                )}
                {duration &&
                  (activeClips ?? [{ start: 0, end: duration }]).map((c, i) => (
                    <div className="clip" key={i}>
                      {multi && (
                        <div className="clip-head">
                          <span className="clip-name">{t.clipN(i + 1)}</span>
                          <button className="btn btn-sm btn-ghost" onClick={() => removeClip(i)} title={t.removeClip} aria-label={t.removeClip}>
                            <Icon name="trash" size={16} />
                          </button>
                        </div>
                      )}
                      <TrimRange duration={duration} value={c} onChange={(r) => setClip(i, r)} preview={preview} />
                    </div>
                  ))}
                {duration && (
                  <div className="clips-footer">
                    <button className="btn btn-sm" onClick={addClip}>
                      <Icon name="plus" size={16} /> {t.addClip}
                    </button>
                    {multi && !isMobile && (
                      <div className="clips-output">
                        <span className="field-label">{t.clipsOutput}</span>
                        <Segmented<"join" | "separate">
                          label={t.clipsOutput}
                          value={joinClips ? "join" : "separate"}
                          onChange={(v) => setJoinClips(v === "join")}
                          options={[
                            { value: "join", label: t.clipsJoin },
                            { value: "separate", label: t.clipsSeparate },
                          ]}
                        />
                      </div>
                    )}
                  </div>
                )}
                {multi && (
                  <div className="faint" style={{ marginTop: 8 }}>
                    {willJoin ? t.clipsJoinHint(activeClips!.length) : t.clipsSeparateHint(activeClips!.length)}
                  </div>
                )}
                {multi && !willJoin && !isMobile && s.kind === "video" && (
                  <div style={{ marginTop: 12 }}>
                    <Toggle checked={timeline} onChange={setTimeline} title={t.timelineToggle} hint={t.timelineHint} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---------- إضافات: ترجمة، صورة، معلومات المصدر، لقطات ---------- */}
        <details className="extras" open={s.wantSubs || s.wantThumb || s.wantInfo || stills !== "off" || undefined}>
          <summary>
            <Icon name="layers" size={16} /> {t.extrasLabel}
            <span className="extras-count">
              {[s.wantSubs && "SRT", s.wantThumb && "JPG", s.wantInfo && "TXT", stills !== "off" && t.stillsLabel].filter(Boolean).join(" · ")}
            </span>
            <Icon name="chevron" size={16} />
          </summary>
          <div className="extras-grid">
            <div>
              <Toggle checked={s.wantSubs} onChange={(wantSubs) => update({ wantSubs })} title={t.subsToggle} hint={t.subsHint} />
              {s.wantSubs && info && !entries && (
                <div className="chips">
                  {available.length === 0 && <span className="faint">{t.subsNone}</span>}
                  {available.map((l) => {
                    const on = chosenSubs.length ? chosenSubs.includes(l.code) : l === available[0];
                    return (
                      <button key={l.code} className="chip-btn" aria-pressed={on} onClick={() => toggleLang(l.code)}>
                        {l.name}
                        {l.auto && <small>{t.subsAuto}</small>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <Toggle checked={s.wantThumb} onChange={(wantThumb) => update({ wantThumb })} title={t.thumbToggle} hint={t.thumbHint} />
            <Toggle checked={s.wantInfo} onChange={(wantInfo) => update({ wantInfo })} title={t.infoToggle} hint={t.infoHint} />
            {!isMobile && s.kind === "video" && !original && (
              <div>
                <span className="field-label">{t.stillsLabel}</span>
                <Segmented<Stills>
                  label={t.stillsLabel}
                  value={stills}
                  onChange={setStills}
                  options={[
                    { value: "off", label: t.stillsOff },
                    { value: "5", label: t.stillsEvery(5) },
                    { value: "10", label: t.stillsEvery(10) },
                    { value: "scene", label: t.stillsScenes },
                  ]}
                />
                {stills !== "off" && <div className="faint" style={{ marginTop: 6 }}>{t.stillsHint}</div>}
              </div>
            )}
          </div>
        </details>

        {!isMobile && !original && (
          <div className="stems-row">
            <span className="field-label">{t.stemsLabel}</span>
            <Segmented<"off" | "voice" | "music">
              label={t.stemsLabel}
              value={stems}
              onChange={setStems}
              options={[
                { value: "off", label: t.stemsOff },
                { value: "voice", label: t.stemsVoice },
                { value: "music", label: t.stemsMusic },
              ]}
            />
            <div className="collapse" data-open={stems !== "off"}>
              <div>
                {entries && (
                  <div className="stems-scope">
                    <span className="field-label">{t.stemsApplyTo}</span>
                    <Segmented<"all" | "pick">
                      label={t.stemsApplyTo}
                      value={stemsScope}
                      onChange={setStemsScope}
                      options={[
                        { value: "all", label: t.stemsApplyAll },
                        { value: "pick", label: t.stemsApplyPick },
                      ]}
                    />
                    <div className="faint" style={{ marginTop: 6 }}>
                      {stemsScope === "pick" ? t.stemsPickHint(stemsCount, selected.size, stemsLabel) : t.stemsAllHint(stemsCount)}
                    </div>
                  </div>
                )}
                <div className="faint" style={{ marginTop: 6 }}>{t.stemsHint}</div>
              </div>
            </div>
          </div>
        )}

        <div className="schedule-row">
          <span className="field-label">{t.startLabel}</span>
          <div className="schedule-controls">
            <Segmented<"now" | "later">
              label={t.startLabel}
              value={when}
              onChange={setWhen}
              options={[
                { value: "now", label: t.startNow },
                { value: "later", label: <><Icon name="clock" size={14} /> {t.startLater}</> },
              ]}
            />
            {when === "later" && (
              <input className="input time-input ltr" type="time" value={atTime} onChange={(e) => setAtTime(e.target.value)} aria-label={t.startLater} />
            )}
          </div>
          {when === "later" && <div className="faint" style={{ marginTop: 6 }}>{t.scheduleHint(atTime)}</div>}
        </div>
      </div>

      {startError && <ErrorBox error={startError} inline onFix={fix} />}

      <div className="action-row">
        {!isMobile && s.projects.length > 0 && (
          <label className="project-pick" title={t.project}>
            <Icon name="layers" size={16} />
            <select
              className="select select-sm"
              value={s.activeProject ?? ""}
              aria-label={t.project}
              onChange={(e) => {
                const p = s.projects.find((x) => x.name === e.target.value);
                if (!p) return update({ activeProject: null });
                update({
                  activeProject: p.name,
                  outputDir: p.outputDir,
                  kind: p.kind,
                  videoFormat: p.videoFormat,
                  audioFormat: p.audioFormat,
                  quality: p.quality,
                  editorReady: p.editorReady,
                  filenameTemplate: p.filenameTemplate,
                  siteFolders: p.siteFolders,
                });
                props.toast(t.toastProject(p.name));
              }}
            >
              <option value="">{t.noProject}</option>
              {s.projects.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
        {isMobile ? (
          <div className="save-to">
            <Icon name="folder" size={16} />
            <span className="path ltr">{MOBILE_SAVE_DIR}</span>
          </div>
        ) : (
          <FolderPicker current={props.outputDir} recent={s.recentDirs} onPick={props.onPickDir} onChoose={props.onChooseDir} />
        )}
        <span className="spacer" />
        <button className="btn btn-primary btn-lg download-btn" disabled={!canStart} onClick={start}>
          <Icon name={when === "later" ? "clock" : "download"} />
          {startCount ? t.downloadN(startCount) : t.download}
        </button>
      </div>
    </div>
  );
}
