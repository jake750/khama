import type { AppError, DownloadRequest, JobState } from "../api";
import { formatDuration, formatEta, formatSpeed } from "../format";
import { useI18n, type Dict } from "../i18n";
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./Icon";

/** عملية تنزيل كما تحفظها الواجهة */
export interface Job {
  id: number;
  request: DownloadRequest;
  title: string;
  state: JobState;
  stage?: "video" | "audio" | "file";
  percent?: number;
  speed?: number;
  eta?: number;
  file?: string;
  error?: AppError;
}

const ACTIVE: JobState[] = ["starting", "downloading", "processing", "converting"];
export const isActive = (j: Job) => ACTIVE.includes(j.state);

function statusText(t: Dict, j: Job): string {
  switch (j.state) {
    case "starting":
      return t.stStarting;
    case "downloading":
      return j.stage === "video" ? t.stDownloadingVideo : j.stage === "audio" ? t.stDownloadingAudio : t.stDownloading;
    case "processing":
      return t.stProcessing;
    case "converting":
      return t.stConverting;
    case "done":
      return t.stDone;
    case "canceled":
      return t.stCanceled;
    case "error":
      return t.stError;
  }
}

export function JobCard(props: {
  job: Job;
  onCancel: () => void;
  onReveal: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const j = props.job;
  const active = isActive(j);
  // نسبة مجهولة (التحضير/المعالجة) ← شريط متحرك بدل رقم
  const indeterminate = active && (j.percent == null || j.state === "starting" || j.state === "processing");
  const fileName = j.file?.split(/[\\/]/).pop();
  const r = j.request;

  return (
    <div className="card job">
      <div className={`job-icon ${j.state === "done" ? "done" : j.state === "error" ? "error" : ""}`}>
        <Icon name={j.state === "done" ? "check" : j.state === "error" ? "alert" : r.kind === "audio" ? "music" : "film"} />
      </div>

      <div className="job-body">
        <div className="job-title" title={j.title}>
          {j.state === "done" && fileName ? fileName : j.title}
        </div>
        <div className="job-meta">
          <span>{statusText(t, j)}</span>
          {active && j.percent != null && !indeterminate && <span className="ltr">{j.percent.toFixed(1)}%</span>}
          {j.state === "downloading" && j.speed != null && <span>{formatSpeed(t, j.speed)}</span>}
          {j.state === "downloading" && j.eta != null && <span>{formatEta(t, j.eta)}</span>}
          <span className="faint">
            {r.kind === "audio" ? (r.audioFormat === "m4a" ? "AAC" : r.audioFormat.toUpperCase()) : r.videoFormat.toUpperCase()}
            {r.kind === "video" && ` · ${r.quality === "best" ? t.best : r.quality + "p"}`}
            {r.end != null && <span className="ltr"> · ✂ {formatDuration(r.start ?? 0)}–{formatDuration(r.end)}</span>}
          </span>
        </div>

        {active && (
          <div className={`progress ${indeterminate ? "indeterminate" : ""}`}>
            <div style={{ width: `${j.percent ?? 0}%` }} />
          </div>
        )}

        {j.state === "error" && j.error && <ErrorBox error={j.error} compact />}
      </div>

      <div className="job-actions">
        {active && (
          <button className="btn btn-sm btn-danger" onClick={props.onCancel}>
            <Icon name="x" size={16} /> {t.cancel}
          </button>
        )}
        {j.state === "done" && (
          <button className="btn btn-sm" onClick={props.onReveal}>
            <Icon name="folder" size={16} /> {t.showInFolder}
          </button>
        )}
        {(j.state === "error" || j.state === "canceled") && (
          <button className="btn btn-sm" onClick={props.onRetry}>
            <Icon name="retry" size={16} /> {t.retry}
          </button>
        )}
        {!active && (
          <button className="icon-btn" style={{ width: 32, height: 32 }} title={t.remove} aria-label={t.remove} onClick={props.onRemove}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
