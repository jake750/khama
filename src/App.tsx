import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, asAppError, type AppError, type ConvertRequest, type DownloadRequest, type JobUpdate, type Settings } from "./api";
import { ConvertView, defaultOptions, MEDIA_FILTER, type SourceFile } from "./components/ConvertView";
import { DownloadView, newDownloadSession, type StartMeta } from "./components/DownloadView";
import { GuideView } from "./components/GuideView";
import { HistoryView } from "./components/HistoryView";
import { Icon, type IconName } from "./components/Icon";
import { Dialog, useConfirm } from "./components/Dialog";
import { isActive, JobCard, mergeUpdate, type Job } from "./components/JobCard";
import { SettingsView } from "./components/SettingsView";
import { Tour, Welcome, type TourStep } from "./components/Tour";
import { UpdateDialog } from "./components/UpdateDialog";
import { formatTimecode } from "./format";
import { dictionaries, I18n, type Dict } from "./i18n";
import { AnimatedList, Presence, reducedMotion, SlideSwitch, usePresence, useSlidingIndicator } from "./motion";
import { isMobile } from "./platform";
import type { Toast, ToastAction } from "./toast";
import { presetById } from "./presets";
import { logError } from "./log";
import { nextTheme } from "./theme";
import { limiter } from "./limit";

/** تحليل الملفات المضافة للمحوّل: 4 في كل مرة (U-93) */
const analyzeTurn = limiter(4);

type Tab = "download" | "convert" | "history" | "settings" | "guide";

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
  // تبديل الثيم: دائرة تكبر من مكان الضغط وتكشف الثيم الجديد (bubbly.css).
  // الثيمان لقطتان كاملتان، فلا تظهر ألوان نصفها قديم كما في التلاشي (D-79)
  const lastPress = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => (lastPress.current = { x: e.clientX, y: e.clientY, at: performance.now() });
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);
  const switching = useRef(0);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => root.setAttribute("data-theme", resolved);
    const from = root.getAttribute("data-theme");
    if (!from || from === resolved || reducedMotion() || !document.startViewTransition) return apply();
    // من مكان آخر ضغطة إن كانت للتوّ، وإلا من وسط الشاشة (اختصار، أو تغيّر ثيم النظام)
    const p = lastPress.current;
    const recent = p && performance.now() - p.at < 1500;
    const x = recent ? p.x : window.innerWidth / 2;
    const y = recent ? p.y : window.innerHeight / 2;
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    root.style.setProperty("--theme-x", `${x}px`);
    root.style.setProperty("--theme-y", `${y}px`);
    root.style.setProperty("--theme-r", `${Math.ceil(r)}px`);
    root.dataset.themeSwitch = "";
    const id = ++switching.current;
    // إن تُخطّي الانتقال (النافذة مخفية مثلًا) يُطبَّق الثيم فورًا، ولا نريد خطأً في السجل
    const vt = document.startViewTransition(apply);
    vt.ready.catch(() => {});
    vt.finished
      .catch(() => {})
      .then(() => {
        if (switching.current === id) delete root.dataset.themeSwitch;
      });
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
    img.onerror = () =>
      resolve("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
    img.src = "/logo.png";
  });
  return dragIcon;
}

/** إشعار من النظام (يطلب الإذن مرة واحدة) */
async function notify(title: string, body: string) {
  try {
    // الإذن يُطلب عند تفعيل «الإشعارات» في الإعدادات، لا فجأة بعد أول تنزيل (T-75)
    if (await isPermissionGranted()) sendNotification({ title, body });
  } catch {
    // الإشعارات ليست أساسية
  }
}

