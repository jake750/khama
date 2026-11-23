import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Toast } from "../toast";
import { useEffect, useMemo, useState } from "react";
import { api, asAppError, type AppError, type HistoryEntry } from "../api";
import { errorText, numLocale, useI18n } from "../i18n";
import { ErrorBox } from "./ErrorBox";
import { isMobile } from "../platform";
import { useConfirm } from "./Dialog";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";
import { presetById } from "../presets";
import { logError } from "../log";

/** «اليوم»، «أمس»، أو التاريخ: عنوان كل مجموعة في السجلّ */
function dayLabel(lang: string, ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat(numLocale(lang), { numeric: "auto" });
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
  toast: Toast;
}) {
  const { t, lang } = useI18n();
  const [confirmNode, confirm] = useConfirm();
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

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // eslint-disable-next-line react-hooks/purity -- يكفي حساب الوقت عند تغيّر الفلتر
    const from = since === "all" ? 0 : Date.now() - Number(since) * 86_400_000;
    const items = (list ?? [])
      .filter((e) => !needle || [e.title, e.url, e.meta, e.file].some((x) => x.toLowerCase().includes(needle)))
      .filter((e) => kind === "all" || (kind === "video" ? e.kind === "video" : e.kind === kind))
      .filter((e) => e.date >= from)
      .slice(0, limit);
    // مجموعات حسب اليوم
    const groups: { label: string; items: HistoryEntry[] }[] = [];
    for (const e of items) {
      const label = dayLabel(lang, e.date);
      const g = groups[groups.length - 1];
      if (g?.label === label) g.items.push(e);
      else groups.push({ label, items: [e] });
    }
    return groups;
  }, [list, q, lang, kind, since, limit]);
  const total = list?.length ?? 0;

  // القائمة تتغيّر بعد نجاح الحذف فقط: إن فشل لا نوهم المستخدم بأنه حُذف ثم يعود في القراءة التالية
  const remove = (id: number) =>
    api
      .removeHistory(id)
      .then(() => setList((l) => l?.filter((e) => e.id !== id) ?? null))
      .catch(fail);

  const clear = async () => {
    if (!(await confirm(t.historyClear, t.historyConfirmClear))) return;
    await api
      .clearHistory()
      .then(() => setList([]))
      .catch(fail);
  };

  return (
    <div className="card history">
      {confirmNode}
      <div className="history-head">
        <div>
          <h2>{t.historyTitle}</h2>
          {list && list.length > 0 && <p className="faint">{t.historyCount(list.length)}</p>}
        </div>
        {list && list.length > 0 && (
          <button className="btn btn-sm btn-danger" onClick={clear}>
            <Icon name="trash" size={16} /> {t.historyClear}
          </button>
        )}
      </div>

      {list && list.length > 0 && (
        <label className="search">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.historySearch} spellCheck={false} />
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
                title={canDrag ? t.dragHint : undefined}
              >
                {e.thumbnail && !brokenThumbs.has(e.id) ? (
                  <img
                    className="history-thumb"
                    src={e.thumbnail}
                    alt=""
                    // سجلّات قديمة حفظت رابطًا انتهت صلاحيته: نعرض الأيقونة بدل صورة مكسورة
                    onError={() => setBrokenThumbs((b) => new Set(b).add(e.id))}
                  />
                ) : (
                  <div className={`history-thumb kind-${e.kind === "audio" ? "audio" : "video"}`}>
                    <Icon name={e.kind === "audio" ? "music" : e.kind === "convert" ? "convert" : "film"} size={20} />
                  </div>
                )}
                <div className="history-body">
                  <div className="job-title" dir="auto" title={e.title}>
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
                  <button className="icon-btn sm" title={t.remove} aria-label={t.remove} onClick={() => remove(e.id)}>
                    <Icon name="x" size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      ))}
      {shown.reduce((n, g) => n + g.items.length, 0) >= limit && total > limit && (
        <button className="btn btn-sm mt-3" onClick={() => setLimit((l) => l + 100)}>
          {t.showMore}
        </button>
      )}
    </div>
  );
}
