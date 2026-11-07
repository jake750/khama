import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";

/* أدوات الحركة: كلها تحرّك transform/opacity أو ارتفاع عنصر واحد، وتحترم «تقليل الحركة». */

export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
export const EASE_IN = "cubic-bezier(0.7, 0, 0.84, 0)";
export const EASE_IO = "cubic-bezier(0.65, 0, 0.35, 1)";

export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * مؤشّر منزلق تحت العنصر المختار (تبويبات، أزرار مجزّأة).
 * يقيس الزر المختار ويحرّك «حبّة» واحدة إليه بـtransform بدل أن يقفز اللون من زر لآخر.
 */
export function useSlidingIndicator(container: RefObject<HTMLElement | null>, selector: string, dep: unknown) {
  const pill = useRef<HTMLSpanElement>(null);
  const state = useRef<{ box: HTMLElement | null; dep: unknown; placed: boolean; ro: ResizeObserver | null }>({
    box: null,
    dep: undefined,
    placed: false,
    ro: null,
  });

  const place = (animate: boolean) => {
    const s = state.current;
    const box = s.box;
    const el = pill.current;
    if (!box || !el) return;
    const active = box.querySelector<HTMLElement>(selector);
    if (!active) {
      el.style.opacity = "0";
      return;
    }
    const glide = animate && s.placed && !reducedMotion();
    if (!glide) el.style.transition = "none";
    el.style.opacity = "1";
    el.style.width = `${active.offsetWidth}px`;
    el.style.height = `${active.offsetHeight}px`;
    el.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    if (!glide) {
      void el.offsetWidth; // نثبّت الموضع بلا حركة ثم نعيد الانتقال
      el.style.transition = "";
    }
    s.placed = true;
  };

  // يعمل بعد كل رسم، لكنه لا يقيس إلا إذا تغيّر المختار أو ظهر الحاوي لأول مرة
  // (الحاوي قد لا يوجد في أول رسم، مثل شاشة التحميل)
  useLayoutEffect(() => {
    const s = state.current;
    const box = container.current;
    if (box !== s.box) {
      s.ro?.disconnect();
      s.box = box;
      s.placed = false;
      s.dep = dep;
      if (!box) return;
      // تغيّر الخط/اللغة/حجم النافذة: نعيد القياس بلا حركة
      s.ro = new ResizeObserver(() => place(false));
      s.ro.observe(box);
      box.querySelectorAll("button").forEach((b) => s.ro?.observe(b));
      place(false);
      return;
    }
    if (!box || Object.is(s.dep, dep)) return;
    s.dep = dep;
    box.querySelectorAll("button").forEach((b) => s.ro?.observe(b));
    place(true);
  });

  useEffect(() => () => state.current.ro?.disconnect(), []);

  return pill;
}

/**
 * قائمة تتحرك عناصرها عند الإضافة والحذف:
 * الجديد ينفتح بارتفاعه ويصعد، والمحذوف ينطوي ويختفي، فيتحرك ما تحته بانسياب بدل أن يقفز.
 * كل عنصر يُلفّ بـ<div class="li">؛ المسافة بين العناصر تكون في الغلاف حتى تنطوي معه.
 */
