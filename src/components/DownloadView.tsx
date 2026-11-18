import { readText } from "@tauri-apps/plugin-clipboard-manager";
import type { Toast } from "../toast";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  asAppError,
  type AppError,
  type AudioFormat,
  type DownloadRequest,
  type Kind,
  type ProbeInfo,
  type Settings,
  type VideoFormat,
} from "../api";
import { extractUrls, formatBytes, formatDuration, isHttpUrl } from "../format";
import { limiter } from "../limit";
import { nextClip, planDownloads, RATES, scheduledAt, type Stills } from "../downloadPlan";
import { useI18n } from "../i18n";
import { ErrorBox, type ErrorFix } from "./ErrorBox";
import { Icon } from "./Icon";
import { Segmented, Toggle } from "./Segmented";
import { SlideSwitch } from "../motion";
import { isMobile, MOBILE_SAVE_DIR } from "../platform";
import { logError } from "../log";
import { convertMinutes, estimateDownload } from "../estimate";
import { TrimRange, type PreviewLink, type Range } from "./TrimRange";
import { PlaylistPanel } from "./PlaylistPanel";
import { FolderPicker } from "./FolderPicker";
import { ExtrasPanel } from "./download/ExtrasPanel";
import { ProjectPicker } from "./download/ProjectPicker";
import { ScheduleRow, type When } from "./download/ScheduleRow";
import { StemsRow } from "./download/StemsRow";

const QUALITIES = ["best", "2160", "1440", "1080", "720", "480"] as const;

type ProbeState = { status: "idle" } | { status: "loading" } | { status: "ok"; info: ProbeInfo } | { status: "error"; error: AppError };

/**
 * ما يجب أن يبقى عند الانتقال لتبويب آخر والعودة (الشاشة تُبنى من جديد).
 * يملكه App (useRef) ويمرّره صراحة، بدل متغيرات عامة في الوحدة (T-12).
 */
export interface DownloadSession {
  /** النص في حقل الرابط */
  draftUrl: string;
  /** آخر معاينة، لعرضها فورًا عند العودة لنفس الرابط */
  lastProbe: { url: string; info: ProbeInfo } | null;
  /** آخر رابط من السجلّ عولج (لا يعود بعد الانتقال بين التبويبات) */
  lastInject: number;
  /** آخر رابط لُصق تلقائيًا من الحافظة: لا نلصقه مرة ثانية بعد أن يمسحه المستخدم */
  lastAutoPasted: string;
  /** معاينة كل رابط في دفعة عدة روابط (U-65، U-94) */
  links: Map<string, ProbeInfo | "loading" | "error">;
}

export const newDownloadSession = (): DownloadSession => ({
  draftUrl: "",
  lastProbe: null,
  lastInject: 0,
  lastAutoPasted: "",
  links: new Map(),
});

/** معاينات الدفعة: اثنتان في كل مرة، فعشرة روابط لا تشغّل عشر عمليات Python معًا */
const linkTurn = limiter(2);
const BATCH_PREVIEW = 10;

