import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useSlidingIndicator } from "../motion";
import { Hint } from "./Hint";

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** مجموعة أزرار يُختار منها واحد فقط (بديل أوضح من القائمة المنسدلة) */
export function Segmented<T extends string>(props: { value: T; options: SegOption<T>[]; onChange: (v: T) => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  // «حبّة» واحدة تنزلق إلى الزر المختار
  const pill = useSlidingIndicator(box, 'button[aria-pressed="true"]', `${props.value}|${props.options.length}`);
  // الأسهم تنقل الاختيار للخيار المجاور (يمينًا = التالي في الواجهة العربية)، وHome/End للطرفين (R2-19)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = props.options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === props.value);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 1, ArrowUp: -1 }[e.key];
    let next: SegOption<T> | undefined;
    if (step) next = enabled[(i + step + enabled.length) % enabled.length];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    props.onChange(next.value);
    const btns = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    btns[props.options.indexOf(next)]?.focus();
  };
  return (
    // أكثر من 3 خيارات: على الهاتف تصير شبكة من 3 أعمدة بدل سطر يخرج من الشاشة
    <div
      className={`segmented ${props.options.length > 3 ? "seg-many" : ""}`}
      role="group"
      aria-label={props.label}
      ref={box}
      onKeyDown={onKey}
    >
      <span className="seg-pill" ref={pill} aria-hidden="true" />
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; title: string; hint?: string }) {
  // الاسم هو العنوان وحده، والشرح وصف له: كان الشرح كله وزر «المزيد» جزءًا من اسم المفتاح (R2-23)
  const id = useId();
  return (
    <div className="toggle">
      <input
        id={`${id}-in`}
        type="checkbox"
        role="switch"
        checked={props.checked}
        aria-describedby={props.hint ? `${id}-hint` : undefined}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <label className="switch" htmlFor={`${id}-in`} aria-hidden="true" />
      <span>
        <label htmlFor={`${id}-in`}>{props.title}</label>
        {props.hint && <Hint id={`${id}-hint`} className="hint-plain" text={props.hint} />}
      </span>
    </div>
  );
}
