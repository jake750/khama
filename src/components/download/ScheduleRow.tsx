import { numLocale, useI18n } from "../../i18n";
import { scheduledAt } from "../../downloadPlan";
import { Icon } from "../Icon";
import { Segmented } from "../Segmented";
import { Select } from "../Select";

export type When = "now" | "later";

const pad = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
// كل دقيقة لا كل خمس: 14:07 ممكنة (R2-80). القائمة تقفز بالكتابة («0» ثم «7»)
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));

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
  // الوقت الآن في كل رسم، كما يحسبه start(): الصف يبقى مفتوحًا ساعات، ولحظة فتحه كانت تعرض
  // «اليوم 14:00» لموعد سيُضبط فعلًا على الغد
  const now = new Date();
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
          <Select
            className="day-select"
            label={t.scheduleDay}
            value={String(props.atDay)}
            onChange={(v) => props.onAtDay(Number(v))}
            options={[0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: dayName(d) }))}
          />
        )}
        {when === "later" && (
          // ساعة ودقيقة بقائمتين بنظام 24 ساعة: مربع الوقت الأصلي يختلف شكله بين الأنظمة وبعضها 12 ساعة (D-89)
          <span className="time-pick ltr" role="group" aria-label={t.startLater}>
            <Select
              className="select-sm"
              label={t.hourLabel}
              value={hh}
              onChange={(v) => props.onAtTime(`${v}:${mm}`)}
              options={HOURS.map((h) => ({ value: h, label: h, text: h }))}
            />
            <span aria-hidden="true">:</span>
            <Select
              className="select-sm"
              label={t.minuteLabel}
              value={mm}
              onChange={(v) => props.onAtTime(`${hh}:${v}`)}
              options={MINUTES.map((m) => ({ value: m, label: m, text: m }))}
            />
          </span>
        )}
      </div>
      {when === "later" && <div className="faint mt-2">{t.scheduleHint(atText)}</div>}
    </div>
  );
}
