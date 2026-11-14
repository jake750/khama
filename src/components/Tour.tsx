import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { EASE_OUT, reducedMotion } from "../motion";
import { GuideArt, type ArtName } from "./GuideArt";
import { Icon } from "./Icon";

export type TourStep<Tab extends string> = {
  /** محدِّد CSS للعنصر الذي نضيئه. إن لم يوجد تظهر البطاقة في الوسط */
  target: string;
  /** ننتقل لهذا التبويب قبل الخطوة */
  tab?: Tab;
  art: ArtName;
  title: string;
  body: string;
};

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 6; // هامش الإضاءة حول العنصر
const GAP = 12; // المسافة بين الإضاءة والبطاقة
const EDGE = 16; // حافة الشاشة

/** يجد العنصر الظاهر (له حجم) المطابق للمحدِّد */
function findVisible(selector: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/**
 * جولة فوق الواجهة الحقيقية: تضيء عنصرًا في كل خطوة وتشرحه ببطاقة فيها رسم توضيحي.
 * الرسم يغني عن وجود فيديو أو قائمة عند أول فتح.
 */
export function Tour<Tab extends string>(props: { steps: TourStep<Tab>[]; onTab: (tab: Tab) => void; onClose: () => void }) {
  const { t, lang } = useI18n();
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [searching, setSearching] = useState(true);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const step = props.steps[idx];
  const last = idx === props.steps.length - 1;

  const { onTab, onClose } = props;

  // تبديل التبويب ثم البحث عن العنصر (قد يحتاج لحظة حتى ينتهي انتقال الشاشة)
  useEffect(() => {
    if (step.tab) onTab(step.tab);
    setSearching(true);
    let raf = 0;
    let el: HTMLElement | null = null;
    let prev = "";
    const started = performance.now();
    const tick = () => {
      if (!el || !el.isConnected) {
        el = findVisible(step.target);
        if (el) el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
        else if (performance.now() - started > 900) {
          setSearching(false);
          setRect(null);
        }
      }
      if (el) {
        const r = el.getBoundingClientRect();
        const key = `${Math.round(r.top)}|${Math.round(r.left)}|${Math.round(r.width)}|${Math.round(r.height)}`;
        if (key !== prev) {
          prev = key;
          setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
        }
        setSearching(false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [idx, step.target, step.tab, onTab]);

  // مكان البطاقة: تحت العنصر إن اتّسع المكان، وإلا فوقه، وإلا أسفل الشاشة
  useLayoutEffect(() => {
    const c = card.current;
    if (!c) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(360, vw - EDGE * 2);
    const h = c.offsetHeight;
    if (!rect) {
      setPos({ top: Math.max(EDGE, (vh - h) / 2), left: (vw - width) / 2, width });
      return;
    }
    let top: number;
    if (vh - (rect.top + rect.height) >= h + GAP + EDGE) top = rect.top + rect.height + GAP;
    else if (rect.top >= h + GAP + EDGE) top = rect.top - GAP - h;
    else top = vh - h - EDGE;
    const center = rect.left + rect.width / 2 - width / 2;
    const left = Math.min(Math.max(EDGE, center), vw - width - EDGE);
    setPos({ top: Math.max(EDGE, top), left, width });
  }, [rect, idx, searching]);

  useEffect(() => {
    const onResize = () => setRect((r) => (r ? { ...r } : r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // المحتوى الجديد يدخل بهدوء، والتركيز على زر «التالي»
  useLayoutEffect(() => {
    next.current?.focus({ preventScroll: true });
    if (reducedMotion()) return;
    card.current?.querySelector(".tour-content")?.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 320, easing: EASE_OUT },
    );
  }, [idx]);

  const go = (d: number) => {
    const n = idx + d;
    if (n < 0) return;
    if (n >= props.steps.length) onClose();
    else setIdx(n);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // الأسهم تتبع اتجاه القراءة
      const fwd = lang === "ar" ? "ArrowLeft" : "ArrowRight";
      const back = lang === "ar" ? "ArrowRight" : "ArrowLeft";
      if (e.key === fwd) go(1);
      if (e.key === back) go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="tour" role="presentation">
      {/* طبقة تمنع الضغط على الواجهة أثناء الجولة */}
      <div className="tour-block" onClick={(e) => e.stopPropagation()} />
      {rect && !searching ? (
        <div className="tour-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} />
      ) : (
        <div className="tour-scrim" />
      )}
      <div
        ref={card}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: "hidden" }}
      >
        <div className="tour-content" key={idx}>
          <GuideArt name={step.art} className="tour-art" />
          <div className="tour-count faint">{t.tourCount(idx + 1, props.steps.length)}</div>
          <h2 id="tour-title">{step.title}</h2>
          <p id="tour-body" className="muted">
            {step.body}
          </p>
        </div>
        <div className="tour-dots" aria-hidden="true">
          {props.steps.map((_, i) => (
            <span key={i} data-on={i === idx} />
          ))}
        </div>
        <div className="tour-actions">
          {!last && (
            <button className="btn btn-sm btn-ghost" onClick={onClose}>
              {t.tourSkip}
            </button>
          )}
          <span className="spacer" />
          {idx > 0 && (
            <button className="btn btn-sm" onClick={() => go(-1)}>
              {t.tourBack}
            </button>
          )}
          <button className="btn btn-sm btn-primary" ref={next} onClick={() => go(1)}>
            {last ? t.tourDone : t.tourNext}
          </button>
        </div>
      </div>
    </div>
  );
}

/** ترحيب عند أول فتح: يعرض الجولة، أو يذكّر بمكان الدليل */
export function Welcome(props: { onTour: () => void; onLater: () => void }) {
  const { t } = useI18n();
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onLater();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="update-backdrop welcome-backdrop" onClick={(e) => e.target === e.currentTarget && props.onLater()}>
      <div className="update-card welcome-card motif" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-body">
        <GuideArt name="tabs" className="welcome-art" />
        <div>
          <h2 id="welcome-title">{t.welcomeTitle}</h2>
          <p id="welcome-body" className="muted">
            {t.welcomeBody}
          </p>
        </div>
        <div className="update-actions">
          <button className="btn btn-ghost" onClick={props.onLater}>
            {t.welcomeLater}
          </button>
          <button className="btn btn-primary" ref={primary} onClick={props.onTour}>
            <Icon name="eye" size={16} /> {t.tourStart}
          </button>
        </div>
      </div>
    </div>
  );
}
