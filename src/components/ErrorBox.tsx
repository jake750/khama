import type { AppError } from "../api";
import { errorText, useI18n } from "../i18n";
import { Icon } from "./Icon";

/** رسالة خطأ مفهومة، وتحتها (مطويّة) التفاصيل التقنية الأصلية */
export function ErrorBox({ error, compact }: { error: AppError; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <div className="alert" style={compact ? { marginTop: 8 } : undefined}>
        <Icon name="alert" size={16} />
        <span>{errorText(t, error)}</span>
      </div>
      {error.detail && (
        <details className="tech">
          <summary>{t.techDetails}</summary>
          <pre>{error.detail}</pre>
        </details>
      )}
    </>
  );
}
