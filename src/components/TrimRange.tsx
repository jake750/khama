import { useEffect, useState } from "react";
import { formatDuration, formatTimecode, parseTime } from "../format";
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
function TimeField(props: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(formatTimecode(props.value));
  useEffect(() => setText(formatTimecode(props.value)), [props.value]);
  const commit = () => {
    const v = parseTime(text);
    if (v != null) props.onCommit(v);
    // نعيد عرض القيمة الفعلية: إن رُفضت القيمة أو عُدّلت، لا يبقى في الحقل رقم لا يطابق الشريط
    setText(formatTimecode(props.value));
  };
  return (
    <label className="time-field">
      <span className="field-label">{props.label}</span>
      <input
        className="input ltr"
        value={text}
        inputMode="numeric"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
}

/**
 * شريط اختيار جزء من المدة بمقبضين.
 * الشريط دائمًا من اليسار لليمين (خط الزمن)، حتى في الواجهة العربية.
 */
export function TrimRange(props: { duration: number; value: Range; onChange: (r: Range) => void; preview?: PreviewLink | null }) {
  const { t } = useI18n();
  const { duration: d, value: r } = props;
  const step = d > 600 ? 1 : 0.1;
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
          onChange={(e) => set(Number(e.target.value), r.end)}
        />
        <input
          type="range"
          min={0}
          max={d}
          step={step}
          value={r.end}
          aria-label={t.trimEnd}
          onChange={(e) => set(r.start, Number(e.target.value))}
        />
      </div>
      <div className="trim-fields">
        <TimeField label={t.trimStart} value={r.start} onCommit={typeStart} />
        <div className="trim-length">
          <span className="field-label">{t.trimLength}</span>
          <span className="ltr">{formatDuration(r.end - r.start)}</span>
        </div>
        <TimeField label={t.trimEnd} value={r.end} onCommit={typeEnd} />
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
