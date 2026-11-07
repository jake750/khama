import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, asAppError, type ConvertRequest, type DownloadRequest, type JobUpdate, type Settings } from "./api";
import { ConvertView, defaultOptions, MEDIA_FILTER, type SourceFile } from "./components/ConvertView";
import { DownloadView } from "./components/DownloadView";
import { Icon } from "./components/Icon";
import { isActive, JobCard, type Job } from "./components/JobCard";
import { SettingsView } from "./components/SettingsView";
import { formatTimecode } from "./format";
import { dictionaries, I18n, type Dict } from "./i18n";
import { AnimatedList, reducedMotion, usePresence, useSlidingIndicator } from "./motion";
import { presetById } from "./presets";

type Tab = "download" | "convert" | "settings";

/** يطبّق الثيم ويعيد الثيم الفعلي. "system" يتبع إعداد النظام ويتغيّر معه */
function useTheme(theme: Settings["theme"] | undefined): "dark" | "light" {
  const media = useMemo(() => window.matchMedia("(prefers-color-scheme: light)"), []);
  const [systemLight, setSystemLight] = useState(media.matches);
  useEffect(() => {
    const onChange = () => setSystemLight(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [media]);
  const resolved = theme === "system" || !theme ? (systemLight ? "light" : "dark") : theme;
  const first = useRef(true);
  useEffect(() => {
    const root = document.documentElement;
    // عند التبديل (لا عند الفتح): الألوان تتلاشى إلى الثيم الجديد بدل الوميض
    if (!first.current && !reducedMotion()) {
      root.classList.add("theme-anim");
      const t = window.setTimeout(() => root.classList.remove("theme-anim"), 500);
      root.setAttribute("data-theme", resolved);
      return () => window.clearTimeout(t);
    }
    first.current = false;
    root.setAttribute("data-theme", resolved);
  }, [resolved]);
  return resolved;
}

function downloadMeta(t: Dict, r: DownloadRequest): string {
  if (r.kind === "audio") return r.audioFormat === "m4a" ? "AAC" : r.audioFormat.toUpperCase();
  return `${r.videoFormat.toUpperCase()} · ${r.quality === "best" ? t.best : r.quality === "2160" ? "4K" : r.quality + "p"}`;
}

const MEDIA_EXT = new Set(MEDIA_FILTER.extensions);
const isMedia = (p: string) => MEDIA_EXT.has(p.split(".").pop()?.toLowerCase() ?? "");
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defaultDir, setDefaultDir] = useState("");
  const [tab, setTab] = useState<Tab>("download");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [hw, setHw] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // تحديثات وصلت قبل أن نضيف العملية للقائمة (Rust أسرع أحيانًا من الرد)
  const pending = useRef(new Map<number, JobUpdate>());

  const lang = settings?.language ?? "en";
  const i18n = useMemo(() => ({ lang, t: dictionaries[lang] }), [lang]);
  const { t } = i18n;
  const tRef = useRef(t);
  tRef.current = t;

  const resolvedTheme = useTheme(settings?.theme);
  const [toastShown, toastLeaving] = usePresence(toastMsg, 260);
  const tabsRef = useRef<HTMLElement>(null);
  const tabPill = useSlidingIndicator(tabsRef, '.tab[aria-current="page"]', `${tab}|${lang}`);

  // اللغة تحدد اتجاه الصفحة: العربية من اليمين لليسار
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.title = t.appName;
  }, [lang, t]);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.defaultOutputDir().then((d) => setDefaultDir(d ?? ""));
  }, []);

  // مشفّرات كرت الشاشة: نفحصها عند أول فتح للمحوّل (تأخذ ثوانٍ)
  useEffect(() => {
    if (tab === "convert" && hw == null) api.hwEncoders().then(setHw).catch(() => setHw([]));
  }, [tab, hw]);

  // نستمع لأحداث التقدّم القادمة من Rust
  useEffect(() => {
    const unlisten = api.onJobUpdate((u) => {
      setJobs((prev) => {
        if (!prev.some((j) => j.id === u.id)) {
          pending.current.set(u.id, { ...pending.current.get(u.id), ...u });
          return prev;
        }
        return prev.map((j) => (j.id === u.id ? { ...j, ...u } : j));
      });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      api.saveSettings(next).catch(() => {});
      return next;
    });
  }, []);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg((m) => (m === msg ? null : m)), 2600);
  }, []);

  const chooseDir = useCallback(async () => {
    const dir = await open({ directory: true, defaultPath: settings?.outputDir ?? defaultDir });
    if (typeof dir === "string") update({ outputDir: dir });
  }, [settings?.outputDir, defaultDir, update]);

  const addJob = useCallback((id: number, job: Omit<Job, "id" | "state">) => {
    const early = pending.current.get(id);
    pending.current.delete(id);
    setJobs((prev) => [{ id, state: "starting", ...job, ...early } as Job, ...prev]);
  }, []);

  const startDownload = useCallback(
    async (request: DownloadRequest, title: string) => {
      const id = await api.startDownload(request);
      addJob(id, { type: "download", request, title, meta: downloadMeta(tRef.current, request) });
    },
    [addJob],
  );

  const startConvert = useCallback(
    async (convert: ConvertRequest, title: string, meta: string) => {
      const id = await api.startConvert(convert);
      addJob(id, { type: "convert", convert, title, meta });
    },
    [addJob],
  );

  /** يضيف ملفات للمحوّل ويقرأ معلوماتها */
  const addFiles = useCallback((paths: string[]) => {
    const media = paths.filter(isMedia);
    if (!media.length) return;
    setTab("convert");
    setFiles((prev) => {
      const fresh = media.filter((p) => !prev.some((f) => f.path === p));
      for (const p of fresh) {
        api
          .analyzeFile(p)
          .then((info) => setFiles((cur) => cur.map((f) => (f.path === p ? { ...f, info } : f))))
          .catch((e) => setFiles((cur) => cur.map((f) => (f.path === p ? { ...f, error: asAppError(e) } : f))));
      }
      return [...prev, ...fresh.map((path) => ({ path }))];
    });
  }, []);

  // السحب والإفلات من خارج التطبيق (Tauri يعطينا المسارات الحقيقية)
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragging(true);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        addFiles(p.paths);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [addFiles]);

  // المجلدات المراقَبة: Rust يخبرنا بالملف الجديد، ونضيفه لطابور التحويل
  useEffect(() => {
    const un = api.onWatchFile((hit) => {
      const p = presetById(hit.preset);
      startConvert(
        { inputs: [hit.path], preset: hit.preset, options: { ...defaultOptions(), hw: true, outDir: hit.outDir } },
        baseName(hit.path),
        p?.name[lang] ?? hit.preset,
      ).catch(() => {});
      toast(tRef.current.toastWatch(baseName(hit.path)));
    });
    return () => {
      un.then((f) => f());
    };
  }, [startConvert, toast, lang]);

  if (!settings) return null;

  const outputDir = settings.outputDir || defaultDir;
  const shown = jobs.filter((j) => (tab === "convert" ? j.type === "convert" : j.type === "download"));
  const finished = shown.filter((j) => !isActive(j));

  const retry = (j: Job) => {
    setJobs((p) => p.filter((x) => x.id !== j.id));
    if (j.type === "download" && j.request) startDownload(j.request, j.title).catch(() => {});
    if (j.type === "convert" && j.convert) startConvert(j.convert, j.title, j.meta).catch(() => {});
  };

  /** من نتائج الكشف: نقاط القطع = بداية المشهد، أو منتصف الفراغ الأسود/الصامت */
  const split = (j: Job) => {
    if (!j.convert || !j.markers?.length) return;
    const input = j.convert.inputs[0];
    // نعيد الترميز (بجودة عالية) حتى يكون القطع دقيقًا بالإطار، لا عند أقرب إطار مفتاحي
    const preset = "edit_h264";
    const splitAt = j.markers.map(([s, e]) => (s === e ? s : (s + e) / 2));
    startConvert(
      { inputs: [input], preset, options: { ...defaultOptions(), quality: "high", hw: settings.convertHw, start: j.convert.options.start, end: j.convert.options.end, splitAt } },
      baseName(input),
      t.splitHere,
    ).catch(() => {});
  };

  const copyMarkers = (j: Job) => {
    const text = (j.markers ?? []).map(([s, e]) => (s === e ? formatTimecode(s) : `${formatTimecode(s)}\t${formatTimecode(e)}`)).join("\n");
    navigator.clipboard.writeText(text).then(() => toast(t.toastCopied)).catch(() => {});
  };

  const tabs: { id: Tab; icon: "download" | "convert" | "settings"; label: string }[] = [
    { id: "download", icon: "download", label: t.tabDownload },
    { id: "convert", icon: "convert", label: t.tabConvert },
    { id: "settings", icon: "settings", label: t.tabSettings },
  ];

  return (
    <I18n.Provider value={i18n}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark"><Icon name="film" size={18} /></span>
            {t.appName}
          </div>
          <nav className="tabs" ref={tabsRef}>
            <span className="tab-pill" ref={tabPill} aria-hidden="true" />
            {tabs.map((x) => (
              <button key={x.id} className="tab" aria-current={tab === x.id ? "page" : undefined} onClick={() => setTab(x.id)}>
                <Icon name={x.icon} size={16} /> <span>{x.label}</span>
                {x.id !== "settings" && jobs.some((j) => isActive(j) && (x.id === "convert") === (j.type === "convert")) && (
                  <span className="tab-dot" aria-hidden="true" />
                )}
              </button>
            ))}
          </nav>
          <span className="spacer" />
          <button
            className="icon-btn"
            title={t.toggleTheme}
            aria-label={t.toggleTheme}
            onClick={() => update({ theme: resolvedTheme === "light" ? "dark" : "light" })}
          >
            <Icon name={resolvedTheme === "light" ? "moon" : "sun"} />
          </button>
        </header>

        <main className="main">
          <div className="container">
            {!settings.acceptedNotice && (
              <div className="alert info" style={{ marginTop: 0, alignItems: "center" }}>
                <Icon name="alert" size={16} />
                <span style={{ flex: 1 }}>{t.notice}</span>
                <button className="btn btn-sm" onClick={() => update({ acceptedNotice: true })}>{t.gotIt}</button>
              </div>
            )}

            <div className="view" key={tab}>
              {tab === "download" && (
                <DownloadView settings={settings} update={update} outputDir={outputDir} onChooseDir={chooseDir} onStart={startDownload} />
              )}
              {tab === "convert" && (
                <ConvertView
                  settings={settings}
                  update={update}
                  files={files}
                  addFiles={addFiles}
                  setFiles={setFiles}
                  hw={hw}
                  dragging={dragging}
                  onStart={startConvert}
                />
              )}
              {tab === "settings" && (
                <SettingsView
                  settings={settings}
                  update={update}
                  outputDir={outputDir}
                  onChooseDir={chooseDir}
                  onOpenDir={() => api.openOutputDir().catch(() => {})}
                  toast={toast}
                />
              )}

              {tab !== "settings" && (
                <>
                  <div className="jobs-header">
                    <h3>{tab === "convert" ? t.convertJobsTitle : t.jobsTitle}</h3>
                    {finished.length > 0 && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setJobs((p) => p.filter((j) => isActive(j) || !shown.includes(j)))}>
                        {t.clearFinished}
                      </button>
                    )}
                  </div>
                  {shown.length === 0 && <div className="card empty">{tab === "convert" ? t.convertJobsEmpty : t.jobsEmpty}</div>}
                  <AnimatedList className="job-list">
                    {shown.map((j) => (
                      <JobCard
                        key={j.id}
                        job={j}
                        onCancel={() => api.cancelDownload(j.id)}
                        onReveal={() => j.file && api.revealFile(j.file)}
                        onRetry={() => retry(j)}
                        onRemove={() => setJobs((p) => p.filter((x) => x.id !== j.id))}
                        onConvert={j.type === "download" && j.file ? () => addFiles([j.file!]) : undefined}
                        onSplit={j.markers?.length ? () => split(j) : undefined}
                        onCopyMarkers={j.markers?.length ? () => copyMarkers(j) : undefined}
                      />
                    ))}
                  </AnimatedList>
                </>
              )}
            </div>
          </div>
        </main>

        {dragging && tab !== "convert" && (
          <div className="drop-overlay">
            <div>
              <Icon name="convert" size={32} />
              <b>{t.dropHere}</b>
            </div>
          </div>
        )}

        {toastShown && (
          <div className={`toast ${toastLeaving ? "leaving" : ""}`} role="status">
            {toastShown}
          </div>
        )}
      </div>
    </I18n.Provider>
  );
}
