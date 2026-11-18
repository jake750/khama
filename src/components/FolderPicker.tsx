import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";
import { D_ANTICIPATE, usePresence } from "../motion";

/** "C:\Users\me\Downloads" ← "Downloads" (المسار الكامل يظهر عند الوقوف عليه) */
export const folderName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p;

/** المجلد الأب: «Downloads» وحده لا يفرّق بين مجلدين بالاسم نفسه (D-33) */
export const parentName = (p: string) => {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length > 2 ? parts[parts.length - 2] : "";
};

/** زر مجلد الحفظ: اسم المجلد فقط، وقائمة بآخر المجلدات المستخدمة */
export function FolderPicker(props: {
  current: string;
  recent: string[];
  onPick: (dir: string) => void;
  onChoose: () => void;
  /** إزالة مجلد من «الأخيرة» (F-91) */
  onForget?: (dir: string) => void;
  /** مجلد الموقع الفرعي إن كان «مجلد لكل موقع» مفعّلًا (U-84) */
  sub?: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [shown, leaving] = usePresence(open || null, D_ANTICIPATE);
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
        <span className="folder-name ltr">
          {parentName(props.current) && <span className="faint">{parentName(props.current)}/</span>}
          {folderName(props.current)}
          {props.sub && <span className="faint">/{props.sub}</span>}
        </span>
        <Icon name="chevron" size={16} />
      </button>
      {shown && (
        <div className="menu" role="menu" data-leaving={leaving || undefined} inert={leaving || undefined}>
          <div className="menu-item current" title={props.current}>
            <Icon name="check" size={16} />
            <span className="ltr">{props.current}</span>
          </div>
          {others.length > 0 && <div className="menu-label">{t.recentFolders}</div>}
          {others.map((d) => (
            <div key={d} className="menu-row">
              <button
                role="menuitem"
                className="menu-item"
                title={d}
                onClick={() => {
                  props.onPick(d);
                  setOpen(false);
                }}
              >
                <Icon name="folder" size={16} />
                <span className="ltr">{d}</span>
              </button>
              {props.onForget && (
                <button className="icon-btn sm" title={t.forgetFolder} aria-label={t.forgetFolder} onClick={() => props.onForget!(d)}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
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
            <Icon name="plus" size={16} /> {t.chooseFolder}
          </button>
        </div>
      )}
    </div>
  );
}
