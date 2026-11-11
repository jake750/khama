import type { AppError } from "../api";
import { errorText, useI18n } from "../i18n";
import { Icon } from "./Icon";

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
  onFix?: (fix: ErrorFix) => void;
}) {
  const { t } = useI18n();
  const { error } = props;
  const fix = props.onFix ? suggestedFix(error) : null;
  const fixLabel = fix === "cookies" ? t.fixCookies : fix === "ytdlp" ? t.updateYtdlpAction : t.tryAgain;
  return (
    <div className={props.inline ? "error-inline" : undefined}>
      <div className={`alert ${props.inline ? "inline" : ""}`} style={props.compact ? { marginTop: 8 } : undefined} role="alert">
        <Icon name="alert" size={16} />
        <span style={{ flex: 1 }}>{errorText(t, error)}</span>
        {fix && (
          <button className="btn btn-sm" onClick={() => props.onFix!(fix)}>
            <Icon name={fix === "cookies" ? "settings" : "retry"} size={16} /> {fixLabel}
          </button>
        )}
      </div>
      {error.detail && (
        <details className="tech">
          <summary>{t.techDetails}</summary>
          <pre>{error.detail}</pre>
        </details>
      )}
    </div>
  );
}
