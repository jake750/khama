import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { isMac } from "../platform";

/** أيقونات أزرار النافذة بخط رفيع كما في Windows 11 (10×10) */
const glyph = {
  min: <path d="M0 5.5h10" />,
  max: <rect x="0.5" y="0.5" width="9" height="9" rx="1" />,
  restore: (
    <>
      <rect x="0.5" y="2.5" width="7" height="7" rx="1" />
      <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
    </>
  ),
  close: <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />,
};

function Glyph({ d }: { d: ReactNode }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      {d}
    </svg>
  );
}

/**
 * شريط عنوان خامة على الكمبيوتر: بلون التطبيق بدل شريط النظام.
 * السحب ونقرتا التكبير عبر data-tauri-drag-region. على macOS تبقى الإشارات الأصلية
 * (titleBarStyle: Overlay) ونترك لها مكانًا، وعلى Windows وLinux نرسم الأزرار بأنفسنا.
 */
export function TitleBar(props: { children?: ReactNode; tools?: ReactNode }) {
  const { t } = useI18n();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (isMac) return;
    const w = getCurrentWindow();
    const sync = () => w.isMaximized().then(setMaximized).catch(() => {});
    sync();
    const un = w.onResized(sync);
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  const w = () => getCurrentWindow();
  return (
    <header className={`titlebar ${isMac ? "mac" : ""}`} data-tauri-drag-region>
      {props.children}
      <span className="spacer" data-tauri-drag-region />
      {props.tools && <div className="titlebar-tools">{props.tools}</div>}
      {!isMac && (
        <div className="window-controls">
          <button className="wc" onClick={() => w().minimize()} aria-label={t.winMinimize} title={t.winMinimize}>
            <Glyph d={glyph.min} />
          </button>
          <button className="wc" onClick={() => w().toggleMaximize()} aria-label={maximized ? t.winRestore : t.winMaximize} title={maximized ? t.winRestore : t.winMaximize}>
            <Glyph d={maximized ? glyph.restore : glyph.max} />
          </button>
          <button className="wc close" onClick={() => w().close()} aria-label={t.winClose} title={t.winClose}>
            <Glyph d={glyph.close} />
          </button>
        </div>
      )}
    </header>
  );
}
