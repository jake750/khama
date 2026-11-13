import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, asAppError, type ConvertRequest, type DownloadRequest, type JobUpdate, type Settings, type ToolsInfo } from "./api";
import { ConvertView, defaultOptions, MEDIA_FILTER, type SourceFile } from "./components/ConvertView";
import { DownloadView, type StartMeta } from "./components/DownloadView";
import { HistoryView } from "./components/HistoryView";
import { Icon, type IconName } from "./components/Icon";
import { isActive, JobCard, type Job } from "./components/JobCard";
import { SettingsView } from "./components/SettingsView";
import { TitleBar } from "./components/TitleBar";
import { UpdateDialog } from "./components/UpdateDialog";
import { formatSpeed, formatTimecode } from "./format";
import { dictionaries, I18n, type Dict } from "./i18n";
import { AnimatedList, reducedMotion, SlideSwitch, usePresence, useSlidingIndicator } from "./motion";
import { isMobile } from "./platform";
import { presetById } from "./presets";

type Tab = "download" | "convert" | "history" | "settings";

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
  if (r.original) return t.driveFile;
  if (r.kind === "audio") return r.audioFormat === "m4a" ? "AAC" : r.audioFormat.toUpperCase();
  return `${r.videoFormat.toUpperCase()} · ${r.quality === "best" ? t.best : r.quality === "2160" ? "4K" : r.quality + "p"}`;
}

const MEDIA_EXT = new Set(MEDIA_FILTER.extensions);
const isMedia = (p: string) => MEDIA_EXT.has(p.split(".").pop()?.toLowerCase() ?? "");
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const stripExt = (n: string) => n.replace(/\.[^.]+$/, "");

/** صورة صغيرة تتبع المؤشر أثناء سحب ملف إلى برنامج آخر (الشعار، PNG بصيغة data URL) */
let dragIcon: Promise<string> | null = null;
function getDragIcon(): Promise<string> {
  dragIcon ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      c.getContext("2d")!.drawImage(img, 0, 0, 64, 64);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => resolve("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
    img.src = "/logo.png";
  });
  return dragIcon;
}

