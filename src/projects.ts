// المشروع = لقطة من مجلد الحفظ وخيارات التنزيل. مكان واحد يحدد أي حقول تنتقل (T-48)،
// يستخدمه حفظ المشروع (الإعدادات) وتطبيقه (شاشة التنزيل).
import type { Project, Settings } from "./api";

/** الحقول التي يحفظها المشروع ويعيدها */
export const PROJECT_FIELDS = [
  "outputDir",
  "kind",
  "videoFormat",
  "audioFormat",
  "quality",
  "editorReady",
  "filenameTemplate",
  "siteFolders",
] as const satisfies readonly (keyof Settings & keyof Project)[];

type ProjectFields = Pick<Settings, (typeof PROJECT_FIELDS)[number]>;

/** يحفظ الإعدادات الحالية كمشروع */
export function snapshotProject(s: Settings, id: string, name: string): Project {
  const fields = Object.fromEntries(PROJECT_FIELDS.map((k) => [k, s[k]])) as ProjectFields;
  return { id, name, ...fields };
}

/** التعديل على الإعدادات عند اختيار مشروع */
export function applyProject(p: Project): Partial<Settings> {
  const fields = Object.fromEntries(PROJECT_FIELDS.map((k) => [k, p[k]])) as ProjectFields;
  return { activeProject: p.id, ...fields };
}
