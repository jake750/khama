import type { Settings } from "../../api";
import type { Toast } from "../../toast";
import { useI18n } from "../../i18n";
import { applyProject } from "../../projects";
import { Icon } from "../Icon";

/** اختيار مشروع من شاشة التنزيل: يطبّق مجلده وخياراته */
export function ProjectPicker(props: { settings: Settings; update: (p: Partial<Settings>) => void; toast: Toast }) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  if (s.projects.length === 0) return null;
  return (
    <label className="project-pick" title={t.project}>
      <Icon name="layers" size={16} />
      <select
        className="select select-sm"
        value={s.activeProject ?? ""}
        aria-label={t.project}
        onChange={(e) => {
          const p = s.projects.find((x) => x.id === e.target.value);
          if (!p) return update({ activeProject: null });
          update(applyProject(p));
          props.toast(t.toastProject(p.name));
        }}
      >
        <option value="">{t.noProject}</option>
        {s.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
