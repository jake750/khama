import { Component, type ErrorInfo, type ReactNode } from "react";
import { logError, recentErrors } from "../log";

/**
 * خطأ أثناء الرسم في أي مكوّن كان يترك النافذة فارغة (R2-1). هنا رسالة باللغتين،
 * وزر يعيد تحميل الواجهة (العمليات الجارية تبقى في Rust وتعود بطاقاتها)، وزر ينسخ التفاصيل للتقرير.
 * باللغتين معًا لأن الخطأ قد يقع قبل قراءة الإعدادات أو داخل مزوّد اللغة نفسه.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; copied: boolean }> {
  state = { error: null as Error | null, copied: false };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError("render")(`${error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const details = [`Khama render error: ${error.message}`, ...recentErrors()].join("\n");
    return (
      <div className="boot-error crash" role="alert">
        <p>حدث خطأ في الواجهة — Something went wrong</p>
        <p className="faint" dir="auto">
          العمليات الجارية لم تتوقف. أعد تحميل الواجهة للمتابعة — Running jobs were not stopped. Reload to continue.
        </p>
        <code className="ltr">{error.message}</code>
        <div className="crash-actions">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            أعد التحميل — Reload
          </button>
          <button
            className="btn"
            onClick={() =>
              navigator.clipboard
                ?.writeText(details)
                .then(() => this.setState({ copied: true }))
                .catch(() => {})
            }
          >
            {copied ? "نُسخ — Copied" : "انسخ للتقرير — Copy for report"}
          </button>
        </div>
      </div>
    );
  }
}
