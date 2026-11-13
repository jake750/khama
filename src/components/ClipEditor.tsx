import { useRef } from "react";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";
import { TrimRange, type PreviewLink, type Range } from "./TrimRange";

/** مقطع جديد يبدأ بعد آخر مقطع (أو من البداية إن لم يبقَ وقت)، بطول 10% من الفيديو */
export function nextClip(duration: number, clips: Range[]): Range {
  const len = Math.max(Math.min(duration / 10, 60), Math.min(1, duration));
  const lastEnd = Math.max(0, ...clips.map((c) => c.end));
  const start = lastEnd + len <= duration ? lastEnd : 0;
  return { start, end: Math.min(start + len, duration) };
}

/** هل المقاطع تعني «جزءًا» من الفيديو لا الفيديو كله؟ */
export function isTrimmed(duration: number, clips: Range[]): boolean {
  if (clips.length !== 1) return clips.length > 1;
  const c = clips[0];
  return c.start > 0 || c.end < duration - 0.05;
}

/**
 * محرّر المقاطع: معاينة الفيديو (إن توفّرت)، ومقبضا بداية ونهاية لكل مقطع،
 * وإضافة مقطع، واختيار حفظها فيديو واحدًا أو ملفات منفصلة.
 * يُستعمل لفيديو واحد ولكل عنصر في قائمة التشغيل.
 */
export function ClipEditor(props: {
  duration: number;
  clips: Range[];
  onClips: (clips: Range[]) => void;
  join: boolean;
  onJoin: (join: boolean) => void;
  previewUrl?: string | null;
  poster?: string | null;
}) {
  const { t } = useI18n();
  const { duration, clips } = props;
  const video = useRef<HTMLVideoElement>(null);
  const multi = clips.length > 1;

  const preview: PreviewLink | null = props.previewUrl
    ? {
        now: () => video.current?.currentTime ?? null,
        seek: (v) => {
          if (video.current) video.current.currentTime = v;
        },
      }
    : null;

  return (
    <>
      {props.previewUrl && (
        <video
          ref={video}
          className="trim-video"
          src={props.previewUrl}
          poster={props.poster ?? undefined}
          controls
          preload="metadata"
          aria-label={t.previewLabel}
        />
      )}
      {clips.map((c, i) => (
        <div className="clip" key={i}>
          {multi && (
            <div className="clip-head">
              <span className="clip-name">{t.clipN(i + 1)}</span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => props.onClips(clips.filter((_, j) => j !== i))}
                title={t.removeClip}
                aria-label={t.removeClip}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
          )}
          <TrimRange
            duration={duration}
            value={c}
            onChange={(r) => props.onClips(clips.map((x, j) => (j === i ? r : x)))}
            preview={preview}
          />
        </div>
      ))}
      <div className="clips-footer">
        <button className="btn btn-sm" onClick={() => props.onClips([...clips, nextClip(duration, clips)])}>
          <Icon name="plus" size={16} /> {t.addClip}
        </button>
        {multi && (
          <div className="clips-output">
            <span className="field-label">{t.clipsOutput}</span>
            <Segmented<"join" | "separate">
              label={t.clipsOutput}
              value={props.join ? "join" : "separate"}
              onChange={(v) => props.onJoin(v === "join")}
              options={[
                { value: "join", label: t.clipsJoin },
                { value: "separate", label: t.clipsSeparate },
              ]}
            />
          </div>
        )}
      </div>
      {multi && (
        <div className="faint" style={{ marginTop: 8 }}>
          {props.join ? t.clipsJoinHint(clips.length) : t.clipsSeparateHint(clips.length)}
        </div>
      )}
    </>
  );
}
