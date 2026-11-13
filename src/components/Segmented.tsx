import { useRef, type ReactNode } from "react";
import { useSlidingIndicator } from "../motion";

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** مجموعة أزرار يُختار منها واحد فقط (بديل أوضح من القائمة المنسدلة) */
export function Segmented<T extends string>(props: {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  // «حبّة» واحدة تنزلق إلى الزر المختار
  const pill = useSlidingIndicator(box, 'button[aria-pressed="true"]', `${props.value}|${props.options.length}`);
  return (
    // أكثر من 3 خيارات: على الهاتف تصير شبكة من 3 أعمدة بدل سطر يخرج من الشاشة
    <div className={`segmented ${props.options.length > 3 ? "seg-many" : ""}`} role="group" aria-label={props.label} ref={box}>
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

export function Toggle(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint?: string;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="switch" />
      <span>
        <span>{props.title}</span>
        {props.hint && <span className="faint" style={{ display: "block" }}>{props.hint}</span>}
      </span>
    </label>
  );
}
