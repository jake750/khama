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

/* أدوات الحركة: التبويبات (SlideSwitch ومؤشّرها)، القوائم (AnimatedList)، والطبقات (Presence). الرموز مشتركة مع bubbly.css.
   كلها تحرّك transform/opacity أو ارتفاع عنصر واحد، وتحترم «تقليل الحركة». */

export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
export const EASE_IN = "cubic-bezier(0.7, 0, 0.84, 0)";
export const EASE_IO = "cubic-bezier(0.65, 0, 0.35, 1)";

/* رموز الحركة «الفقاعية»: المصدر نفسه في bubbly.css (--m-bounce وأخواتها). غيّر الاثنين معًا.
   bounce للظهور والفتح، soft للانتقال وتغيّر الحجم، anticipate للخروج (يتراجع قليلًا ثم يغادر). */
export const BOUNCE = "cubic-bezier(0.34, 1.56, 0.64, 1)";
export const SOFT = "cubic-bezier(0.22, 1.2, 0.36, 1)";
export const ANTICIPATE = "cubic-bezier(0.36, 0, 0.66, -0.56)";
export const D_BOUNCE = 420;
export const D_SOFT = 360;
export const D_ANTICIPATE = 260;

// «تقليل الحركة» في النظام يُحترم (CS3، بموافقة صاحب التطبيق): يضع data-motion="reduce" على الجذر،
// وكل الأنماط (bubbly.css) والحركات في الكود تقرأ هذه السمة وحدها.
export const reducedMotion = () => document.documentElement.dataset.motion === "reduce";

/** يربط data-motion بإعداد النظام الآن وكلما تغيّر */
export function followSystemMotion() {
  const q = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (!q) return;
  const apply = () => {
    if (q.matches) document.documentElement.dataset.motion = "reduce";
    else delete document.documentElement.dataset.motion;
  };
  apply();
  q.addEventListener?.("change", apply);
}

/**
 * مؤشّر منزلق تحت العنصر المختار (تبويبات، أزرار مجزّأة).
 * يقيس الزر المختار ويحرّك «حبّة» واحدة إليه بـtransform بدل أن يقفز اللون من زر لآخر.
 */
export function useSlidingIndicator(container: RefObject<HTMLElement | null>, selector: string, dep: unknown) {
  const pill = useRef<HTMLSpanElement>(null);
  const state = useRef<{
    box: HTMLElement | null;
    dep: unknown;
    placed: boolean;
    ro: ResizeObserver | null;
    mo: MutationObserver | null;
    frame: number;
  }>({
    box: null,
    dep: undefined,
    placed: false,
    ro: null,
    mo: null,
    frame: 0,
  });

  // المراقبون يُطلقون نداءً لكل زر تغيّر حجمه (عشرة أزرار = عشرة قياسات متتالية): نجمعها
  // في قياس واحد قبل الرسم التالي، فلا تتناوب القراءة والكتابة على التخطيط (T-86)
  const placeSoon = () => {
    const s = state.current;
    if (s.frame) return;
    s.frame = requestAnimationFrame(() => {
      s.frame = 0;
      place(false);
    });
  };

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

    el.animate(
      [
        { transform: `translate(${from.x}px, ${from.y}px)`, width: `${from.w}px`, height: `${from.h}px` },
        { transform: `translate(${to.x}px, ${to.y}px)`, width: `${to.w}px`, height: `${to.h}px` },
      ],
      { duration: D_SOFT, easing: SOFT },
    );
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
      s.ro = new ResizeObserver(placeSoon);
      s.ro.observe(box);
      // تبديل اتجاه الصفحة (عربي ↔ إنجليزي) يعكس أماكن الخيارات دون أن تتغيّر أحجامها،
      // فلا يلاحظه ResizeObserver: نراقب dir على الصفحة ونعيد القياس
      s.mo?.disconnect();
      s.mo = new MutationObserver(placeSoon);
      s.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["dir"] });
      box.querySelectorAll("button").forEach((b) => s.ro?.observe(b));
      place(false);
      return;
    }
    if (!box || Object.is(s.dep, dep)) return;
    s.dep = dep;
    box.querySelectorAll("button").forEach((b) => s.ro?.observe(b));
    place(true);
  });

  useEffect(
    () => () => {
      state.current.ro?.disconnect();
      state.current.mo?.disconnect();
      cancelAnimationFrame(state.current.frame);
      state.current.frame = 0;
      // إن رُكّب المكوّن من جديد (StrictMode يفعل ذلك) نعيد إنشاء المراقبين
      state.current.box = null;
    },
    [],
  );

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
        { height: "0px", opacity: 0, transform: "translateY(10px) scale(0.92)", easing: EASE_OUT },
        // يتجاوز حجمه قليلًا ثم يستقر
        { height: `${h}px`, opacity: 1, transform: "scale(1.015)", offset: 0.6, easing: EASE_IO },
        { height: `${h}px`, opacity: 1, transform: "none" },
      ],
      { duration: D_BOUNCE },
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
        { height: `${h}px`, opacity: 0, transform: "scale(0.92)", offset: 0.35, easing: EASE_IO },
        { height: "0px", opacity: 0, transform: "scale(0.92)", offset: 1 },
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
    const t = setTimeout(
      () => {
        setShown(null);
        setLeaving(false);
      },
      reducedMotion() ? 0 : exitMs,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return [shown, leaving];
}

