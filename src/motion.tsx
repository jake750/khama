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

// الحركة جزء من تصميم التطبيق، فلا نتبع إعداد «تأثيرات الحركة» في ويندوز (كثيرون يطفئونه لتسريع النظام).
// من يريد إيقافها يضع data-motion="reduce" على الجذر.
export const reducedMotion = () => document.documentElement.dataset.motion === "reduce";

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
    const to = { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight };
    const glide = animate && s.placed && !reducedMotion();

    // من أين نبدأ؟ من الموضع المرئي الآن (حتى لو قُطعت حركة سابقة في منتصفها)
    let from = to;
    if (glide) {
      const cs = getComputedStyle(el);
      const m = new DOMMatrix(cs.transform);
      from = { x: m.e, y: m.f, w: parseFloat(cs.width), h: parseFloat(cs.height) };
      el.getAnimations().forEach((a) => a.cancel());
    }

    el.style.opacity = "1";
    el.style.width = `${to.w}px`;
    el.style.height = `${to.h}px`;
    el.style.transform = `translate(${to.x}px, ${to.y}px)`;
    s.placed = true;
    if (!glide || (from.x === to.x && from.y === to.y && from.w === to.w)) return;

    // حركة «سائلة»: الحافة الأمامية تسبق والخلفية تلحق، فتتمطّط الحبّة في منتصف الطريق
    // ثم تنكمش وتستقر على الخيار الجديد. تمطيط خفيف للعرض وانضغاط بسيط للارتفاع.
    // كل حافة لها منحنى خاص: الأمامية تنطلق وتهدأ، والخلفية تبدأ ببطء ثم تلحق.
    // نحسب الإطارات مسبقًا فتبقى السرعة متصلة بلا أي قفزة.
    const right = to.x >= from.x;
    const lead = (t: number) => 1 - Math.pow(1 - t, 3);
    const trail = (t: number) => t * t * t * (t * (6 * t - 15) + 10);
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    const frames: Keyframe[] = [];
    const N = 36;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const kl = right ? trail(t) : lead(t);
      const kr = right ? lead(t) : trail(t);
      const l = lerp(from.x, to.x, kl);
      const r = lerp(from.x + from.w, to.x + to.w, kr);
      const baseH = lerp(from.h, to.h, t);
      const h = baseH * (1 - 0.08 * Math.sin(Math.PI * t)); // انضغاط خفيف في منتصف الطريق
      const y = lerp(from.y, to.y, lead(t)) + (baseH - h) / 2;
      frames.push({ transform: `translate(${l}px, ${y}px)`, width: `${r - l}px`, height: `${h}px` });
    }
    el.animate(frames, { duration: 540, easing: "linear" });
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

/**
 * تبديل محتوى باتجاه: عند الانتقال إلى خيار على اليمين ينزلق المحتوى الحالي إلى اليسار ويختفي،
 * ويدخل الجديد من اليمين (والعكس). الاتجاه بصري، فيُعكس في الواجهة العربية.
 * المغادر يبقى نفس النسخة (لا يُعاد بناؤه) ويُرفع فوق الجديد حتى تنتهي حركته، والحاوي يغيّر ارتفاعه بانسياب.
 */
export function SlideSwitch(props: { id: string; index: number; children: ReactNode; className?: string; distance?: number }) {
  const [cur, setCur] = useState({ id: props.id, index: props.index, dir: 0 });
  const [leaving, setLeaving] = useState<{ id: string; el: ReactNode; dir: number }[]>([]);
  const last = useRef<ReactNode>(props.children);
  const ready = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const lastH = useRef(0);

  if (cur.id !== props.id) {
    const rtl = document.documentElement.dir === "rtl" ? -1 : 1;
    const dir = Math.sign(props.index - cur.index) * rtl || 1;
    const prev = { id: cur.id, el: last.current, dir };
    setLeaving((l) => [...l.filter((x) => x.id !== props.id && x.id !== prev.id), prev]);
    setCur({ id: props.id, index: props.index, dir });
  }

  useLayoutEffect(() => {
    last.current = props.children;
  });

  // عند التبديل فقط (لا عند كل رسم): نعرف الارتفاع القديم من المراقب
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // الارتفاع ينتقل من القديم إلى الجديد بدل أن يقفز ما تحته
    const h = el.offsetHeight;
    if (ready.current && lastH.current && h !== lastH.current && !reducedMotion()) {
      el.animate([{ height: `${lastH.current}px` }, { height: `${h}px` }], { duration: 460, easing: EASE_OUT });
    }
    lastH.current = h;
  }, [cur.id]);

  useEffect(() => {
    ready.current = true;
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => (lastH.current = el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const D = props.distance ?? 48;
  return (
    <div className={`slide-switch ${props.className ?? ""}`} ref={box}>
      {leaving.map((l) => (
        <SlidePane key={l.id} out dir={l.dir} distance={D} animate onGone={() => setLeaving((x) => x.filter((y) => y.id !== l.id))}>
          {l.el}
        </SlidePane>
      ))}
      <SlidePane key={cur.id} out={false} dir={cur.dir} distance={D} animate={ready.current} onGone={() => {}}>
        {props.children}
      </SlidePane>
    </div>
  );
}

function SlidePane(props: { out: boolean; dir: number; distance: number; animate: boolean; children: ReactNode; onGone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onGone = useRef(props.onGone);
  onGone.current = props.onGone;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !props.animate) return;
    if (reducedMotion()) {
      if (props.out) onGone.current();
      return;
    }
    // نبدأ من الموضع المرئي الآن، فلو رجع المستخدم في منتصف الحركة لا يقفز شيء
    const cs = getComputedStyle(el);
    const fromX = new DOMMatrix(cs.transform).e;
    const fromO = parseFloat(cs.opacity);
    el.getAnimations().forEach((a) => a.cancel());
    const d = props.distance * props.dir;
    if (props.out) {
      // يغادر بسرعة نحو الجهة المعاكسة ويبهت قبل أن يصل، فلا يتزاحم مع القادم
      const a = el.animate(
        [
          { transform: `translateX(${fromX}px)`, opacity: fromO },
          { transform: `translateX(${-d}px)`, opacity: 0 },
        ],
        { duration: 280, easing: "cubic-bezier(0.3, 0.1, 0.6, 1)", fill: "forwards" },
      );
      a.onfinish = () => onGone.current();
    } else {
      const start = fromO < 1 ? fromX : d;
      el.animate(
        [
          { transform: `translateX(${start}px)`, opacity: fromO < 1 ? fromO : 0 },
          { transform: "none", opacity: 1 },
        ],
        { duration: 520, delay: fromO < 1 ? 0 : 110, easing: EASE_OUT, fill: "backwards" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.out]);

  return (
    <div className="slide-pane" ref={ref} data-out={props.out || undefined} inert={props.out || undefined} aria-hidden={props.out || undefined}>
      {props.children}
    </div>
  );
}
