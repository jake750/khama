import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { EASE_IN, EASE_OUT, reducedMotion, usePresence } from "../motion";
import { Icon } from "./Icon";

/** صفحة آخر إصدار: بديل يدوي إن فشل التثبيت التلقائي */
const RELEASES_URL = "https://github.com/jake750/khama/releases/latest";
/** ننتظر قليلًا بعد الفتح حتى لا ينافس الفحصُ تحميلَ الواجهة */
const CHECK_DELAY_MS = 2500;
const EXIT_MS = 220;

type Phase = { step: "ask" } | { step: "downloading"; got: number; total: number | null } | { step: "installing" } | { step: "failed" };

/**
 * يبحث عن نسخة أحدث من خامة مرة واحدة بعد الفتح، ويعرض نافذة «تحديث / لاحقًا».
 * بلا إنترنت أو بلا إصدار منشور: يفشل بصمت. «لاحقًا» تغلقها حتى الفتح القادم.
 */
export function UpdateDialog() {
  const { t } = useI18n();
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>({ step: "ask" });
  const [shown, leaving] = usePresence(update, EXIT_MS);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode يركّب ويفكّ ثم يركّب في التطوير: الإلغاء يمسح المؤقّت الأول،
    // والعلَم يُرفع عند انطلاق الفحص فعلًا، فيحدث مرة واحدة فقط
    if (started.current) return;
    const timer = window.setTimeout(() => {
      started.current = true;
      check({ timeout: 15_000 })
        .then((u) => u && setUpdate(u))
        .catch(() => {}); // بلا اتصال، أو لا يوجد latest.json بعد
    }, CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const busy = phase.step === "downloading" || phase.step === "installing";
  const close = () => {
    if (!busy) setUpdate(null);
  };

  const install = async () => {
    if (!update) return;
    setPhase({ step: "downloading", got: 0, total: null });
    try {
      let got = 0;
      await update.downloadAndInstall((e) => {
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
    invoke("plugin:opener|open_url", { url: RELEASES_URL }).catch(() => {});
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
          { opacity: 0, transform: "translateY(14px) scale(0.96)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 460, easing: EASE_OUT },
      );
    } else if (leaving && !still) {
      b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, easing: EASE_IN, fill: "forwards" });
      c.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(8px) scale(0.97)" }], {
        duration: EXIT_MS,
        easing: EASE_IN,
        fill: "forwards",
      });
    }
  }, [shown, leaving]);

  if (!shown) return null;

  const pct = phase.step === "downloading" && phase.total ? Math.min(100, Math.round((phase.got / phase.total) * 100)) : null;
  const notes = shown.body?.trim();

  return (
    <div className="update-backdrop" ref={backdrop} onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="update-card" ref={card} role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-body">
        <div className="update-head">
          <span className="update-icon" aria-hidden="true">
            <Icon name="download" size={20} />
          </span>
          <div>
            <h2 id="update-title">{t.appUpdateTitle}</h2>
            <p id="update-body" className="muted">
              {t.appUpdateBody(shown.version, shown.currentVersion)}
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
          {phase.step === "failed" ? (
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
