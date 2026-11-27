import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, asAppError, type AppError, type ConvertRequest, type DownloadRequest, type JobUpdate, type Settings } from "./api";
import { ConvertView, defaultOptions, MEDIA_FILTER, type SourceFile } from "./components/ConvertView";
import { DownloadView, newDownloadSession, type StartMeta } from "./components/DownloadView";
import { HistoryView } from "./components/HistoryView";
import { Icon, type IconName } from "./components/Icon";
import { Dialog, useConfirm } from "./components/Dialog";
import type { ErrorFix } from "./components/ErrorBox";
import { isActive, JobCard, mergeUpdate, overallPercent, type Job } from "./components/JobCard";
import { SettingsView } from "./components/SettingsView";
import { Tour, Welcome, type TourStep } from "./components/Tour";
import { UpdateDialog } from "./components/UpdateDialog";
import { CHAPTER_MIN_COUNT, chapterStarts, extractUrls, formatTimecode, youtubeChapters } from "./format";
import { dictionaries, errorText, I18n, type Dict, type Lang } from "./i18n";
import { isMixed, resolveDir } from "./layoutDir";
import { AnimatedList, Presence, reducedMotion, SlideSwitch, usePresence, useSlidingIndicator } from "./motion";
import { isMobile } from "./platform";
import type { Toast, ToastAction } from "./toast";
import { presetById } from "./presets";
import { logError } from "./log";
import { nextTheme } from "./theme";
import { limiter } from "./limit";
import { announceUpdate } from "./whatsNew";
import { REEL_MAX, REEL_MIN, silenceCuts, topicRows, topicsText } from "./topics";
import { exportCues, keptLength, planTopic, toSrt, type Range } from "./reels";
import type { ExportOptions } from "./components/TopicPanel";
import { optionsFromMeta } from "./downloadPlan";

/** تحليل الملفات المضافة للمحوّل: 4 في كل مرة (U-93) */
const analyzeTurn = limiter(4);
// الدليل (~35KB نصوص) لا يلزم عند الإقلاع: يُحمَّل أول مرة يُفتح تبويبه (FE25)
const GuideView = lazy(() => import("./components/GuideView").then((m) => ({ default: m.GuideView })));

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
  if (r.kind === "audio")
    return r.audioFormat === "m4a" ? "AAC" : r.audioFormat === "original" ? t.audioOriginal : r.audioFormat.toUpperCase();
  return `${r.videoFormat.toUpperCase()} · ${r.quality === "best" ? t.best : r.quality === "2160" ? "4K" : r.quality + "p"}`;
}

function activeProjectName(s: Settings | null): string | null {
  return s?.projects.find((p) => p.id === s.activeProject)?.name ?? null;
}

