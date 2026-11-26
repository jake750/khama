import { useId, useState } from "react";
import { useI18n } from "../i18n";
import { Icon, type IconName } from "./Icon";

/** أول جملة من النص، والباقي (إن وُجد) */
export function splitHint(text: string): [string, string] {
  const m = /^(.+?[.!?؟])\s+(.+)$/s.exec(text.trim());
  return m ? [m[1], m[2]] : [text.trim(), ""];
}

/**
 * شرح قصير بأيقونة: أول جملة ظاهرة، والتفاصيل خلف «المزيد» حتى لا يصبح كل خيار فقرة.
 * يُستعمل بدل <div className="faint">نص طويل</div> تحت الخيارات.
 */
export function Hint(props: { text: string; icon?: IconName; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const id = useId();
  const [first, rest] = splitHint(props.text);
  return (
    <div className={`hint ${props.className ?? ""}`}>
      <span className="hint-icon" aria-hidden="true">
        <Icon name={props.icon ?? "info"} size={16} />
      </span>
      <span className="hint-text">
        {first}
        {rest && (
          <>
            {" "}
            {open && (
              <span id={id} className="hint-rest">
                {rest}{" "}
              </span>
            )}
            <button
              type="button"
              className="hint-more"
              aria-expanded={open}
              aria-controls={id}
              onClick={(e) => {
                // داخل <label>: لا نترك النقرة تقلب المفتاح
                e.preventDefault();
                e.stopPropagation();
                setOpen((v) => !v);
              }}
            >
              {open ? t.hintLess : t.hintMore}
            </button>
          </>
        )}
      </span>
    </div>
  );
}
