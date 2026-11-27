import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { ANTICIPATE, BOUNCE, D_BOUNCE, EASE_IN, EASE_OUT, reducedMotion, usePresence } from "../motion";
import { isMobile } from "../platform";
import { Icon } from "./Icon";
import { logError } from "../log";

/** صفحة آخر إصدار: بديل يدوي إن فشل التثبيت التلقائي */
const RELEASES_URL = "https://github.com/jake750/khama/releases/latest";
/** للهاتف: آخر إصدار منشور (المسودات والإصدارات التجريبية لا تظهر هنا) */
const LATEST_API = "https://api.github.com/repos/jake750/khama/releases/latest";
/** ننتظر قليلًا بعد الفتح حتى لا ينافس الفحصُ تحميلَ الواجهة */
const CHECK_DELAY_MS = 2500;
const RECHECK_MS = 12 * 3600_000;
const EXIT_MS = 220;

type Phase =
  | { step: "ask" }
  | { step: "downloading"; got: number; total: number | null }
  | { step: "installing" }
  /** أندرويد: الملف نزل، ومثبّت النظام مفتوح (أو ينتظر إذن «تثبيت التطبيقات») */
  | { step: "apk"; path: string; allow: boolean }
  | { step: "failed" };

/** تحديث متاح: على الكمبيوتر نثبّته بأنفسنا (native)، وعلى الهاتف نفتح رابط ملف APK (url) */
type Available = { version: string; current: string; notes?: string; native?: Update; url?: string; size?: number };

/** "v1.2.10" > "1.2.9"؟ نقارن الأرقام فقط ونتجاهل لاحقة مثل -beta */
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) =>
    v
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

async function checkDesktop(): Promise<Available | null> {
  const u = await check({ timeout: 15_000 });
  return u && { version: u.version, current: u.currentVersion, notes: u.body, native: u };
}

/**
 * أندرويد: لا يمكن للتطبيق تثبيت نفسه، فنقارن نسختنا بآخر إصدار على GitHub،
 * ولا نعرض النافذة إلا إن كان فيه ملف APK يمكن تنزيله.
 */
