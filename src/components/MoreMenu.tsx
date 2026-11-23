import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as KeyEvent } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { D_ANTICIPATE, usePresence } from "../motion";

export interface MenuItem {
  label: string;
  icon: IconName;
  onClick: () => void;
  /** شرح يظهر عند الوقوف على العنصر */
  title?: string;
}

/** قائمة «⋯» للأفعال الثانوية: تُغلق بالنقر خارجها أو بـ Escape (D-25) */
export function MoreMenu(props: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [shown, leaving] = usePresence(open || null, D_ANTICIPATE);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const [up, setUp] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /** يغلق القائمة ويعيد التركيز إلى زر «⋯» (لوحة المفاتيح وقارئ الشاشة) */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const items = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  /** الأسهم بين العناصر، Home/End للطرفين، Tab يغلق (القائمة في آخر الصفحة فلا معنى للتنقّل فيها بـ Tab) */
  const onMenuKey = (e: KeyEvent) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      all[(n + all.length) % all.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  };
  // القائمة في طبقة ثابتة فوق الصفحة: البطاقة (overflow: hidden) كانت تقصّها، وتنقلب لأعلى إن لم يتّسع ما تحتها
  useLayoutEffect(() => {
    if (!shown || leaving) return;
    const btn = box.current?.getBoundingClientRect();
    const el = list.current;
    if (!btn || !el) return;
    const gap = 4;
    const margin = 8;
    const nav = document.querySelector<HTMLElement>("nav.tabs")?.getBoundingClientRect();
    // شريط التبويبات السفلي (الهاتف) يغطّي أسفل الشاشة
    const floor = nav && nav.top > window.innerHeight / 2 ? nav.top : window.innerHeight;
    const h = el.offsetHeight;
    const below = floor - btn.bottom - gap - margin;
    const above = btn.top - gap - margin;
    const flip = h > below && above > below;
    const rtl = document.documentElement.dir === "rtl";
    const maxW = window.innerWidth - 2 * margin;
    const w = Math.min(el.offsetWidth, maxW);
    let left = rtl ? btn.left : btn.right - w;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - w));
    setUp(flip);
    setPos({
      position: "fixed",
      left,
      right: "auto",
      insetInlineEnd: "auto",
      maxWidth: maxW,
      maxHeight: Math.max(120, flip ? above : below),
      overflowY: "auto",
      ...(flip ? { top: "auto", bottom: window.innerHeight - btn.top + gap } : { top: btn.bottom + gap, bottom: "auto" }),
    });
    // التركيز على أول عنصر: بدونه لا تصل لوحة المفاتيح إلى القائمة (هي في آخر الصفحة)
    el.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [shown, leaving]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!box.current?.contains(n) && !list.current?.contains(n)) setOpen(false);
    };
    // القائمة ثابتة: إن تحرّكت الصفحة تبقى معلّقة بعيدًا عن زرّها، فتُغلق
    const scroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
    };
  }, [open]);
  if (!props.items.length) return null;
  return (
    <div className="more-menu" ref={box}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn sm"
        title={props.label}
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          // يبدأ مخفيًا في كل فتح حتى يُقاس مكانه (قبل الرسم، في useLayoutEffect)
          if (!open) setPos({ visibility: "hidden" });
          setOpen(!open);
        }}
      >
        <Icon name="dots" size={16} />
      </button>
      {shown &&
        createPortal(
          <div
            ref={list}
            className="more-menu-list"
            role="menu"
            style={pos}
            data-up={up || undefined}
            data-leaving={leaving || undefined}
            inert={leaving || undefined}
            onKeyDown={onMenuKey}
          >
            {props.items.map((it) => (
              <button
                key={it.label}
                type="button"
                title={it.title}
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close(true);
                  it.onClick();
                }}
              >
                <Icon name={it.icon} size={16} /> {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
