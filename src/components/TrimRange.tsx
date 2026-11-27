import { useEffect, useId, useState } from "react";
import { formatDuration, formatTimecode, parseTime, timeTicks } from "../format";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

export interface Range {
  start: number;
  end: number;
}

/** ربط الشريط بمشغّل المعاينة: تحريك مقبض يقفز بالفيديو إليه، وأزرار «من هنا» تقرأ وقته */
export interface PreviewLink {
  now: () => number | null;
  seek: (t: number) => void;
}

/** حقل وقت: يقبل الكتابة الحرة ويطبّق القيمة عند الخروج أو Enter */
function TimeField(props: { label: string; value: number; fps?: number | null; onCommit: (v: number) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(formatTimecode(props.value, props.fps));
  // نص لا يُفهم وقتًا: يبقى في الحقل معلَّمًا بسطر يقول الصيغة، بدل أن يعود بصمت (R2-21)
  const [bad, setBad] = useState(false);
  const hintId = useId();
  useEffect(() => setText(formatTimecode(props.value, props.fps)), [props.value, props.fps]);
  const commit = () => {
    // خروج من الحقل بلا تعديل: لا شيء. كان يعيد تطبيق القيمة المقرّبة فينقل المعاينة إلى نهاية المقطع
    if (text === formatTimecode(props.value, props.fps)) return setBad(false);
    const v = parseTime(text, props.fps);
    if (v == null) return setBad(true);
    setBad(false);
    props.onCommit(v);
    // نعيد عرض القيمة الفعلية: إن عُدّلت (حدود المدة)، لا يبقى في الحقل رقم لا يطابق الشريط
    setText(formatTimecode(props.value, props.fps));
  };
  return (
    <label className="time-field">
      <span className="field-label">{props.label}</span>
      {/* لا inputMode="numeric": لوحة أندرويد الرقمية بلا «:» فلا يُكتب 1:15 (R2-7) */}
      <input
        className="input ltr"
        value={text}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={bad || undefined}
        aria-describedby={bad ? hintId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (bad) setBad(false);
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {bad && (
        <span id={hintId} className="field-error" role="alert">
          {props.fps ? t.timeFormatFps : t.timeFormat}
        </span>
      )}
    </label>
  );
}

/**
 * شريط اختيار جزء من المدة بمقبضين.
 * الشريط دائمًا من اليسار لليمين (خط الزمن)، حتى في الواجهة العربية.
 */
export function TrimRange(props: {
  duration: number;
  value: Range;
  onChange: (r: Range) => void;
  preview?: PreviewLink | null;
  /** معدل الإطارات إن عُرف: الحقول بكود زمني HH:MM:SS:FF والخطوة إطار واحد (U-16) */
  fps?: number | null;
}) {
  const { t } = useI18n();
  const { duration: d, value: r } = props;
  const step = props.fps ? 1 / props.fps : d > 600 ? 1 : 0.1;
  const minGap = Math.min(1, d / 10);
  const set = (start: number, end: number) => {
    start = Math.max(0, Math.min(start, d));
    end = Math.max(0, Math.min(end, d));
    if (end - start < minGap) return;
    // نعرض في المعاينة الطرف الذي تحرّك
    if (props.preview) props.preview.seek(start !== r.start ? start : end);
    props.onChange({ start, end });
  };
  const here = (which: "start" | "end") => {
    const now = props.preview?.now();
    if (now == null) return;
    if (which === "start") typeStart(now);
    else typeEnd(now);
  };
  const pct = (v: number) => `${(v / d) * 100}%`;
  // من الحقول: بداية بعد النهاية تحرّك النهاية معها (بنفس المدة)، ونهاية قبل البداية تحرّك البداية
  const len = r.end - r.start;
  const typeStart = (v: number) => {
    v = Math.max(0, Math.min(v, d - minGap));
    set(v, v + minGap > r.end ? Math.min(v + len, d) : r.end);
  };
  const typeEnd = (v: number) => {
    v = Math.max(minGap, Math.min(v, d));
    set(v - minGap < r.start ? Math.max(v - len, 0) : r.start, v);
  };

  return (
    <div className="trim">
      <div className="trim-track" dir="ltr">
        <div className="trim-fill" style={{ left: pct(r.start), width: `calc(${pct(r.end)} - ${pct(r.start)})` }} />
        <input
          type="range"
          min={0}
          max={d}
          step={step}
          value={r.start}
          aria-label={t.trimStart}
          // قارئ الشاشة يقرأ «1:15.5» لا «75.5» (R2-20)
          aria-valuetext={formatTimecode(r.start, props.fps)}
          onChange={(e) => set(Number(e.target.value), r.end)}
        />
        <input
          type="range"
          min={0}
          max={d}
          step={step}
          value={r.end}
          aria-label={t.trimEnd}
          aria-valuetext={formatTimecode(r.end, props.fps)}
          onChange={(e) => set(r.start, Number(e.target.value))}
        />
      </div>
      {/* تدريج زمني تحت الشريط (D-102) */}
      <div className="trim-ticks" dir="ltr" aria-hidden="true">
        {timeTicks(d).map((v) => (
          <span key={v} className={v > 0 && v / d > 0.9 ? "end" : undefined} style={{ left: pct(v) }}>
            {formatDuration(v)}
          </span>
        ))}
      </div>
      <div className="trim-fields">
        <TimeField label={t.trimStart} value={r.start} fps={props.fps} onCommit={typeStart} />
        <div className="trim-length">
          <span className="field-label">{t.trimLength}</span>
          {/* بالإطارات حين تُكتب الحدود بالإطارات (R2-57) */}
          <span className="ltr">{props.fps ? formatTimecode(r.end - r.start, props.fps) : formatDuration(r.end - r.start)}</span>
        </div>
        <TimeField label={t.trimEnd} value={r.end} fps={props.fps} onCommit={typeEnd} />
      </div>
      {props.preview && (
        <div className="trim-here">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => here("start")}>
            <Icon name="flagStart" size={16} /> {t.setStartHere}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => here("end")}>
            {t.setEndHere} <Icon name="flagEnd" size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