async function checkMobile(): Promise<Available | null> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(LATEST_API, { signal: ctrl.signal, headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const rel: { tag_name: string; body?: string | null; assets?: { name: string; browser_download_url: string; size?: number }[] } =
      await res.json();
    const current = await getVersion();
    // قد يكون هناك APK لكل معمارية: نفضّل الشامل، ثم arm64 (أغلب الهواتف)، ثم أي واحد
    const apks = (rel.assets ?? []).filter((a) => a.name.toLowerCase().endsWith(".apk"));
    const pick = (k: string) => apks.find((a) => a.name.toLowerCase().includes(k));
    const apk = pick("universal") ?? pick("arm64") ?? pick("aarch64") ?? apks[0];
    if (!apk || !isNewer(rel.tag_name, current)) return null;
    return {
      version: rel.tag_name.replace(/^v/i, ""),
      current,
      notes: rel.body ?? undefined,
      url: apk.browser_download_url,
      size: apk.size,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

const openUrl = (url: string) => invoke("plugin:opener|open_url", { url }).catch(logError("openUrl"));

/**
 * يبحث عن نسخة أحدث من خامة مرة واحدة بعد الفتح، ويعرض نافذة «تحديث / لاحقًا».
 * بلا إنترنت أو بلا إصدار منشور: يفشل بصمت. «لاحقًا» تغلقها حتى الفتح القادم.
 */
export function UpdateDialog(props: {
  /** عمليات جارية: لا نقاطعها بنافذة */
  busy: boolean;
  /** يزيد حين يضغط المستخدم «ثبّت التحديث» في الإعدادات */
  request: number;
  /** البحث عند الفتح مسموح (إعداد «البحث عن تحديثات»، F-51) */
  enabled: boolean;
  /** وُجد تحديث: نافذة عند الفتح، وشارة على «الإعدادات» تبقى إن أُجّل */
  onAvailable: (version: string | null) => void;
}) {
  const { t } = useI18n();
  const [update, setUpdate] = useState<Available | null>(null);
  const found = useRef<Available | null>(null);
  const onAvailable = useRef(props.onAvailable);
  onAvailable.current = props.onAvailable;
  const [phase, setPhase] = useState<Phase>({ step: "ask" });
  const [shown, leaving] = usePresence(update, EXIT_MS);
  const started = useRef(false);
  const busyRef = useRef(props.busy);
  useEffect(() => {
    busyRef.current = props.busy;
  }, [props.busy]);

  useEffect(() => {
    // StrictMode يركّب ويفكّ ثم يركّب في التطوير: الإلغاء يمسح المؤقّت الأول،
    // والعلَم يُرفع عند انطلاق الفحص فعلًا، فيحدث مرة واحدة فقط
    if (started.current || !props.enabled) return;
    const check = (first: boolean) =>
      (isMobile ? checkMobile() : checkDesktop())
        .then((u) => {
          // فحص لاحق لا يعيد فتح نافذة رآها المستخدم لنفس الإصدار
          const fresh = u && u.version !== found.current?.version;
          found.current = u;
          onAvailable.current(u?.version ?? null);
          // نخبر المستخدم فور الفتح، إلا إن بدأ تنزيلًا: عندها تبقى الشارة على «الإعدادات».
          // في الفحوص اللاحقة الشارة وحدها، بلا نافذة تقاطع عمله
          if (u && first && fresh && !busyRef.current) setUpdate(u);
        })
        .catch(() => {}); // بلا اتصال، أو لا يوجد إصدار منشور بعد
    const timer = window.setTimeout(() => {
      started.current = true;
      void check(true);
    }, CHECK_DELAY_MS);
    // التطبيق يبقى مفتوحًا في الخلفية أيامًا: فحص كل 12 ساعة، وإلا لا يرى الإصدار الجديد حتى يُعاد تشغيله (R2-16)
    const every = window.setInterval(() => void check(false), RECHECK_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- مرة عند الفتح فقط
  }, []);

  // تُفتح النافذة فقط حين يطلبها المستخدم، ولا أثناء تنزيل
  useEffect(() => {
    if (props.request > 0 && found.current && !props.busy) setUpdate(found.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.request]);

  const busy = phase.step === "downloading" || phase.step === "installing";

  /** أندرويد: يفتح مثبّت النظام، أو شاشة السماح بالتثبيت أول مرة */
  const openInstaller = async (path: string) => {
    try {
      const allow = await invoke<boolean>("install_app_update", { path });
      setPhase({ step: "apk", path, allow });
    } catch (e) {
      logError("installApk")(e);
      setPhase({ step: "failed" });
    }
  };

  // بعد الرجوع من شاشة السماح بالتثبيت نكمل تلقائيًا
  useEffect(() => {
    if (phase.step !== "apk" || !phase.allow) return;
    const path = phase.path;
    const onVisible = () => document.visibilityState === "visible" && void openInstaller(path);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [phase]);

  const installMobile = async (u: Available) => {
    if (!u.url) return;
    setPhase({ step: "downloading", got: 0, total: u.size ?? null });
    const stop = await listen<number>("app-update-progress", (e) =>
      setPhase((p) => (p.step === "downloading" ? { ...p, got: e.payload } : p)),
    );
    try {
      const path = await invoke<string>("download_app_update", { url: u.url, version: u.version });
      await openInstaller(path);
    } catch (e) {
      logError("downloadApk")(e);
      setPhase({ step: "failed" });
    } finally {
      stop();
    }
  };
  const close = () => {
    if (!busy) setUpdate(null);
  };

  const install = async () => {
    if (!update) return;
    // الهاتف: ننزّل ملف APK داخل التطبيق، ثم يطلب أندرويد من المستخدم تأكيد تثبيته
    if (!update.native) return installMobile(update);
    setPhase({ step: "downloading", got: 0, total: null });
    try {
      let got = 0;
      await update.native.downloadAndInstall((e) => {
        if (e.event === "Started") setPhase({ step: "downloading", got: 0, total: e.data.contentLength ?? null });
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          setPhase((p) => (p.step === "downloading" ? { ...p, got } : p));
        } else if (e.event === "Finished") setPhase({ step: "installing" });
      });
      // على Windows يغلق المثبّت التطبيق بنفسه؛ على الأنظمة الأخرى نعيد تشغيله
      await relaunch();
    } catch {
      setPhase({ step: "failed" });
    }
  };

  const openPage = () => {
    openUrl(RELEASES_URL);
    setUpdate(null);
  };

  // Esc = «لاحقًا»
  useEffect(() => {
    if (!update) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // دخول وخروج: الخلفية تبهت، والبطاقة تصعد وتكبر قليلًا (وتنزل عند الإغلاق)
  const backdrop = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const entered = useRef(false);
  useLayoutEffect(() => {
    const b = backdrop.current;
    const c = card.current;
    if (!shown || !b || !c) {
      entered.current = false;
      return;
    }
    const still = reducedMotion();
    if (!leaving && !entered.current) {
      entered.current = true;
      primary.current?.focus();
      if (still) return;
      b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: EASE_OUT });
      c.animate(
        [
          { opacity: 0, transform: "translateY(14px) scale(0.85)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: D_BOUNCE, easing: BOUNCE },
      );
    } else if (leaving && !still) {
      b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, easing: EASE_IN, fill: "forwards" });
      c.animate(
        [
          { opacity: 1, transform: "none", easing: ANTICIPATE },
          { opacity: 0, transform: "translateY(8px) scale(0.9)" },
        ],
        {
          duration: EXIT_MS,
          fill: "forwards",
        },
      );
    }
  }, [shown, leaving]);

  if (!shown) return null;

  const pct = phase.step === "downloading" && phase.total ? Math.min(100, Math.round((phase.got / phase.total) * 100)) : null;
  const notes = shown.notes?.trim();

  return (
    <div className="update-backdrop" ref={backdrop} onClick={(e) => e.target === e.currentTarget && close()}>
      <div
        className="update-card motif"
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        aria-describedby="update-body"
      >
        <div className="update-head">
          <span className="update-icon" aria-hidden="true">
            <Icon name="download" size={20} />
          </span>
          <div>
            <h2 id="update-title">{t.appUpdateTitle}</h2>
            <p id="update-body" className="muted">
              {t.appUpdateBody(shown.version, shown.current)}
              {!shown.native && <> {t.appUpdateApkHint}</>}
            </p>
          </div>
        </div>

        {notes && phase.step === "ask" && (
          <div className="update-notes">
            <b>{t.appUpdateNotes}</b>
            {/* ملاحظات الإصدار قد تكون بلغة غير لغة الواجهة: اتجاهها من نصّها */}
            <p dir="auto">{notes}</p>
          </div>
        )}

        {busy && (
          <div className="update-progress" role="status">
            <span className="faint">
              {phase.step === "installing" ? t.appUpdateInstalling : t.appUpdateDownloading}
              {pct != null && <bdi className="ltr"> {pct}%</bdi>}
            </span>
            <div className={`progress ${pct == null ? "indeterminate" : ""}`}>
              <div style={{ width: `${pct ?? 0}%` }} />
            </div>
          </div>
        )}

        {phase.step === "apk" && (
          <div className="update-progress" role="status">
            <span className="faint">{phase.allow ? t.appUpdateApkAllow : t.appUpdateApkConfirm}</span>
          </div>
        )}

        {phase.step === "failed" && (
          <div className="alert" role="alert">
            <Icon name="alert" size={16} />
            <span>{t.appUpdateFailed}</span>
          </div>
        )}

        <div className="update-actions">
          <button className="btn btn-ghost" onClick={close} disabled={busy}>
            {t.appUpdateLater}
          </button>
          {phase.step === "apk" ? (
            <button className="btn btn-primary" ref={primary} onClick={() => void openInstaller(phase.path)}>
              {t.appUpdateInstall}
            </button>
          ) : phase.step === "failed" ? (
            <button className="btn btn-primary" ref={primary} onClick={openPage}>
              {t.appUpdateOpenPage}
            </button>
          ) : (
            <button className="btn btn-primary" ref={primary} onClick={install} disabled={busy}>
              {t.appUpdateNow}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
