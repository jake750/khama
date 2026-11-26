import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as KeyEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { D_ANTICIPATE, usePresence } from "../motion";

/**
 * قائمة منسدلة بأسلوب التطبيق بدل <select> الأصلية (زواياها حادة وتظهر بلا حركة، ويرسمها النظام).
 * تنبت من زرّها وتنعكس لأعلى إن لم يتّسع ما تحته، وتُغلق بالنقر خارجها أو Escape أو بالتمرير.
 * لوحة المفاتيح: الأسهم وHome/End للتنقّل، Enter/Space للاختيار، وحرف للقفز إلى أول خيار يبدأ به.
 */
/** قبل القياس: ثابتة في أعلى الشاشة ومخفية، فلا تطيل الصفحة ولا تحرّكها */
const HIDDEN: CSSProperties = { visibility: "hidden", position: "fixed", top: 0, left: 0 };

export function Select(props: {
  value: string;
  options: { value: string; label: ReactNode; text?: string }[];
  onChange: (v: string) => void;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [shown, leaving] = usePresence(open || null, D_ANTICIPATE);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>(HIDDEN);
  const [up, setUp] = useState(false);
  const current = props.options.find((o) => o.value === props.value) ?? props.options[0];

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (v: string) => {
    if (v !== props.value) props.onChange(v);
    close(true);
  };
  const items = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
  const onKey = (e: KeyEvent) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      all[Math.max(0, Math.min(all.length - 1, n))]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Tab") close(false);
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const txt = (n: number) => (props.options[n]?.text ?? all[n]?.textContent ?? "").trim().toLowerCase();
      const hit = all.findIndex((_, n) => n > i && txt(n).startsWith(k));
      const first = all.findIndex((_, n) => txt(n).startsWith(k));
      if (hit >= 0 || first >= 0) go(hit >= 0 ? hit : first);
    }
  };

  // مكان القائمة قبل الرسم: تحت الزر بعرضه على الأقل، أو فوقه إن كان ما تحته أضيق
  useLayoutEffect(() => {
    if (!shown || leaving) return;
    const btn = trigger.current?.getBoundingClientRect();
    const el = list.current;
    if (!btn || !el) return;
    const gap = 6;
    const margin = 8;
    const nav = document.querySelector<HTMLElement>("nav.tabs")?.getBoundingClientRect();
    const floor = nav && nav.top > window.innerHeight / 2 ? nav.top : window.innerHeight;
    const h = el.scrollHeight;
    const below = floor - btn.bottom - gap - margin;
    const above = btn.top - gap - margin;
    const flip = h > below && above > below;
    const w = Math.min(Math.max(btn.width, el.offsetWidth), window.innerWidth - 2 * margin);
    const rtl = document.documentElement.dir === "rtl";
    let left = rtl ? btn.right - w : btn.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - w));
    setUp(flip);
    setPos({
      position: "fixed",
      left,
      width: w,
      maxHeight: Math.max(140, Math.min(320, flip ? above : below)),
      overflowY: "auto",
      ...(flip ? { bottom: window.innerHeight - btn.top + gap } : { top: btn.bottom + gap }),
    });
  }, [shown, leaving]);

  // التركيز بعد أن تظهر (العنصر المخفي لا يقبل التركيز)، على الخيار المختار
  const placed = pos.visibility !== "hidden";
  useEffect(() => {
    const el = list.current;
    if (!placed || !el || leaving) return;
    const sel = el.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? el.querySelector<HTMLButtonElement>('[role="option"]');
    // نمرّر القائمة نفسها فقط: scrollIntoView يحرّك الصفحة أيضًا، وحدث التمرير يغلقها فور فتحها
    if (sel) el.scrollTop = Math.max(0, sel.offsetTop - el.clientHeight / 2 + sel.offsetHeight / 2);
    sel?.focus({ preventScroll: true });
  }, [placed, leaving]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!trigger.current?.contains(n) && !list.current?.contains(n)) setOpen(false);
    };
    // القائمة ثابتة: إن تحرّكت الصفحة تبقى بعيدة عن زرّها، فتُغلق
    const scroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`select select-btn ${props.className ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props.label}
        data-open={open || undefined}
        onClick={() => {
          if (!open) setPos(HIDDEN);
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            setPos(HIDDEN);
            setOpen(true);
          }
        }}
      >
        <span className="select-value">{current?.label}</span>
        <span className="select-chevron" aria-hidden="true">
          <Icon name="chevron" size={16} />
        </span>
      </button>
      {shown &&
        createPortal(
          <div
            ref={list}
            className="more-menu-list select-list"
            role="listbox"
            aria-label={props.label}
            style={pos}
            data-up={up || undefined}
            data-leaving={leaving || undefined}
            inert={leaving || undefined}
            onKeyDown={onKey}
          >
            {props.options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === props.value}
                onClick={() => pick(o.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    pick(o.value);
                  }
                }}
              >
                <span className="select-check" aria-hidden="true">
                  {o.value === props.value && <Icon name="check" size={16} />}
                </span>
                <span>{o.label}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
