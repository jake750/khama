import { useState } from "react";
import { numLocale, useI18n } from "../../i18n";
import { scheduledAt } from "../../downloadPlan";
import { Icon } from "../Icon";
import { Segmented } from "../Segmented";

export type When = "now" | "later";

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
  const loc = numLocale(lang);
  // لحظة فتح الصف: تكفي لأسماء الأيام والتاريخ المعروض
  const [now] = useState(() => new Date());
  const dayName = (d: number) =>
    d === 0 ? t.dayToday : d === 1 ? t.dayTomorrow : new Date(now.getTime() + d * 86_400_000).toLocaleDateString(loc, { weekday: "long" });
  const at = scheduledAt(when, atTime, now, props.atDay);
  // التاريخ كاملًا وبتوقيت الجهاز صراحة (U-85)
  const atText = at
    ? new Date(at).toLocaleString(loc, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
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
          <input
            className="input time-input ltr"
            type="time"
            value={atTime}
            onChange={(e) => props.onAtTime(e.target.value)}
            aria-label={t.startLater}
          />
        )}
      </div>
      {when === "later" && <div className="faint mt-2">{t.scheduleHint(atText)}</div>}
    </div>
  );
}
