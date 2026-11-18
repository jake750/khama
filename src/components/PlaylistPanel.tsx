import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { PlaylistEntry } from "../api";
import { formatDuration } from "../format";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

const PAGE = 200;

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
  // قناة فيها آلاف الفيديوهات: نرسم 200 ثم «اعرض المزيد»، لا الكل دفعة واحدة (T-44)
  const [shown, setShown] = useState(PAGE);
  // تصفية بالاسم أو القناة في القوائم الطويلة (U-48)؛ «الكل/لا شيء» يعمل على النتائج فقط
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase();
  const matches = useMemo(
    () =>
      entries
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => !q || e.title.toLocaleLowerCase().includes(q) || (e.uploader ?? "").toLocaleLowerCase().includes(q)),
    [entries, q],
  );
  const all = matches.every(({ i }) => selected.has(i));
  const setAll = (on: boolean) =>
    props.onSelected((cur) => {
      const next = new Set(cur);
      for (const { i } of matches) {
        if (on) next.add(i);
        else next.delete(i);
      }
      return next;
    });

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
        {entries.length > 20 && (
          <input
            className="input pl-search"
            type="search"
            value={query}
            placeholder={t.plSearch}
            aria-label={t.plSearch}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
          />
        )}
        <button className="btn btn-sm btn-ghost" disabled={matches.length === 0} onClick={() => setAll(!all)}>
          {all ? t.selectNone : t.selectAll}
        </button>
      </div>
      <ul className="pl-list">
        {matches.slice(0, shown).map(({ e, i }) => {
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
                  <span className="pl-thumb pl-thumb-empty">
                    <Icon name="music" size={16} />
                  </span>
                )}
                <span className="pl-text">
                  <span className="pl-title" title={e.title}>
                    {e.title}
                  </span>
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
                  <Icon name={picked.has(i) ? "check" : "plus"} size={16} />
                  <span>{props.pickLabel}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {q && matches.length === 0 && <p className="faint pl-none">{t.plNoMatch}</p>}
      {shown < matches.length && (
        <button className="btn btn-sm btn-ghost pl-more" onClick={() => setShown((n) => n + PAGE)}>
          {t.plShowMore(Math.min(PAGE, matches.length - shown), matches.length - shown)}
        </button>
      )}
    </div>
  );
}