const MEDIA_EXT = new Set(MEDIA_FILTER.extensions);
const isMedia = (p: string) => MEDIA_EXT.has(p.split(".").pop()?.toLowerCase() ?? "");
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** صورة صغيرة تتبع المؤشر أثناء سحب ملف إلى برنامج آخر: الصورة المصغّرة للفيديو إن وُجدت (D-69)، وإلا الشعار */
const dragIcons = new Map<string, Promise<string>>();
const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
function getDragIcon(thumb?: string | null): Promise<string> {
  const src = thumb || "/logo.png";
  let icon = dragIcons.get(src);
  if (!icon) {
    icon = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          // مصغّرة 16:9 أو مربع للشعار
          c.width = thumb ? 112 : 64;
          c.height = 64;
          c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/png"));
        } catch {
          // صورة من موقع لا يسمح بقراءتها: نعود للشعار
          resolve(thumb ? getDragIcon() : BLANK_PNG);
        }
      };
      img.onerror = () => resolve(thumb ? getDragIcon() : BLANK_PNG);
      img.src = src;
    });
    dragIcons.set(src, icon);
  }
  return icon;
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
  const filesRef = useRef<SourceFile[]>([]);
  const analyzed = useRef(new Map<string, Partial<SourceFile>>());
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

  // تغيير اللغة يغيّر النصوص فقط، واتجاه التخطيط إعداد مستقل (layoutDir): من اليمين لليسار افتراضيًا،
  // أو من اليسار لليمين، أو حسب اللغة. إن خالف النصُّ التخطيطَ يُرتَّب كل نص داخل مكانه حسب لغته (bubbly.css)
  const layoutDir = settings?.layoutDir;
  const loaded = settings != null;
  // آخر اتجاه طُلب: انتقال سابق لم يكتمل يطبّق الأحدث لا ما طُلب وقتها
  const wantDir = useRef<{ lang: Lang; layout?: string; dir?: string; loaded?: boolean }>({ lang });
  useEffect(() => {
    const root = document.documentElement;
    const dir = resolveDir(layoutDir, lang);
    const prev = wantDir.current;
    wantDir.current = { lang, layout: layoutDir, dir, loaded };
    const apply = () => {
      const w = wantDir.current;
      root.lang = w.lang;
      root.dir = w.dir!;
      if (isMixed(w.layout, w.lang)) root.dataset.mixedDir = "";
      else delete root.dataset.mixedDir;
    };
    // انقلاب التخطيط بيد المستخدم: تلاشٍ قصير بين الصورتين بدل قفزة، بلا دوران.
    // أول تطبيق بعد قراءة الإعدادات فوري (لا انتقال عند فتح البرنامج)
    if (!prev.loaded || prev.dir === dir || reducedMotion() || !document.startViewTransition) return apply();
    root.dataset.dirSwitch = "";
    const vt = document.startViewTransition(apply);
    vt.ready.catch(() => {});
    vt.finished.catch(() => {}).then(() => delete root.dataset.dirSwitch);
  }, [lang, layoutDir, loaded, t]);

  useEffect(() => {
    api
      .getSettings()
      // أول تشغيل بالإنجليزية دائمًا (الافتراضي في settings.rs)، واللغة التي يختارها المستخدم تُحفظ فورًا وتبقى
      .then(setSettings)
      .catch((e) => setBootError(asAppError(e)));
    api
      .defaultOutputDir()
      .then((d) => setDefaultDir(d ?? ""))
      .catch(logError("defaultOutputDir"));
  }, []);

  // مشفّرات كرت الشاشة: نفحصها عند أول فتح للمحوّل (تأخذ ثوانٍ)
  useEffect(() => {
    if (tab === "convert" && hw == null)
      api
        .hwEncoders()
        .then(setHw)
        .catch(() => setHw([]));
  }, [tab, hw]);

  const dragTip = useRef(() => {});
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
    if (u.state === "done") setHistoryVersion((v) => v + 1);
    // أول ملف مكتمل: نلفت النظر لسحب البطاقة إلى برنامج المونتاج، مرة واحدة فقط (U-38)
    if (u.state === "done" && u.file && !isMobile) {
      try {
        if (!localStorage.getItem("khama.dragTip")) {
          localStorage.setItem("khama.dragTip", "1");
          dragTip.current();
        }
      } catch {
        // بلا تخزين: لا تلميح، ولا شيء ينكسر
      }
    }
  }, []);

  /** ما يُفعل بملف تنزيل حين يكتمل (رقم التنزيل ← الدالة) */
  const afterDownload = useRef(new Map<number, (file: string) => void>());

  // نستمع لأحداث التقدّم القادمة من Rust
  useEffect(() => {
    const unlisten = api.onJobUpdate((u) => {
      const job = jobsRef.current.find((j) => j.id === u.id);
      if (job && (u.state === "done" || u.state === "error") && job.state !== u.state) onFinished(job, u);
      // تصدير من تحليل رابط: ينتظر تنزيل المدى المطلوب، ثم يقص الملف المنزَّل
      const then = afterDownload.current.get(u.id);
      if (then && ["done", "error", "canceled"].includes(u.state)) {
        afterDownload.current.delete(u.id);
        if (u.state === "done" && u.file) then(u.file);
      }
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
    // وصل الرابط بالحدث: نأخذه من Rust أيضًا، وإلا عاد رابط قديم عند إعادة تحميل الواجهة
    const un2 = api.onDeepLink((url) => {
      toDownload(url);
      api.takeDeepLink().catch(logError("takeDeepLink"));
    });
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
  // إشعار بـ«تراجع» لا يمحوه إشعار عادي قبل مهلته (R2-6): العادي ينتظر ثم يظهر بعده
  const toastNow = useRef<{ msg: string; action?: ToastAction } | null>(null);
  const toastNext = useRef<{ msg: string; action?: ToastAction } | null>(null);
  const endToast = useCallback(() => {
    const next = toastNext.current;
    toastNext.current = null;
    toastNow.current = next;
    setToastMsg(next);
  }, []);
  const armToast = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    const m = toastNow.current;
    if (m) toastTimer.current = window.setTimeout(endToast, m.action?.ms ?? 4000);
  }, [endToast]);
  useEffect(() => {
    armToast();
    return () => window.clearTimeout(toastTimer.current);
  }, [toastMsg, armToast]);
  /** المؤشر أو التركيز على التنبيه يوقف عدّه، ومغادرته تعيده بمهلة كاملة (UX12) */
  const holdToast = () => window.clearTimeout(toastTimer.current);
  const resumeToast = armToast;
  const toast: Toast = useCallback((msg, action) => {
    if (toastNow.current?.action?.ms && !action) {
      toastNext.current = { msg };
      return;
    }
    toastNext.current = null;
    toastNow.current = { msg, action };
    setToastMsg({ msg, action });
  }, []);
  // الملف نُقل أو حُذف (يحدث كثيرًا: الممنتج ينقل الملفات لمجلد المشروع): رسالة بدل نقرة بلا أثر
  const fileFailed = (e: unknown) => toast(errorText(t, asAppError(e)));
  // تحميل الدليل مسبقًا بعد الإقلاع بقليل: فتحه لاحقًا فوري بلا فراغ
  useEffect(() => {
    const id = window.setTimeout(() => void import("./components/GuideView"), 4000);
    return () => window.clearTimeout(id);
  }, []);

  // «ما الجديد» بعد التحديث، بلغة المستخدم: ننتظر الإعدادات (U-59)
  const announced = useRef(false);
  useEffect(() => {
    if (!settings || announced.current) return;
    announced.current = true;
    void announceUpdate(t, toast);
  }, [settings, t, toast]);
  // أحدث القيم للمستمعين والمؤقّتات، تُحدَّث بعد الرسم لا أثناءه
  useLayoutEffect(() => {
    jobsRef.current = jobs;
    filesRef.current = files;
    settingsRef.current = settings;
    tRef.current = t;
    tabNowRef.current = tab;
    saveFailed.current = () => toast(t.settingsSaveFailed);

    dragTip.current = () => toast(t.dragTip, { label: t.gotIt, run: () => {}, ms: 9000 });
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
    const dir = await open({ directory: true, defaultPath: settings?.outputDir ?? defaultDir }).catch(logError("chooseDir"));
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
      return id;
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
        // المشروع النشط يظهر على البطاقة وفي السجلّ (U-83)
        meta: [downloadMeta(tRef.current, request), activeProjectName(settingsRef.current)].filter(Boolean).join(" · "),
        lastError: meta.lastError,
      };
      if (at && at > Date.now()) {
        // مجدول: بطاقة تنتظر؛ يبدؤها فاحص المواعيد أدناه في وقتها
        const localId = nextLocalId.current--;
        setJobs((prev) => [{ id: localId, state: "scheduled", at, ...base } as Job, ...prev]);
        return;
      }
      return await launch(base, (id) => api.startDownload(withHistory(request, base), id));
    },
    [launch],
  );

  // التقدّم الكلي في عنوان النافذة وعلى أيقونة شريط المهام، واسم التبويب في العنوان (R2-31، R2-85):
  // يُرى من Alt+Tab ومن شريط المهام والنافذة مصغّرة أو خلف غيرها
  const titlePercent = useMemo(() => {
    const live = jobs.filter(isActive);
    if (!live.length) return null;
    return Math.round(live.reduce((sum, j) => sum + (overallPercent(j) ?? 0), 0) / live.length);
  }, [jobs]);
  const tabTitle = { download: t.tabDownload, convert: t.tabConvert, history: t.tabHistory, settings: t.tabSettings, guide: t.guideTitle }[
    tab
  ];
  useEffect(() => {
    document.title = [titlePercent != null && `${titlePercent}%`, tabTitle, t.appName].filter(Boolean).join(" · ");
  }, [titlePercent, tabTitle, t]);
  useEffect(() => {
    if (isMobile) return;
    getCurrentWindow()
      .setProgressBar(
        titlePercent == null ? { status: ProgressBarStatus.None } : { status: ProgressBarStatus.Normal, progress: titlePercent },
      )
      .catch(() => {});
  }, [titlePercent]);

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
    api.cancelDownload(j.id).catch(logError("cancelDownload"));
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
    async (convert: ConvertRequest, title: string, meta: string, lastError?: AppError, inDownloads?: boolean) => {
      await launch({ type: "convert", convert, title, meta, lastError, inDownloads }, (id) => api.startConvert(convert, id));
    },
    [launch],
  );

  /** خطوتان على ملف واحد (أداة ذكاء ثم تحويل): الثانية تبدأ على ناتج الأولى حين تكتمل */
  const chainConvert = useCallback(
    async (first: ConvertRequest, title: string, meta: string, next: (file: string) => { req: ConvertRequest; meta: string }) => {
      await launch({ type: "convert", convert: first, title, meta }, (id) => {
        // يُسجَّل قبل البدء، فلا يسبقه حدث «اكتمل» من عملية قصيرة
        afterDownload.current.set(id, (file) => {
          const n = next(file);
          startConvert(n.req, title, n.meta).catch(logError("chainConvert"));
        });
        return api.startConvert(first, id).catch((e) => {
          afterDownload.current.delete(id);
          throw e;
        });
      });
    },
    [launch, startConvert],
  );

  /** يضيف ملفات للمحوّل ويقرأ معلوماتها */
  const addFiles = useCallback((paths: string[]) => {
    const media = paths.filter(isMedia);
    if (!media.length) return;
    setTab("convert");
    // التحليل خارج دالة التحديث (FE16: React قد يستدعيها مرتين)، ونتيجته تُحفظ أيضًا
    // فـ«تراجع» بعد «مسح» يعيد الملفات محلَّلة لا عالقة على «جارٍ التحليل» (FE4)
    const fresh = media.filter((p) => !filesRef.current.some((f) => f.path === p));
    const apply = (p: string, r: Partial<SourceFile>) => {
      analyzed.current.set(p, r);
      setFiles((cur) => cur.map((f) => (f.path === p ? { ...f, ...r } : f)));
    };
    for (const p of fresh) {
      analyzeTurn(() => api.analyzeFile(p))
        .then((info) => apply(p, { info }))
        .catch((e) => apply(p, { error: asAppError(e) }));
    }
    setFiles((prev) => [...prev, ...fresh.filter((p) => !prev.some((f) => f.path === p)).map((path) => ({ path }))]);
  }, []);

  /** سحب ملف مكتمل إلى Premiere/DaVinci/CapCut أو إلى أي مجلد */
  const dragOut = useCallback(async (file: string | string[], thumbnail?: string | null) => {
    try {
      await startDrag({ item: Array.isArray(file) ? file : [file], icon: await getDragIcon(thumbnail) });
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
        // ملف .txt فيه روابط يذهب لحقل التنزيل، لا للمحوّل (U-51)
        const texts = p.paths.filter((x) => x.toLowerCase().endsWith(".txt"));
        if (texts.length) {
          Promise.all(texts.map((x) => api.readLinksFile(x).catch(() => "")))
            .then((all) => {
              const links = extractUrls(all.join(" "));
              // ملف نصي بلا روابط: نقول ذلك بدل إفلات بلا أثر (R2-87)
              if (!links.length) return toast(tRef.current.noLinksInFile);
              setInject({ url: links.join(" "), n: Date.now() });
              setTab("download");
            })
            .catch(logError("readLinksFile"));
        }
        addFiles(p.paths);
        // صور أو PDF أو ملفات لا يقرؤها المحوّل: رسالة بأسمائها بدل لا شيء (R2-10)
        const skipped = p.paths.filter((x) => !isMedia(x) && !x.toLowerCase().endsWith(".txt"));
        if (skipped.length) toast(tRef.current.dropSkipped(skipped.length, baseName(skipped[0])));
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [addFiles, toast]);

  const watchBurst = useRef({ n: 0, at: 0 });
  // المجلدات المراقَبة: Rust يخبرنا بالملف الجديد، ونضيفه لطابور التحويل
  useEffect(() => {
    const un = api.onWatchFile((hit) => {
      const p = presetById(hit.preset);
      addJob(hit.id, {
        type: "convert",
        convert: { inputs: [hit.path], preset: hit.preset, options: defaultOptions() },
        title: baseName(hit.path),
        // اللغة من المرجع: تغييرها لا يعيد الاشتراك فيضيع ملف وصل بين الإلغاء والاشتراك (FE22)
        meta: p?.name[settingsRef.current?.language ?? "en"] ?? hit.preset,
      });
      // عشرة ملفات معًا = إشعار واحد بعددها، لا عشرة متتالية يمحو كل منها سابقه (R2-49)
      const now = Date.now();
      const w = watchBurst.current;
      w.n = now - w.at < 4000 ? w.n + 1 : 1;
      w.at = now;
      toast(w.n > 1 ? tRef.current.toastWatchN(w.n) : tRef.current.toastWatch(baseName(hit.path)));
    });
    return () => {
      un.then((f) => f());
    };
  }, [addJob, toast]);

  useEffect(() => {
    const order: Tab[] = ["download", "convert", "history", "settings", "guide"];
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]");
      // بالمفتاح الفعلي (e.code) لا بالحرف: مع لوحة المفاتيح العربية يكون «,» حرف «و» و«?» «؟»
      const digit = /^Digit([1-5])$/.exec(e.code)?.[1];
      if ((e.ctrlKey || e.metaKey) && digit) {
        e.preventDefault();
        setTab(order[Number(digit) - 1]);
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        // Ctrl+Enter يبدأ التنزيل أو التحويل من أي مكان في الشاشة (R2-58)
        const btn = document.querySelector<HTMLButtonElement>("main [data-primary]:not(:disabled)");
        if (btn) {
          e.preventDefault();
          btn.click();
        }
      } else if (e.key === "F1") {
        // F1 للدليل كما في أغلب البرامج (R2-47، R2-86)
        e.preventDefault();
        setTab("guide");
      } else if ((e.ctrlKey || e.metaKey) && e.code === "Comma") {
        e.preventDefault();
        setTab("settings");
      } else if (!typing && (e.key === "?" || e.key === "؟") && !document.querySelector('[aria-modal="true"]')) {
        setShortcuts((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // المصغّرة للصق الروابط فقط، فتفتح على التنزيل؛ والعودة ترجع للتبويب الذي كنت فيه (U-53)
  const tabBeforeCompact = useRef<Tab>("download");
  const toggleCompact = useCallback(() => {
    const next = !compact;
    api
      .setCompact(next)
      .then(() => {
        setCompact(next);
        if (next) {
          tabBeforeCompact.current = tab;
          setTab("download");
        } else setTab(tabBeforeCompact.current);
      })
      .catch(logError("setCompact"));
  }, [compact, tab]);

  const openSettings = useCallback((id: string) => {
    setSettingsSection({ id, n: Date.now() });
    setTab("settings");
  }, []);

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

  // شاشة إقلاع بالشعار بدل نافذة فارغة حتى تصل الإعدادات (D-87)
  if (!settings)
    return (
      <div className="boot" aria-busy="true">
        <img src="/logo.svg" alt="" />
      </div>
    );

  const outputDir = settings.outputDir || defaultDir;
  // تحليل مواضيع بدأ من بطاقة تنزيل يبقى في قائمة التنزيلات
  const shown = jobs.filter((j) => (tab === "convert" ? j.type === "convert" && !j.inDownloads : j.type === "download" || !!j.inDownloads));
  const finished = shown.filter((j) => !isActive(j) && j.state !== "scheduled");
  const doneFiles = shown.filter((j) => j.state === "done" && j.file).map((j) => j.file!);

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
          const order = new Map(before.map((id, i) => [id, i]));
          const pos = (j: Job) => order.get(j.id) ?? -1;
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
      startDownload(j.request, { title: j.title, thumbnail: j.thumbnail, lastError: j.error }).catch(logError("retryDownload"));
    if (j.type === "convert" && j.convert) startConvert(j.convert, j.title, j.meta, j.error, j.inDownloads).catch(logError("retryConvert"));
  };

  /** زر الإصلاح على بطاقة تنزيل فاشلة (R2-2): الكوكيز تفتح الإعدادات، وyt-dlp يُحدَّث ثم يُعاد التنزيل */
  const fixJob = async (j: Job, fix: ErrorFix) => {
    if (fix === "cookies") return openSettings("cookies");
    if (fix === "ytdlp") {
      try {
        const r = await api.updateYtdlp();
        toast(r.updated ? t.updatedTo(r.version ?? "") : t.upToDate(r.version ?? ""));
      } catch (e) {
        toast(errorText(t, asAppError(e)));
        return;
      }
    }
    retry(j);
  };

  /** من نتائج الكشف: نقاط القطع = بداية المشهد، أو منتصف الفراغ الأسود/الصامت */
  const split = (j: Job) => {
    if (!j.convert || !j.markers?.length) return;
    const input = j.convert.inputs[0];
    // نعيد الترميز حتى يكون القطع دقيقًا بالإطار، لا عند أقرب إطار مفتاحي.
    // بنفس عائلة المصدر: ProRes يبقى ProRes وDNxHR يبقى DNxHR، لا H.264 بصمت (U-39)،
    // والملف الصوتي يبقى صوتًا (H.264 على ملف بلا فيديو يفشل بـ noVideoStream)
    const preset = sameFamily(input);
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
      `${t.splitHere} · ${presetById(preset)?.name[lang] ?? preset}`,
    ).catch(logError("splitHere"));
  };

  /** ما يبقى بعد الكلام وقبله عند حذف الصمت */
  const silencePad = (j: Job) => Math.max(0, j.convert?.options.silencePad ?? 0.15);
  const silencePadBefore = (j: Job) => Math.max(0, j.convert?.options.silencePadBefore ?? silencePad(j));
  /** الفترات التي ستُحذف: الصمت يُبقي من طرفيه ما اختير حتى لا يلتصق الكلام */
  const removalCuts = (j: Job): [number, number][] => {
    if (j.convert?.preset !== "detect_silence") return (j.markers ?? []).filter(([s, e]) => e - s > 0.01);
    return silenceCuts(j.markers ?? [], silencePad(j), 0, Infinity, silencePadBefore(j));
  };

  /** المدة قبل الحذف وبعده (للصمت والسواد) */
  const removalLengths = (j: Job): [number, number] | null => {
    if (!j.convert || !["detect_silence", "detect_black"].includes(j.convert.preset)) return null;
    const dur = files.find((f) => f.path === j.convert!.inputs[0])?.info?.duration;
    if (!dur) return null;
    const lo = j.convert.options.start ?? 0;
    const hi = j.convert.options.end ?? dur;
    const removed = removalCuts(j).reduce((sum, [s, e]) => sum + Math.max(0, Math.min(e, hi) - Math.max(s, lo)), 0);
    return [hi - lo, Math.max(0, hi - lo - removed)];
  };

  /** للعرض المرئي لنتيجة كشف الصمت أو السواد: ما سيُحذف والمدى المحلَّل */
  const removalView = (j: Job) => {
    if (!j.convert || !["detect_silence", "detect_black"].includes(j.convert.preset) || !j.markers) return null;
    const info = files.find((f) => f.path === j.convert!.inputs[0])?.info;
    const lo = j.convert.options.start ?? 0;
    const lastMarker = j.markers.reduce((m, [, e]) => Math.max(m, e), 0);
    const envEnd = j.levels?.envelope?.length ? (j.levels.envStart ?? 0) + j.levels.envelope.length * (j.levels.envStep ?? 0) : 0;
    const hi = j.convert.options.end ?? info?.duration ?? Math.max(lastMarker, envEnd);
    if (!(hi > lo)) return null;
    return {
      cuts: removalCuts(j),
      range: [lo, hi] as [number, number],
      video: info ? !!info.video : !/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(j.convert.inputs[0]),
      black: j.convert.preset === "detect_black",
    };
  };

  /** صيغة الناتج عند القص والحذف: بنفس عائلة المصدر (ملف من التنزيلات قد لا يكون في قائمة المحوّل) */
  const sameFamily = (input: string): string => {
    const info = files.find((f) => f.path === input)?.info;
    const codec = info?.video?.codec ?? "";
    const ext = input.split(".").pop()?.toLowerCase() ?? "";
    const audio = ({ mp3: "mp3", m4a: "aac", aac: "aac", flac: "flac", opus: "opus", ogg: "opus", wav: "wav" } as Record<string, string>)[
      ext
    ];
    const hasVideo = info ? !!info.video : !audio;
    if (!hasVideo) return audio ?? "wav";
    return codec === "prores" ? "prores_hq" : codec === "dnxhd" ? "dnxhr_hq" : "edit_h264";
  };

  /** يحذف الفترات المكتشفة ويصل الباقي، بنفس عائلة المصدر */
  const removeFound = (j: Job) => {
    if (!j.convert) return;
    const cut = removalCuts(j);
    if (!cut.length) return;
    const input = j.convert.inputs[0];
    const preset = sameFamily(input);
    const label = j.convert.preset === "detect_silence" ? t.removeSilence : t.removeBlack;
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
          cut,
        },
      },
      baseName(input),
      `${label} · ${presetById(preset)?.name[lang] ?? preset}`,
    ).catch(logError("removeFound"));
  };

  /** تحليل المواضيع: مدة الريل المختارة، والصفوف بمدتها بعد حذف الصمت */
  const reelRange = (j: Job): [number, number] => [j.convert?.options.reelMin ?? REEL_MIN, j.convert?.options.reelMax ?? REEL_MAX];
  const rowsOf = (j: Job) =>
    j.topics ? topicRows(j.topics, j.markers ?? [], silencePad(j), reelRange(j), silencePadBefore(j)) : undefined;
  /** كل فترات الصمت التي تُحذف في الملف (بالهامشين) */
  const allCuts = (j: Job) => silenceCuts(j.markers ?? [], silencePad(j), 0, Infinity, silencePadBefore(j));
  const plansOf = (j: Job) => j.topics?.map((tp) => planTopic(tp.start, tp.end, j.cues ?? [], j.markers ?? [], allCuts(j), reelRange(j)));

  /**
   * يصدّر المواضيع والأجزاء المختارة: ملف لكل مقطع، أو فيديو واحد يصلها (ما بينها يُحذف كما يُحذف الصمت).
   * بجانب كل ناتج ترجمته بتوقيت يبدأ من صفره، ويُعاد حسابه بعد حذف الصمت.
   */
  const exportTopics = (j: Job, sections: Range[], o: ExportOptions) => {
    if (!j.convert || !sections.length) return;
    const input = j.convert.inputs[0];
    if (/^https?:\/\//.test(input)) {
      exportFromUrl(j, input, sections, o);
      return;
    }
    exportFromFile(j, input, sections, o);
  };

  /**
   * تحليل رابط لم يُنزَّل: يُنزَّل المدى المطلوب فقط (مدى كل مقطع، أو من أول المقاطع إلى آخرها لفيديو واحد)،
   * ثم يُقص الملف المنزَّل كما يُقص ملف محلي، بأوقات تبدأ من بداية ما نُزّل.
   */
  const exportFromUrl = (j: Job, url: string, sections: Range[], o: ExportOptions) => {
    const spans: Range[][] = o.join ? [sections] : sections.map((s) => [s]);
    for (const secs of spans) {
      const from = secs[0][0];
      const to = secs[secs.length - 1][1];
      const shift = (r: Range): Range => [r[0] - from, r[1] - from];
      const moved: Job = {
        ...j,
        markers: j.markers?.map(shift),
        cues: j.cues?.map((c) => ({ ...c, start: c.start - from, end: c.end - from })),
        words: j.words?.map((w) => ({ ...w, start: w.start - from, end: w.end - from })),
      };
      const request: DownloadRequest = {
        url,
        kind: "video",
        videoFormat: settings.videoFormat,
        audioFormat: settings.audioFormat,
        quality: settings.quality,
        editorReady: false,
        start: from,
        end: to,
        stems: null,
        clips: [],
        joinClips: false,
        subs: [],
        thumbnail: false,
        infoFile: false,
        stills: null,
        original: false,
      };
      startDownload(request, { title: `${j.title} · ${formatTimecode(from)}`, thumbnail: j.thumbnail })
        .then((id) => {
          if (id != null) afterDownload.current.set(id, (file) => exportFromFile(moved, file, secs.map(shift), o));
        })
        .catch(logError("exportFromUrl"));
    }
  };

  const exportFromFile = (j: Job, input: string, sections: Range[], o: ExportOptions) => {
    const preset = sameFamily(input);
    const silence = o.tight ? allCuts(j) : [];
    const lines = { maxWords: o.maxWords, maxSecs: o.maxSecs };
    const srt = (secs: Range[]) =>
      o.subs && j.cues?.length ? toSrt(exportCues(j.cues, secs, silence, lines, j.words, j.markers ?? [])) : null;
    const groups: Range[][] = o.join ? [sections] : sections.map((s) => [s]);
    groups.forEach((secs, n) => {
      const start = secs[0][0];
      const end = secs[secs.length - 1][1];
      // ما بين المقاطع يُحذف، ثم الصمت داخلها
      const gaps: Range[] = secs
        .slice(1)
        .map((s, i) => [secs[i][1], s[0]] as Range)
        .filter(([a, b]) => b - a > 0.01);
      const cut = [...gaps, ...silence.map(([a, b]) => [Math.max(a, start), Math.min(b, end)] as Range).filter(([a, b]) => b - a > 0.01)];
      const label = `${o.tight ? t.topicClipTight : t.topicClip} ${o.join ? "" : n + 1}`.trim();
      startConvert(
        {
          inputs: [input],
          preset,
          options: {
            ...defaultOptions(),
            quality: "high",
            hw: settings.convertHw,
            start,
            end,
            cut: cut.sort((a, b) => a[0] - b[0]),
            sidecarSrt: srt(secs),
          },
        },
        `${baseName(input)} · ${formatTimecode(start)}`,
        `${label} · ${presetById(preset)?.name[lang] ?? preset}`,
        undefined,
        j.inDownloads,
      ).catch(logError("exportTopics"));
    });
  };

  /** من حقل الرابط: تحليل المواضيع قبل التنزيل (Rust يأخذ ترجمة الموقع أو الصوت وحده) */
  const analyzeUrl = (url: string, title: string, thumbnail?: string | null, range?: [number, number] | null) => {
    startConvert(
      {
        inputs: [url],
        preset: "topics",
        options: { ...defaultOptions(), sourceUrl: url, start: range?.[0] ?? null, end: range?.[1] ?? null },
      },
      title,
      presetById("topics")?.name[lang] ?? "topics",
      undefined,
      true,
    )
      .then(() => thumbnail && setJobs((prev) => prev.map((j) => (j.convert?.inputs[0] === url && !j.thumbnail ? { ...j, thumbnail } : j))))
      .catch(logError("analyzeUrl"));
  };

  /** من بطاقة تنزيل مكتمل: تحليل مواضيعه، مع رابط الصفحة لأخذ ترجمتها (إن نُزّل كاملًا) */
  const findTopics = (j: Job) => {
    if (!j.file) return;
    const r = j.request;
    const whole = r && !r.clips?.length && r.start == null && r.end == null;
    startConvert(
      {
        inputs: [j.file],
        preset: "topics",
        options: { ...defaultOptions(), sourceUrl: whole && /^https?:\/\//.test(r.url) ? r.url : null },
      },
      j.title,
      presetById("topics")?.name[lang] ?? "topics",
      undefined,
      true,
    ).catch(logError("findTopics"));
  };

  const copyText = (text: string, note?: string) => {
    writeText(text)
      .then(() => toast(note ?? t.toastCopied))
      .catch(logError("copyText"));
  };

  const copyMarkers = (j: Job) => {
    const text = (j.markers ?? []).map(([s, e]) => (s === e ? formatTimecode(s) : `${formatTimecode(s)}\t${formatTimecode(e)}`)).join("\n");
    // أين يُلصق؟ نقول ذلك بدل «تم النسخ» وحدها (U-60)
    writeText(text)
      .then(() => toast(t.timesCopied))
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
  const overall = running.length ? running.reduce((sum, j) => sum + (overallPercent(j) ?? 0), 0) / running.length : null;

  return (
    <I18n.Provider value={i18n}>
      {confirmNode}
      <div className={`app ${compact ? "compact" : ""}`}>
        <header className="topbar">
          <div className="brand">
            <img className="brand-mark" src="/logo.svg" alt="" />
            <h1 className="brand-name">{t.appName}</h1>
          </div>
          <nav className="tabs" ref={tabsRef} aria-label={t.tabsLabel}>
            <span className="tab-pill" ref={tabPill} aria-hidden="true" />
            {tabs.map((x) => (
              <button
                key={x.id}
                className="tab"
                data-tab={x.id}
                aria-current={tab === x.id ? "page" : undefined}
                onClick={() => {
                  // النقطة على «الإعدادات» تعني تحديثًا: نفتح القسم الذي فيه زر التحديث مباشرة
                  if (x.id === "settings" && updateVersion) setSettingsSection({ id: "about", n: Date.now() });
                  setTab(x.id);
                }}
                title={x.label}
              >
                <Icon name={x.icon} size={20} /> <span>{x.label}</span>
                {x.id === "settings" && updateVersion && <span className="tab-dot update" title={t.appUpdateTitle} />}
                {(x.id === "download" || x.id === "convert") &&
                  jobs.some((j) => isActive(j) && (x.id === "convert") === (j.type === "convert")) && (
                    <span className="tab-dot">
                      <span className="sr-only">{t.jobsRunning}</span>
                    </span>
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
          <div className="container">
            <SlideSwitch id={tab} index={tab === "guide" ? tabs.length : tabs.findIndex((x) => x.id === tab)} fade={!isMobile}>
              <div className="view">
                {tab === "download" && (
                  <DownloadView
                    session={downloadSession}
                    onAnalyze={isMobile ? undefined : analyzeUrl}
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
                      toast(t.filesCleared(prev.length), {
                        label: t.undo,
                        ms: 5000,
                        run: () => setFiles(() => prev.map((f) => ({ ...f, ...analyzed.current.get(f.path) }))),
                      });
                    }}
                    onRemoveFiles={(paths) => {
                      // حذف ملف أو الفاشلة منها يُتراجع عنه بمواضعها كما كانت (R2-52، R2-53)
                      const prev = files;
                      const gone = new Set(paths);
                      setFiles((cur) => cur.filter((f) => !gone.has(f.path)));
                      toast(t.filesRemoved(paths.length), {
                        label: t.undo,
                        ms: 5000,
                        run: () => setFiles(() => prev.map((f) => ({ ...f, ...analyzed.current.get(f.path) }))),
                      });
                    }}
                    onStart={startConvert}
                    onChain={chainConvert}
                  />
                )}
                {tab === "history" && (
                  <HistoryView
                    version={historyVersion}
                    onDownloadAgain={(e) => {
                      // نفس النوع والصيغة والجودة لا الرابط وحده (U-40)
                      if (e.kind !== "convert") update(optionsFromMeta(e.kind, e.meta));
                      setInject({ url: e.url, n: Date.now() });
                      setTab("download");
                    }}
                    onDragOut={isMobile ? undefined : (file, thumb) => dragOut(file, thumb)}
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
                  <Suspense fallback={null}>
                    <GuideView
                      onTour={startTour}
                      onGo={(to, section) => {
                        if (section) setSettingsSection({ id: section, n: Date.now() });
                        setTab(to);
                      }}
                    />
                  </Suspense>
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
                            (await confirm(t.cancelAll, t.cancelAllConfirm(activeShown.length))) &&
                            // القائمة بعد التأكيد لا قبله: ما انتهى أثناء السؤال لا يُلغى (FE23)
                            jobsRef.current.filter((j) => isActive(j) && activeShown.some((a) => a.id === j.id)).forEach(cancel)
                          }
                        >
                          <Icon name="x" size={16} /> {t.cancelAll}
                        </button>
                      )}
                      {/* كل الملفات المكتملة بسحبة واحدة إلى برنامج المونتاج (U-99) */}
                      {!isMobile && doneFiles.length > 1 && (
                        <div
                          className="btn btn-sm drag-all"
                          role="button"
                          tabIndex={-1}
                          draggable
                          title={t.dragAllHint}
                          onDragStart={(e) => {
                            e.preventDefault();
                            void dragOut(doneFiles);
                          }}
                        >
                          <Icon name="grip" size={16} /> {t.dragAll(doneFiles.length)}
                        </div>
                      )}
                      {finished.length > 0 && (
                        <button className="btn btn-sm btn-ghost" onClick={() => removeJobs(finished)}>
                          {t.clearFinished}
                        </button>
                      )}
                    </div>
                    {shown.length === 0 && (
                      // سطر مضغوط لا كتلة كبيرة: يقع تحت النموذج ولا يُرى غالبًا إلا بالتمرير (D-51)
                      <div className="empty-state compact">
                        <div className="empty-art">
                          <Icon name={tab === "convert" ? "convert" : "download"} size={20} />
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
                          onReveal={isMobile ? undefined : () => j.file && api.revealFile(j.file).catch(fileFailed)}
                          onOpen={isMobile ? undefined : () => j.file && api.openFile(j.file).catch(fileFailed)}
                          onCopyPath={isMobile ? undefined : () => j.file && copyText(j.file, t.pathCopied)}
                          onRetry={() => retry(j)}
                          onFix={j.type === "download" ? (fix) => fixJob(j, fix) : undefined}
                          onRemove={() => setJobs((p) => p.filter((x) => x.id !== j.id))}
                          onConvert={
                            j.type === "download" && j.file
                              ? () => {
                                  // ينقلك للمحوّل؛ والإشعار يقول ما حدث ويعيدك بنقرة (U-54)
                                  addFiles([j.file!]);
                                  toast(t.sentToConvert, { label: t.backToDownloads, run: () => setTab("download"), ms: 5000 });
                                }
                              : undefined
                          }
                          onSplit={j.markers?.length && !j.topics ? () => split(j) : undefined}
                          onRemoveFound={
                            j.markers?.length && ["detect_silence", "detect_black"].includes(j.convert?.preset ?? "")
                              ? () => removeFound(j)
                              : undefined
                          }
                          removeLabel={j.convert?.preset === "detect_silence" ? t.removeSilence : t.removeBlack}
                          lengths={j.markers?.length && !j.topics ? removalLengths(j) : null}
                          removal={removalView(j)}
                          queuePos={j.state === "queued" ? [queuedIds.indexOf(j.id) + 1, queuedIds.length] : undefined}
                          onStartNow={j.type === "download" ? () => api.startNow(j.id).catch(logError("startNow")) : undefined}
                          onCopyMarkers={j.markers?.length && !j.topics ? () => copyMarkers(j) : undefined}
                          onCopyChapters={
                            j.markers?.length && !j.topics
                              ? () => {
                                  const starts = j.markers!.map(([s, e]) => (s === e ? s : e));
                                  // YouTube يتجاهل الفصول كلها إن قلّت عن 3 (R2-4)
                                  const few = chapterStarts(starts).length < CHAPTER_MIN_COUNT;
                                  copyText(youtubeChapters(starts, t.chapterName), few ? t.chaptersTooFew : t.chaptersCopied);
                                }
                              : undefined
                          }
                          onDragOut={!isMobile && j.file ? () => dragOut(j.file!, j.thumbnail) : undefined}
                          topicRows={rowsOf(j)}
                          reelRange={j.topics ? reelRange(j) : undefined}
                          onCopyTopics={j.topics?.length ? () => copyText(topicsText(rowsOf(j)!, t.topicReel), t.topicsCopied) : undefined}
                          topicPlans={j.topics ? plansOf(j) : undefined}
                          partLength={(r) => keptLength(r[0], r[1], allCuts(j))}
                          onExportTopics={j.topics?.length ? (secs, o) => exportTopics(j, secs, o) : undefined}
                          onFindTopics={j.type === "download" && j.file ? () => findTopics(j) : undefined}
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
              <Icon name="filePlus" size={24} />
              <b>{t.dropHere}</b>
              {/* يقول مسبقًا إلى أين تذهب الملفات بدل نقلة مفاجئة (D-56) */}
              <span className="faint">{t.dropHereSub}</span>
            </div>
          </div>
        </Presence>

        {toastShown && (
          <div
            className={`toast ${toastLeaving ? "leaving" : ""}`}
            role="status"
            onMouseEnter={holdToast}
            onMouseLeave={resumeToast}
            onFocus={holdToast}
            onBlur={resumeToast}
          >
            <span>{toastShown.msg}</span>
            {toastShown.action && (
              <button
                className="toast-action"
                onClick={() => {
                  toastShown.action!.run();
                  endToast();
                }}
              >
                {toastShown.action.label}
              </button>
            )}
          </div>
        )}

        {/* تحديثات خامة: الكمبيوتر يثبّتها بنفسه، والهاتف يفتح رابط ملف APK الجديد */}
        <UpdateDialog enabled={settings.checkUpdates} busy={running.length > 0} request={updateRequest} onAvailable={setUpdateVersion} />

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
                <button className="btn btn-danger" onClick={() => api.quitApp().catch(logError("quitApp"))}>
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
