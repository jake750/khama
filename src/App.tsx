import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DownloadRequest, type JobUpdate, type Settings } from "./api";
import { DownloadView } from "./components/DownloadView";
import { Icon } from "./components/Icon";
import { isActive, JobCard, type Job } from "./components/JobCard";
import { SettingsView } from "./components/SettingsView";
import { dictionaries, I18n } from "./i18n";

type Tab = "download" | "settings";

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
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);
  return resolved;
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defaultDir, setDefaultDir] = useState("");
  const [tab, setTab] = useState<Tab>("download");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // تحديثات وصلت قبل أن نضيف العملية للقائمة (Rust أسرع أحيانًا من رد start_download)
  const pending = useRef(new Map<number, JobUpdate>());

  const lang = settings?.language ?? "en";
  const i18n = useMemo(() => ({ lang, t: dictionaries[lang] }), [lang]);
  const { t } = i18n;

  const resolvedTheme = useTheme(settings?.theme);

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

  const startDownload = useCallback(async (request: DownloadRequest, title: string) => {
    const id = await api.startDownload(request);
    const early = pending.current.get(id);
    pending.current.delete(id);
    setJobs((prev) => [{ id, request, title, state: "starting", ...early }, ...prev]);
  }, []);

  if (!settings) return null;

  const outputDir = settings.outputDir || defaultDir;
  const finished = jobs.filter((j) => !isActive(j));

  return (
    <I18n.Provider value={i18n}>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark"><Icon name="film" size={18} /></span>
            {t.appName}
          </div>
          <nav className="tabs">
            <button className="tab" aria-current={tab === "download" ? "page" : undefined} onClick={() => setTab("download")}>
              <Icon name="download" size={16} /> <span>{t.tabDownload}</span>
            </button>
            <button className="tab" aria-current={tab === "settings" ? "page" : undefined} onClick={() => setTab("settings")}>
              <Icon name="settings" size={16} /> <span>{t.tabSettings}</span>
            </button>
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

            {tab === "download" ? (
              <>
                <DownloadView settings={settings} update={update} outputDir={outputDir} onChooseDir={chooseDir} onStart={startDownload} />

                <div className="jobs-header">
                  <h3>{t.jobsTitle}</h3>
                  {finished.length > 0 && (
                    <button className="btn btn-sm btn-ghost" onClick={() => setJobs((p) => p.filter(isActive))}>
                      {t.clearFinished}
                    </button>
                  )}
                </div>
                {jobs.length === 0 ? (
                  <div className="card empty">{t.jobsEmpty}</div>
                ) : (
                  jobs.map((j) => (
                    <JobCard
                      key={j.id}
                      job={j}
                      onCancel={() => api.cancelDownload(j.id)}
                      onReveal={() => j.file && api.revealFile(j.file)}
                      onRetry={() => {
                        setJobs((p) => p.filter((x) => x.id !== j.id));
                        startDownload(j.request, j.title).catch(() => {});
                      }}
                      onRemove={() => setJobs((p) => p.filter((x) => x.id !== j.id))}
                    />
                  ))
                )}
              </>
            ) : (
              <SettingsView
                settings={settings}
                update={update}
                outputDir={outputDir}
                onChooseDir={chooseDir}
                onOpenDir={() => api.openOutputDir().catch(() => {})}
                toast={toast}
              />
            )}
          </div>
        </main>

        {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
      </div>
    </I18n.Provider>
  );
}
