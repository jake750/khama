import { notesSince } from "../changelog";
import { useI18n } from "../i18n";
import { openReleasePage } from "../whatsNew";
import { Dialog } from "./Dialog";

/** R3-U36: ما الجديد منذ آخر نسخة فُتحت، بلغة الواجهة. قفزة عدة إصدارات تُعرض كلها، الأحدث أولًا */
export function WhatsNewDialog(props: { from: string; to: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const notes = notesSince(props.from, props.to);
  return (
    <Dialog
      title={t.whatsNewTitle(props.to)}
      onClose={props.onClose}
      actions={
        <>
          <button className="btn btn-ghost" onClick={() => openReleasePage()}>
            {t.allReleases}
          </button>
          <button className="btn btn-primary" onClick={props.onClose}>
            {t.gotIt}
          </button>
        </>
      }
    >
      <div className="whats-new">
        {notes.map((n) => (
          <section key={n.version}>
            {notes.length > 1 && <h3 className="ltr-num">{n.version}</h3>}
            <ul>
              {n[lang].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
