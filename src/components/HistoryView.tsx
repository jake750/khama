import { useEffect, useMemo, useState } from "react";
import { api, type HistoryEntry } from "../api";
import { useI18n } from "../i18n";
import { isMobile } from "../platform";
import { Icon } from "./Icon";

/** «اليوم»، «أمس»، أو التاريخ: عنوان كل مجموعة في السجلّ */
function dayLabel(lang: string, ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (days <= 1) {
    const s = rtf.format(-days, "day");
    return s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);
  }
  return d.toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** سجلّ التنزيلات: يبقى بعد إغلاق التطبيق، مع بحث وفتح المجلد وإعادة التنزيل */
export function HistoryView(props: {
  /** يتغيّر بعد كل تنزيل مكتمل، فنعيد القراءة */
  version: number;
  onDownloadAgain: (url: string) => void;
  onDragOut?: (file: string, thumbnail?: string | null) => void;
  toast: (msg: string) => void;
}) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<HistoryEntry[] | null>(null);
  const [q, setQ] = useState("");

  const load = () => api.getHistory().then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, [props.version]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = (list ?? []).filter(
      (e) => !needle || [e.title, e.url, e.meta, e.file].some((x) => x.toLowerCase().includes(needle)),
    );
    // مجموعات حسب اليوم
    const groups: { label: string; items: HistoryEntry[] }[] = [];
    for (const e of items) {
      const label = dayLabel(lang, e.date);
      const g = groups[groups.length - 1];
      if (g?.label === label) g.items.push(e);
      else groups.push({ label, items: [e] });
    }
    return groups;
  }, [list, q, lang]);

  const remove = async (id: number) => {
    await api.removeHistory(id).catch(() => {});
    setList((l) => l?.filter((e) => e.id !== id) ?? null);
  };

  const clear = async () => {
    if (!window.confirm(t.historyConfirmClear)) return;
    await api.clearHistory().catch(() => {});
    setList([]);
  };

  return (
    <div className="card history">
      <div className="history-head">
        <div>
          <h2>{t.historyTitle}</h2>
          {list && list.length > 0 && <p className="faint">{t.historyCount(list.length)}</p>}
        </div>
        {list && list.length > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={clear}>
            <Icon name="trash" size={14} /> {t.historyClear}
          </button>
        )}
      </div>

      {list && list.length > 0 && (
        <label className="search">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.historySearch} spellCheck={false} />
        </label>
      )}

      {list && list.length === 0 && (
        <div className="empty-state">
          <div className="empty-art">
            <Icon name="history" size={28} />
          </div>
          <p>{t.historyEmpty}</p>
        </div>
      )}
      {list && list.length > 0 && shown.length === 0 && <p className="faint" style={{ textAlign: "center" }}>{t.historyNoMatch}</p>}

      {shown.map((g) => (
        <section key={g.label} className="history-group">
          <h4>{g.label}</h4>
          {g.items.map((e) => {
            const canDrag = e.exists && !!props.onDragOut;
            return (
              <div
                key={e.id}
                className={`history-item ${e.exists ? "" : "missing"}`}
                draggable={canDrag || undefined}
                onDragStart={
                  canDrag
                    ? (ev) => {
                        ev.preventDefault();
                        props.onDragOut!(e.file, e.thumbnail);
                      }
                    : undefined
                }
                title={canDrag ? t.dragHint : undefined}
              >
                {e.thumbnail ? <img className="history-thumb" src={e.thumbnail} alt="" /> : (
                  <div className="history-thumb"><Icon name={e.kind === "audio" ? "music" : "film"} size={18} /></div>
                )}
                <div className="history-body">
                  <div className="job-title" title={e.title}>{e.title}</div>
                  <div className="job-meta">
                    <span>{new Date(e.date).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="faint">{e.meta}</span>
                    {!e.exists && !isMobile && <span className="missing-tag">{t.historyMissing}</span>}
                  </div>
                </div>
                <div className="job-actions">
                  {e.exists && !isMobile && (
                    <button className="btn btn-sm" onClick={() => api.revealFile(e.file).catch(() => {})}>
                      <Icon name="folder" size={14} /> {t.showInFolder}
                    </button>
                  )}
                  <button className="btn btn-sm btn-ghost" onClick={() => props.onDownloadAgain(e.url)} title={t.downloadAgain}>
                    <Icon name="retry" size={14} /> <span className="hide-sm">{t.downloadAgain}</span>
                  </button>
                  <button
                    className="icon-btn sm"
                    title={t.copyLink}
                    aria-label={t.copyLink}
                    onClick={() => navigator.clipboard.writeText(e.url).then(() => props.toast(t.toastCopied)).catch(() => {})}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                  <button className="icon-btn sm" title={t.remove} aria-label={t.remove} onClick={() => remove(e.id)}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