/**
 * يُبقي طبقة (نافذة حوار، ترحيب، منطقة إفلات) مركّبة حتى تكتمل حركة خروجها.
 * الدخول والخروج انتقالات CSS (bubbly.css) فتنعكس من مكانها إن عاد المستخدم في منتصفها.
 */
export function Presence(props: { show: boolean; ms?: number; children: ReactNode }) {
  const [shown, leaving] = usePresence(props.show || null, props.ms ?? D_ANTICIPATE);
  if (!shown) return null;
  return (
    <div className="presence" data-leaving={leaving || undefined} inert={leaving || undefined}>
      {props.children}
    </div>
  );
}

/**
 * تبديل محتوى باتجاه: عند الانتقال إلى خيار على اليمين ينزلق المحتوى الحالي إلى اليسار ويختفي،
 * ويدخل الجديد من اليمين (والعكس). الاتجاه بصري، فيُعكس في الواجهة العربية.
 * المغادر يبقى نفس النسخة (لا يُعاد بناؤه) ويُرفع فوق الجديد حتى تنتهي حركته، والحاوي يغيّر ارتفاعه بانسياب.
 */
export function SlideSwitch(props: {
  id: string;
  index: number;
  children: ReactNode;
  className?: string;
  distance?: number;
  /** تلاشٍ سريع بلا انزلاق، فلا تتداخل الشاشتان (الكمبيوتر، D-9، D-80) */
  fade?: boolean;
}) {
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

  // كل تغيّر في ارتفاع المحتوى (تبديل، أو مجموعة صيغ فيها بطاقات أكثر) ينساب بدل أن يقفز ما تحته.
  // نراقب اللوح الحالي لا الحاوي: ارتفاع الحاوي نفسه هو ما نحرّكه
  useLayoutEffect(() => {
    const el = box.current;
    const pane = el?.querySelector<HTMLElement>(":scope > .slide-pane:not([data-out])");
    if (!el || !pane) return;
    const resize = (h: number) => {
      const from = el.getAnimations().length ? el.getBoundingClientRect().height : lastH.current;
      lastH.current = h;
      if (!ready.current || !from || Math.abs(from - h) < 1 || reducedMotion()) return;
      el.getAnimations().forEach((a) => a.cancel());
      // أثناء النمو يُقصّ ما يتجاوز الحاوي، فلا يغطّي المحتوى الجديد ما تحته
      el.style.overflow = "clip";
      el.style.overflowClipMargin = "12px";
      const a = el.animate([{ height: `${from}px` }, { height: `${h}px` }], { duration: D_SOFT, easing: EASE_OUT });
      a.onfinish = a.oncancel = () => {
        if (!el.getAnimations().length) el.style.overflow = "";
      };
    };

    resize(pane.getBoundingClientRect().height);
    const ro = new ResizeObserver(() => resize(pane.getBoundingClientRect().height));
    ro.observe(pane);
    return () => ro.disconnect();
  }, [cur.id]);

  useEffect(() => {
    ready.current = true;
  }, []);

  const D = props.distance ?? 48;
  return (
    <div className={`slide-switch ${props.className ?? ""}`} ref={box}>
      {leaving.map((l) => (
        <SlidePane
          key={l.id}
          out
          dir={l.dir}
          distance={D}
          fade={props.fade}
          animate
          onGone={() => setLeaving((x) => x.filter((y) => y.id !== l.id))}
        >
          {l.el}
        </SlidePane>
      ))}
      <SlidePane key={cur.id} out={false} dir={cur.dir} distance={D} fade={props.fade} animate={ready.current} onGone={() => {}}>
        {props.children}
      </SlidePane>
    </div>
  );
}

function SlidePane(props: {
  out: boolean;
  dir: number;
  distance: number;
  fade?: boolean;
  animate: boolean;
  children: ReactNode;
  onGone: () => void;
}) {
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
    if (props.fade) {
      // يختفي القديم في 120ms ثم يظهر الجديد في 150ms، فلا تُرى الشاشتان معًا
      const a = props.out
        ? el.animate([{ opacity: fromO }, { opacity: 0 }], { duration: 120, easing: "linear", fill: "forwards" })
        : el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, delay: 120, easing: EASE_OUT, fill: "backwards" });
      if (props.out) a.onfinish = () => onGone.current();
      return;
    }
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
        { duration: D_BOUNCE, delay: fromO < 1 ? 0 : 110, easing: SOFT, fill: "backwards" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.out]);

  return (
    <div
      className="slide-pane"
      ref={ref}
      data-out={props.out || undefined}
      inert={props.out || undefined}
      aria-hidden={props.out || undefined}
    >
      {props.children}
    </div>
  );
}
