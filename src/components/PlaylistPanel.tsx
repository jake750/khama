import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, type PlaylistEntry } from "../api";
import type { EntryClips } from "../downloadPlan";
import { formatDuration } from "../format";
import { useI18n } from "../i18n";
import { ClipEditor, isTrimmed } from "./ClipEditor";
import { Icon } from "./Icon";

/** ما نعرفه عن العنصر لمعاينة القص: مدته الحقيقية ونسخة المعاينة */
interface EntryMedia {
  duration: number | null;
  previewUrl?: string | null;
  thumbnail?: string | null;
}

const PAGE = 200;

/**
 * عناصر قائمة التشغيل: تختار ما يُنزَّل (الكل افتراضيًا)، ويمكن قص أي عنصر محدَّد
 * إلى جزء أو عدة مقاطع (زر «قص» بجانبه) بنفس محرّر الفيديو الواحد.
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

  // Shift+نقر يحدد (أو يلغي) كل ما بين آخر عنصر نُقر وهذا، ضمن النتائج الظاهرة (R2-37)
  const lastClicked = useRef<number | null>(null);
  const toggleRow = (i: number, shift: boolean) => {
    const from = lastClicked.current;
    lastClicked.current = i;
    if (!shift || from == null || from === i) return props.onSelected((cur) => toggle(cur, i));
    const on = !selected.has(i);
    const pos = (n: number) => matches.findIndex((m) => m.i === n);
    const [a, b] = [pos(from), pos(i)].sort((x, y) => x - y);
    if (a < 0) return props.onSelected((cur) => toggle(cur, i));
    props.onSelected((cur) => {
      const next = new Set(cur);
      for (const { i: k } of matches.slice(a, b + 1)) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  };

  // العنصر المفتوح للقص، وما جُلب لكل عنصر (المدة الدقيقة ورابط المعاينة)
  const [open, setOpen] = useState<number | null>(null);
  const [media, setMedia] = useState<Map<number, EntryMedia | "loading" | "error">>(new Map());
  const setMediaAt = (i: number, v: EntryMedia | "loading" | "error") => setMedia((m) => new Map(m).set(i, v));

  function openTrim(i: number) {
    if (open === i) return setOpen(null);
    setOpen(i);
    const e = entries[i];
    if (media.has(i) && media.get(i) !== "error") return;
    // مدة القائمة تكفي للبدء، والمعاينة تصل حين ينتهي الجلب
    setMediaAt(i, e.duration ? { duration: e.duration, thumbnail: e.thumbnail } : "loading");
    api
      .probe(e.url)
      .then((info) =>
        setMediaAt(i, {
          duration: info.duration ?? e.duration ?? null,
          previewUrl: info.previewUrl,
          thumbnail: info.thumbnail ?? e.thumbnail,
        }),
      )
      .catch(() => setMediaAt(i, e.duration ? { duration: e.duration, thumbnail: e.thumbnail } : "error"));
  }

  /** ملخّص القص على زر العنصر: «0:30–1:10» أو «3 مقاطع» */
  const trimLabel = (c: EntryClips | undefined) => {
    if (!c || !isTrimmed(c.duration, c.clips)) return t.plTrim;
    if (c.clips.length > 1) return t.plTrimClips(c.clips.length);
    return `${formatDuration(c.clips[0].start)}–${formatDuration(c.clips[0].end)}`;
  };

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
          const c = props.clips.get(i);
          const trimmed = !!c && isTrimmed(c.duration, c.clips);
          const editing = open === i && on;
          const m = media.get(i);
          const md = m && m !== "loading" && m !== "error" && m.duration ? { ...m, duration: m.duration } : null;
          return (
            <li key={i} className="pl-row" data-on={on} data-editing={editing || undefined}>
              <label className="pl-main">
                <input type="checkbox" checked={on} onChange={() => {}} onClick={(ev) => toggleRow(i, ev.shiftKey)} title={t.plShiftHint} />
                <span className="pl-idx">{i + 1}</span>
                {e.thumbnail ? (
                  <img className="pl-thumb" src={e.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" decoding="async" />
                ) : (
                  <span className="pl-thumb pl-thumb-empty">
                    <Icon name="music" size={16} />
                  </span>
                )}
                <span className="pl-text">
                  <span className="pl-title" dir="auto" title={e.title}>
                    {e.title}
                  </span>
                  {sub && <span className="pl-sub faint">{sub}</span>}
                </span>
              </label>
              {on && (
                <button className="pl-stem" aria-pressed={trimmed} aria-expanded={editing} onClick={() => openTrim(i)} title={t.trimToggle}>
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
                  {m && m !== "loading" && !md && <div className="faint">{t.plTrimFailed}</div>}
                  {md && (
                    <>
                      <ClipEditor
                        duration={md.duration}
                        clips={c?.clips ?? [{ start: 0, end: md.duration }]}
                        onClips={(clips) => props.onClips(i, clips.length ? { duration: md.duration, clips, join: c?.join ?? true } : null)}
                        join={c?.join ?? true}
                        onJoin={(join) =>
                          props.onClips(i, { duration: md.duration, clips: c?.clips ?? [{ start: 0, end: md.duration }], join })
                        }
                        previewUrl={md.previewUrl}
                        poster={md.thumbnail}
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
      {q && matches.length === 0 && <p className="faint pl-none">{t.plNoMatch}</p>}
      {shown < matches.length && (
        <button className="btn btn-sm btn-ghost pl-more" onClick={() => setShown((n) => n + PAGE)}>
          {t.plShowMore(Math.min(PAGE, matches.length - shown), matches.length - shown)}
        </button>
      )}
    </div>
  );
}
