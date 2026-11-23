import type { Stems } from "../../downloadPlan";
import { useI18n } from "../../i18n";
import { isMobile } from "../../platform";
import { api } from "../../api";
import { useConfirm } from "../Dialog";
import { Segmented } from "../Segmented";

/** نسبة البطارية إن كانت أقل من 30% والجهاز لا يشحن، وإلا null (أو إن لم يدعمها المتصفح) */
async function lowBattery(): Promise<number | null> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
    const b = await nav.getBattery?.();
    return b && !b.charging && b.level < 0.3 ? Math.round(b.level * 100) : null;
  } catch {
    return null;
  }
}

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
  const [confirmNode, confirm] = useConfirm();
  // أول استعمال يُنزّل ~140MB: نسأل قبلها، فلا تكون مفاجأة على بيانات الهاتف (U-29)
  const choose = async (v: Stems) => {
    if (v !== "off" && stems === "off") {
      const ready = await api.aiReady().catch(() => true);
      if (!ready && !(await confirm(t.aiDownloadTitle, isMobile ? t.aiDownloadBodyMobile : t.aiDownloadBody, t.aiDownloadOk))) return;
      // الهاتف: الفصل ثقيل ويسخّن الجهاز؛ ببطارية منخفضة بلا شحن ننبّه قبل البدء (U-30)
      const pct = isMobile ? await lowBattery() : null;
      if (pct != null && !(await confirm(t.lowBatteryTitle, t.lowBatteryBody(pct), t.lowBatteryOk))) return;
    }
    props.onStems(v);
  };
  const label = stems === "music" ? t.stemsMusic : t.stemsVoice;
  return (
    <div className="stems-row">
      {confirmNode}
      <span className="field-label">{t.stemsLabel}</span>
      <Segmented<Stems>
        label={t.stemsLabel}
        value={stems}
        onChange={(v) => void choose(v)}
        options={[
          { value: "off", label: t.stemsOff },
          { value: "voice", label: t.stemsVoice },
          { value: "music", label: t.stemsMusic },
        ]}
      />
      <div className="collapse" data-open={stems !== "off"} inert={!(stems !== "off") || undefined}>
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
              <div className="faint mt-2">
                {scope === "pick" ? t.stemsPickHint(props.count, props.selected, label) : t.stemsAllHint(props.count)}
              </div>
            </div>
          )}
          <div className="faint mt-2">{isMobile ? t.stemsHintMobile : t.stemsHint}</div>
        </div>
      </div>
    </div>
  );
}
