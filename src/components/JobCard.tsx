import { useEffect, useState, type CSSProperties } from "react";
import type { AppError, ConvertRequest, Cue, DownloadRequest, Word, JobState, JobUpdate, SilenceLevels, Topic } from "../api";
import type { Range, TopicPlan } from "../reels";
import { LevelsLine, TopicPanel, type ExportOptions } from "./TopicPanel";
import { formatDuration, formatEta, formatSpeed, formatTimecode } from "../format";
import { errorText, numLocale, useI18n, type Dict } from "../i18n";
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./Icon";
import { MoreMenu, type MenuItem } from "./MoreMenu";

/** عملية (تنزيل أو تحويل) كما تحفظها الواجهة */
export interface Job {
  id: number;
  type: "download" | "convert";
  title: string;
  /** سطر الوصف: الصيغة والجودة… */
  meta: string;
  request?: DownloadRequest;
  convert?: ConvertRequest;
  state: JobState;
  stage?: "video" | "audio" | "file" | "wait";
  percent?: number;
  speed?: number;
  eta?: number;
  file?: string;
  error?: AppError;
  /** أغنية سبوتيفاي: عنوان ما اختير لها من YouTube Music، لتُكتشف المطابقة الخاطئة (U-18) */
  source?: string;
  /** خطأ المحاولة السابقة عند «أعد» (U-61) */
  lastError?: AppError;
  markers?: [number, number][];
  /** تحليل المواضيع: المواضيع، ومن أين جاء النص */
  topics?: Topic[];
  transcript?: "subtitles" | "captions" | "speech";
  /** كشف الصمت: ما قيس في الملف */
  levels?: SilenceLevels;
  /** تحليل المواضيع: النص بأوقاته، ووقت كل كلمة */
  cues?: Cue[];
  words?: Word[];
  /** تحويل بدأ من بطاقة تنزيل (تحليل المواضيع): يظهر في قائمة التنزيلات */
  inDownloads?: boolean;
  /** صورة الفيديو (من المعاينة) */
  thumbnail?: string | null;
  /** تنزيل مجدول: وقت البدء (ms) */
  at?: number;
}

/** المجلد الذي فيه الملف، بآخر جزأين فقط ليبقى قصيرًا */
function parentDir(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).slice(0, -1);
  return parts.length > 2 ? "…" + sep + parts.slice(-2).join(sep) : parts.join(sep);
}

const MUSIC_SEARCH = "https://music.youtube.com/search?q=";

/** يدمج تحديثًا من Rust في البطاقة. العنوان من yt-dlp يحلّ محلّ الرابط فقط، لا محلّ عنوان المعاينة،
 * والصورة لا تُستبدل إن كانت موجودة (T-43). */
export function mergeUpdate(j: Job, u: JobUpdate): Job {
  const { title, thumbnail, ...rest } = u;
  return {
    ...j,
    ...rest,
    // «تنتظر دور الفصل» تزول حين يبدأ الفصل فعلًا (Rust لا يرسل stage حينها) (U-71)
    ...(u.state === "separating" && !u.stage ? { stage: undefined } : {}),
    // مرحلة جديدة: الوقت الباقي للمرحلة السابقة لا يصلح لها
    ...(u.state !== j.state && u.eta == null ? { eta: undefined } : {}),
    // ولا نسبتها وسرعتها: «تنتظر دور الفصل» بلا نسبة كانت تعرض 100% من التنزيل وشريطًا ممتلئًا
    ...(u.state !== j.state && u.percent == null ? { percent: undefined, speed: undefined } : {}),
    title: title && /^https?:\/\//.test(j.title) ? title : j.title,
    source: title && j.request?.url.startsWith(MUSIC_SEARCH) ? title : j.source,
    thumbnail: j.thumbnail ?? thumbnail ?? null,
  };
}

const ACTIVE: JobState[] = ["queued", "starting", "analyzing", "downloading", "processing", "preparing", "separating", "converting"];
export const isActive = (j: Job) => ACTIVE.includes(j.state);

