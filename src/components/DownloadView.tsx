import { useEffect, useRef, useState } from "react";
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
import { extractUrls, formatDuration, isHttpUrl } from "../format";
import { useI18n } from "../i18n";
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./Icon";
import { Segmented, Toggle } from "./Segmented";
import { TrimRange, type Range } from "./TrimRange";

const QUALITIES = ["best", "2160", "1440", "1080", "720", "480"] as const;

type ProbeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; info: ProbeInfo }
  | { status: "error"; error: AppError };

export function DownloadView(props: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  outputDir: string;
  onChooseDir: () => void;
  onStart: (req: DownloadRequest, title: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  const [url, setUrl] = useState("");
  const [probe, setProbe] = useState<ProbeState>({ status: "idle" });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<AppError | null>(null);
  const probeToken = useRef(0);
  const [trimOn, setTrimOn] = useState(false);
  const [range, setRange] = useState<Range | null>(null);
  const [stems, setStems] = useState<"off" | "voice" | "music">("off");

  // عند تغيّر الرابط: ننتظر نصف ثانية (حتى ينتهي اللصق/الكتابة) ثم نجلب معلوماته.
  // probeToken يمنع ردًّا قديمًا من الكتابة فوق رد أحدث.
  useEffect(() => {
    const clean = url.trim();
    setStartError(null);
    setRange(null);
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
        if (token === probeToken.current) setProbe({ status: "ok", info });
      } catch (e) {
        if (token === probeToken.current) setProbe({ status: "error", error: asAppError(e) });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [url]);

  const info = probe.status === "ok" ? probe.info : null;
  const maxHeight = info?.heights[0];
  const duration = info && !info.isLive && info.duration ? info.duration : null;
  const activeRange = trimOn && duration ? (range ?? { start: 0, end: duration }) : null;
  const isPartial = !!activeRange && !!duration && (activeRange.start > 0 || activeRange.end < duration - 0.05);

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      setUrl(extractUrls(text)[0] ?? text.trim());
    } catch {
      setStartError({ code: "clipboard" });
    }
  }

  async function start() {
    const clean = url.trim();
    if (!isHttpUrl(clean) || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await props.onStart(
        {
          url: clean,
          kind: s.kind,
          videoFormat: s.videoFormat,
          audioFormat: s.audioFormat,
          quality: s.quality,
          editorReady: s.editorReady,
          start: isPartial ? activeRange!.start : null,
          end: isPartial ? activeRange!.end : null,
          stems: stems === "off" ? null : stems,
        },
        info?.title ?? clean,
      );
      setUrl("");
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

  return (
    <div className="card">
      <h2>{t.pasteTitle}</h2>
      <p className="faint" style={{ margin: "0 0 14px" }}>{t.pasteSub}</p>

      <div className="url-row">
        <input
          className="url-input ltr"
          placeholder="https://…"
          value={url}
          spellCheck={false}
          autoFocus
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start()}
          aria-label={t.urlAria}
        />
        <button className="btn btn-lg" onClick={paste} title={t.pasteTooltip}>
          <Icon name="paste" /> {t.paste}
        </button>
      </div>

      {probe.status === "loading" && (
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
          <div style={{ minWidth: 0 }}>
            <div className="preview-title">{info.title}</div>
            <div className="faint">
              {[info.uploader, formatDuration(info.duration), info.site, maxHeight ? t.upTo(maxHeight) : null]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
      )}

      {probe.status === "error" && <ErrorBox error={probe.error} />}

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
          <div className="swap-in" key={s.kind}>
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
          </div>
        </div>

        <div className="collapse" data-open={s.kind === "video"} aria-hidden={s.kind !== "video" || undefined}>
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
          <div>
            <Toggle
              checked={s.editorReady}
              onChange={(editorReady) => update({ editorReady })}
              title={t.editorReady}
              hint={t.editorReadyHint}
            />
          </div>
          </div>
          </div>
        </div>
      </div>

      {info && (
        <div className="trim-box">
          <Toggle
            checked={trimOn && !info.isLive}
            onChange={setTrimOn}
            title={t.trimToggle}
            hint={info.isLive ? t.trimLive : t.trimHint}
          />
          <div className="collapse" data-open={!!activeRange}>
            <div>
              {duration && <TrimRange duration={duration} value={activeRange ?? { start: 0, end: duration }} onChange={setRange} />}
            </div>
          </div>
        </div>
      )}

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
            <div className="faint" style={{ marginTop: 6 }}>{t.stemsHint}</div>
          </div>
        </div>
      </div>

      {startError && <ErrorBox error={startError} />}

      <div className="action-row">
        <div className="save-to">
          <Icon name="folder" size={16} />
          <span>{t.saveTo}</span>
          <span className="path ltr" title={props.outputDir}>{props.outputDir}</span>
          <button className="btn btn-sm btn-ghost" onClick={props.onChooseDir}>{t.change}</button>
        </div>
        <button className="btn btn-primary btn-lg" disabled={!isHttpUrl(url) || starting} onClick={start}>
          <Icon name="download" /> {t.download}
        </button>
      </div>
    </div>
  );
}