/** ما يكتبه Rust في السجلّ عند انتهاء التنزيل (T-19) */
function withHistory(request: DownloadRequest, base: { title: string; meta: string; thumbnail?: string | null }): DownloadRequest {
  return { ...request, history: { title: base.title, meta: base.meta, thumbnail: base.thumbnail ?? null } };
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  // فشل قراءة الإعدادات عند الفتح: نعرض السبب بدل شاشة فارغة
  const [bootError, setBootError] = useState<AppError | null>(null);
  const [defaultDir, setDefaultDir] = useState("");
  const [tab, setTab] = useState<Tab>("download");
  const tabNowRef = useRef<Tab>("download");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [hw, setHw] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toastMsg, setToastMsg] = useState<{ msg: string; action?: ToastAction } | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [inject, setInject] = useState<{ url: string; n: number } | null>(null);
  const [settingsSection, setSettingsSection] = useState<{ id: string; n: number } | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [compact, setCompact] = useState(false);
  // إغلاق النافذة وفيها عمليات جارية (U-27، U-44)
  const [closeAsk, setCloseAsk] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  // تحديث خامة متاح: شارة على «الإعدادات» بدل نافذة عند الإقلاع (U-31، U-32)
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateRequest, setUpdateRequest] = useState(0);
  const [touring, setTouring] = useState(false);
  const jobsRef = useRef<Job[]>([]);
  const settingsRef = useRef<Settings | null>(null);
  // التنزيلات المجدولة: بطاقات بـ id سالب (محلي)، تُحفظ في scheduled.json
  const nextLocalId = useRef(-1);
  // حالة شاشة التنزيل التي تبقى بين التبويبات (الرابط والمعاينة)
  const [downloadSession] = useState(newDownloadSession);
  const [scheduledLoaded, setScheduledLoaded] = useState(false);

  const lang = settings?.language ?? "en";
  const i18n = useMemo(() => ({ lang, t: dictionaries[lang] }), [lang]);
  const { t } = i18n;
  const tRef = useRef(t);
  const [confirmNode, confirm] = useConfirm();

  const resolvedTheme = useTheme(settings?.theme);
  const [toastShown, toastLeaving] = usePresence(toastMsg, 260);
  const tabsRef = useRef<HTMLElement>(null);
  const tabPill = useSlidingIndicator(tabsRef, '.tab[aria-current="page"]', `${tab}|${lang}|${compact}`);

  // تغيير اللغة يغيّر النصوص فقط: أماكن العناصر ثابتة (تخطيط من اليمين لليسار دائمًا)،
  // والنص الإنجليزي يُرتَّب داخل مكانه من اليسار لليمين (bubbly.css)
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = "rtl";
    document.title = t.appName;
  }, [lang, t]);

  useEffect(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch((e) => setBootError(asAppError(e)));
    api.defaultOutputDir().then((d) => setDefaultDir(d ?? ""));
  }, []);

  // مشفّرات كرت الشاشة: نفحصها عند أول فتح للمحوّل (تأخذ ثوانٍ)
  useEffect(() => {
    if (tab === "convert" && hw == null)
      api
        .hwEncoders()
        .then(setHw)
        .catch(() => setHw([]));
  }, [tab, hw]);

  /** عند انتهاء عملية: إشعار (إن كانت النافذة في الخلفية) + إضافتها للسجلّ */
  const onFinished = useCallback((job: Job, u: JobUpdate) => {
    const tt = tRef.current;
    const s = settingsRef.current;
    const name = u.file ? baseName(u.file) : job.title;
    // لا يراها إن كانت النافذة في الخلفية، أو كان في تبويب آخر لا تظهر فيه بطاقتها (U-86)
    const cardShown = tabNowRef.current === (job.type === "convert" ? "convert" : "download");
    if (s?.notify && (document.hidden || !document.hasFocus() || !cardShown)) {
      const title = u.state === "error" ? tt.notifyFailed : job.type === "convert" ? tt.notifyConvertDone : tt.notifyDone;
      notify(title, name);
    }
    // عنصر السجلّ كتبه Rust قبل إرسال "done" (T-19)؛ نعيد قراءة السجلّ فقط
    if (u.state === "done" && job.type === "download") setHistoryVersion((v) => v + 1);
  }, []);

  // نستمع لأحداث التقدّم القادمة من Rust
  useEffect(() => {
    const unlisten = api.onJobUpdate((u) => {
      const job = jobsRef.current.find((j) => j.id === u.id);
      if (job && (u.state === "done" || u.state === "error") && job.state !== u.state) onFinished(job, u);
      // البطاقة تُضاف قبل أن يبدأ Rust (newJobId)، فلا تحديث يسبقها (T-18)
      setJobs((prev) => prev.map((j) => (j.id === u.id ? mergeUpdate(j, u) : j)));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [onFinished]);

  useEffect(() => {
    if (isMobile) return;
    const un = api.onCloseRequested(() => setCloseAsk(true));
    // رابط khama:// فتح التطبيق، أو وصل والتطبيق مفتوح: يوضع في حقل الرابط فقط (T-101)
    const toDownload = (url: string) => {
      setInject({ url, n: Date.now() });
      setTab("download");
    };
    api
      .takeDeepLink()
      .then((u) => u && toDownload(u))
      .catch(logError("takeDeepLink"));
    const un2 = api.onDeepLink(toDownload);
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
    };
  }, []);

  // مراقبة الحافظة (Rust): رابط منسوخ جديد يظهر كاقتراح في شاشة التنزيل
  useEffect(() => {
    const un = api.onClipboardUrl((url) => setClipUrl(url));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // حفظ الإعدادات: خارج دالة setState (React قد يستدعيها مرتين)، وحفظ واحد في كل لحظة حتى لا يكتب
  // حفظٌ قديم فوق أحدث منه. التعديلات التي تصل أثناء الحفظ تُجمع في حفظ واحد بآخر قيمة (T-88)،
  // فعدة نقرات سريعة لا تكتب الملف عدة مرات، ولا تأخير على أول تعديل (Rust يقرأ الإعدادات عند بدء أي تنزيل).
  const saving = useRef(false);
  const queuedSave = useRef<Settings | null>(null);
  const saveFailed = useRef<(e: unknown) => void>(() => {});
  // «تم الحفظ» مرة كل 10 ثوانٍ على الأكثر، وفي تبويب الإعدادات فقط (U-57)
  const saveOk = useRef(() => {});
  const lastSavedNote = useRef(0);
  const flushSave = useCallback(async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      while (queuedSave.current) {
        const next = queuedSave.current;
        queuedSave.current = null;
        try {
          await api.saveSettings(next);
          if (!queuedSave.current) saveOk.current();
        } catch (e) {
          saveFailed.current(e);
        }
      }
    } finally {
      saving.current = false;
    }
  }, []);
  const update = useCallback(
    (patch: Partial<Settings>) => {
      const prev = settingsRef.current;
      if (!prev) return;
      const next = { ...prev, ...patch };
      settingsRef.current = next;
      setSettings(next);
      queuedSave.current = next;
      void flushSave();
    },
    [flushSave],
  );

  // مؤقّت واحد للتنبيه: رسالة جديدة (أو نفس الرسالة مرة ثانية) تبدأ مدتها من جديد
  const toastTimer = useRef<number | undefined>(undefined);
  const toast: Toast = useCallback((msg, action) => {
    setToastMsg({ msg, action });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), action?.ms ?? 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  // أحدث القيم للمستمعين والمؤقّتات، تُحدَّث بعد الرسم لا أثناءه
  useLayoutEffect(() => {
    jobsRef.current = jobs;
    settingsRef.current = settings;
    tRef.current = t;
    tabNowRef.current = tab;
    saveFailed.current = () => toast(t.settingsSaveFailed);
    saveOk.current = () => {
      if (tab !== "settings" || Date.now() - lastSavedNote.current < 10_000) return;
      lastSavedNote.current = Date.now();
      toast(t.settingsSaved);
    };
  });

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
    api.rememberJob(id, job).catch(logError("rememberJob"));
    setJobs((prev) => [{ id, state: "starting", ...job } as Job, ...prev]);
  }, []);

  /** يحجز رقمًا، يضيف البطاقة، ثم يبدأ العملية به. إن رفضها Rust تُزال البطاقة ويُرمى الخطأ */
  const launch = useCallback(
    async (job: Omit<Job, "id" | "state">, start: (id: number) => Promise<number>) => {
      const id = await api.newJobId();
      addJob(id, job);
      try {
        await start(id);
      } catch (e) {
        setJobs((prev) => prev.filter((j) => j.id !== id));
        throw e;
      }
    },
    [addJob],
  );

  const startDownload = useCallback(
    async (request: DownloadRequest, meta: StartMeta, at?: number) => {
      const base = {
        type: "download" as const,
        request,
        title: meta.title,
        thumbnail: meta.thumbnail,
        meta: downloadMeta(tRef.current, request),
      };
      if (at && at > Date.now()) {
        // مجدول: بطاقة تنتظر؛ يبدؤها فاحص المواعيد أدناه في وقتها
        const localId = nextLocalId.current--;
        setJobs((prev) => [{ id: localId, state: "scheduled", at, ...base } as Job, ...prev]);
        return;
      }
      await launch(base, (id) => api.startDownload(withHistory(request, base), id));
    },
    [launch],
  );

  // فحص أسبوعي لتحديث yt-dlp، لمن فعّله فقط، وليس أثناء تنزيل (T-100)
  const ytdlpChecked = useRef(false);
  useEffect(() => {
    const s = settings;
    if (!s || ytdlpChecked.current || !s.ytdlpWeekly || isMobile) return;
    if (Date.now() - (s.ytdlpCheckedAt ?? 0) < 7 * 86_400_000) return;
    if (jobs.some(isActive)) return;
    ytdlpChecked.current = true;
    api
      .updateYtdlp()
      .then((r) => {
        update({ ytdlpCheckedAt: Date.now() });
        if (r.updated) toast(tRef.current.updatedTo(r.version ?? ""));
      })
      .catch(logError("weeklyYtdlp"));
  }, [settings, jobs, update, toast]);

  const cancel = useCallback((j: Job) => {
    if (j.state === "scheduled") {
      setJobs((prev) => prev.map((x) => (x.id === j.id ? { ...x, state: "canceled" } : x)));
      return;
    }
    api.cancelDownload(j.id);
  }, []);

  // العمليات التي ما زالت تعمل في Rust بعد إعادة تحميل الواجهة (T-17)
  useEffect(() => {
    api
      .listJobs()
      .then((live) => {
        const cards = (live ?? []).filter((j) => typeof j.type === "string") as unknown as Job[];
        if (!cards.length) return;
        setJobs((prev) => [...cards.filter((c) => !prev.some((j) => j.id === c.id)), ...prev]);
      })
      .catch(logError("listJobs"));
  }, []);

  // استرجاع المجدولة المحفوظة عند الفتح (ما فات وقته يبدأ فورًا عبر الفاحص)
  useEffect(() => {
    let alive = true;
    api
      .getScheduled()
      .then((items) => {
        if (!alive) return;
        const restored = (items ?? []).map((it) => ({ ...it, id: nextLocalId.current--, type: "download", state: "scheduled" }) as Job);
        setJobs((prev) => [...prev, ...restored]);
      })
      .catch(logError("getScheduled"))
      .finally(() => alive && setScheduledLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  // حفظ المجدولة كلما تغيّرت (بعد الاسترجاع حتى لا نمحو الملف قبل قراءته)
  const scheduledJson = JSON.stringify(
    jobs
      .filter((j) => j.state === "scheduled" && j.request && j.at)
      .map((j) => ({ at: j.at, request: j.request, title: j.title, meta: j.meta, thumbnail: j.thumbnail })),
  );
  const savedScheduled = useRef(scheduledJson);
  useEffect(() => {
    if (!scheduledLoaded || savedScheduled.current === scheduledJson) return;
    savedScheduled.current = scheduledJson;
    api.saveScheduled(JSON.parse(scheduledJson)).catch(logError("saveScheduled"));
  }, [scheduledLoaded, scheduledJson]);

  // فاحص المواعيد: كل 15 ثانية وعند عودة النافذة. لا يعتمد على مؤقّت واحد طويل
  // (setTimeout يتعطل فوق 24.8 يومًا وينحرف بعد سكون الجهاز)
  useEffect(() => {
    const tick = () => {
      const due = jobsRef.current.filter((j) => j.state === "scheduled" && j.request && (j.at ?? 0) <= Date.now());
      if (!due.length) return;
      const ids = new Set(due.map((j) => j.id));
      jobsRef.current = jobsRef.current.filter((j) => !ids.has(j.id));
      setJobs((prev) => prev.filter((j) => !ids.has(j.id)));
      for (const j of due) {
        const { request, title, meta, thumbnail } = j;
        const base = { type: "download" as const, request, title, meta, thumbnail };
        launch(base, (id) => api.startDownload(withHistory(request!, base), id)).catch((e) =>
          setJobs((prev) => [{ id: j.id, state: "error", error: asAppError(e), ...base } as Job, ...prev]),
        );
      }
    };
    if (!scheduledLoaded) return;
    const iv = window.setInterval(tick, 15_000);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    tick();
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [launch, scheduledLoaded]);

  const startConvert = useCallback(
    async (convert: ConvertRequest, title: string, meta: string) => {
      await launch({ type: "convert", convert, title, meta }, (id) => api.startConvert(convert, id));
    },
    [launch],
  );

  /** يضيف ملفات للمحوّل ويقرأ معلوماتها */
  const addFiles = useCallback((paths: string[]) => {
    const media = paths.filter(isMedia);
    if (!media.length) return;
    setTab("convert");
    setFiles((prev) => {
      const fresh = media.filter((p) => !prev.some((f) => f.path === p));
      for (const p of fresh) {
        analyzeTurn(() => api.analyzeFile(p))
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
      addJob(hit.id, {
        type: "convert",
        convert: { inputs: [hit.path], preset: hit.preset, options: defaultOptions() },
        title: baseName(hit.path),
        meta: p?.name[lang] ?? hit.preset,
      });
      toast(tRef.current.toastWatch(baseName(hit.path)));
    });
    return () => {
      un.then((f) => f());
    };
  }, [addJob, toast, lang]);

  useEffect(() => {
    const order: Tab[] = ["download", "convert", "history", "settings"];
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]");
      if ((e.ctrlKey || e.metaKey) && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        setTab(order[Number(e.key) - 1]);
      } else if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setTab("settings");
      } else if (!typing && e.key === "?") {
        setShortcuts((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const toggleCompact = useCallback(() => {
    const next = !compact;
    api
      .setCompact(next)
      .then(() => {
        setCompact(next);
        if (next) setTab("download");
      })
      .catch(logError("setCompact"));
  }, [compact]);

  /** الجولة تبدّل التبويب بنفسها (دالة ثابتة حتى لا تعيد الخطوة الحالية) */
  const tourTab = useCallback((x: Tab) => setTab(x), []);
  const tourSteps = useMemo<TourStep<Tab>[]>(() => {
    const s = (id: string) => ({ title: t.tourSteps[id][0], body: t.tourSteps[id][1] });
    return [
      { target: ".url-field", tab: "download", art: "link", ...s("link") },
      { target: ".options-box > summary", tab: "download", art: "trim", ...s("format") },
      { target: "details.extras:not(.options-box) > summary", tab: "download", art: "stems", ...s("extras") },
      { target: ".download-btn", tab: "download", art: "playlist", ...s("download") },
      { target: '.tab[data-tab="convert"]', art: "convert", ...s("convert") },
      { target: '.tab[data-tab="history"]', art: "history", ...s("history") },
      { target: '.tab[data-tab="settings"]', art: "projects", ...s("settings") },
      { target: ".guide-btn", art: "guide", ...s("guide") },
    ];
  }, [t]);

  const startTour = useCallback(() => {
    update({ seenTour: true });
    if (compact)
      api
        .setCompact(false)
        .then(() => setCompact(false))
        .catch(() => {});
    setTouring(true);
  }, [update, compact]);

  if (bootError)
    return (
      <div className="boot-error" role="alert" dir="auto">
        <p>تعذّر تحميل الإعدادات — Could not load settings</p>
        <code className="ltr">{bootError.code + (bootError.detail ? `: ${bootError.detail}` : "")}</code>
      </div>
    );

  if (!settings) return null;

  const outputDir = settings.outputDir || defaultDir;
  const shown = jobs.filter((j) => (tab === "convert" ? j.type === "convert" : j.type === "download"));
  const finished = shown.filter((j) => !isActive(j) && j.state !== "scheduled");

  /** إزالة عمليات من القائمة مع «تراجع» لمدة 5 ثوانٍ (U-20، U-91) */
  const removeJobs = (gone: Job[]) => {
    if (!gone.length) return;
    const ids = new Set(gone.map((j) => j.id));
    const before = jobs.map((j) => j.id);
    setJobs((p) => p.filter((j) => !ids.has(j.id)));
    toast(t.removedN(gone.length), {
      label: t.undo,
      ms: 5000,
      run: () =>
        setJobs((cur) => {
          const have = new Set(cur.map((j) => j.id));
          const merged = [...cur, ...gone.filter((g) => !have.has(g.id))];
          const pos = (j: Job) => (before.includes(j.id) ? before.indexOf(j.id) : -1);
          return merged.sort((a, b) => pos(a) - pos(b));
        }),
    });
  };
  const failed = shown.filter((j) => j.state === "error");
  // الطابور يأخذ الأقدم أولًا، والأرقام تصاعدية بترتيب البدء (U-55)
  const queuedIds = shown
    .filter((j) => j.state === "queued")
    .map((j) => j.id)
    .sort((a, b) => a - b);
  const activeShown = shown.filter((j) => isActive(j) || j.state === "scheduled");

  const retry = (j: Job) => {
    setJobs((p) => p.filter((x) => x.id !== j.id));
    if (j.type === "download" && j.request)
      startDownload(j.request, { title: j.title, thumbnail: j.thumbnail }).catch(logError("retryDownload"));
    if (j.type === "convert" && j.convert) startConvert(j.convert, j.title, j.meta).catch(logError("retryConvert"));
  };

  /** من نتائج الكشف: نقاط القطع = بداية المشهد، أو منتصف الفراغ الأسود/الصامت */
  const split = (j: Job) => {
    if (!j.convert || !j.markers?.length) return;
    const input = j.convert.inputs[0];
    // نعيد الترميز (بجودة عالية) حتى يكون القطع دقيقًا بالإطار، لا عند أقرب إطار مفتاحي
    const preset = "edit_h264";
    const splitAt = j.markers.map(([s, e]) => (s === e ? s : (s + e) / 2));
    startConvert(
      {
        inputs: [input],
        preset,
        options: {
          ...defaultOptions(),
          quality: "high",
          hw: settings.convertHw,
          start: j.convert.options.start,
          end: j.convert.options.end,
          splitAt,
        },
      },
      baseName(input),
      t.splitHere,
    ).catch(logError("splitHere"));
  };

  const copyMarkers = (j: Job) => {
    const text = (j.markers ?? []).map(([s, e]) => (s === e ? formatTimecode(s) : `${formatTimecode(s)}\t${formatTimecode(e)}`)).join("\n");
    writeText(text)
      .then(() => toast(t.toastCopied))
      .catch(logError("copyMarkers"));
  };

  const tabs: { id: Tab; icon: IconName; label: string }[] = [
    { id: "download", icon: "download", label: t.tabDownload },
    { id: "convert" as Tab, icon: "convert" as IconName, label: t.tabConvert },
    { id: "history", icon: "history", label: t.tabHistory },
    { id: "settings", icon: "settings", label: t.tabSettings },
  ];

  // متوسط تقدّم العمليات الجارية، للخط الرفيع تحت الشريط العلوي
  const running = jobs.filter(isActive);
  const overall = running.length ? running.reduce((sum, j) => sum + (j.percent ?? 0), 0) / running.length : null;

  return (
    <I18n.Provider value={i18n}>
      {confirmNode}
      <div className={`app ${compact ? "compact" : ""}`}>
        <header className="topbar">
          <div className="brand">
            <img className="brand-mark" src="/logo.svg" alt="" />
            <span className="brand-name">{t.appName}</span>
          </div>
          <nav className="tabs" ref={tabsRef}>
            <span className="tab-pill" ref={tabPill} aria-hidden="true" />
            {tabs.map((x) => (
              <button
                key={x.id}
                className="tab"
                data-tab={x.id}
                aria-current={tab === x.id ? "page" : undefined}
                onClick={() => setTab(x.id)}
                title={x.label}
              >
                <Icon name={x.icon} size={20} /> <span>{x.label}</span>
                {x.id === "settings" && updateVersion && <span className="tab-dot update" title={t.appUpdateTitle} />}
                {(x.id === "download" || x.id === "convert") &&
                  jobs.some((j) => isActive(j) && (x.id === "convert") === (j.type === "convert")) && (
                    <span className="tab-dot" aria-hidden="true" />
                  )}
              </button>
            ))}
          </nav>
          <span className="spacer" />
          <div className="topbar-tools">
            {!compact && (
              <button
                className="icon-btn ghost guide-btn"
                title={t.guideOpen}
                aria-label={t.guideOpen}
                aria-pressed={tab === "guide"}
                onClick={() => setTab("guide")}
              >
                <Icon name="help" size={20} />
              </button>
            )}
            {!isMobile && (
              <button className="btn btn-sm btn-ghost topbar-btn" title={compact ? t.compactOff : t.compactOn} onClick={toggleCompact}>
                <Icon name={compact ? "maximize" : "minimize"} size={18} />
                <span className="topbar-btn-label">{compact ? t.compactShortOff : t.compactShort}</span>
              </button>
            )}
            <button
              className="icon-btn ghost"
              title={
                (resolvedTheme === "light" ? t.themeNowLight : t.themeNowDark) + (settings?.theme === "system" ? t.themeFollowsSystem : "")
              }
              aria-label={resolvedTheme === "light" ? t.themeNowLight : t.themeNowDark}
              onClick={() => update({ theme: nextTheme(resolvedTheme, window.matchMedia("(prefers-color-scheme: light)").matches) })}
            >
              <span className="theme-icon" key={resolvedTheme}>
                <Icon name={resolvedTheme === "light" ? "sun" : "moon"} size={20} />
              </span>
            </button>
          </div>
          {overall != null && (
            <span className="topbar-progress" aria-hidden="true">
              <span style={{ width: `${overall}%` }} />
            </span>
          )}
        </header>

        <main className="main">
          <div className={`container ${tab === "settings" ? "wide" : ""}`}>
            <SlideSwitch id={tab} index={tab === "guide" ? tabs.length : tabs.findIndex((x) => x.id === tab)} fade={!isMobile}>
              <div className="view">
                {tab === "download" && (
                  <DownloadView
                    session={downloadSession}
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
                  <ConvertView
                    settings={settings}
                    update={update}
                    files={files}
                    addFiles={addFiles}
                    setFiles={setFiles}
                    hw={hw}
                    dragging={dragging}
                    onClearFiles={() => {
                      const prev = files;
                      setFiles(() => []);
                      toast(t.filesCleared(prev.length), { label: t.undo, ms: 5000, run: () => setFiles(() => prev) });
                    }}
                    onStart={startConvert}
                  />
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
                    onOpenDir={() => api.openOutputDir().catch(logError("openOutputDir"))}
                    toast={toast}
                    section={settingsSection}
                    updateVersion={updateVersion}
                    onInstallUpdate={() => setUpdateRequest((n) => n + 1)}
                    onOpenGuide={() => setTab("guide")}
                    onTour={startTour}
                  />
                )}
                {tab === "guide" && (
                  <GuideView
                    onTour={startTour}
                    onGo={(to, section) => {
                      if (section) setSettingsSection({ id: section, n: Date.now() });
                      setTab(to);
                    }}
                  />
                )}

                {(tab === "download" || tab === "convert") && (
                  <>
                    <div className="jobs-header">
                      <h3>{tab === "convert" ? t.convertJobsTitle : t.jobsTitle}</h3>
                      {/* أفعال على القائمة كلها (U-45) */}
                      {failed.length > 1 && (
                        <button className="btn btn-sm btn-ghost" onClick={() => failed.forEach(retry)}>
                          <Icon name="retry" size={16} /> {t.retryFailed(failed.length)}
                        </button>
                      )}
                      {activeShown.length > 1 && (
                        <button
                          className="btn btn-sm btn-ghost danger-text"
                          onClick={async () =>
                            (await confirm(t.cancelAll, t.cancelAllConfirm(activeShown.length))) && activeShown.forEach(cancel)
                          }
                        >
                          <Icon name="x" size={16} /> {t.cancelAll}
                        </button>
                      )}
                      {finished.length > 0 && (
                        <button className="btn btn-sm btn-ghost" onClick={() => removeJobs(finished)}>
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
                          queuePos={j.state === "queued" ? [queuedIds.indexOf(j.id) + 1, queuedIds.length] : undefined}
                          onCopyMarkers={j.markers?.length ? () => copyMarkers(j) : undefined}
                          onDragOut={!isMobile && j.file ? () => dragOut(j.file!) : undefined}
                        />
                      ))}
                    </AnimatedList>
                  </>
                )}
              </div>
            </SlideSwitch>
          </div>
        </main>

        <Presence show={dragging && tab !== "convert"}>
          <div className="drop-overlay">
            <div>
              <Icon name="convert" size={24} />
              <b>{t.dropHere}</b>
            </div>
          </div>
        </Presence>

        {toastShown && (
          <div className={`toast ${toastLeaving ? "leaving" : ""}`} role="status">
            <span>{toastShown.msg}</span>
            {toastShown.action && (
              <button
                className="toast-action"
                onClick={() => {
                  toastShown.action!.run();
                  setToastMsg(null);
                }}
              >
                {toastShown.action.label}
              </button>
            )}
          </div>
        )}

        {/* تحديثات خامة: الكمبيوتر يثبّتها بنفسه، والهاتف يفتح رابط ملف APK الجديد */}
        <UpdateDialog busy={running.length > 0} request={updateRequest} onAvailable={setUpdateVersion} />

        <Presence show={!settings.acceptedNotice}>
          <Dialog
            title={t.noticeTitle}
            actions={
              <button className="btn btn-primary" onClick={() => update({ acceptedNotice: true })}>
                {t.gotIt}
              </button>
            }
          >
            <p className="muted">{t.notice}</p>
          </Dialog>
        </Presence>

        <Presence show={closeAsk}>
          <Dialog
            title={t.closeAskTitle}
            onClose={() => setCloseAsk(false)}
            actions={
              <>
                <button className="btn btn-ghost" onClick={() => setCloseAsk(false)}>
                  {t.stay}
                </button>
                <button className="btn btn-danger" onClick={() => api.quitApp()}>
                  {t.stopAndQuit}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setCloseAsk(false);
                    api.hideMain().catch(logError("hideMain"));
                  }}
                >
                  {t.keepInBackground}
                </button>
              </>
            }
          >
            <p className="muted">{t.closeAskBody(running.length)}</p>
          </Dialog>
        </Presence>

        <Presence show={shortcuts}>
          <Dialog
            title={t.shortcutsTitle}
            onClose={() => setShortcuts(false)}
            actions={
              <button className="btn btn-primary" onClick={() => setShortcuts(false)}>
                {t.gotIt}
              </button>
            }
          >
            <dl className="shortcuts">
              {t.shortcutList.map(([k, v]) => (
                <div key={k}>
                  <dt>
                    <kbd className="ltr">{k}</kbd>
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Dialog>
        </Presence>

        {/* أول فتح: ترحيب يعرض جولة سريعة على الخصائص */}
        <Presence show={!settings.seenTour && !touring && !compact}>
          <Welcome onTour={startTour} onLater={() => update({ seenTour: true })} />
        </Presence>
        <Presence show={touring}>
          <Tour steps={tourSteps} onTab={tourTab} onClose={() => setTouring(false)} />
        </Presence>
      </div>
    </I18n.Provider>
  );
}
