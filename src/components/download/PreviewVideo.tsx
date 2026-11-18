import { useEffect, useState, type RefObject } from "react";
import { formatDuration } from "../../format";
import { useI18n } from "../../i18n";
import { Icon } from "../Icon";

/** معاينة القص بأزرار بأسلوب التطبيق بدل تحكّم المتصفح الأصلي (D-101). التنقّل يتم بمقابض القص نفسها */
export function PreviewVideo({ video, src, poster }: { video: RefObject<HTMLVideoElement | null>; src: string; poster?: string | null }) {
  const { t } = useI18n();
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [now, setNow] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const sync = () => {
      setPlaying(!v.paused);
      setMuted(v.muted);
      setNow(v.currentTime);
      setTotal(isFinite(v.duration) ? v.duration : 0);
    };
    const events = ["play", "pause", "timeupdate", "loadedmetadata", "volumechange", "seeked"];
    events.forEach((e) => v.addEventListener(e, sync));
    return () => events.forEach((e) => v.removeEventListener(e, sync));
  }, [video, src]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };

  // الفيديو من الصفحة لا من ref المستلم: قاعدة react-hooks تمنع تعديل ما يصل عبر props
  const toggleMute = (e: React.MouseEvent<HTMLElement>) => {
    const v = e.currentTarget.closest(".trim-player")?.querySelector("video");
    if (v) v.muted = !v.muted;
  };

  return (
    <div className="trim-player">
      <video
        ref={video}
        className="trim-video"
        src={src}
        poster={poster ?? undefined}
        preload="metadata"
        aria-label={t.previewLabel}
        onClick={toggle}
      />
      <div className="trim-player-bar" dir="ltr">
        <button
          type="button"
          className="icon-btn sm"
          onClick={toggle}
          aria-label={playing ? t.pauseLabel : t.playLabel}
          title={playing ? t.pauseLabel : t.playLabel}
        >
          <Icon name={playing ? "pause" : "play"} size={16} />
        </button>
        <span className="ltr-num faint">
          {formatDuration(now)}
          {total > 0 && ` / ${formatDuration(total)}`}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn sm"
          onClick={toggleMute}
          aria-label={muted ? t.unmuteLabel : t.muteLabel}
          title={muted ? t.unmuteLabel : t.muteLabel}
        >
          <Icon name={muted ? "mute" : "volume"} size={16} />
        </button>
      </div>
    </div>
  );
}
