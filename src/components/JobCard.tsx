import type { CSSProperties, DragEvent } from "react";
import type { AppError, ConvertRequest, DownloadRequest, JobState } from "../api";
import { formatDuration, formatEta, formatSpeed, formatTimecode } from "../format";
import { useI18n, type Dict } from "../i18n";
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./Icon";

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
  stage?: "video" | "audio" | "file";
  percent?: number;
  speed?: number;
  eta?: number;
  file?: string;
  error?: AppError;
  markers?: [number, number][];
  /** صورة الفيديو (من المعاينة) */
  thumbnail?: string | null;
  /** تنزيل مجدول: وقت البدء (ms) */
  at?: number;
}

const ACTIVE: JobState[] = ["queued", "starting", "analyzing", "downloading", "processing", "preparing", "separating", "converting"];
export const isActive = (j: Job) => ACTIVE.includes(j.state);

function statusText(t: Dict, j: Job): string {
  switch (j.state) {
    case "scheduled":
      return t.stScheduled(new Date(j.at ?? 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    case "queued":
      return t.stQueued;
    case "starting":
      return t.stStarting;
    case "analyzing":
      return t.stAnalyzing;
    case "downloading":
      return j.stage === "video" ? t.stDownloadingVideo : j.stage === "audio" ? t.stDownloadingAudio : t.stDownloading;
    case "processing":
      return t.stProcessing;
    case "preparing":
      return t.stPreparing;
    case "separating":
      return t.stSeparating;
    case "converting":
      return j.type === "convert" ? t.stEncoding : t.stConverting;
    case "done":
      return j.markers ? (j.markers.length ? t.markersFound(j.markers.length) : t.markersNone) : t.stDone;
    case "canceled":
      return t.stCanceled;
    case "error":
      return t.stError;
  }
}

export function JobCard(props: {
  job: Job;
  onCancel: () => void;
  onReveal?: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onConvert?: () => void;
  onSplit?: () => void;
  onCopyMarkers?: () => void;
  /** سحب الملف المكتمل إلى برنامج آخر (الكمبيوتر فقط) */
  onDragOut?: () => void;
}) {
  const { t } = useI18n();
  const j = props.job;
  const active = isActive(j);
  // نسبة مجهولة (انتظار/تحضير/معالجة) ← شريط متحرك بدل رقم
  const indeterminate =
    active && (j.percent == null || ["queued", "starting", "processing"].includes(j.state) || (j.state === "separating" && !j.percent) || (j.state === "analyzing" && !j.percent));
  const fileName = j.file?.split(/[\\/]/).pop();
  const audioOnly = j.request?.kind === "audio" || j.meta.startsWith("WAV") || j.meta.startsWith("MP3");
  const r = j.request;

  const draggable = j.state === "done" && !!j.file && !!props.onDragOut;
  const fill = active && !indeterminate ? j.percent ?? 0 : 0;
  // بطاقة بصورة (تنزيل له صورة): تخطيط مثل يوتيوب، صورة واضحة وعنوان واضح
  const media = !!j.thumbnail;
  // العنوان قد يكون الرابط نفسه إن بدأ التنزيل قبل المعاينة: اسم الملف أوضح حينها
  const titleIsUrl = /^https?:\/\//.test(j.title);
  const title = media ? (titleIsUrl && fileName ? fileName : j.title) : j.state === "done" && fileName ? fileName : j.title;
  const removable = !active && j.state !== "scheduled";

  const meta = (
    <div className="job-meta">
      <span className="job-status">{statusText(t, j)}</span>
      {active && j.percent != null && !indeterminate && <span className="ltr">{j.percent.toFixed(1)}%</span>}
      {j.state === "downloading" && j.speed != null && <span>{formatSpeed(t, j.speed)}</span>}
      {(j.state === "downloading" || j.state === "converting") && j.eta != null && <span>{formatEta(t, j.eta)}</span>}
      {media ? (
        r?.end != null && <span className="faint ltr">✂ {formatDuration(r.start ?? 0)}–{formatDuration(r.end)}</span>
      ) : (
        <span className="faint">
          {j.meta}
          {r?.end != null && <span className="ltr"> · ✂ {formatDuration(r.start ?? 0)}–{formatDuration(r.end)}</span>}
        </span>
      )}
    </div>
  );

  const extras = (
    <>
      {j.state === "done" && j.markers && j.markers.length > 0 && (
        <div className="markers">
          <div className="marker-list ltr">
            {j.markers.slice(0, 40).map(([s, e], i) => (
              <span key={i} className="chip">
                {s === e ? formatTimecode(s) : `${formatTimecode(s)}–${formatTimecode(e)}`}
              </span>
            ))}
            {j.markers.length > 40 && <span className="chip">+{j.markers.length - 40}</span>}
          </div>
          <div className="marker-actions">
            {props.onSplit && (
              <button className="btn btn-sm" onClick={props.onSplit}>
                <Icon name="scissors" size={16} /> {t.splitHere}
              </button>
            )}
            {props.onCopyMarkers && (
              <button className="btn btn-sm btn-ghost" onClick={props.onCopyMarkers}>
                <Icon name="paste" size={16} /> {t.copyTimes}
              </button>
            )}
          </div>
        </div>
      )}
      {j.state === "error" && j.error && <ErrorBox error={j.error} compact />}
    </>
  );

  const showConvert = j.state === "done" && !!j.file && !!props.onConvert;
  const showReveal = j.state === "done" && !!j.file && !!props.onReveal;
  const showRetry = j.state === "error" || j.state === "canceled";
  const showCancel = active || j.state === "scheduled";
  const buttons = (
    <>
      {showCancel && (
        <button className="btn btn-sm btn-danger" onClick={props.onCancel}>
          <Icon name="x" size={16} /> {t.cancel}
        </button>
      )}
      {showConvert && (
        <button className="btn btn-sm btn-ghost" onClick={props.onConvert} title={t.sendToConvert}>
          <Icon name="convert" size={16} /> {t.sendToConvert}
        </button>
      )}
      {showReveal && (
        <button className="btn btn-sm" onClick={props.onReveal}>
          <Icon name="folder" size={16} /> {t.showInFolder}
        </button>
      )}
      {showRetry && (
        <button className="btn btn-sm" onClick={props.onRetry}>
          <Icon name="retry" size={16} /> {t.retry}
        </button>
      )}
    </>
  );
  const removeBtn = removable && (
    <button className="icon-btn job-remove" title={t.remove} aria-label={t.remove} onClick={props.onRemove}>
      <Icon name="x" size={16} />
    </button>
  );

  const dragProps = {
    draggable: draggable || undefined,
    onDragStart: draggable
      ? (e: DragEvent) => {
          e.preventDefault();
          props.onDragOut!();
        }
      : undefined,
    title: draggable ? t.dragHint : undefined,
  };

  if (media) {
    const badge = j.state === "done" ? "check" : j.state === "error" ? "alert" : j.state === "scheduled" ? "clock" : null;
    return (
      <div className={`card job job-media state-${j.state} ${draggable ? "draggable" : ""}`} {...dragProps}>
        <div className="job-thumb">
          <img src={j.thumbnail!} alt="" />
          {badge && (
            <span className={`job-thumb-badge ${j.state}`}>
              <Icon name={badge} size={14} />
            </span>
          )}
          {j.meta && <span className="job-thumb-chip ltr">{j.meta}</span>}
          {active && (
            <div className={`progress job-thumb-progress ${indeterminate ? "indeterminate" : ""}`}>
              <div style={{ width: `${j.percent ?? 0}%` }} />
            </div>
          )}
        </div>
        <div className="job-body">
          <div className="job-head">
            <div className="job-title" title={fileName ?? j.title}>
              {title}
            </div>
            {removeBtn}
          </div>
          {meta}
          {extras}
          {(showCancel || showConvert || showReveal || showRetry || draggable) && (
            <div className="job-actions">
              {buttons}
              {draggable && (
                <span className="drag-grip" aria-hidden="true">
                  <Icon name="grip" size={16} />
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`card job state-${j.state} ${draggable ? "draggable" : ""}`} style={{ "--fill": `${fill}%` } as CSSProperties} {...dragProps}>
      <div className={`job-icon ${j.state === "done" ? "done" : j.state === "error" ? "error" : ""}`}>
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
            size={18}
          />
        </span>
      </div>

      <div className="job-body">
        <div className="job-title" title={j.title}>
          {title}
        </div>
        {meta}

        {active && (
          <div className={`progress ${indeterminate ? "indeterminate" : ""}`}>
            <div style={{ width: `${j.percent ?? 0}%` }} />
          </div>
        )}

        {extras}
      </div>

      <div className="job-actions">
        {draggable && (
          <span className="drag-grip" aria-hidden="true">
            <Icon name="grip" size={16} />
          </span>
        )}
        {buttons}
        {removeBtn}
      </div>
    </div>
  );
}
