import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getVersion } from "@tauri-apps/api/app";
import { platform, version as osVersion } from "@tauri-apps/plugin-os";
import { useState } from "react";
import type { AppError } from "../api";
import { errorText, useI18n } from "../i18n";
import { Icon } from "./Icon";
import { isMobile } from "../platform";

/** R3-U16: متصفحات لوحة «استعمل كوكيز من…» مكان الخطأ (Firefox أولًا: الوحيد الذي يُقرأ دائمًا على Windows) */
const QUICK_BROWSERS = ["firefox", "chrome", "edge", "brave"];
export const browserName = (b: string) => (b === "edge" ? "Edge" : b[0].toUpperCase() + b.slice(1));

/** ماذا يستطيع المستخدم أن يفعل حيال الخطأ؟ (زر واحد بجانب الرسالة) */
export type ErrorFix = "cookies" | "ytdlp" | "retry";

const COOKIE_CODES = ["botCheck", "ageRestricted", "loginRequired", "membersOnly", "privateVideo", "cookiesRead"];
const YTDLP_CODES = ["extractorOutdated", "unknown", "formatUnavailable", "forbidden"];

export function suggestedFix(e: AppError): ErrorFix | null {
  if (COOKIE_CODES.includes(e.code)) return "cookies";
  if (YTDLP_CODES.includes(e.code)) return "ytdlp";
  if (["network", "timeout", "rateLimited"].includes(e.code)) return "retry";
  return null;
}

/**
 * رسالة خطأ مفهومة، وتحتها (مطويّة) التفاصيل التقنية الأصلية.
 * inline = سطر خفيف تحت الحقل بدل صندوق أحمر كبير.
 */
export function ErrorBox(props: {
  error: AppError;
  compact?: boolean;
  inline?: boolean;
  onFix?: (fix: ErrorFix) => void | Promise<void>;
  /** البطاقة فيها زر «أعد» خاص بها: لا نكرّره هنا */
  noRetry?: boolean;
  /** R3-U16: كوكيز من متصفح بنقرة ثم إعادة المحاولة وحدها، بدل الذهاب إلى الإعدادات */
  onCookies?: (browser: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const { error } = props;
  const suggested = props.onFix ? suggestedFix(error) : null;
  const fix = props.noRetry && suggested === "retry" ? null : suggested;
  const fixLabel = fix === "cookies" ? t.fixCookies : fix === "ytdlp" ? t.updateYtdlpAction : t.tryAgain;
  const [copied, setCopied] = useState(false);
  // تحديث yt-dlp يستغرق ثواني: الزر يُظهر الانتظار ولا يُضغط مرتين (UX9)
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const quickCookies = fix === "cookies" && !!props.onCookies && !isMobile;
  const runFix = async () => {
    if (quickCookies) return setPicking((p) => !p);
    setBusy(true);
    try {
      await props.onFix!(fix!);
    } finally {
      setBusy(false);
    }
  };
  // التقرير يحمل الإصدار والنظام: «لا يعمل» بلا إصدار لا يمكن تتبّعه (R2-36)
  const copy = async () => {
    const version = await getVersion().catch(() => "?");
    const os = (() => {
      try {
        return `${platform()} ${osVersion()}`;
      } catch {
        return navigator.userAgent;
      }
    })();
    writeText(`Khama ${version} (${os})\nerror: ${error.code}\n${error.detail ?? ""}`)
      .then(() => {
        setCopied(true);
        // «نُسخ» يعود زرًا بعد ثانيتين فيمكن النسخ مجددًا (R2-56)
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };
  return (
    // compact = داخل بطاقة في قائمة: عشر بطاقات فاشلة لا تقاطع قارئ الشاشة عشر مرات (UX22)
    <div className={props.inline ? "error-inline" : undefined}>
      <div
        className={`alert ${props.inline ? "inline" : ""}`}
        style={props.compact ? { marginTop: 8 } : undefined}
        role={props.compact ? undefined : "alert"}
      >
        <Icon name="alert" size={16} />
        <span className="grow">{errorText(t, error)}</span>
        {fix && (
          <button
            className="btn btn-sm"
            onClick={runFix}
            disabled={busy}
            aria-busy={busy || undefined}
            aria-expanded={quickCookies ? picking : undefined}
          >
            <Icon name={fix === "cookies" ? "settings" : "retry"} size={16} /> {fixLabel}
          </button>
        )}
      </div>
      {quickCookies && picking && (
        <div className="cookie-pick" role="group" aria-label={t.cookiesPickFrom}>
          <span className="faint">{t.cookiesPickFrom}</span>
          {QUICK_BROWSERS.map((b) => (
            <button
              key={b}
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await props.onCookies!(b);
                  setPicking(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {browserName(b)}
            </button>
          ))}
          <button className="btn btn-sm btn-ghost" onClick={() => props.onFix!("cookies")}>
            {t.cookiesOther}
          </button>
        </div>
      )}
      {error.detail && (
        <details className="tech">
          <summary>{t.techDetails}</summary>
          <pre className="ltr">{error.detail}</pre>
          <button className="btn btn-sm btn-ghost" onClick={copy}>
            <Icon name={copied ? "check" : "copy"} size={16} /> {copied ? t.copiedForReport : t.copyForReport}
          </button>
        </details>
      )}
    </div>
  );
}
