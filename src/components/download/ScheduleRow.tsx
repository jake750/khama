import { useI18n } from "../../i18n";
import { Icon } from "../Icon";
import { Segmented } from "../Segmented";

export type When = "now" | "later";

/** متى يبدأ التنزيل: الآن أو في ساعة محددة */
export function ScheduleRow(props: { when: When; onWhen: (w: When) => void; atTime: string; onAtTime: (v: string) => void }) {
  const { t } = useI18n();
  const { when, atTime } = props;
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
          <input
            className="input time-input ltr"
            type="time"
            value={atTime}
            onChange={(e) => props.onAtTime(e.target.value)}
            aria-label={t.startLater}
          />
        )}
      </div>
      {when === "later" && <div className="faint mt-2">{t.scheduleHint(atTime)}</div>}
    </div>
  );
}
