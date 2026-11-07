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
}

const ACTIVE: JobState[] = ["queued", "starting", "analyzing", "downloading", "processing", "converting"];
export const isActive = (j: Job) => ACTIVE.includes(j.state);

function statusText(t: Dict, j: Job): string {
  switch (j.state) {
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
  onReveal: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onConvert?: () => void;
  onSplit?: () => void;
  onCopyMarkers?: () => void;
}) {
  const { t } = useI18n();
  const j = props.job;
  const active = isActive(j);
  // نسبة مجهولة (انتظار/تحضير/معالجة) ← شريط متحرك بدل رقم
  const indeterminate =
    active && (j.percent == null || ["queued", "starting", "processing"].includes(j.state) || (j.state === "analyzing" && !j.percent));
  const fileName = j.file?.split(/[\\/]/).pop();
  const audioOnly = j.request?.kind === "audio" || j.meta.startsWith("WAV") || j.meta.startsWith("MP3");
  const r = j.request;

  return (
    <div className="card job">
      <div className={`job-icon ${j.state === "done" ? "done" : j.state === "error" ? "error" : ""}`}>
        <Icon
          name={
            j.state === "done" ? "check" : j.state === "error" ? "alert" : j.type === "convert" ? "convert" : audioOnly ? "music" : "film"
          }
        />
      </div>

      <div className="job-body">
        <div className="job-title" title={j.title}>
          {j.state === "done" && fileName ? fileName : j.title}
        </div>
        <div className="job-meta">
          <span>{statusText(t, j)}</span>
          {active && j.percent != null && !indeterminate && <span className="ltr">{j.percent.toFixed(1)}%</span>}
          {j.state === "downloading" && j.speed != null && <span>{formatSpeed(t, j.speed)}</span>}
          {(j.state === "downloading" || j.state === "converting") && j.eta != null && <span>{formatEta(t, j.eta)}</span>}
          <span className="faint">
            {j.meta}
            {r?.end != null && <span className="ltr"> · ✂ {formatDuration(r.start ?? 0)}–{formatDuration(r.end)}</span>}
          </span>
        </div>

        {active && (
          <div className={`progress ${indeterminate ? "indeterminate" : ""}`}>
            <div style={{ width: `${j.percent ?? 0}%` }} />
          </div>
        )}

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
      </div>

      <div className="job-actions">
        {active && (
          <button className="btn btn-sm btn-danger" onClick={props.onCancel}>
            <Icon name="x" size={16} /> {t.cancel}
          </button>
        )}
        {j.state === "done" && j.file && props.onConvert && (
          <button className="btn btn-sm btn-ghost" onClick={props.onConvert} title={t.sendToConvert}>
            <Icon name="convert" size={16} /> {t.sendToConvert}
          </button>
        )}
        {j.state === "done" && j.file && (
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
