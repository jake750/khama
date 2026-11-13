import { useState, type Dispatch, type SetStateAction } from "react";
import { api, type PlaylistEntry } from "../api";
import { formatDuration } from "../format";
import { useI18n } from "../i18n";
import { ClipEditor, isTrimmed } from "./ClipEditor";
import { Icon } from "./Icon";
import type { Range } from "./TrimRange";

/** المقاطع المختارة من عنصر في القائمة */
export interface EntryClips {
  duration: number;
  clips: Range[];
  join: boolean;
}

/** ما نعرفه عن العنصر لمعاينة القص (مدته الحقيقية ونسخة المعاينة) */
interface EntryMedia {
  duration: number | null;
  previewUrl?: string | null;
  thumbnail?: string | null;
}

/**
 * عناصر قائمة التشغيل: تختار ما يُنزَّل (الكل افتراضيًا)، ويمكن قص أي عنصر محدَّد
 * إلى جزء أو عدة مقاطع (زر المقص بجانبه).
 * pickLabel: عند اختيار "عناصر أحدّدها" لإزالة الموسيقى، يظهر بجانب كل عنصر محدَّد زر بهذا الاسم.
 */
export function PlaylistPanel(props: {
  entries: PlaylistEntry[];
  selected: Set<number>;
  onSelected: Dispatch<SetStateAction<Set<number>>>;
  pickLabel: string | null;
  picked: Set<number>;
  onPicked: Dispatch<SetStateAction<Set<number>>>;
  clips: Map<number, EntryClips>;
  onClips: (i: number, v: EntryClips | null) => void;
}) {
  const { t } = useI18n();
  const { entries, selected, picked } = props;
  const all = selected.size === entries.length;
  const [open, setOpen] = useState<number | null>(null);
  const [media, setMedia] = useState<Map<number, EntryMedia | "loading" | "error">>(new Map());

  const toggle = (set: Set<number>, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  };

  const setMediaAt = (i: number, v: EntryMedia | "loading" | "error") => setMedia((m) => new Map(m).set(i, v));

  /** فتح محرّر القص لعنصر: نجلب معلوماته مرة واحدة (المدة الدقيقة ونسخة المعاينة) */
  function openTrim(i: number) {
    if (open === i) {
      setOpen(null);
      return;
    }
    setOpen(i);
    const e = entries[i];
    if (media.has(i) && media.get(i) !== "error") return;
    // المدة من القائمة تكفي للبدء، والمعاينة تصل حين ينتهي الجلب
    setMediaAt(i, e.duration ? { duration: e.duration } : "loading");
    api
      .probe(e.url)
      .then((info) =>
        setMediaAt(i, {
          duration: info.duration ?? e.duration ?? null,
          previewUrl: info.previewUrl,
          thumbnail: info.thumbnail ?? e.thumbnail,
        }),
      )
      .catch(() => setMediaAt(i, e.duration ? { duration: e.duration } : "error"));
  }

  /** ملخّص القص على زر العنصر: «0:30–1:10» أو «3 مقاطع» */
  const trimLabel = (c: EntryClips | undefined) => {
    if (!c || !isTrimmed(c.duration, c.clips)) return t.plTrim;
    if (c.clips.length > 1) return t.plTrimClips(c.clips.length);
    return `${formatDuration(c.clips[0].start)}–${formatDuration(c.clips[0].end)}`;
  };

  return (
    <div className="playlist">
      <div className="pl-head">
        <span className="pl-count">{t.plSelected(selected.size, entries.length)}</span>
        <span className="spacer" />
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => props.onSelected(all ? new Set() : new Set(entries.map((_, i) => i)))}
        >
          {all ? t.selectNone : t.selectAll}
        </button>
      </div>
      <ul className={`pl-list ${open != null ? "editing" : ""}`}>
        {entries.map((e, i) => {
          const on = selected.has(i);
          const c = props.clips.get(i);
          const trimmed = !!c && isTrimmed(c.duration, c.clips);
          const sub = [e.uploader, formatDuration(e.duration)].filter(Boolean).join(" · ");
          const m = media.get(i);
          const editing = open === i && on;
          return (
            <li key={i} className="pl-row" data-on={on} data-editing={editing || undefined}>
              <label className="pl-main">
                <input type="checkbox" checked={on} onChange={() => props.onSelected((cur) => toggle(cur, i))} />
                <span className="pl-idx">{i + 1}</span>
                {e.thumbnail ? (
                  <img className="pl-thumb" src={e.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className="pl-thumb pl-thumb-empty"><Icon name="music" size={16} /></span>
                )}
                {e.guessed ? (
                  // الاسم الحقيقي في الطريق: هيكل مؤقت بدل رمز الرابط الغريب
                  <span className="pl-text pl-loading" aria-label={t.plTrimLoading}>
                    <span className="skeleton" />
                    <span className="skeleton" />
                  </span>
                ) : (
                  <span className="pl-text">
                    <span className="pl-title" title={e.title}>{e.title}</span>
                    {sub && <span className="pl-sub faint">{sub}</span>}
                  </span>
                )}
              </label>
              {on && (
                <button
                  className="pl-stem"
                  aria-pressed={trimmed}
                  aria-expanded={editing}
                  onClick={() => openTrim(i)}
                  title={t.trimToggle}
                >
                  <Icon name="scissors" size={16} />
                  <span className="ltr-num">{trimLabel(c)}</span>
                </button>
              )}
              {props.pickLabel && on && (
                <button
                  className="pl-stem"
                  aria-pressed={picked.has(i)}
                  onClick={() => props.onPicked((cur) => toggle(cur, i))}
                  title={props.pickLabel}
                >
                  <Icon name={picked.has(i) ? "check" : "plus"} size={16} />
                  <span>{props.pickLabel}</span>
                </button>
              )}
              {editing && (
                <div className="pl-clip trim-box">
                  {m === "loading" && <div className="faint">{t.plTrimLoading}</div>}
                  {(m === "error" || (m && m !== "loading" && !m.duration)) && <div className="faint">{t.plTrimFailed}</div>}
                  {m && m !== "loading" && m !== "error" && m.duration && (
                    <>
                      <ClipEditor
                        duration={m.duration}
                        clips={c?.clips ?? [{ start: 0, end: m.duration }]}
                        onClips={(clips) =>
                          props.onClips(i, clips.length ? { duration: m.duration!, clips, join: c?.join ?? true } : null)
                        }
                        join={c?.join ?? true}
                        onJoin={(join) =>
                          props.onClips(i, { duration: m.duration!, clips: c?.clips ?? [{ start: 0, end: m.duration! }], join })
                        }
                        previewUrl={m.previewUrl}
                        poster={m.thumbnail}
                      />
                      <div className="pl-clip-actions">
                        {trimmed && (
                          <button className="btn btn-sm btn-ghost" onClick={() => props.onClips(i, null)}>
                            {t.plTrimReset}
                          </button>
                        )}
                        <button className="btn btn-sm" onClick={() => setOpen(null)}>
                          {t.plTrimDone}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
