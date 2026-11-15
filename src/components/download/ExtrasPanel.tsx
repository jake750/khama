import type { ProbeInfo, Settings } from "../../api";
import type { Stills } from "../../downloadPlan";
import { useI18n } from "../../i18n";
import { Icon } from "../Icon";
import { Segmented, Toggle } from "../Segmented";

/** إضافات بجانب الملف: ترجمة SRT، صورة مصغّرة، ملف معلومات، لقطات ثابتة */
export function ExtrasPanel(props: {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
  /** معاينة فيديو واحد (لا قائمة تشغيل): تظهر لغات الترجمة المتاحة فيه */
  video: ProbeInfo | null;
  /** الملف الأصلي بلا تحويل: لا لقطات */
  original: boolean;
  stills: Stills;
  onStills: (v: Stills) => void;
}) {
  const { t } = useI18n();
  const { settings: s, update, video, stills } = props;
  const available = video?.subtitles ?? [];
  const chosen = available.filter((l) => s.subLangs.includes(l.code)).map((l) => l.code);
  const toggleLang = (code: string) =>
    update({ subLangs: s.subLangs.includes(code) ? s.subLangs.filter((c) => c !== code) : [...s.subLangs, code] });

  return (
    <details className="extras" open={s.wantSubs || s.wantThumb || s.wantInfo || stills !== "off" || undefined}>
      <summary>
        <Icon name="layers" size={16} /> {t.extrasLabel}
        <span className="extras-count">
          {[s.wantSubs && "SRT", s.wantThumb && "JPG", s.wantInfo && "TXT", stills !== "off" && t.stillsLabel].filter(Boolean).join(" · ")}
        </span>
        <Icon name="chevron" size={16} />
      </summary>
      <div className="extras-grid">
        <div>
          <Toggle checked={s.wantSubs} onChange={(wantSubs) => update({ wantSubs })} title={t.subsToggle} hint={t.subsHint} />
          {s.wantSubs && video && (
            <div className="chips">
              {available.length === 0 && <span className="faint">{t.subsNone}</span>}
              {available.map((l) => {
                const on = chosen.length ? chosen.includes(l.code) : l === available[0];
                return (
                  <button key={l.code} className="chip-btn" aria-pressed={on} onClick={() => toggleLang(l.code)}>
                    {l.name}
                    {l.auto && <small>{t.subsAuto}</small>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <Toggle checked={s.wantThumb} onChange={(wantThumb) => update({ wantThumb })} title={t.thumbToggle} hint={t.thumbHint} />
        <Toggle checked={s.wantInfo} onChange={(wantInfo) => update({ wantInfo })} title={t.infoToggle} hint={t.infoHint} />
        {s.kind === "video" && !props.original && (
          <div>
            <span className="field-label">{t.stillsLabel}</span>
            <Segmented<Stills>
              label={t.stillsLabel}
              value={stills}
              onChange={props.onStills}
              options={[
                { value: "off", label: t.stillsOff },
                { value: "5", label: t.stillsEvery(5) },
                { value: "10", label: t.stillsEvery(10) },
                { value: "scene", label: t.stillsScenes },
              ]}
            />
            {stills !== "off" && (
              <div className="faint" style={{ marginTop: 6 }}>
                {t.stillsHint}
              </div>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
