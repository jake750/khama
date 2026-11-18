import { useState } from "react";
import { numLocale, useI18n } from "../../i18n";
import { scheduledAt } from "../../downloadPlan";
import { Icon } from "../Icon";
import { Segmented } from "../Segmented";

export type When = "now" | "later";

const pad = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 12 }, (_, i) => pad(i * 5));

/** متى يبدأ التنزيل: الآن أو في ساعة محددة */
export function ScheduleRow(props: {
  when: When;
  onWhen: (w: When) => void;
  atTime: string;
  onAtTime: (v: string) => void;
  /** بعد كم يوم: 0 اليوم (أو غدًا إن مضت الساعة)، حتى 6 (U-46) */
  atDay: number;
  onAtDay: (d: number) => void;
}) {
  const { t, lang } = useI18n();
  const { when, atTime } = props;
  const [hh = "00", mm = "00"] = atTime.split(":");
  const loc = numLocale(lang);
  // لحظة فتح الصف: تكفي لأسماء الأيام والتاريخ المعروض
  const [now] = useState(() => new Date());
  const dayName = (d: number) =>
    d === 0 ? t.dayToday : d === 1 ? t.dayTomorrow : new Date(now.getTime() + d * 86_400_000).toLocaleDateString(loc, { weekday: "long" });
  const at = scheduledAt(when, atTime, now, props.atDay);
  // التاريخ كاملًا وبتوقيت الجهاز صراحة (U-85)
  const atText = at
    ? new Date(at).toLocaleString(loc, {
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    : atTime;
  return (
    <div className="schedule-row">
      <span className="field-label">{t.startLabel}</span>
      <div className="schedule-controls">
        <Segmented<When>
          label={t.startLabel}
          value={when}
          onChange={props.onWhen}
          options={[
            { value: "now", label: t.startNow },
            {
              value: "later",
              label: (
                <>
                  <Icon name="clock" size={16} /> {t.startLater}
                </>
              ),
            },
          ]}
        />
        {when === "later" && (
          <select
            className="select day-select"
            value={props.atDay}
            onChange={(e) => props.onAtDay(Number(e.target.value))}
            aria-label={t.scheduleDay}
          >
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <option key={d} value={d}>
                {dayName(d)}
              </option>
            ))}
          </select>
        )}
        {when === "later" && (
          // ساعة ودقيقة بقائمتين بنظام 24 ساعة: مربع الوقت الأصلي يختلف شكله بين الأنظمة وبعضها 12 ساعة (D-89)
          <span className="time-pick ltr" role="group" aria-label={t.startLater}>
            <select
              className="select select-sm"
              value={hh}
              aria-label={t.hourLabel}
              onChange={(e) => props.onAtTime(`${e.target.value}:${mm}`)}
            >
              {HOURS.map((h) => (
                <option key={h}>{h}</option>
              ))}
            </select>
            <span aria-hidden="true">:</span>
            <select
              className="select select-sm"
              value={mm}
              aria-label={t.minuteLabel}
              onChange={(e) => props.onAtTime(`${hh}:${e.target.value}`)}
            >
              {(MINUTES.includes(mm) ? MINUTES : [...MINUTES, mm].sort()).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </span>
        )}
      </div>
      {when === "later" && <div className="faint mt-2">{t.scheduleHint(atText)}</div>}
    </div>
  );
}
