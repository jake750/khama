import { useEffect, useRef, type ReactNode } from "react";

/** نافذة حوار بسيطة: خلفية معتمة، Esc والنقر خارجها يغلقانها (إن سُمح)، والتركيز على أول زر أساسي */
export function Dialog(props: { title: string; children: ReactNode; actions: ReactNode; onClose?: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  useEffect(() => {
    onClose.current = props.onClose;
  });
  useEffect(() => {
    card.current?.querySelector<HTMLButtonElement>(".btn-primary")?.focus();
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
