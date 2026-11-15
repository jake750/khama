import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export interface MenuItem {
  label: string;
  icon: IconName;
  onClick: () => void;
}

/** قائمة «⋯» للأفعال الثانوية: تُغلق بالنقر خارجها أو بـ Escape (D-25) */
export function MoreMenu(props: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!props.items.length) return null;
  return (
    <div className="more-menu" ref={box}>
      <button
        type="button"
        className="icon-btn sm"
        title={props.label}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div className="more-menu-list" role="menu">
          {props.items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              <Icon name={it.icon} size={16} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
