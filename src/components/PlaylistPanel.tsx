import type { Dispatch, SetStateAction } from "react";
import type { PlaylistEntry } from "../api";
import { formatDuration } from "../format";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

/**
 * عناصر قائمة التشغيل: تختار ما يُنزَّل (الكل افتراضيًا).
 * pickLabel: عند اختيار "عناصر أحدّدها" لإزالة الموسيقى، يظهر بجانب كل عنصر محدَّد زر بهذا الاسم.
 */
export function PlaylistPanel(props: {
  entries: PlaylistEntry[];
  selected: Set<number>;
  onSelected: Dispatch<SetStateAction<Set<number>>>;
  pickLabel: string | null;
  picked: Set<number>;
  onPicked: Dispatch<SetStateAction<Set<number>>>;
}) {
  const { t } = useI18n();
  const { entries, selected, picked } = props;
  const all = selected.size === entries.length;

  const toggle = (set: Set<number>, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
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
      <ul className="pl-list">
        {entries.map((e, i) => {
          const on = selected.has(i);
          const sub = [e.uploader, formatDuration(e.duration)].filter(Boolean).join(" · ");
          return (
            <li key={i} className="pl-row" data-on={on}>
              <label className="pl-main">
                <input type="checkbox" checked={on} onChange={() => props.onSelected((cur) => toggle(cur, i))} />
                <span className="pl-idx">{i + 1}</span>
                {e.thumbnail ? (
                  <img className="pl-thumb" src={e.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className="pl-thumb pl-thumb-empty"><Icon name="music" size={14} /></span>
                )}
                <span className="pl-text">
                  <span className="pl-title" title={e.title}>{e.title}</span>
                  {sub && <span className="pl-sub faint">{sub}</span>}
                </span>
              </label>
              {props.pickLabel && on && (
                <button
                  className="pl-stem"
                  aria-pressed={picked.has(i)}
                  onClick={() => props.onPicked((cur) => toggle(cur, i))}
                  title={props.pickLabel}
                >
                  <Icon name={picked.has(i) ? "check" : "plus"} size={14} />
                  <span>{props.pickLabel}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