/** إشعار من النظام (يطلب الإذن مرة واحدة) */
async function notify(title: string, body: string) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title, body });
  } catch {
    // الإشعارات ليست أساسية
  }
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defaultDir, setDefaultDir] = useState("");
  const [tab, setTab] = useState<Tab>("download");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [hw, setHw] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [inject, setInject] = useState<{ url: string; n: number } | null>(null);
  const [settingsSection, setSettingsSection] = useState<{ id: string; n: number } | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(false);
  compactRef.current = compact;
  // تحديثات وصلت قبل أن نضيف العملية للقائمة (Rust أسرع أحيانًا من الرد)
  const pending = useRef(new Map<number, JobUpdate>());
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = settings;
  // التنزيلات المجدولة: id سالب (محلي) ← مؤقّت البدء
  const timers = useRef(new Map<number, number>());
  const nextLocalId = useRef(-1);

  const lang = settings?.language ?? "en";
  const i18n = useMemo(() => ({ lang, t: dictionaries[lang] }), [lang]);
  const { t } = i18n;
  const tRef = useRef(t);
  tRef.current = t;

  const resolvedTheme = useTheme(settings?.theme);
  const [toastShown, toastLeaving] = usePresence(toastMsg, 260);
  const tabsRef = useRef<HTMLElement>(null);
  const tabPill = useSlidingIndicator(tabsRef, '.tab[aria-current="page"]', `${tab}|${lang}|${compact}`);

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

  /** عند انتهاء عملية: إشعار (إن كانت النافذة في الخلفية) + إضافتها للسجلّ */
  const onFinished = useCallback((job: Job, u: JobUpdate) => {
    const tt = tRef.current;
    const s = settingsRef.current;
    const name = u.file ? baseName(u.file) : job.title;
    if (s?.notify && (document.hidden || !document.hasFocus())) {
      const title = u.state === "error" ? tt.notifyFailed : job.type === "convert" ? tt.notifyConvertDone : tt.notifyDone;
      notify(title, name);
    }
    if (u.state === "done" && job.type === "download" && job.request && u.file) {
      const request = job.request;
      const file = u.file;
      const titleIsUrl = /^https?:\/\//.test(job.title);
      // بدأ التنزيل قبل اكتمال المعاينة (أو عدة روابط): نجلب العنوان والصورة الآن
      const info =
        titleIsUrl || !job.thumbnail
          ? api.probe(request.url).then((p) => ({ title: p.title, thumbnail: p.thumbnail ?? null })).catch(() => null)
          : Promise.resolve(null);
      info
        .then((p) =>
          api.addHistory({
            id: Date.now() * 1000 + (Math.abs(job.id) % 1000),
            title: titleIsUrl ? (p?.title ?? stripExt(name)) : job.title,
            url: request.url,
            file,
            kind: request.kind,
            meta: job.meta,
            thumbnail: job.thumbnail ?? p?.thumbnail ?? null,
            date: Date.now(),
          }),
        )
        .then(() => setHistoryVersion((v) => v + 1))
        .catch(() => {});
    }
  }, []);

  // نستمع لأحداث التقدّم القادمة من Rust
  useEffect(() => {
    const unlisten = api.onJobUpdate((u) => {
      const job = jobsRef.current.find((j) => j.id === u.id);
      if (job && (u.state === "done" || u.state === "error") && job.state !== u.state) onFinished(job, u);
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
  }, [onFinished]);

  // مراقبة الحافظة (Rust): رابط منسوخ جديد يظهر كاقتراح في شاشة التنزيل
  useEffect(() => {
    const un = api.onClipboardUrl((url) => setClipUrl(url));
    return () => {
      un.then((f) => f());
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

  /** مجلد حفظ جديد، ويُضاف لأعلى قائمة «مجلدات استخدمتها مؤخرًا» */
  const pickDir = useCallback(
    (dir: string) => {
      const prev = settingsRef.current;
      const old = prev?.outputDir || defaultDir;
      const recent = [dir, old, ...(prev?.recentDirs ?? [])].filter((d, i, a) => d && a.indexOf(d) === i).slice(0, 6);
      update({ outputDir: dir, recentDirs: recent });
    },
    [update, defaultDir],
  );

  const chooseDir = useCallback(async () => {
    const dir = await open({ directory: true, defaultPath: settings?.outputDir ?? defaultDir });
    if (typeof dir === "string") pickDir(dir);
  }, [settings?.outputDir, defaultDir, pickDir]);

  const addJob = useCallback((id: number, job: Omit<Job, "id" | "state">) => {
    const early = pending.current.get(id);
    pending.current.delete(id);
    setJobs((prev) => [{ id, state: "starting", ...job, ...early } as Job, ...prev]);
  }, []);

  const startDownload = useCallback(
    async (request: DownloadRequest, meta: StartMeta, at?: number) => {
      const base = { type: "download" as const, request, title: meta.title, thumbnail: meta.thumbnail, meta: downloadMeta(tRef.current, request) };
      if (at && at > Date.now()) {
        // مجدول: بطاقة محلية تنتظر، ثم يبدأ التنزيل الحقيقي في وقته
        const localId = nextLocalId.current--;
        setJobs((prev) => [{ id: localId, state: "scheduled", at, ...base } as Job, ...prev]);
        const timer = window.setTimeout(async () => {
          timers.current.delete(localId);
          setJobs((prev) => prev.filter((j) => j.id !== localId));
          try {
            const id = await api.startDownload(request);
            addJob(id, base);
          } catch (e) {
            setJobs((prev) => [{ id: localId, state: "error", error: asAppError(e), ...base } as Job, ...prev]);
          }
        }, at - Date.now());
        timers.current.set(localId, timer);
        return;
      }
      const id = await api.startDownload(request);
      addJob(id, base);
    },
    [addJob],
  );

  const cancel = useCallback((j: Job) => {
    const timer = timers.current.get(j.id);
    if (timer != null) {
      window.clearTimeout(timer);
      timers.current.delete(j.id);
      setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, state: "canceled" } : x)));
      return;
    }
    api.cancelDownload(j.id);
  }, []);

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

  /** سحب ملف مكتمل إلى Premiere/DaVinci/CapCut أو إلى أي مجلد */
  const dragOut = useCallback(async (file: string) => {
    try {
      await startDrag({ item: [file], icon: await getDragIcon() });
    } catch {
      // سحب فاشل لا يحتاج رسالة
    }
  }, []);

  // السحب والإفلات من خارج التطبيق (Tauri يعطينا المسارات الحقيقية)
  useEffect(() => {
    if (isMobile) return;
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

  const toggleCompact = useCallback(() => {
    const next = !compact;
    api
      .setCompact(next)
      .then(() => {
        setCompact(next);
        if (next) setTab("download");
      })
      .catch(() => {});
  }, [compact]);

  // الكمبيوتر بنافذة عادية (لا هاتف ولا نافذة مصغّرة)
  const desktop = !isMobile && !compact;

  // إصدار yt-dlp لشريط الحالة
  const [tools, setTools] = useState<ToolsInfo | null>(null);
  useEffect(() => {
    if (desktop && !tools) api.toolsInfo().then(setTools).catch(() => {});
  }, [desktop, tools]);

  // سلوك تطبيق كمبيوتر لا صفحة ويب: لا قائمة المتصفح عند النقر بالزر الأيمن، ولا إعادة تحميل
  // أو طباعة من لوحة المفاتيح، واختصارات للتنقّل (Ctrl+1..3 والإعدادات Ctrl+,)
  useEffect(() => {
    if (isMobile) return;
    const order: Tab[] = ["download", "convert", "history"];
    const onMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      const editable = el?.closest("input, textarea, [contenteditable]");
      const selected = !!window.getSelection()?.toString();
      if (!editable && !selected) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (import.meta.env.PROD && (k === "f5" || (mod && (k === "r" || k === "p")))) {
        e.preventDefault();
        return;
      }
      if (!mod || e.altKey || compactRef.current) return;
      if (k >= "1" && k <= "3") {
        e.preventDefault();
        setTab(order[Number(k) - 1]);
      } else if (k === ",") {
        e.preventDefault();
        setTab("settings");
      }
    };
    document.addEventListener("contextmenu", onMenu);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("contextmenu", onMenu);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!settings) return null;

  const outputDir = settings.outputDir || defaultDir;
  const shown = jobs.filter((j) => (tab === "convert" ? j.type === "convert" : j.type === "download"));
  const finished = shown.filter((j) => !isActive(j) && j.state !== "scheduled");

  const retry = (j: Job) => {
    setJobs((p) => p.filter((x) => x.id !== j.id));
    if (j.type === "download" && j.request) startDownload(j.request, { title: j.title, thumbnail: j.thumbnail }).catch(() => {});
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

  const tabs: { id: Tab; icon: IconName; label: string }[] = [
    { id: "download", icon: "download", label: t.tabDownload },
    { id: "convert" as Tab, icon: "convert" as IconName, label: t.tabConvert },
    { id: "history", icon: "history", label: t.tabHistory },
    { id: "settings", icon: "settings", label: t.tabSettings },
  ];

  // الكمبيوتر بنافذة عادية: شريط جانبي ولوحتان وشريط حالة. الهاتف والنافذة المصغّرة: التصميم المضغوط
  const twoPanes = desktop && (tab === "download" || tab === "convert");
  const running = jobs.filter(isActive);
  const runningOf = (type: Job["type"]) => running.filter((j) => j.type === type).length;
  const totalSpeed = running.reduce((sum, j) => sum + (j.state === "downloading" && j.speed ? j.speed : 0), 0);

  const toolButtons = (
    <>
      {!isMobile && (
        <button className="icon-btn ghost" title={compact ? t.compactOff : t.compactOn} aria-label={compact ? t.compactOff : t.compactOn} onClick={toggleCompact}>
          <Icon name={compact ? "maximize" : "minimize"} size={desktop ? 16 : 20} />
        </button>
      )}
      <button
        className="icon-btn ghost"
        title={t.toggleTheme}
        aria-label={t.toggleTheme}
        onClick={() => update({ theme: resolvedTheme === "light" ? "dark" : "light" })}
      >
        <Icon name={resolvedTheme === "light" ? "moon" : "sun"} size={desktop ? 16 : 20} />
      </button>
    </>
  );

  const notice = !settings.acceptedNotice && (
    <div className="alert info notice-bar">
      <Icon name="alert" size={16} />
      <span style={{ flex: 1 }}>{t.notice}</span>
      <button className="btn btn-sm" onClick={() => update({ acceptedNotice: true })}>{t.gotIt}</button>
    </div>
  );

  const screen = (
    <>
      {tab === "download" && (
        <DownloadView
          settings={settings}
          update={update}
          outputDir={outputDir}
          onChooseDir={chooseDir}
          onPickDir={pickDir}
          onStart={startDownload}
          clipUrl={clipUrl}
          onClipDone={() => setClipUrl(null)}
          inject={inject}
          onOpenSettings={(id) => {
            setSettingsSection({ id, n: Date.now() });
            setTab("settings");
          }}
          toast={toast}
        />
      )}
      {tab === "convert" && (
        <ConvertView settings={settings} update={update} files={files} addFiles={addFiles} setFiles={setFiles} hw={hw} dragging={dragging} onStart={startConvert} />
      )}
      {tab === "history" && (
        <HistoryView
          version={historyVersion}
          onDownloadAgain={(url) => {
            setInject({ url, n: Date.now() });
            setTab("download");
          }}
          onDragOut={isMobile ? undefined : (file) => dragOut(file)}
          toast={toast}
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
          section={settingsSection}
        />
      )}
    </>
  );

  const queue = (tab === "download" || tab === "convert") && (
    <>
      <div className="jobs-header">
        <h3>
          {tab === "convert" ? t.convertJobsTitle : t.jobsTitle}
          {desktop && shown.length > 0 && <span className="count">{shown.length}</span>}
        </h3>
        {finished.length > 0 && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setJobs((p) => p.filter((j) => isActive(j) || j.state === "scheduled" || !shown.includes(j)))}
          >
            {t.clearFinished}
          </button>
        )}
      </div>
      {shown.length === 0 && (
        <div className="empty-state">
          <div className="empty-art">
            <Icon name={tab === "convert" ? "convert" : "download"} size={24} />
          </div>
          <p>{tab === "convert" ? t.convertJobsEmpty : t.jobsEmpty}</p>
          {tab === "download" && !isMobile && <p className="faint">{t.jobsEmptyHint}</p>}
        </div>
      )}
      <AnimatedList className="job-list">
        {shown.map((j) => (
          <JobCard
            key={j.id}
            job={j}
            onCancel={() => cancel(j)}
            onReveal={isMobile ? undefined : () => j.file && api.revealFile(j.file)}
            onRetry={() => retry(j)}
            onRemove={() => setJobs((p) => p.filter((x) => x.id !== j.id))}
            onConvert={j.type === "download" && j.file ? () => addFiles([j.file!]) : undefined}
            onSplit={j.markers?.length ? () => split(j) : undefined}
            onCopyMarkers={j.markers?.length ? () => copyMarkers(j) : undefined}
            onDragOut={!isMobile && j.file ? () => dragOut(j.file!) : undefined}
          />
        ))}
      </AnimatedList>
    </>
  );

  const overlays = (
    <>
      {dragging && tab !== "convert" && (
        <div className="drop-overlay">
          <div>
            <Icon name="convert" size={24} />
            <b>{t.dropHere}</b>
          </div>
        </div>
      )}

      {toastShown && (
        <div className={`toast ${toastLeaving ? "leaving" : ""}`} role="status">
          {toastShown}
        </div>
      )}

      {/* تحديثات خامة: الكمبيوتر يثبّتها بنفسه، والهاتف يفتح رابط ملف APK الجديد */}
      <UpdateDialog />
    </>
  );

  if (desktop) {
    return (
      <I18n.Provider value={i18n}>
        <div className="app desktop">
          <TitleBar tools={toolButtons}>
            <div className="brand" data-tauri-drag-region>
              <img className="brand-mark" src="/logo.png" alt="" data-tauri-drag-region />
              <span className="brand-name" data-tauri-drag-region>
                {t.appName}
              </span>
            </div>
          </TitleBar>

          <nav className="sidebar tabs" ref={tabsRef} aria-label={t.appName}>
            <span className="tab-pill" ref={tabPill} aria-hidden="true" />
            {tabs.map((x, i) => {
              const busy = x.id === "download" ? runningOf("download") : x.id === "convert" ? runningOf("convert") : 0;
              return (
                <button
                  key={x.id}
                  className={`tab side-item ${x.id === "settings" ? "side-bottom" : ""}`}
                  aria-current={tab === x.id ? "page" : undefined}
                  onClick={() => setTab(x.id)}
                  title={x.label + t.shortcutHint(x.id === "settings" ? "Ctrl+," : `Ctrl+${i + 1}`)}
                >
                  <Icon name={x.icon} size={18} />
                  <span className="side-label">{x.label}</span>
                  {busy > 0 && <span className="side-badge">{busy}</span>}
                </button>
              );
            })}
          </nav>

          <main className={`workspace ${twoPanes ? "split" : ""}`}>
            <section className="pane form-pane">
              <div className={`pane-inner ${tab === "settings" ? "wide" : ""}`}>
                {notice}
                <SlideSwitch id={tab} index={tabs.findIndex((x) => x.id === tab)}>
                  <div className="view">{screen}</div>
                </SlideSwitch>
              </div>
            </section>
            {twoPanes && <aside className="pane queue-pane">{queue}</aside>}
          </main>

          <footer className="statusbar">
            <span className={`status-dot ${running.length ? "busy" : ""}`} aria-hidden="true" />
            <span>{running.length ? t.statusActive(running.length) : t.statusIdle}</span>
            {totalSpeed > 0 && <span className="ltr">{formatSpeed(t, totalSpeed)}</span>}
            <span className="spacer" />
            <button className="status-link" onClick={() => api.openOutputDir().catch(() => {})} title={outputDir}>
              <Icon name="folder" size={12} />
              <span>{t.statusSaveTo}:</span>
              <span className="ltr">{baseName(outputDir) || outputDir}</span>
            </button>
            {tools?.ytdlp && <span className="ltr">yt-dlp {tools.ytdlp}</span>}
          </footer>

          {overlays}
        </div>
      </I18n.Provider>
    );
  }

  return (
    <I18n.Provider value={i18n}>
      <div className={`app ${compact ? "compact" : ""}`}>
        {/* النافذة المصغّرة على الكمبيوتر بلا شريط النظام: شريطنا يبقى للسحب والإغلاق */}
        {!isMobile && <TitleBar />}
        <header className="topbar">
          <div className="brand">
            <img className="brand-mark" src="/logo.png" alt="" />
            <span className="brand-name">{t.appName}</span>
          </div>
          <nav className="tabs" ref={tabsRef}>
            <span className="tab-pill" ref={tabPill} aria-hidden="true" />
            {tabs.map((x) => (
              <button
                key={x.id}
                className="tab"
                aria-current={tab === x.id ? "page" : undefined}
                onClick={() => setTab(x.id)}
                title={x.label}
              >
                <Icon name={x.icon} size={16} /> <span>{x.label}</span>
                {(x.id === "download" || x.id === "convert") && runningOf(x.id) > 0 && <span className="tab-dot" aria-hidden="true" />}
              </button>
            ))}
          </nav>
          <span className="spacer" />
          <div className="topbar-tools">{toolButtons}</div>
        </header>

        <main className="main">
          <div className={`container ${tab === "settings" ? "wide" : ""}`}>
            {notice}
            <SlideSwitch id={tab} index={tabs.findIndex((x) => x.id === tab)}>
              <div className="view">
                {screen}
                {queue}
              </div>
            </SlideSwitch>
          </div>
        </main>

        {overlays}
      </div>
    </I18n.Provider>
  );
}
