import { useEffect, useRef, useState } from "react";
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
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./Icon";
import { Segmented, Toggle } from "./Segmented";
import { SlideSwitch } from "../motion";
import { isMobile, MOBILE_SAVE_DIR } from "../platform";
import { TrimRange, type Range } from "./TrimRange";
import { PlaylistPanel } from "./PlaylistPanel";

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
  // المقاطع المختارة (null = مقطع واحد يغطي الفيديو كله، قبل أن يحرّك المستخدم شيئًا)
  const [clips, setClips] = useState<Range[] | null>(null);
  const [joinClips, setJoinClips] = useState(true);
  const [stems, setStems] = useState<"off" | "voice" | "music">("off");
  // قائمة التشغيل: العناصر المحدَّدة للتنزيل، وأيّها تُزال منه الموسيقى (إن اختار "عناصر أحدّدها")
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [stemsScope, setStemsScope] = useState<"all" | "pick">("all");
  const [picked, setPicked] = useState<Set<number>>(new Set());

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
  }, [url]);

  const info = probe.status === "ok" ? probe.info : null;
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
    try {
      const text = await navigator.clipboard.readText();
      setUrl(extractUrls(text)[0] ?? text.trim());
    } catch {
      setStartError({ code: "clipboard" });
    }
  }

  /** قائمة تشغيل: عملية تنزيل لكل عنصر محدَّد (Rust يشغّل 3 معًا والباقي ينتظر) */
  async function startPlaylist(list: PlaylistEntry[], folder: string) {
    let firstError: AppError | null = null;
    for (const i of [...selected].sort((a, b) => a - b)) {
      const e = list[i];
      if (!e) continue;
      const removeHere = stemsOn && (stemsScope === "all" || picked.has(i));
      try {
        await props.onStart(
          {
            url: e.url,
            kind: s.kind,
            videoFormat: s.videoFormat,
            audioFormat: s.audioFormat,
            quality: s.quality,
            editorReady: s.editorReady && !isMobile,
            start: null,
            end: null,
            stems: removeHere ? (stems as "voice" | "music") : null,
            clips: [],
            joinClips: false,
            subdir: folder,
          },
          e.title,
        );
      } catch (err) {
        firstError ??= asAppError(err);
      }
    }
    if (firstError) throw firstError;
  }

  async function start() {
    const clean = url.trim();
    if (!isHttpUrl(clean) || starting) return;
    if (entries && selected.size === 0) return;
    setStarting(true);
    setStartError(null);
    if (entries && info) {
      try {
        await startPlaylist(entries, info.title);
        setUrl("");
      } catch (e) {
        setStartError(asAppError(e));
      } finally {
        setStarting(false);
      }
      return;
    }
    try {
      await props.onStart(
        {
          url: clean,
          kind: s.kind,
          videoFormat: s.videoFormat,
          audioFormat: s.audioFormat,
          quality: s.quality,
          editorReady: s.editorReady && !isMobile,
          start: isPartial ? single!.start : null,
          end: isPartial ? single!.end : null,
          stems: stems === "off" || isMobile ? null : stems,
          clips: multi ? activeClips!.map((c) => [c.start, c.end] as [number, number]) : [],
          joinClips: willJoin,
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
              {(entries
                ? [t.plItems(entries.length), info.uploader, info.site]
                : [info.uploader, formatDuration(info.duration), info.site, maxHeight ? t.upTo(maxHeight) : null]
              )
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
      )}

      {entries && info?.site === "Spotify" && (
        <div className="alert info">
          <Icon name="music" size={16} />
          <span>{t.spotifyHint}</span>
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
          {!isMobile && <div>
            <Toggle
              checked={s.editorReady}
              onChange={(editorReady) => update({ editorReady })}
              title={t.editorReady}
              hint={t.editorReadyHint}
            />
          </div>}
          </div>
          </div>
        </div>
      </div>

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
              {duration && (activeClips ?? [{ start: 0, end: duration }]).map((c, i) => (
                <div className="clip" key={i}>
                  {multi && (
                    <div className="clip-head">
                      <span className="clip-name">{t.clipN(i + 1)}</span>
                      <button className="btn btn-sm btn-ghost" onClick={() => removeClip(i)} title={t.removeClip} aria-label={t.removeClip}>
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  )}
                  <TrimRange duration={duration} value={c} onChange={(r) => setClip(i, r)} />
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
            </div>
          </div>
        </div>
      )}

      {!isMobile && <div className="stems-row">
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
      </div>}

      {startError && <ErrorBox error={startError} />}

      <div className="action-row">
        <div className="save-to">
          <Icon name="folder" size={16} />
          <span>{t.saveTo}</span>
          <span className="path ltr" title={props.outputDir}>{isMobile ? MOBILE_SAVE_DIR : props.outputDir}</span>
          {!isMobile && <button className="btn btn-sm btn-ghost" onClick={props.onChooseDir}>{t.change}</button>}
        </div>
        <button
          className="btn btn-primary btn-lg"
          disabled={!isHttpUrl(url) || starting || (!!entries && selected.size === 0)}
          onClick={start}
        >
          <Icon name="download" /> {entries ? t.downloadN(selected.size) : t.download}
        </button>
      </div>
    </div>
  );
}
