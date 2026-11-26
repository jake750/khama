import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SilenceLevels } from "../api";
import { formatDuration, formatTimecode } from "../format";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";

type Range = [number, number];

/** مجموع أطوال الفترات (ث) */
const total = (rs: Range[]) => rs.reduce((n, [s, e]) => n + Math.max(0, e - s), 0);

/**
 * نتيجة كشف الصمت (أو السواد) مرئية: ما قيس من الصوت، والعتبة، وأين الصمت على خط الزمن،
 * وما سيُحذف منه وما يبقى هامشًا، ومشغّل يعرض الأصل أو النتيجة بعد الحذف دون انتظار تحويل.
 */
export function SilenceView(props: {
  /** الصمت (أو السواد) المكتشف بثواني الملف */
  found: Range[];
  /** ما سيُحذف فعلًا (الصمت بعد ترك الهامش من طرفيه) */
  cuts: Range[];
  /** المدى المحلَّل من الملف */
  range: Range;
  levels?: SilenceLevels | null;
  /** الملف المحلي (للمشغّل)، أو لا شيء */
  path?: string | null;
  video: boolean;
  black?: boolean;
}) {
  const { t } = useI18n();
  const [lo, hi] = props.range;
  const span = Math.max(0.001, hi - lo);
  const lv = props.levels;

  // ===== المشغّل: الأصل، أو «بعد الحذف» بالقفز فوق كل فترة محذوفة أثناء التشغيل =====
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<"before" | "after">("after");
  const [now, setNow] = useState(lo);
  const [playing, setPlaying] = useState(false);
  const load = () => {
    if (!props.path || src) return;
    api
      .allowMedia(props.path)
      .then(() => setSrc(convertFileSrc(props.path!)))
      .catch(() => setFailed(true));
  };
  const skip = (el: HTMLMediaElement) => {
    if (mode !== "after") return;
    const c = props.cuts.find(([s, e]) => el.currentTime >= s - 0.01 && el.currentTime < e - 0.02);
    if (c) el.currentTime = c[1];
  };
  useEffect(() => {
    const el = media.current;
    if (!el) return;
    // timeupdate يصل كل ~250 ms فقط: نراقب كل إطار أثناء التشغيل حتى لا يُسمع طرف الصمت المحذوف
    let raf = 0;
    const tick = () => {
      skip(el);
      if (el.currentTime >= hi) el.pause();
      setNow(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    const play = () => {
      setPlaying(true);
      if (el.currentTime < lo || el.currentTime >= hi) el.currentTime = lo;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      setPlaying(false);
      cancelAnimationFrame(raf);
    };
    el.addEventListener("play", play);
    el.addEventListener("pause", stop);
    el.addEventListener("ended", stop);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("play", play);
      el.removeEventListener("pause", stop);
      el.removeEventListener("ended", stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, mode, props.cuts, lo, hi]);
  const seek = (sec: number, andPlay = true) => {
    load();
    setNow(sec);
    const go = () => {
      const el = media.current;
      if (!el) return;
      el.currentTime = sec;
      if (andPlay) el.play().catch(() => {});
    };
    if (media.current?.readyState) go();
    else setTimeout(go, 150);
  };

  // ===== خط الزمن =====
  const W = 1000;
  const H = 64;
  const yOf = (db: number) => H - ((Math.max(-80, Math.min(0, db)) + 80) / 80) * H;
  const area = useMemo(() => {
    const env = lv?.envelope;
    if (!env?.length || lv?.envStep == null) return null;
    const x0 = lv.envStart ?? lo;
    const pts = env.map((db, i) => `${((x0 + i * lv.envStep! - lo) / span) * W},${yOf(db)}`);
    return `M0,${H} L${pts.join(" L")} L${W},${H} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lv, lo, span]);
  const x = (sec: number) => ((sec - lo) / span) * W;
  const removed = total(props.cuts);
  const silent = total(props.found);
  const kept = Math.max(0, silent - removed);
  const [showList, setShowList] = useState(false);

  return (
    <div className="silence-view">
      {/* ما قيس: الخلفية والكلام والحد بينهما على مقياس الديسيبل */}
      {lv && !props.black && (
        <div className="sv-meter" title={t.silenceLevelsHint}>
          <div className="sv-meter-bar" dir="ltr">
            <span className="sv-mark noise" style={{ insetInlineStart: `${((lv.noise + 80) / 80) * 100}%` }} />
            {lv.threshold != null && (
              <span className="sv-mark threshold" style={{ insetInlineStart: `${((lv.threshold + 80) / 80) * 100}%` }} />
            )}
            <span className="sv-mark speech" style={{ insetInlineStart: `${((lv.speech + 80) / 80) * 100}%` }} />
          </div>
          <div className="sv-meter-legend">
            <span>
              <i className="sv-dot noise" /> {t.svNoise} <b className="ltr-num">{lv.noise.toFixed(0)} dB</b>
            </span>
            {lv.threshold != null && (
              <span>
                <i className="sv-dot threshold" /> {lv.manual ? t.svLimitManual : t.svLimitAuto}{" "}
                <b className="ltr-num">{lv.threshold.toFixed(0)} dB</b>
              </span>
            )}
            <span>
              <i className="sv-dot speech" /> {t.svSpeech} <b className="ltr-num">{lv.speech.toFixed(0)} dB</b>
            </span>
          </div>
        </div>
      )}

      {/* أرقام سريعة بأيقونات */}
      <div className="sv-stats">
        <div>
          <Icon name="list" size={16} />
          <b className="ltr-num">{props.found.length}</b>
          <span>{props.black ? t.svBlackCount : t.svPauses}</span>
        </div>
        <div>
          <Icon name="clock" size={16} />
          <b className="ltr-num">{formatDuration(silent)}</b>
          <span>{props.black ? t.svBlackTotal : t.svSilenceTotal}</span>
        </div>
        <div className="cut">
          <Icon name="scissors" size={16} />
          <b className="ltr-num">{formatDuration(removed)}</b>
          <span>{t.svRemoved}</span>
        </div>
        <div>
          <Icon name="timeline" size={16} />
          <b className="ltr-num">
            {formatDuration(span)} → {formatDuration(Math.max(0, span - removed))}
          </b>
          <span>{t.svLength}</span>
        </div>
      </div>

      {/* خط الزمن: الصوت، والحد، والصمت (الهامش الباقي والمحذوف)، ومكان التشغيل */}
      <div className="sv-timeline" dir="ltr">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t.svTimeline}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek(lo + ((e.clientX - r.left) / r.width) * span);
          }}
        >
          {props.found.map(([s, e], i) => (
            <rect key={`f${i}`} className="sv-kept" x={x(s)} width={Math.max(1, x(e) - x(s))} y={0} height={H} />
          ))}
          {props.cuts.map(([s, e], i) => (
            <rect key={`c${i}`} className="sv-cut" x={x(s)} width={Math.max(1, x(e) - x(s))} y={0} height={H} />
          ))}
          {area && <path className="sv-wave" d={area} />}
          {lv?.threshold != null && !props.black && (
            <line className="sv-limit" x1={0} x2={W} y1={yOf(lv.threshold)} y2={yOf(lv.threshold)} />
          )}
          {src && <line className="sv-head" x1={x(now)} x2={x(now)} y1={0} y2={H} />}
        </svg>
        <div className="sv-axis faint ltr-num">
          <span>{formatTimecode(lo)}</span>
          <span>{formatTimecode(lo + span / 2)}</span>
          <span>{formatTimecode(hi)}</span>
        </div>
      </div>
      <div className="sv-legend faint">
        {area && (
          <span>
            <i className="sv-swatch wave" /> {t.svWave}
          </span>
        )}
        <span>
          <i className="sv-swatch kept" /> {t.svKept(formatDuration(kept))}
        </span>
        <span>
          <i className="sv-swatch cut" /> {t.svCut}
        </span>
      </div>

      {/* المشغّل: يُحمَّل عند أول طلب فقط، فلا يُقرأ الملف إن لم يُشغَّل */}
      {props.path && !failed && (
        <div className="sv-player">
          {src &&
            (props.video ? (
              <video ref={media} src={src} preload="metadata" playsInline className="sv-video" />
            ) : (
              <audio ref={media} src={src} preload="metadata" />
            ))}
          <div className="sv-controls">
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                if (!src) return seek(lo);
                const el = media.current;
                if (el) {
                  if (el.paused) el.play().catch(() => {});
                  else el.pause();
                }
              }}
            >
              <Icon name={playing ? "pause" : "play"} size={16} /> {playing ? t.svPause : t.svPlay}
            </button>
            <Segmented<"before" | "after">
              label={t.svMode}
              value={mode}
              onChange={setMode}
              options={[
                { value: "before", label: t.svBefore },
                { value: "after", label: t.svAfter },
              ]}
            />
            {src && <span className="faint ltr-num">{formatTimecode(now)}</span>}
          </div>
        </div>
      )}

      {/* كل فترة: نقرة تشغّل من قبلها بثانيتين لتسمع ما حولها */}
      {props.found.length > 0 && (
        <div>
          <button className="btn btn-sm btn-ghost" aria-expanded={showList} onClick={() => setShowList((v) => !v)}>
            <span className={showList ? "flip-y" : undefined}>
              <Icon name="chevron" size={16} />
            </span>{" "}
            {t.svAll(props.found.length)}
          </button>
          {showList && (
            <div className="marker-list ltr">
              {props.found.map(([s, e], i) => (
                <button
                  key={i}
                  className="chip chip-btn"
                  onClick={() => seek(Math.max(lo, s - 2))}
                  title={t.svPlayHere}
                  disabled={!props.path}
                >
                  {s === e ? formatTimecode(s) : `${formatTimecode(s)}–${formatTimecode(e)}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
