import type { Settings } from "../../api";
import type { Toast } from "../../toast";
import { useI18n } from "../../i18n";
import { applyProject } from "../../projects";
import { Icon } from "../Icon";
import { Select } from "../Select";

/** اختيار مشروع من شاشة التنزيل: يطبّق مجلده وخياراته */
export function ProjectPicker(props: { settings: Settings; update: (p: Partial<Settings>) => void; toast: Toast }) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  if (s.projects.length === 0) return null;
  return (
    <div className="project-pick" title={t.project}>
      <Icon name="layers" size={16} />
      {/* بقائمة التطبيق لا القائمة الأصلية التي يرسمها النظام بلا ثيم (R2-14) */}
      <Select
        className="select-sm"
        label={t.project}
        value={s.activeProject ?? ""}
        onChange={(v) => {
          const p = s.projects.find((x) => x.id === v);
          if (!p) return update({ activeProject: null });
          update(applyProject(p));
          props.toast(t.toastProject(p.name));
        }}
        options={[{ value: "", label: t.noProject }, ...s.projects.map((p) => ({ value: p.id, label: p.name, text: p.name }))]}
      />
    </div>
  );
}
