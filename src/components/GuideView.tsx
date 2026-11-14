import { useState } from "react";
import { entryText, GUIDE, type GuideEntry, type GuideGroup, type GuideTab } from "../guide";
import { useI18n } from "../i18n";
import { isMobile } from "../platform";
import { GuideArt } from "./GuideArt";
import { Icon } from "./Icon";

/** الدليل: مدخل قصير لكل خاصية، يُفتح ليعرض رسمًا توضيحيًا وخطوات وزر «أرني» */
export function GuideView(props: { onGo: (tab: GuideTab, section?: string) => void; onTour: () => void }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const entries = GUIDE.filter((e) => !e.only || e.only === (isMobile ? "mobile" : "desktop"));
  const groups: { id: GuideGroup; label: string }[] = [
    { id: "download", label: t.guideGroupDownload },
    { id: "convert", label: t.guideGroupConvert },
    { id: "organize", label: t.guideGroupOrganize },
    { id: "fix", label: t.guideGroupFix },
  ];

  return (
    <div className="guide">
      <div className="card guide-hero motif">
        <div className="guide-hero-text">
          <h2>{t.guideTitle}</h2>
          <p className="muted">{t.guideSub}</p>
          <button className="btn btn-primary" onClick={props.onTour}>
            <Icon name="eye" size={16} /> {t.tourStart}
          </button>
        </div>
        <GuideArt name="guide" className="guide-hero-art" />
      </div>

      {groups.map((g) => (
        <section key={g.id} className="guide-group" aria-labelledby={`guide-${g.id}`}>
          <h3 id={`guide-${g.id}`}>{g.label}</h3>
          <div className="card guide-list">
            {entries
              .filter((e) => e.group === g.id)
              .map((e) => (
                <Entry key={e.id} entry={e} lang={lang} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} onGo={props.onGo} />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Entry(props: { entry: GuideEntry; lang: "en" | "ar"; open: boolean; onToggle: () => void; onGo: (tab: GuideTab, section?: string) => void }) {
  const { t } = useI18n();
  const e = props.entry;
  const x = entryText(e, props.lang, isMobile);
  const panel = `guide-panel-${e.id}`;
  return (
    <div className="guide-item" data-open={props.open}>
      <button className="guide-row" aria-expanded={props.open} aria-controls={panel} onClick={props.onToggle}>
        <span className="guide-icon">
          <Icon name={e.icon} size={18} />
        </span>
        <span className="guide-row-text">
          <b>{x.title}</b>
          <span className="faint">{x.what}</span>
        </span>
        <span className="guide-chevron">
          <Icon name="chevron" size={16} />
        </span>
      </button>
      <div className="collapse" id={panel} data-open={props.open}>
        <div>
          <div className="guide-detail">
            <GuideArt name={e.art} className="guide-detail-art" />
            <div className="guide-detail-text">
              <p className="guide-when">
                <span className="field-label">{t.guideWhen}</span>
                {x.when}
              </p>
              <span className="field-label">{t.guideSteps}</span>
              <ol className="guide-steps">
                {x.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <button className="btn btn-sm" onClick={() => props.onGo(e.go.tab, e.go.section)}>
                {t.guideShowMe} <span className="guide-go-arrow" aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
