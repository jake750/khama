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
import { planDownloads, type EntryClips, RATES, scheduledAt, type Stills } from "../downloadPlan";
import { numLocale, useI18n } from "../i18n";
import { ErrorBox, type ErrorFix } from "./ErrorBox";
import { Icon } from "./Icon";
import { Segmented, Toggle } from "./Segmented";
import { SlideSwitch } from "../motion";
import { isMobile, mobileSaveDir } from "../platform";
import { logError } from "../log";
import { convertMinutes, estimateDownload } from "../estimate";
import type { Range } from "./TrimRange";
import { ClipEditor } from "./ClipEditor";
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
/** الرابط الواحد في الحقل مكتملًا: «www.youtube.com/…» المكتوب بيده يُفحص كالملصوق (R2-39) */
function singleUrl(text: string): string {
  const found = extractUrls(text);
  return found.length === 1 ? found[0] : text.trim();
}

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
  onStart: (req: DownloadRequest, meta: StartMeta, at?: number) => Promise<unknown>;
  /** رابط نسخه المستخدم وخامة تراقب الحافظة */
  clipUrl: string | null;
  onClipDone: () => void;
  /** رابط من خارج الشاشة (السجلّ: «نزّله مرة أخرى») */
  inject: { url: string; n: number } | null;
  onOpenSettings: (section: string) => void;
  toast: Toast;
  session: DownloadSession;
  /** تحليل المواضيع قبل التنزيل (ترجمة الموقع أو الصوت وحده). range = المقطع المحدد إن وُجد */
  onAnalyze?: (url: string, title: string, thumbnail?: string | null, range?: [number, number] | null) => void;
}) {
  const { t, lang } = useI18n();
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
  // مقاطع عناصر القائمة التي قُصّت (رقم العنصر ← مقاطعه)
  const [entryClips, setEntryClips] = useState<Map<number, EntryClips>>(new Map());
  const [when, setWhen] = useState<When>("now");
  const [atTime, setAtTime] = useState(() => {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  });
  const [atDay, setAtDay] = useState(0);
  const [savingThumb, setSavingThumb] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const urls = useMemo(() => extractUrls(url), [url]);
  const multiLinks = urls.length > 1;

  // عند تغيّر الرابط: ننتظر نصف ثانية (حتى ينتهي اللصق/الكتابة) ثم نجلب معلوماته.
  // probeToken يمنع ردًّا قديمًا من الكتابة فوق رد أحدث.
  useEffect(() => {
    const clean = singleUrl(url);
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
      setEntryClips(new Map());
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
          setEntryClips(new Map());
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
      // e.code: مع لوحة المفاتيح العربية يكون الحرف «ر» لا «v»
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyV") {
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
    const clean = singleUrl(url);
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
      entryClips,
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
    setEntryClips(new Map());
    setWhen("now");
  }

  const clearUrl = () => {
    setUrl("");
    setStartedUrl(null);
    input.current?.focus();
  };

  const formatNote =
    s.kind === "video"
      ? s.videoFormat === "mov"
        ? t.movTooltip
        : null
      : (({ mp3: t.mp3Note, m4a: t.aacTooltip, wav: t.wavNote, original: t.audioOriginalTooltip } as Record<string, string>)[
          s.audioFormat
        ] ?? null);
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
  const canStart = (multiLinks || isHttpUrl(singleUrl(url))) && !starting && !(entries && selected.size === 0);
  // اقتراح واحد فقط: من مراقبة الحافظة أو مما وجدناه عند الرجوع للنافذة (U-82)
  const clipSuggest = [props.clipUrl, clipFound].find((c) => c && c !== url.trim()) ?? null;

  // الحجم المتوقّع والمساحة الحرة (U-36، U-37، T-96)
  const clipFraction = activeClips && duration ? activeClips.reduce((n, c) => n + (c.end - c.start), 0) / duration : 1;
  const expected = info && !entries && !original ? estimateDownload(info, s.kind, effQuality, clipFraction) : null;
  const hasEstimate = expected != null;
  useEffect(() => {
    if (isMobile || !hasEstimate) return;
    let alive = true;
    api
      .freeSpace(props.outputDir)
      .then((f) => alive && setFree(f))
      .catch(() => alive && setFree(null));
    return () => {
      alive = false;
    };
    // المساحة لا تتغيّر مع كل خطوة من سحب حدّي القص: نسأل حين يظهر تقدير أو يتغيّر المجلد فقط
  }, [props.outputDir, hasEstimate]);
  const noRoom = expected != null && free != null && expected > free;
  const startCount = multiLinks ? urls.length : entries ? selected.size : 0;

  // ملخّص الإعداد الحالي: يظهر على سطر «الصيغة والجودة» المطويّ وعلى زر التنزيل،
  // فيعرف المستخدم ما سيحصل عليه دون أن يفتح الخيارات
  const formatName = s.kind === "video" ? s.videoFormat.toUpperCase() : s.audioFormat === "m4a" ? "AAC" : s.audioFormat.toUpperCase();
  const optionsSummary = // الدقة الفعلية لهذا الرابط لا المحفوظة: حين لا يوفّر الفيديو 1440 يُنزَّل 1080 ويُكتب 1080 (R2-3)
    (s.kind === "video" ? [t.video, formatName, qualityLabel(effQuality), s.editorReady && t.editorReady] : [t.audio, formatName])
      .filter(Boolean)
      .join(" · ");
  // موعد لغير اليوم: اليوم مع الساعة على الزر، لا الساعة وحدها (R2-41)
  const laterAt = when === "later" ? scheduledAt(when, atTime, new Date(), atDay) : null;
  const laterLabel =
    laterAt && new Date(laterAt).toDateString() !== new Date().toDateString()
      ? `${new Date(laterAt).toLocaleDateString(numLocale(lang), { weekday: "short" })} ${atTime}`
      : atTime;
  const buttonMeta = original
    ? null
    : [formatName, s.kind === "video" && qualityLabel(effQuality), when === "later" && laterLabel].filter(Boolean).join(" · ");

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
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.ctrlKey && (multiLinks || probe.status === "ok")) start();
              // Esc يمسح الرابط (R2-48)
              else if (e.key === "Escape" && url) {
                e.preventDefault();
                clearUrl();
              }
            }}
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
        <div className="alert warn" role="alert">
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
                  <img className="link-thumb" src={info.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" decoding="async" />
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
            {/* بشكل المعاينة الحقيقية: عنوان ثم شارات (D-52) */}
            <div className="meta-tags">
              <span className="skeleton skeleton-tag" />
              <span className="skeleton skeleton-tag" />
              <span className="skeleton skeleton-tag" />
            </div>
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
          {info.thumbnail ? (
            <img
              className="thumb"
              src={info.thumbnail}
              alt=""
              referrerPolicy="no-referrer"
              decoding="async"
              // صورة محجوبة أو منتهية: مربع فارغ بدل أيقونة صورة مكسورة (R2-54)
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <div className="thumb" />
          )}
          <div className="preview-body">
            <div className="preview-title selectable" dir="auto">
              {info.title}
            </div>
            {/* شارات منفصلة بدل سطر واحد بنقاط فاصلة (D-74) */}
            <div className="meta-tags">
              {(entries
                ? [t.plItems(entries.length), info.uploader, info.site]
                : [info.uploader, formatDuration(info.duration), info.site, maxHeight ? t.upTo(maxHeight) : null]
              )
                .filter(Boolean)
                .map((x, i) => (
                  <span key={i} className="meta-tag" dir="auto">
                    {x}
                  </span>
                ))}
            </div>
            {info.thumbnail && !entries && (
              <button className="btn btn-sm preview-action" onClick={saveThumb} disabled={savingThumb}>
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
          clips={entryClips}
          onClips={(i, v) =>
            setEntryClips((m) => {
              const next = new Map(m);
              if (v) next.set(i, v);
              else next.delete(i);
              return next;
            })
          }
        />
      )}
      {/* أين تذهب العناصر (F-56) */}
      {entries && info?.title && <div className="faint mt-2">{t.plFolderNote(info.title)}</div>}

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
                        { value: "mp4", label: "MP4", title: t.mp4Tooltip },
                        { value: "mov", label: "MOV", title: t.movTooltip },
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
                {/* الشرح ظاهرًا لا في title فقط، فالهاتف لا يعرض title (F-24، F-25) */}
                {formatNote && <div className="faint mt-2">{formatNote}</div>}
              </div>

              <div className="collapse slide-x" data-open={s.kind === "video"} inert={!(s.kind === "video") || undefined}>
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
                          title: q === "best" ? t.bestTooltip : undefined,
                          // بعد جلب معلومات الرابط: نعطّل الدقات الأعلى من المتاح
                          disabled: q !== "best" && maxHeight != null && Number(q) > maxHeight,
                        }))}
                      />
                      {qualityHint && <div className={`mt-2 ${fellBack || needsConvert ? "warn-text" : "muted"}`}>{qualityHint}</div>}
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
        {qualityHint && !original && <div className={`quality-hint ${needsConvert ? "warn-text" : "muted"}`}>{qualityHint}</div>}

        {info && !entries && <h3 className="form-section">{t.secPart}</h3>}
        {info && !entries && (
          <div className="trim-box">
            <Toggle
              checked={trimOn && !info.isLive}
              onChange={setTrimOn}
              title={t.trimToggle}
              hint={info.isLive ? `${t.trimLive} ${t.liveNote}` : t.trimHint}
            />
            <div className="collapse" data-open={!!activeClips} inert={!activeClips || undefined}>
              <div>
                {activeClips && duration && (
                  <ClipEditor
                    duration={duration}
                    clips={activeClips}
                    onClips={setClips}
                    join={joinClips}
                    onJoin={setJoinClips}
                    previewUrl={info.previewUrl}
                    poster={info.thumbnail}
                  />
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
        {isMobile ? (
          <div className="save-to">
            <Icon name="folder" size={16} />
            <span className="path ltr">{mobileSaveDir(s)}</span>
          </div>
        ) : (
          <FolderPicker
            current={props.outputDir}
            recent={s.recentDirs}
            onPick={props.onPickDir}
            onChoose={props.onChooseDir}
            onForget={(d) => update({ recentDirs: s.recentDirs.filter((x) => x !== d) })}
            sub={
              [s.kindFolders && (s.kind === "audio" ? "Audio" : "Video"), s.siteFolders && (info?.site ?? t.siteFolderAny)]
                .filter(Boolean)
                .join("/") || null
            }
          />
        )}
        {/* بعد منتقي المجلد: ظهوره مع أول مشروع لا يُزيح المجلد من مكانه (D-77) */}
        <ProjectPicker settings={s} update={update} toast={props.toast} />
        <span className="spacer" />
        {expected != null && (
          <span className="estimate ltr-num" title={t.estimateHint}>
            {t.estimate(formatBytes(t, expected))}
          </span>
        )}
        {/* رابط فيديو واحد: تحليل مواضيعه قبل تنزيله، بلا تنزيل الفيديو */}
        {props.onAnalyze && info && duration && (
          <button
            className="btn btn-lg"
            onClick={() =>
              props.onAnalyze!(
                urls[0] ?? url.trim(),
                info.title,
                info.thumbnail,
                activeClips?.length === 1 ? [activeClips[0].start, activeClips[0].end] : null,
              )
            }
            title={t.analyzeVideoHint}
          >
            <Icon name="captions" /> {t.analyzeVideo}
          </button>
        )}
        <button className="btn btn-primary btn-lg download-btn" data-primary disabled={!canStart} onClick={start}>
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