function statusText(t: Dict, j: Job, lang: string, queuePos?: [number, number]): string {
  switch (j.state) {
    case "scheduled":
      // بعد اليوم يظهر اليوم أيضًا لا الساعة وحدها (U-46)
      return t.stScheduled(
        new Date(j.at ?? 0).toLocaleString(numLocale(lang), {
          ...(new Date(j.at ?? 0).toDateString() === new Date().toDateString() ? {} : { weekday: "short" }),
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    case "queued":
      // لماذا ينتظر: الحد معلن بجانب الحالة (F-97)
      return `${queuePos && queuePos[1] > 1 ? t.stQueuedAt(queuePos[0], queuePos[1]) : t.stQueued} · ${j.type === "convert" ? t.queueLimitConvert : t.queueLimitDownload}`;
    case "starting":
      return t.stStarting;
    case "analyzing":
      return t.stAnalyzing;
    case "downloading":
      // الصورة ثم الصوت كل منهما من 0%: «الجزء 1 من 2» يمنع ظنّ أن التنزيل بدأ من جديد (F-89). تنزيل صوت فقط جزء واحد
      if (j.request?.kind === "audio") return t.stDownloading;
      return j.stage === "video" ? t.stDownloadingVideo : j.stage === "audio" ? t.stDownloadingAudio : t.stDownloading;
    case "processing":
      return t.stProcessing;
    case "preparing":
      return t.stPreparing;
    case "separating":
      return j.stage === "wait" ? t.stSeparatingWait : t.stSeparating;
    case "converting":
      return j.type === "convert" ? t.stEncoding : t.stConverting;
    case "done":
      if (j.topics) return t.topicsFound(j.topics.length);
      return j.markers ? (j.markers.length ? t.markersFound(j.markers.length) : t.markersNone) : t.stDone;
    case "canceled":
      return t.stCanceled;
    case "error":
      return t.stError;
  }
}

/** الصورة أكبر من الصوت عادةً بكثير: حصتها من الشريط */
const VIDEO_SHARE = 85;

/** نسبة التقدّم الكلية للعملية. تنزيل فيديو بصوت منفصل جزءان كل منهما من 0 إلى 100%:
 * الشريط كان يمتلئ عند نهاية الصورة ثم يعود للصفر، فيبدو أن التنزيل انتهى وهو في منتصفه.
 * هنا الجزءان شريط واحد متصل. */
export function overallPercent(j: Pick<Job, "state" | "stage" | "percent" | "request">): number | undefined {
  const p = j.percent;
  if (p == null) return undefined;
  if (j.state !== "downloading" || j.request?.kind === "audio") return p;
  if (j.stage === "video") return (p * VIDEO_SHARE) / 100;
  if (j.stage === "audio") return VIDEO_SHARE + (p * (100 - VIDEO_SHARE)) / 100;
  return p;
}

/** موضوع كما يُعرض: مدته قبل حذف الصمت وبعده، وهل يصلح ريلًا */
export interface TopicRow extends Topic {
  before: number;
  after: number;
  reel: boolean;
}

export function JobCard(props: {
  job: Job;
  onCancel: () => void;
  onReveal?: () => void;
  /** فتح الملف ونسخ مساره (U-64) */
  onOpen?: () => void;
  onCopyPath?: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onConvert?: () => void;
  onSplit?: () => void;
  /** حذف الصمت أو السواد المكتشف ووصل الباقي */
  onRemoveFound?: () => void;
  removeLabel?: string;
  /** المدة قبل الحذف وبعده (ث) */
  lengths?: [number, number] | null;
  /** موقعها في الطابور: [الترتيب، عدد المنتظرين] (U-55) */
  queuePos?: [number, number];
  onCopyMarkers?: () => void;
  onCopyChapters?: () => void;
  /** تنزيل في الطابور: ابدأه الآن دون انتظار دوره (U-11) */
  onStartNow?: () => void;
  /** سحب الملف المكتمل إلى برنامج آخر (الكمبيوتر فقط) */
  onDragOut?: () => void;
  /** تحليل المواضيع: الصفوف بمدتها بعد حذف الصمت، ومدة الريل [أقصر، أطول] */
  topicRows?: TopicRow[];
  reelRange?: [number, number];
  onCopyTopics?: () => void;
  /** أنواع المواضيع وأجزاؤها المقترحة، وطول الجزء بعد حذف الصمت */
  topicPlans?: TopicPlan[];
  partLength?: (r: Range) => number;
  /** تصدير المواضيع والأجزاء المختارة */
  onExportTopics?: (sections: Range[], o: ExportOptions) => void;
  /** بطاقة تنزيل مكتمل: حلّل مواضيعه */
  onFindTopics?: () => void;
}) {
  const { t, lang } = useI18n();
  const j = props.job;
  // الضغطة الأولى على «إلغاء» تطلب تأكيدًا، والثانية خلال 3 ثوانٍ تلغي (U-28)
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const tm = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(tm);
  }, [armed]);
  const active = isActive(j);
  // نسبة مجهولة (انتظار/تحضير/معالجة) ← شريط متحرك بدل رقم
  const indeterminate =
    active &&
    (j.percent == null ||
      ["queued", "starting", "processing"].includes(j.state) ||
      (j.state === "separating" && !j.percent) ||
      (j.state === "analyzing" && !j.percent));
  const fileName = j.file?.split(/[\\/]/).pop();
  const audioOnly = j.request?.kind === "audio" || j.meta.startsWith("WAV") || j.meta.startsWith("MP3");
  const r = j.request;

  const draggable = j.state === "done" && !!j.file && !!props.onDragOut;
  // الأفعال الثانوية في «⋯»، والظاهر: إظهار، وإلغاء أو إعادة (D-25)
  const extra: MenuItem[] = [];
  if (j.state === "queued" && props.onStartNow) extra.push({ label: t.skipQueue, icon: "download", onClick: props.onStartNow });
  if (j.state === "done" && j.file && props.onOpen) extra.push({ label: t.openFile, icon: "eye", onClick: props.onOpen });
  if (j.state === "done" && j.file && props.onCopyPath) extra.push({ label: t.copyPath, icon: "copy", onClick: props.onCopyPath });
  if (j.state === "done" && j.file && props.onConvert) extra.push({ label: t.sendToConvert, icon: "convert", onClick: props.onConvert });
  if (j.state === "done" && props.onSplit) extra.push({ label: t.splitHere, icon: "scissors", onClick: props.onSplit, title: t.splitHint });
  if (j.state === "done" && props.onCopyMarkers) extra.push({ label: t.copyTimes, icon: "paste", onClick: props.onCopyMarkers });
  if (j.state === "done" && props.onCopyChapters) extra.push({ label: t.copyChapters, icon: "list", onClick: props.onCopyChapters });
  if (j.state === "done" && props.onFindTopics)
    extra.push({ label: t.findTopics, icon: "captions", onClick: props.onFindTopics, title: t.findTopicsHint });
  // مرحلة شريط التقدّم: تنزيل، ثم معالجة، ثم ذكاء اصطناعي (D-93)
  const phase = j.state === "separating" ? "ai" : ["processing", "preparing", "converting"].includes(j.state) ? "proc" : "dl";
  const pct = overallPercent(j);
  const fill = active && !indeterminate ? (pct ?? 0) : 0;

  return (
    <div
      className={`card job state-${j.state} ${draggable ? "draggable" : ""}`}
      style={{ "--fill": `${fill}%` } as CSSProperties}
      draggable={draggable || undefined}
      onDragStart={
        draggable
          ? (e) => {
              e.preventDefault();
              props.onDragOut!();
            }
          : undefined
      }
      title={draggable ? t.dragHint : undefined}
    >
      <div className={`job-icon ${j.state === "done" ? "done" : j.state === "error" ? "error" : ""} ${j.thumbnail ? "has-thumb" : ""}`}>
        {j.thumbnail && <img src={j.thumbnail} alt="" />}
        <span className="job-badge">
          <Icon
            name={
              j.state === "done"
                ? "check"
                : j.state === "error"
                  ? "alert"
                  : j.state === "scheduled"
                    ? "clock"
                    : j.type === "convert"
                      ? "convert"
                      : audioOnly
                        ? "music"
                        : "film"
            }
            size={j.thumbnail ? 14 : 18}
          />
        </span>
      </div>

      <div className="job-body">
        <div className="job-title" dir="auto" title={j.state === "done" && j.file ? j.file : j.title}>
          {j.state === "done" && fileName ? fileName : j.title}
        </div>
        <div className="job-meta">
          <span>{statusText(t, j, lang, props.queuePos)}</span>
          {/* التحويل «بجانب الأصل» يكتب في مجلد لا يعرفه المستخدم من البطاقة (U-72) */}
          {j.state === "done" && j.type === "convert" && j.file && (
            <span className="job-dir ltr" title={j.file}>
              {parentDir(j.file)}
            </span>
          )}
          {active && pct != null && !indeterminate && <span className="ltr">{pct.toFixed(1)}%</span>}
          {j.state === "downloading" && j.speed != null && <span>{formatSpeed(t, j.speed)}</span>}
          {(j.state === "downloading" || j.state === "converting" || j.state === "separating") && j.eta != null && (
            <span>{formatEta(t, j.eta)}</span>
          )}
          <span className="faint">
            {j.meta}
            {r?.end != null && (
              <span className="ltr">
                {" "}
                · ✂ {formatDuration(r.start ?? 0)}–{formatDuration(r.end)}
              </span>
            )}
          </span>
        </div>

        {active && (
          <div
            className={`progress phase-${phase} ${indeterminate ? "indeterminate" : ""}`}
            role="progressbar"
            aria-label={j.title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : Math.round(pct ?? 0)}
          >
            <div style={{ width: `${pct ?? 0}%` }} />
          </div>
        )}

        {j.state === "done" && props.topicRows && props.topicRows.length > 0 && (
          <TopicPanel
            rows={props.topicRows}
            plans={props.topicPlans ?? []}
            summary={[
              j.transcript ? t.topicsFrom[j.transcript] : "",
              props.reelRange ? t.topicsReels(props.topicRows.filter((r) => r.reel).length) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
            levels={j.levels}
            partLength={props.partLength ?? ((r) => r[1] - r[0])}
            hasCues={!!j.cues?.length}
            onExport={props.onExportTopics}
            onCopyTopics={props.onCopyTopics}
          />
        )}

        {j.state === "done" && !j.topics && j.levels && <LevelsLine levels={j.levels} />}
        {j.state === "done" && !j.topics && j.markers && j.markers.length > 0 && (
          <div className="markers">
            <div className="marker-list ltr">
              {j.markers.slice(0, 40).map(([s, e], i) => (
                <span key={i} className="chip">
                  {s === e ? formatTimecode(s) : `${formatTimecode(s)}–${formatTimecode(e)}`}
                </span>
              ))}
              {j.markers.length > 40 && <span className="chip">+{j.markers.length - 40}</span>}
            </div>
            {props.lengths && (
              <div className="faint mt-2">{t.lengthAfter(formatTimecode(props.lengths[0]), formatTimecode(props.lengths[1]))}</div>
            )}
            {props.onRemoveFound && (
              <button className="btn btn-sm mt-2" onClick={props.onRemoveFound} title={t.removeHint}>
                <Icon name="scissors" size={16} /> {props.removeLabel}
              </button>
            )}
          </div>
        )}

        {j.state === "error" && j.error && <ErrorBox error={j.error} compact />}
        {j.source && j.source !== j.title && (
          <div className="faint job-source" dir="auto" title={j.source}>
            {t.matchedFrom(j.source)}
          </div>
        )}
        {j.lastError && active && (
          <div className="faint job-last-error">
            {t.lastAttempt}: {errorText(t, j.lastError)}
          </div>
        )}
      </div>

      <div className="job-actions">
        {draggable && (
          <span className="drag-grip" aria-hidden="true" title={t.dragHint}>
            <Icon name="grip" size={18} />
          </span>
        )}
        {(active || j.state === "scheduled") && (
          <button
            className={`btn btn-sm btn-danger ${armed ? "armed" : ""}`}
            onClick={() => {
              // المجدول لم يبدأ بعد: إلغاؤه لا يضيّع شيئًا
              if (armed || j.state === "scheduled") props.onCancel();
              else setArmed(true);
            }}
          >
            <Icon name="x" size={16} /> {armed ? t.cancelConfirm : t.cancel}
          </button>
        )}
        {j.state === "done" && j.file && props.onReveal && (
          <button className="btn btn-sm" onClick={props.onReveal}>
            <Icon name="folder" size={16} /> {t.showInFolder}
          </button>
        )}
        {(j.state === "error" || j.state === "canceled") && (
          <button className="btn btn-sm" onClick={props.onRetry}>
            <Icon name="retry" size={16} /> {t.retry}
          </button>
        )}
        <MoreMenu label={t.moreActions} items={extra} />
        {!active && j.state !== "scheduled" && (
          <button className="icon-btn sm" title={t.remove} aria-label={t.remove} onClick={props.onRemove}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