export interface StartMeta {
  title: string;
  thumbnail?: string | null;
  /** إعادة محاولة: خطأ المحاولة السابقة يبقى ظاهرًا (U-61) */
  lastError?: AppError;
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
  toast: Toast;
  session: DownloadSession;
}) {
  const { t } = useI18n();
  const { settings: s, update, session } = props;
  const [url, setUrl] = useState(() => session.draftUrl);
  useEffect(() => {
    session.draftUrl = url;
  }, [session, url]);
  // رابط في الحافظة وجدناه عند الرجوع للنافذة: اقتراح بزر، لا لصق مباشر (U-5، U-8)
  const [clipFound, setClipFound] = useState<string | null>(null);
  // آخر رابط بدأ تنزيله: يبقى في الحقل مع سطر «أُضيف للقائمة» (U-10)
  const [startedUrl, setStartedUrl] = useState<string | null>(null);
  const [free, setFree] = useState<number | null>(null);
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
  const [when, setWhen] = useState<When>("now");
  const [atTime, setAtTime] = useState(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  });
  const [atDay, setAtDay] = useState(0);
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
    // نفس الرابط الذي عاينّاه قبل الانتقال لتبويب آخر: نعرضه فورًا بلا انتظار
    if (session.lastProbe?.url === clean && reprobe === 0) {
      const info = session.lastProbe.info;
      setSelected(new Set(info.entries?.map((_, i) => i) ?? []));
      setPicked(new Set());
      setProbe({ status: "ok", info });
      return;
    }
    const timer = setTimeout(async () => {
      setProbe({ status: "loading" });
      try {
        const info = await api.probe(clean, { replace: true });
        session.lastProbe = { url: clean, info };
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
  }, [session, url, reprobe]);

  // عدة روابط: نقرأ عنوان كل واحد وصورته (أول 10) بدل عرض الروابط نفسها (U-65، U-94)
  const [, bumpLinks] = useState(0);
  useEffect(() => {
    if (!multiLinks) return;
    for (const u of urls.slice(0, BATCH_PREVIEW)) {
      if (session.links.has(u)) continue;
      session.links.set(u, "loading");
      linkTurn(() => api.probe(u))
        .then((info) => session.links.set(u, info))
        .catch(() => session.links.set(u, "error"))
        .finally(() => bumpLinks((n) => n + 1));
    }
  }, [multiLinks, urls, session]);

  // ثوانٍ منذ بدء قراءة الرابط (U-77)
  const [probeSecs, setProbeSecs] = useState(0);
  useEffect(() => {
    if (probe.status !== "loading") return;
    const started = Date.now();
    const timer = setInterval(() => setProbeSecs(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => {
      clearInterval(timer);
      setProbeSecs(0);
    };
  }, [probe.status]);
  const cancelProbe = () => {
    probeToken.current++;
    setProbe({ status: "idle" });
    api.cancelProbe().catch(logError("cancelProbe"));
  };

  // رابط من السجلّ
  useEffect(() => {
    // نتجاهل رابطًا عالجناه من قبل (لا يعود بعد الانتقال بين التبويبات)
    if (props.inject && props.inject.n !== session.lastInject) {
      session.lastInject = props.inject.n;
      setUrl(props.inject.url);
    }
  }, [session, props.inject]);

  /** يقرأ أول رابط في الحافظة (عبر Tauri: يعمل على الكمبيوتر والهاتف) */
  async function clipboardUrl(): Promise<string | null> {
    try {
      return extractUrls(await readText()).join(" ") || null;
    } catch {
      return null;
    }
  }

  // اقتراح من الحافظة: عند فتح خامة أو الرجوع إليها، إن كان الحقل فارغًا وفي الحافظة رابط جديد
  const urlRef = useRef(url);
  urlRef.current = url;
  useEffect(() => {
    const check = async () => {
      if (urlRef.current.trim()) return;
      const found = await clipboardUrl();
      if (found && found !== session.lastAutoPasted && !urlRef.current.trim()) {
        session.lastAutoPasted = found;
        setClipFound(found);
      }
    };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [session]);

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
  const stemsOn = stems !== "off";
  const stemsLabel = stems === "music" ? t.stemsMusic : t.stemsVoice;
  // العناصر المحدَّدة التي ستُزال منها الموسيقى
  const stemsCount = !entries || !stemsOn ? 0 : stemsScope === "all" ? selected.size : [...picked].filter((i) => selected.has(i)).length;
  const multi = !!activeClips && activeClips.length > 1;
  // الدمج يحتاج ffmpeg على الكمبيوتر؛ على الهاتف تُحفظ المقاطع ملفات منفصلة
  const willJoin = multi && joinClips;
  const original = !!info?.original;
  const ready = !!info || multiLinks;

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
    setClips([...activeClips, nextClip(duration, activeClips, preview?.now())]);
  }

  async function paste() {
    const found = await clipboardUrl();
    if (found) {
      setUrl(found);
      return;
    }
    try {
      const text = await readText();
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
      const path = await api.saveThumbnail(url.trim());
      props.toast(
        t.toastThumbSaved,
        isMobile ? undefined : { label: t.show, run: () => api.revealFile(path).catch(logError("revealFile")) },
      );
    } catch (e) {
      setStartError(asAppError(e));
    } finally {
      setSavingThumb(false);
    }
  }

  async function start() {
    const clean = url.trim();
    if (starting || (!multiLinks && !isHttpUrl(clean))) return;
    if (entries && selected.size === 0) return;
    setStarting(true);
    setStartError(null);
    const at = scheduledAt(when, atTime, new Date(), atDay);
    const plan = planDownloads({
      settings: { ...s, quality: effQuality },
      urls: multiLinks ? urls : [clean],
      info,
      stills,
      stems,
      selected,
      stemsScope,
      picked,
      clips: activeClips,
      joinClips,
      timeline,
      canTimeline: !isMobile,
    });
    // كل طلب يُرسل حتى لو فشل غيره؛ نعرض أول خطأ
    let firstError: AppError | null = null;
    for (const d of plan) {
      try {
        await props.onStart(d.request, { title: d.title, thumbnail: d.thumbnail }, at);
      } catch (e) {
        firstError ??= asAppError(e);
      }
    }
    setStarting(false);
    if (firstError) return setStartError(firstError);
    // الرابط يبقى في الحقل (لتنزيله بصيغة أخرى مثلًا)، مع سطر يؤكّد الإضافة وزر «امسح» (U-10)
    setStartedUrl(clean);
    // خيارات لمرة واحدة تُصفَّر بعد كل تنزيل، كما يقول سطر «إضافات» (U-9)
    setTrimOn(false);
    setStems("off");
    setStills("off");
    setWhen("now");
  }

  const clearUrl = () => {
    setUrl("");
    setStartedUrl(null);
    input.current?.focus();
  };

  const qualityLabel = (q: string) => (q === "best" ? t.best : q === "2160" ? "4K" : `${q}p`);
  // الدقة المختارة أعلى مما يوفّره الفيديو: نستعمل أقرب دقة أقل منها لهذا الرابط فقط،
  // ولا نغيّر الإعداد المحفوظ (U-13)
  const fellBack = s.kind === "video" && !!maxHeight && s.quality !== "best" && Number(s.quality) > maxHeight;
  const effQuality = fellBack ? (QUALITIES.find((q) => q !== "best" && Number(q) <= maxHeight!) ?? "best") : s.quality;
  // تحويل طويل بعد التنزيل: تنبيه واضح مع تقدير بالدقائق لا سطر باهت (U-14)
  const needsConvert =
    s.kind === "video" && s.editorReady && (s.quality === "best" || Number(s.quality) > 1080) && (maxHeight ?? 2160) > 1080;
  const convertMin = needsConvert
    ? convertMinutes(duration, Math.min(maxHeight ?? 2160, s.quality === "best" ? 4320 : Number(s.quality)))
    : null;
  const qualityHint =
    s.kind !== "video"
      ? null
      : fellBack
        ? t.qualityFellBack(qualityLabel(s.quality), qualityLabel(effQuality))
        : needsConvert
          ? t.qualityNeedsConvert + (convertMin ? " " + t.convertAbout(convertMin) : "")
          : null;
  const canStart = (multiLinks || isHttpUrl(url)) && !starting && !(entries && selected.size === 0);
  // اقتراح واحد فقط: من مراقبة الحافظة أو مما وجدناه عند الرجوع للنافذة (U-82)
  const clipSuggest = [props.clipUrl, clipFound].find((c) => c && c !== url.trim()) ?? null;

  // الحجم المتوقّع والمساحة الحرة (U-36، U-37، T-96)
  const clipFraction = activeClips && duration ? activeClips.reduce((n, c) => n + (c.end - c.start), 0) / duration : 1;
  const expected = info && !entries && !original ? estimateDownload(info, s.kind, effQuality, clipFraction) : null;
  useEffect(() => {
    if (isMobile || expected == null) return;
    let alive = true;
    api
      .freeSpace(props.outputDir)
      .then((f) => alive && setFree(f))
      .catch(() => alive && setFree(null));
    return () => {
      alive = false;
    };
  }, [props.outputDir, expected]);
  const noRoom = expected != null && free != null && expected > free;
  const startCount = multiLinks ? urls.length : entries ? selected.size : 0;

  // ملخّص الإعداد الحالي: يظهر على سطر «الصيغة والجودة» المطويّ وعلى زر التنزيل،
  // فيعرف المستخدم ما سيحصل عليه دون أن يفتح الخيارات
  const formatName = s.kind === "video" ? s.videoFormat.toUpperCase() : s.audioFormat === "m4a" ? "AAC" : s.audioFormat.toUpperCase();
  const optionsSummary = (
    s.kind === "video" ? [t.video, formatName, qualityLabel(s.quality), s.editorReady && t.editorReady] : [t.audio, formatName]
  )
    .filter(Boolean)
    .join(" · ");
  const buttonMeta = original
    ? null
    : [formatName, s.kind === "video" && qualityLabel(s.quality), when === "later" && atTime].filter(Boolean).join(" · ");

  return (
    <div className="card download-card">
      <div className="hero motif">
        <div className="card-head">
          <h2>{t.pasteTitle}</h2>
          <p className="faint">{t.pasteSub}</p>
        </div>

        {clipSuggest && (
          <div className="clip-banner" role="status">
            <Icon name="link" size={16} />
            <span className="clip-banner-text">
              <b>{t.clipboardBanner}</b>
              <span className="ltr">{clipSuggest}</span>
            </span>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                setUrl(clipSuggest);
                setStartedUrl(null);
                setClipFound(null);
                props.onClipDone();
              }}
            >
              {t.useLink}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setClipFound(null);
                props.onClipDone();
              }}
            >
              {t.dismiss}
            </button>
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
            autoFocus={!isMobile}
            onChange={(e) => {
              setUrl(e.target.value);
              setStartedUrl(null);
            }}
            // Enter يبدأ فقط بعد اكتمال المعاينة: لا تنزيل بخيارات لم يرها المستخدم بعد (U-1)
            onKeyDown={(e) => e.key === "Enter" && (multiLinks || probe.status === "ok") && start()}
            aria-label={t.urlAria}
          />
          {url ? (
            <>
              <button className="url-action" onClick={clearUrl} title={t.clearLink} aria-label={t.clearLink}>
                <Icon name="x" size={20} />
              </button>
              {/* لاستبدال الرابط بلصقة واحدة، بلا مسح أولًا (U-81) */}
              <button className="url-action" onClick={paste} title={t.pasteReplace} aria-label={t.pasteReplace}>
                <Icon name="paste" size={20} />
              </button>
            </>
          ) : (
            <button className="url-action paste" onClick={paste} title={t.pasteTooltip}>
              <Icon name="paste" size={20} /> <span>{t.paste}</span>
            </button>
          )}
        </div>
        {startedUrl && startedUrl === url.trim() && (
          <div className="url-note">
            <Icon name="check" size={16} /> <span className="grow">{t.addedToQueue}</span>
            <button className="btn btn-sm btn-ghost" onClick={clearUrl}>
              {t.clearLink}
            </button>
          </div>
        )}
      </div>

      {probe.status === "error" && !multiLinks && <ErrorBox error={probe.error} inline onFix={fix} />}
      {startError && <ErrorBox error={startError} inline onFix={fix} />}
      {noRoom && (
        <div className="alert warn">
          <Icon name="alert" size={16} />
          <span>{t.noRoom(formatBytes(t, expected!), formatBytes(t, free!))}</span>
        </div>
      )}

      {multiLinks && (
        <div className="link-list">
          <div className="faint">{t.multiLinks(urls.length)}</div>
          {urls.map((u) => {
            const li = session.links.get(u);
            const info = typeof li === "object" ? li : null;
            return (
              <div className="link-item" key={u} data-state={info ? "ok" : (li ?? "idle")}>
                {info?.thumbnail ? (
                  <img className="link-thumb" src={info.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className={`link-thumb ${li === "loading" ? "skeleton" : ""}`}>
                    <Icon name={li === "error" ? "alert" : "link"} size={16} />
                  </span>
                )}
                {info ? (
                  <span className="link-text">
                    <span className="link-title" dir="auto" title={info.title}>
                      {info.title}
                    </span>
                    <span className="faint link-meta" title={u}>
                      {[info.site, formatDuration(info.duration), info.entries && t.plItems(info.entries.length)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                ) : (
                  <span className="ltr" title={u}>
                    {u}
                  </span>
                )}
                <button
                  className="icon-btn sm"
                  aria-label={t.removeLink}
                  title={t.removeLink}
                  onClick={() => setUrl(urls.filter((x) => x !== u).join(" "))}
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {probe.status === "loading" && !multiLinks && (
        <div className="preview" aria-busy="true">
          <div className="thumb skeleton" />
          <div className="grow stack-2">
            <div className="skeleton skeleton-title" />
            {/* نص صريح وعدّاد بدل هيكل رمادي فقط (U-77)، وإلغاء لمعاينة عالقة (U-78) */}
            <div className="faint probe-wait" role="status">
              {t.probeReading}
              {probeSecs >= 3 && <span className="ltr-num"> {t.probeSecs(probeSecs)}</span>}
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={cancelProbe}>
            {t.cancel}
          </button>
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
                <Icon name="image" size={16} /> {t.saveThumb}
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

      {!ready && (
        <div className="faint options-locked">
          <Icon name="info" size={16} /> {t.pasteFirst}
        </div>
      )}
      <div className={`options-wrap ${ready ? "" : "locked"}`} inert={!ready || undefined}>
        {!original && <h3 className="form-section">{t.secFile}</h3>}
        {!original && (
          <details className="extras options-box">
            <summary>
              <Icon name="film" size={16} /> <span className="summary-label">{t.optionsLabel}</span>
              <span className="extras-count">{optionsSummary}</span>
              <Icon name="chevron" size={16} />
            </summary>
            <div className="options">
              <div>
                <span className="field-label">{t.kind}</span>
                <Segmented<Kind>
                  label={t.kind}
                  value={s.kind}
                  onChange={(kind) => update({ kind })}
                  options={[
                    {
                      value: "video",
                      label: (
                        <>
                          <Icon name="film" size={16} /> {t.video}
                        </>
                      ),
                    },
                    {
                      value: "audio",
                      label: (
                        <>
                          <Icon name="music" size={16} /> {t.audio}
                        </>
                      ),
                    },
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
                        { value: "original", label: t.audioOriginal, title: t.audioOriginalTooltip },
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
                        value={effQuality}
                        onChange={(quality) => update({ quality })}
                        options={QUALITIES.map((q) => ({
                          value: q,
                          label: qualityLabel(q),
                          // بعد جلب معلومات الرابط: نعطّل الدقات الأعلى من المتاح
                          disabled: q !== "best" && maxHeight != null && Number(q) > maxHeight,
                        }))}
                      />
                      {qualityHint && <div className={`mt-2 ${fellBack || needsConvert ? "warn-text" : "faint"}`}>{qualityHint}</div>}
                    </div>
                    {
                      <div>
                        <Toggle
                          checked={s.editorReady}
                          onChange={(editorReady) => update({ editorReady })}
                          title={t.editorReady}
                          hint={t.editorReadyHint}
                        />
                      </div>
                    }
                  </div>
                </div>
              </div>
            </div>
          </details>
        )}
        {/* التنبيه يبقى ظاهرًا حتى لو كانت الخيارات مطويّة */}
        {qualityHint && !original && <div className={`quality-hint ${needsConvert ? "warn-text" : "faint"}`}>{qualityHint}</div>}

        {info && !entries && <h3 className="form-section">{t.secPart}</h3>}
        {info && !entries && (
          <div className="trim-box">
            <Toggle
              checked={trimOn && !info.isLive}
              onChange={setTrimOn}
              title={t.trimToggle}
              hint={info.isLive ? t.trimLive : t.trimHint}
            />
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
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => removeClip(i)}
                            title={t.removeClip}
                            aria-label={t.removeClip}
                          >
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
                    {multi && (
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
                  <div className="faint mt-2">
                    {willJoin ? t.clipsJoinHint(activeClips!.length) : t.clipsSeparateHint(activeClips!.length)}
                  </div>
                )}
                {multi && !willJoin && !isMobile && s.kind === "video" && (
                  <div className="mt-3">
                    <Toggle checked={timeline} onChange={setTimeline} title={t.timelineToggle} hint={t.timelineHint} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---------- إضافات: ترجمة، صورة، معلومات المصدر، لقطات ---------- */}
        <ExtrasPanel
          settings={s}
          update={update}
          video={info && !entries ? info : null}
          original={original}
          stills={stills}
          onStills={setStills}
          more={[stems !== "off" && t.stemsShort, when === "later" && t.scheduleShort, s.rateLimitKb > 0 && t.speedLimit(s.rateLimitKb)]}
        >
          {!original && (
            <StemsRow
              stems={stems}
              onStems={setStems}
              playlist={!!entries}
              scope={stemsScope}
              onScope={setStemsScope}
              count={stemsCount}
              selected={selected.size}
            />
          )}
          <ScheduleRow when={when} onWhen={setWhen} atTime={atTime} onAtTime={setAtTime} atDay={atDay} onAtDay={setAtDay} />
          {/* حد السرعة هنا أيضًا: يُحتاج أثناء مكالمة فيديو، لا في الإعدادات (U-56) */}
          <div className="rate-row">
            <span className="field-label">{t.rateLimit}</span>
            <Segmented<string>
              label={t.rateLimit}
              value={String(s.rateLimitKb)}
              onChange={(v) => update({ rateLimitKb: Number(v) })}
              options={RATES.map((r) => ({ value: String(r), label: r ? t.speedLimit(r) : t.rateOff }))}
            />
          </div>
        </ExtrasPanel>
      </div>

      <div className="action-row">
        <ProjectPicker settings={s} update={update} toast={props.toast} />
        {isMobile ? (
          <div className="save-to">
            <Icon name="folder" size={16} />
            <span className="path ltr">{MOBILE_SAVE_DIR}</span>
          </div>
        ) : (
          <FolderPicker
            current={props.outputDir}
            recent={s.recentDirs}
            onPick={props.onPickDir}
            onChoose={props.onChooseDir}
            sub={s.siteFolders ? (info?.site ?? t.siteFolderAny) : null}
          />
        )}
        <span className="spacer" />
        {expected != null && (
          <span className="estimate ltr-num" title={t.estimateHint}>
            {t.estimate(formatBytes(t, expected))}
          </span>
        )}
        <button className="btn btn-primary btn-lg download-btn" disabled={!canStart} onClick={start}>
          <Icon name={when === "later" ? "clock" : "download"} />
          <span className="download-btn-text">
            <span>{startCount ? t.downloadN(startCount) : t.download}</span>
            {buttonMeta && <small className="ltr">{buttonMeta}</small>}
          </span>
        </button>
      </div>
    </div>
  );
}
