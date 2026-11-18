import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";

/** نافذة حوار بسيطة: خلفية معتمة، Esc والنقر خارجها يغلقانها (إن سُمح)، والتركيز على أول زر أساسي */
export function Dialog(props: { title: string; children: ReactNode; actions: ReactNode; onClose?: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  useEffect(() => {
    onClose.current = props.onClose;
  });
  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>("[data-autofocus], .btn-primary")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose.current?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="update-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div className="update-card" ref={card} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{props.title}</h2>
        <div className="dialog-body">{props.children}</div>
        <div className="update-actions">{props.actions}</div>
      </div>
    </div>
  );
}

type Ask = { title: string; message: string; ok: string; resolve: (yes: boolean) => void };

/**
 * بديل window.confirm (U-49): نافذة داخل التطبيق بلغته وأسلوبه بدل أزرار النظام.
 * يُرجع [العنصر، ask]؛ ضع العنصر في الشجرة، وask(...) وعدٌ يُحَلّ بنعم أو لا.
 * التركيز على «إلغاء» لأن كل الاستعمالات أفعال لا تُتراجع.
 */
export function useConfirm(): [ReactNode, (title: string, message: string, ok?: string) => Promise<boolean>] {
  const [ask, setAsk] = useState<Ask | null>(null);
  const confirm = useCallback(
    (title: string, message: string, ok?: string) =>
      new Promise<boolean>((resolve) => setAsk({ title, message, ok: ok ?? title, resolve })),
    [],
  );
  const close = (yes: boolean) => {
    ask?.resolve(yes);
    setAsk(null);
  };
  return [ask && <ConfirmDialog ask={ask} close={close} />, confirm];
}

/** مكوّن مستقل ليقرأ اللغة من داخل الشجرة (App نفسه هو من يوفّرها) */
function ConfirmDialog({ ask, close }: { ask: Ask; close: (yes: boolean) => void }) {
  const { t } = useI18n();
  return (
    <Dialog
      title={ask.title}
      onClose={() => close(false)}
      actions={
        <>
          <button className="btn btn-ghost" data-autofocus onClick={() => close(false)}>
            {t.cancel}
          </button>
          <button className="btn btn-danger" onClick={() => close(true)}>
            {ask.ok}
          </button>
        </>
      }
    >
      <p>{ask.message}</p>
    </Dialog>
  );
}
