import type { Stems } from "../../downloadPlan";
import { useI18n } from "../../i18n";
import { isMobile } from "../../platform";
import { Segmented } from "../Segmented";

/** إزالة الموسيقى أو الصوت، ولقائمة التشغيل: على كل العناصر أو المختار منها */
export function StemsRow(props: {
  stems: Stems;
  onStems: (v: Stems) => void;
  /** قائمة تشغيل؟ يظهر اختيار النطاق */
  playlist: boolean;
  scope: "all" | "pick";
  onScope: (v: "all" | "pick") => void;
  /** عدد العناصر التي ستُعالَج، ومن كم عنصر محدَّد */
  count: number;
  selected: number;
}) {
  const { t } = useI18n();
  const { stems, scope } = props;
  const label = stems === "music" ? t.stemsMusic : t.stemsVoice;
  return (
    <div className="stems-row">
      <span className="field-label">{t.stemsLabel}</span>
      <Segmented<Stems>
        label={t.stemsLabel}
        value={stems}
        onChange={props.onStems}
        options={[
          { value: "off", label: t.stemsOff },
          { value: "voice", label: t.stemsVoice },
          { value: "music", label: t.stemsMusic },
        ]}
      />
      <div className="collapse" data-open={stems !== "off"}>
        <div>
          {props.playlist && (
            <div className="stems-scope">
              <span className="field-label">{t.stemsApplyTo}</span>
              <Segmented<"all" | "pick">
                label={t.stemsApplyTo}
                value={scope}
                onChange={props.onScope}
                options={[
                  { value: "all", label: t.stemsApplyAll },
                  { value: "pick", label: t.stemsApplyPick },
                ]}
              />
              <div className="faint" style={{ marginTop: 6 }}>
                {scope === "pick" ? t.stemsPickHint(props.count, props.selected, label) : t.stemsAllHint(props.count)}
              </div>
            </div>
          )}
          <div className="faint" style={{ marginTop: 6 }}>
            {isMobile ? t.stemsHintMobile : t.stemsHint}
          </div>
        </div>
      </div>
    </div>
  );
}
