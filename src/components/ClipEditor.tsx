import { useRef, useState } from "react";
import { laneClips, nextClip } from "../downloadPlan";
import { useI18n } from "../i18n";
import { PreviewVideo } from "./download/PreviewVideo";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";
import { TrimRange, type PreviewLink, type Range } from "./TrimRange";

/** المقاطع تختلف عن «الملف كاملًا»: أكثر من مقطع، أو مقطع لا يغطي المدة كلها */
export function isTrimmed(duration: number, clips: Range[]): boolean {
  return clips.length > 1 || (clips.length === 1 && (clips[0].start > 0 || clips[0].end < duration - 0.05));
}

/**
 * محرّر المقاطع: معاينة، ومقطع أو أكثر ببداية ونهاية، ودمجها في ملف واحد أو حفظها منفصلة.
 * مشترك بين الفيديو الواحد وكل عنصر في قائمة التشغيل.
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
  // آخر مقطع حُذف: سطر «تراجع» حتى التعديل التالي، فمقطع ضُبط بدقة لا يضيع بنقرة خاطئة (R2-89)
  const [removed, setRemoved] = useState<{ clip: Range; at: number; from: Range[] } | null>(null);
  const undoable = removed && JSON.stringify(removed.from.filter((_, j) => j !== removed.at)) === JSON.stringify(clips) ? removed : null;
  const multi = clips.length > 1;
  // المقاطع المتداخلة في صفوف منفصلة على الخط الزمني الموحّد (D-103)
  const lanes = laneClips(clips);
  const preview: PreviewLink | null = props.previewUrl
    ? {
        now: () => video.current?.currentTime ?? null,
        seek: (v) => {
          if (video.current) video.current.currentTime = v;
        },
        toggle: () => {
          const v = video.current;
          if (!v) return;
          if (v.paused) void v.play().catch(() => {});
          else v.pause();
        },
      }
    : null;

  return (
    <>
      {props.previewUrl && <PreviewVideo video={video} src={props.previewUrl} poster={props.poster} />}
      {/* الموقع لا يعطي رابط معاينة: نقول ذلك ونشرح كيف تُعرف الأوقات بدل قص أعمى صامت (U-17) */}
      {!props.previewUrl && (
        <div className="alert info">
          <Icon name="info" size={16} />
          <span>{t.trimNoPreview}</span>
        </div>
      )}
      {/* خط زمني واحد يجمع المقاطع: أين يقع كل مقطع من الفيديو وأيها يتداخل (D-103) */}
      {multi && (
        <div className="clips-overview" dir="ltr" aria-hidden="true" style={{ height: `${lanes.count * 18 + 4}px` }}>
          {clips.map((c, i) => (
            <span
              key={i}
              style={{
                left: `${(c.start / duration) * 100}%`,
                width: `${((c.end - c.start) / duration) * 100}%`,
                top: `${lanes.lane[i] * 18 + 2}px`,
              }}
              title={t.clipN(i + 1)}
            >
              {i + 1}
            </span>
          ))}
        </div>
      )}
      {clips.map((c, i) => (
        <div className="clip" key={i}>
          {multi && (
            <div className="clip-head">
              <span className="clip-name">{t.clipN(i + 1)}</span>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setRemoved({ clip: c, at: i, from: clips });
                  props.onClips(clips.filter((_, j) => j !== i));
                }}
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
      {undoable && (
        <div className="url-note" role="status">
          <span className="grow">{t.clipRemoved(undoable.at + 1)}</span>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              props.onClips(undoable.from);
              setRemoved(null);
            }}
          >
            {t.undo}
          </button>
        </div>
      )}
      <div className="clips-footer">
        <button className="btn btn-sm" onClick={() => props.onClips([...clips, nextClip(duration, clips, preview?.now())])}>
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
      {multi && <div className="faint mt-2">{props.join ? t.clipsJoinHint(clips.length) : t.clipsSeparateHint(clips.length)}</div>}
    </>
  );
}
