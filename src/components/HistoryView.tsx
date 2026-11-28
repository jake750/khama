import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Toast } from "../toast";
import { useEffect, useMemo, useRef, useState } from "react";
import { matches } from "../search";
import { api, asAppError, type AppError, type HistoryEntry } from "../api";
import { errorText, numLocale, useI18n } from "../i18n";
import { ErrorBox } from "./ErrorBox";
import { isMobile } from "../platform";
import { Icon } from "./Icon";
import { MoreMenu } from "./MoreMenu";
import { Segmented } from "./Segmented";
import { presetById } from "../presets";
import { logError } from "../log";

/** منسّق واحد لكل لغة، لا واحد لكل عنصر في كل رسم (R2-67) */
const relFormats = new Map<string, Intl.RelativeTimeFormat>();
function relFormat(lang: string): Intl.RelativeTimeFormat {
  let f = relFormats.get(lang);
  if (!f) relFormats.set(lang, (f = new Intl.RelativeTimeFormat(numLocale(lang), { numeric: "auto" })));
  return f;
}

/** حذف من السجل ينتظر مهلة «تراجع» ثم يُكتب، حتى لو غادر المستخدم التبويب (R2-34) */
const UNDO_MS = 5000;

/** «اليوم»، «أمس»، أو التاريخ: عنوان كل مجموعة في السجلّ */
function dayLabel(lang: string, ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  const rtf = relFormat(lang);
  if (days <= 1) {
    const s = rtf.format(-days, "day");
    return s.charAt(0).toLocaleUpperCase(lang) + s.slice(1);
  }
  return d.toLocaleDateString(numLocale(lang), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/** سجلّ التنزيلات: يبقى بعد إغلاق التطبيق، مع بحث وفتح المجلد وإعادة التنزيل */
export function HistoryView(props: {
  /** يتغيّر بعد كل تنزيل مكتمل، فنعيد القراءة */
  version: number;
  onDownloadAgain: (e: HistoryEntry) => void;
  onDragOut?: (file: string, thumbnail?: string | null) => void;
  /** R3-U12: الملف إلى المحوّل (تحويل، تحليل، مواضيع) بدل طريق مسدود */
  onConvert?: (file: string) => void;
  toast: Toast;
}) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<HistoryEntry[] | null>(null);
  const [q, setQ] = useState("");
  // تصفية بالنوع والتاريخ، ورسم أول 100 فقط حتى يطلب المستخدم المزيد (U-63، T-87)
  const [kind, setKind] = useState<"all" | "video" | "audio" | "convert">("all");
  const [since, setSince] = useState<"all" | "7" | "30">("all");
  const [limit, setLimit] = useState(100);
  const [brokenThumbs, setBrokenThumbs] = useState<Set<number>>(() => new Set());

  // خطأ القراءة يُعرض خطأً مع «حاول مرة أخرى»، لا سجلًّا فارغًا
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    // ردّ قديم (تنزيلان انتهيا معًا) لا يكتب فوق أحدث، ولا يعيد عنصرًا حُذف للتو.
    // تأخير قصير يجمع اكتمالات متتالية (قائمة تشغيل) في قراءة واحدة
    let alive = true;
    const timer = window.setTimeout(() => {
      api
        .getHistory()
        .then((l) => {
          if (!alive) return;
          setList(l);
          setLoadError(null);
        })
        .catch((e) => alive && setLoadError(asAppError(e)));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [props.version, reload]);
  const fail = (e: unknown) => props.toast(errorText(t, asAppError(e)));

  // ما يُحذف الآن ويُنتظر «تراجع» عنه: مخفي من القائمة حتى يُكتب الحذف أو يُلغى
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  // كل ما يطابق البحث والفلتر (قبل حد العرض): عدده يقرر زر «المزيد» ويظهر بجانب البحث (R2-12، R2-82)
  const filtered = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity -- يكفي حساب الوقت عند تغيّر الفلتر
    const from = since === "all" ? 0 : Date.now() - Number(since) * 86_400_000;
    return (list ?? [])
      .filter((e) => !hidden.has(e.id))
      .filter((e) => matches(q, [e.title, e.url, e.meta, e.file]))
      .filter((e) => kind === "all" || e.kind === kind)
      .filter((e) => e.date >= from);
  }, [list, q, kind, since, hidden]);
  const shown = useMemo(() => {
    // مجموعات حسب اليوم
    const groups: { label: string; items: HistoryEntry[] }[] = [];
    for (const e of filtered.slice(0, limit)) {
      const label = dayLabel(lang, e.date);
      const g = groups[groups.length - 1];
      if (g?.label === label) g.items.push(e);
      else groups.push({ label, items: [e] });
    }
    return groups;
  }, [filtered, lang, limit]);
  const total = list?.length ?? 0;

  /** يخفي العناصر فورًا مع «تراجع»، ويكتب الحذف بعد المهلة. فشل الكتابة يعيدها ويقول السبب */
  const remove = (gone: HistoryEntry[]) => {
    if (!gone.length) return;
    const ids = gone.map((e) => e.id);
    setHidden((h) => new Set([...h, ...ids]));
    let undone = false;
    const unhide = () =>
      setHidden((h) => {
        const n = new Set(h);
        ids.forEach((id) => n.delete(id));
        return n;
      });
    props.toast(t.removedN(gone.length), {
      label: t.undo,
      ms: UNDO_MS,
      run: () => {
        undone = true;
        unhide();
      },
    });
    window.setTimeout(() => {
      if (undone) return;
      api
        .removeHistoryMany(ids)
        .then(() => {
          setList((l) => l?.filter((e) => !ids.includes(e.id)) ?? null);
          unhide();
        })
        .catch((e) => {
          unhide();
          fail(e);
        });
    }, UNDO_MS + 200);
  };
  const missing = filtered.filter((e) => !e.exists);

  // Ctrl+F أو / يضعان المؤشر في البحث (R2-47)
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]");
      if (((e.ctrlKey || e.metaKey) && e.code === "KeyF") || (!typing && e.key === "/")) {
        if (!searchBox.current) return;
        e.preventDefault();
        searchBox.current.focus();
        searchBox.current.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // R3-U37: مسح السجل كله بمهلة «تراجع» كالحذف الفردي، بدل حذف فوري لا رجعة فيه
  const clear = () => {
    if (list?.length) remove(list);
  };

  return (
    <div className="card history">
      <div className="history-head">
        <div>
          <h2>{t.historyTitle}</h2>
          {list && list.length > 0 && <p className="faint">{t.historyCount(list.length - hidden.size)}</p>}
        </div>
        {/* R3-D48: الفعل الجماعي الخطِر داخل ⋯ لا زرًا أحمر بجانب العنوان (والتأكيد باقٍ) */}
        {list && list.length > 0 && <MoreMenu label={t.moreActions} items={[{ label: t.historyClear, icon: "trash", onClick: clear }]} />}
      </div>

      {list && list.length > 0 && (
        <label className="search">
          <Icon name="search" size={16} />
          <input
            ref={searchBox}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(100);
            }}
            // Escape يمسح البحث (R2-81)
            onKeyDown={(e) => {
              if (e.key === "Escape" && q) {
                e.stopPropagation();
                setQ("");
              }
            }}
            aria-label={t.historySearch}
            placeholder={t.historySearch}
            spellCheck={false}
          />
          {q && (
            <button type="button" className="icon-btn sm" aria-label={t.clearSearch} title={t.clearSearch} onClick={() => setQ("")}>
              <Icon name="x" size={14} />
            </button>
          )}
        </label>
      )}
      {list && list.length > 0 && (
        <div className="row-2 wrap mt-2">
          <Segmented<"all" | "video" | "audio" | "convert">
            label={t.kind}
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: t.filterAll },
              { value: "video", label: t.video },
              { value: "audio", label: t.audio },
              { value: "convert", label: t.historyConverted },
            ]}
          />
          <Segmented<"all" | "7" | "30">
            label={t.filterSince}
            value={since}
            onChange={setSince}
            options={[
              { value: "all", label: t.filterAnyTime },
              { value: "7", label: t.filterDays(7) },
              { value: "30", label: t.filterDays(30) },
            ]}
          />
        </div>
      )}

      {loadError && (
        <>
          <ErrorBox error={loadError} />
          <button className="btn btn-sm" onClick={() => setReload((n) => n + 1)}>
            <Icon name="retry" size={16} /> {t.tryAgain}
          </button>
        </>
      )}
      {list && list.length === 0 && !loadError && (
        <div className="empty-state">
          <div className="empty-art">
            <Icon name="history" size={24} />
          </div>
          <p>{t.historyEmpty}</p>
        </div>
      )}
      {list && list.length > 0 && (q.trim() || kind !== "all" || since !== "all" || (!isMobile && missing.length > 0)) && (
        <div className="history-found mt-2">
          {/* كم يطابق من كم (R2-82) */}
          {(q.trim() || kind !== "all" || since !== "all") && (
            <span className="faint ltr-num" role="status">
              {t.historyFound(filtered.length, total)}
            </span>
          )}
          <span className="spacer" />
          {/* كل ما فُقد ملفه بنقرة، مع تراجع (R2-35) */}
          {!isMobile && missing.length > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => remove(missing)}>
              <Icon name="trash" size={16} /> {t.removeMissing(missing.length)}
            </button>
          )}
        </div>
      )}
      {list === null && !loadError && (
        // هيكل بشكل السجل بدل صفحة فارغة أثناء القراءة (R2-32)
        <div className="history-loading" aria-busy="true" aria-label={t.historyLoading}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="history-item">
              <div className="history-thumb skeleton" />
              <div className="history-body stack-2">
                <div className="skeleton skeleton-title" />
                <div className="skeleton skeleton-tag" />
              </div>
            </div>
          ))}
        </div>
      )}
      {list && list.length > 0 && shown.length === 0 && <p className="faint text-center">{t.historyNoMatch}</p>}

      {shown.map((g) => (
        <section key={g.label} className="history-group">
          <h3 className="history-day">
            {g.label} <span className="faint ltr-num">{g.items.length}</span>
          </h3>
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
              >
                {/* تلميح السحب على الصورة لا على السطر كله، فلا يظهر مع كل مرور (R2-55) */}
                {e.thumbnail && !brokenThumbs.has(e.id) ? (
                  <img
                    className="history-thumb"
                    src={e.thumbnail}
                    alt=""
                    title={canDrag ? t.dragHint : undefined}
                    loading="lazy"
                    decoding="async"
                    // سجلّات قديمة حفظت رابطًا انتهت صلاحيته: نعرض الأيقونة بدل صورة مكسورة
                    onError={() => setBrokenThumbs((b) => new Set(b).add(e.id))}
                  />
                ) : (
                  <div className={`history-thumb kind-${e.kind === "audio" ? "audio" : "video"}`} title={canDrag ? t.dragHint : undefined}>
                    <Icon name={e.kind === "audio" ? "music" : e.kind === "convert" ? "convert" : "film"} size={20} />
                  </div>
                )}
                <div className="history-body">
                  <div className="job-title selectable" dir="auto" title={e.title}>
                    {e.title}
                  </div>
                  <div className="job-meta">
                    <span>{new Date(e.date).toLocaleTimeString(numLocale(lang), { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="faint">{e.kind === "convert" ? (presetById(e.meta)?.name[lang] ?? e.meta) : e.meta}</span>
                    {!e.exists && !isMobile && (
                      <span className="missing-tag">
                        <Icon name="alert" size={14} /> {t.historyMissing}
                      </span>
                    )}
                  </div>
                </div>
                <div className="job-actions">
                  {e.exists && !isMobile && (
                    <button
                      className="icon-btn sm"
                      title={t.openFile}
                      aria-label={t.openFile}
                      onClick={() => api.openFile(e.file).catch(fail)}
                    >
                      <Icon name="eye" size={16} />
                    </button>
                  )}
                  {e.exists && !isMobile && (
                    <button className="btn btn-sm" onClick={() => api.revealFile(e.file).catch(fail)}>
                      <Icon name="folder" size={16} /> {t.showInFolder}
                    </button>
                  )}
                  {e.exists && props.onConvert && (
                    <button
                      className="icon-btn sm"
                      title={t.sendToConvert}
                      aria-label={t.sendToConvert}
                      onClick={() => props.onConvert!(e.file)}
                    >
                      <Icon name="convert" size={16} />
                    </button>
                  )}
                  {e.kind !== "convert" && (
                    <button className="btn btn-sm" onClick={() => props.onDownloadAgain(e)} title={t.downloadAgain}>
                      <Icon name="retry" size={16} /> <span className="hide-sm">{t.downloadAgain}</span>
                    </button>
                  )}
                  <button
                    className="icon-btn sm"
                    title={e.kind === "convert" ? t.copySourcePath : t.copyLink}
                    aria-label={e.kind === "convert" ? t.copySourcePath : t.copyLink}
                    onClick={() =>
                      writeText(e.url)
                        .then(() => props.toast(t.toastCopied))
                        .catch(logError("copyLink"))
                    }
                  >
                    <Icon name="copy" size={16} />
                  </button>
                  <button className="icon-btn sm" title={t.remove} aria-label={t.remove} onClick={() => remove([e])}>
                    <Icon name="x" size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {filtered.length > limit && (
        <button className="btn btn-sm mt-3" onClick={() => setLimit((l) => l + 100)}>
          {t.showMore}
        </button>
      )}
    </div>
  );
}