export function AnimatedList(props: { children: ReactNode; className?: string }) {
  const current = Children.toArray(props.children).filter(isValidElement) as ReactElement[];
  const [leaving, setLeaving] = useState<Map<React.Key, { el: ReactElement; index: number }>>(new Map());
  const prev = useRef<ReactElement[]>(current);
  const mounted = useRef(false);
  const fresh = useRef(new Set<React.Key>());

  // نكتشف المحذوف قبل الرسم ونبقيه في مكانه حتى ينطوي
  const currentKeys = new Set(current.map((c) => c.key));
  const removed = prev.current.filter((c) => !currentKeys.has(c.key) && !leaving.has(c.key!));
  if (removed.length) {
    const next = new Map(leaving);
    for (const r of removed) next.set(r.key!, { el: r, index: prev.current.indexOf(r) });
    setLeaving(next);
  }
  for (const c of current) {
    if (mounted.current && !prev.current.some((p) => p.key === c.key)) fresh.current.add(c.key!);
  }

  useEffect(() => {
    prev.current = current;
    mounted.current = true;
  });

  // ندمج الباقي مع المغادرين في مواضعهم القديمة
  const merged: { el: ReactElement; state: "in" | "out" }[] = current.map((el) => ({ el, state: "in" }));
  [...leaving.values()]
    .sort((a, b) => a.index - b.index)
    .forEach(({ el, index }) => {
      if (currentKeys.has(el.key)) return;
      merged.splice(Math.min(index, merged.length), 0, { el, state: "out" });
    });

  return (
    <div className={props.className}>
      {merged.map(({ el, state }) => (
        <ListItem
          key={el.key}
          state={state}
          enter={fresh.current.has(el.key!)}
          onEntered={() => fresh.current.delete(el.key!)}
          onExited={() =>
            setLeaving((m) => {
              const n = new Map(m);
              n.delete(el.key!);
              return n;
            })
          }
        >
          {el}
        </ListItem>
      ))}
    </div>
  );
}

function ListItem(props: { state: "in" | "out"; enter: boolean; children: ReactNode; onEntered: () => void; onExited: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !props.enter) return;
    if (reducedMotion()) return props.onEntered();
    const h = el.offsetHeight;
    el.style.overflow = "hidden";
    const a = el.animate(
      [
        { height: "0px", opacity: 0, transform: "translateY(8px) scale(0.985)" },
        { height: `${h}px`, opacity: 1, transform: "none" },
      ],
      { duration: 420, easing: EASE_OUT },
    );
    a.onfinish = () => {
      el.style.overflow = "";
      props.onEntered();
    };
    return () => {
      a.cancel();
      el.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastState = useRef(props.state);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || lastState.current === props.state) return;
    lastState.current = props.state;
    if (props.state === "in") {
      // عاد قبل أن يكتمل خروجه: نلغي الانطواء
      el.getAnimations().forEach((a) => a.cancel());
      el.style.overflow = el.style.pointerEvents = "";
      return;
    }
    if (reducedMotion()) return props.onExited();
    el.style.overflow = "hidden";
    el.style.pointerEvents = "none";
    const h = el.offsetHeight;
    // يبهت أولًا (يبدأ فورًا ويهدأ) ثم ينطوي بانسياب: العين ترى الاختفاء قبل أن يتحرك ما تحته
    const a = el.animate(
      [
        { height: `${h}px`, opacity: 1, transform: "none", offset: 0, easing: EASE_OUT },
        { height: `${h}px`, opacity: 0, transform: "scale(0.97)", offset: 0.35, easing: EASE_IO },
        { height: "0px", opacity: 0, transform: "scale(0.97)", offset: 1 },
      ],
      { duration: 420, fill: "forwards" },
    );
    a.onfinish = props.onExited;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.state]);

  return (
    <div className="li" ref={ref} aria-hidden={props.state === "out" || undefined}>
      {props.children}
    </div>
  );
}

/** يُبقي قيمة معروضة قليلًا بعد أن تصير null حتى يكتمل خروجها (رسائل، طبقات) */
export function usePresence<T>(value: T | null, exitMs: number): [T | null, boolean] {
  const [shown, setShown] = useState(value);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (value != null) {
      setShown(value);
      setLeaving(false);
      return;
    }
    if (shown == null) return;
    setLeaving(true);
    const t = setTimeout(() => {
      setShown(null);
      setLeaving(false);
    }, reducedMotion() ? 0 : exitMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return [shown, leaving];
}

/** تبديل المظهر (فاتح/داكن) بتلاشٍ لوني ناعم بدل الوميض */
export function smoothThemeSwitch(apply: () => void) {
  const root = document.documentElement;
  if (reducedMotion()) return apply();
  root.classList.add("theme-anim");
  apply();
  window.setTimeout(() => root.classList.remove("theme-anim"), 450);
}
