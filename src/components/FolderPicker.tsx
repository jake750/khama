import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

/** "C:\Users\me\Downloads" ← "Downloads" (المسار الكامل يظهر عند الوقوف عليه) */
export const folderName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** زر مجلد الحفظ: اسم المجلد فقط، وقائمة بآخر المجلدات المستخدمة */
export function FolderPicker(props: { current: string; recent: string[]; onPick: (dir: string) => void; onChoose: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const others = props.recent.filter((d) => d !== props.current).slice(0, 5);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="folder-picker" ref={box}>
      <button className="folder-btn" onClick={() => setOpen((o) => !o)} title={props.current} aria-expanded={open} aria-haspopup="menu">
        <Icon name="folder" size={16} />
        <span className="faint">{t.saveTo}</span>
        <span className="folder-name ltr">{folderName(props.current)}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-item current" title={props.current}>
            <Icon name="check" size={14} />
            <span className="ltr">{props.current}</span>
          </div>
          {others.length > 0 && <div className="menu-label">{t.recentFolders}</div>}
          {others.map((d) => (
            <button
              key={d}
              role="menuitem"
              className="menu-item"
              title={d}
              onClick={() => {
                props.onPick(d);
                setOpen(false);
              }}
            >
              <Icon name="folder" size={14} />
              <span className="ltr">{d}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              props.onChoose();
            }}
          >
            <Icon name="plus" size={14} /> {t.chooseFolder}
          </button>
        </div>
      )}
    </div>
  );
}
