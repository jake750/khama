import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PRESETS } from "../presets";
import { api, asAppError, type AppError, type CookiesMode, type Language, type Project, type Settings, type Theme, type ToolsInfo, type WatchFolder } from "../api";
import { useI18n } from "../i18n";
import { ErrorBox } from "./ErrorBox";
import { Icon, type IconName } from "./Icon";
import { Segmented, Toggle } from "./Segmented";
import { isMobile, MOBILE_SAVE_DIR } from "../platform";

// المتصفحات التي يستطيع yt-dlp قراءة الكوكيز منها، حسب النظام
const isMac = navigator.userAgent.includes("Mac");
const BROWSERS = ["firefox", "chrome", "edge", "brave", "opera", "vivaldi", "chromium", ...(isMac ? ["safari"] : [])];
const browserName = (b: string) => (b === "edge" ? "Edge" : b[0].toUpperCase() + b.slice(1));

export function SettingsView(props: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  outputDir: string;
  onChooseDir: () => void;
  onOpenDir: () => void;
  toast: (msg: string) => void;
  /** القسم المطلوب عند الفتح (مثلًا "cookies" من رسالة خطأ) */
  section?: { id: string; n: number } | null;
  onOpenGuide: () => void;
  onTour: () => void;
}) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  const [current, setCurrent] = useState("general");
  const root = useRef<HTMLDivElement>(null);

  const sections: { id: string; label: string; icon: IconName; show: boolean }[] = [
    { id: "general", label: t.secGeneral, icon: "settings", show: true },
    { id: "downloads", label: t.secDownloads, icon: "download", show: true },
    { id: "background", label: t.secBackground, icon: "bell", show: true },
    { id: "projects", label: t.secProjects, icon: "layers", show: true },
    { id: "cookies", label: t.secCookies, icon: "file", show: true },
    { id: "watch", label: t.secWatch, icon: "eye", show: !isMobile },
    { id: "tools", label: t.secTools, icon: "chip", show: true },
    { id: "about", label: t.secAbout, icon: "info", show: true },
  ];

  const go = (id: string, smooth = true) => {
    setCurrent(id);
    root.current?.querySelector(`#set-${id}`)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  };

  useEffect(() => {
    if (props.section) go(props.section.id, false);
  }, [props.section]);

  // القسم الظاهر الآن يُعلَّم في القائمة الجانبية
  useEffect(() => {
    const els = [...(root.current?.querySelectorAll<HTMLElement>("[data-section]") ?? [])];
    const io = new IntersectionObserver(
      (items) => {
        const top = items.filter((i) => i.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setCurrent((top.target as HTMLElement).dataset.section!);
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  return (
    <div className="settings-layout" ref={root}>
      <nav className="settings-nav" aria-label={t.tabSettings}>
        {sections
          .filter((x) => x.show)
          .map((x) => (
            <button key={x.id} aria-current={current === x.id ? "true" : undefined} onClick={() => go(x.id)}>
              <Icon name={x.icon} size={16} /> <span>{x.label}</span>
            </button>
          ))}
      </nav>

      <div className="settings-content">
        <Section id="general" title={t.general}>
          <div className="setting-row">
            <span>{t.language}</span>
            <Segmented<Language>
              label={t.language}
              value={s.language}
              onChange={(language) => update({ language })}
              options={[
                { value: "en", label: "English" },
                { value: "ar", label: "العربية" },
              ]}
            />
          </div>
          <div className="setting-row">
            <span>{t.theme}</span>
            <Segmented<Theme>
              label={t.theme}
              value={s.theme}
              onChange={(theme) => update({ theme })}
              options={[
                { value: "dark", label: t.dark },
                { value: "light", label: t.light },
                { value: "system", label: t.system },
              ]}
            />
          </div>
          <div className="setting-row">
            <div style={{ minWidth: 0 }}>
              <div>{t.saveFolder}</div>
              <div className="faint ltr" style={{ wordBreak: "break-all" }}>{isMobile ? MOBILE_SAVE_DIR : props.outputDir}</div>
            </div>
            {!isMobile && (
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={props.onOpenDir}>
                  <Icon name="folder" size={16} /> {t.open}
                </button>
                <button className="btn" onClick={props.onChooseDir}>{t.choose}</button>
              </div>
            )}
          </div>
        </Section>

        <DownloadsSection settings={s} update={update} />
        <BackgroundSection settings={s} update={update} />
        {<ProjectsSection settings={s} update={update} outputDir={props.outputDir} toast={props.toast} />}
        <CookiesSection settings={s} update={update} toast={props.toast} />
        {!isMobile && <WatchSection settings={s} update={update} />}
        <ToolsSection toast={props.toast} />

        <Section id="about" title={t.aboutTitle}>
          <div className="setting-row">
            <div style={{ minWidth: 0 }}>
              <div>{t.guideTitle}</div>
              <div className="faint">{t.guideSub}</div>
            </div>
            <div className="guide-settings-actions">
              <button className="btn" onClick={props.onTour}>
                <Icon name="eye" size={16} /> {t.tourStart}
              </button>
              <button className="btn" onClick={props.onOpenGuide}>
                <Icon name="help" size={16} /> {t.guideOpen}
              </button>
            </div>
          </div>
          <p className="muted" style={{ margin: "4px 0 8px" }}>{t.aboutBody}</p>
          <p className="faint" style={{ margin: 0 }}>{t.notice}</p>
        </Section>
      </div>
    </div>
  );
}

function Section(props: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="card settings-section" id={`set-${props.id}`} data-section={props.id}>
      <div>
        <h2>{props.title}</h2>
        {props.intro && <p className="faint" style={{ margin: 0 }}>{props.intro}</p>}
      </div>
      <div>{props.children}</div>
    </section>
  );
}

/** مثال حيّ لقالب اسم الملف (نفس قواعد Rust: output_template) */
function templateExample(tpl: string, siteFolders: boolean): string {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  let x = (tpl.trim() || "{title}").replace(/[/\\:*?"<>|]/g, "_");
  if (!x.includes("{")) x = `${x} {title}`;
  x = x
    .split("{title}").join("Big Buck Bunny")
    .split("{uploader}").join("Blender")
    .split("{date}").join("2014-11-10")
    .split("{today}").join(today)
    .split("{site}").join("Youtube")
    .split("{id}").join("aqz-KE-bpKQ")
    .split("{res}").join("1080p")
    .split("{n}").join("001");
  return `${siteFolders ? "Youtube/" : ""}${x}.mp4`;
}

const TOKENS = ["{title}", "{uploader}", "{date}", "{today}", "{site}", "{id}", "{res}", "{n}"];
const RATES = [0, 1, 5, 10, 25];

function DownloadsSection(props: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  const [tpl, setTpl] = useState(s.filenameTemplate);
  useEffect(() => setTpl(s.filenameTemplate), [s.filenameTemplate]);
  const commit = (v: string) => update({ filenameTemplate: v.trim() || "{title}" });
  return (
    <Section id="downloads" title={t.secDownloads}>
      <div className="setting-row column">
        <div>
          <div>{t.filenameTitle}</div>
          <div className="faint">{t.filenameHint}</div>
        </div>
        <input
          className="input wide ltr"
          value={tpl}
          spellCheck={false}
          onChange={(e) => setTpl(e.target.value)}
          onBlur={() => commit(tpl)}
          onKeyDown={(e) => e.key === "Enter" && commit(tpl)}
          aria-label={t.filenameTitle}
        />
        <div className="chips">
          {TOKENS.map((k) => (
            <button
              key={k}
              className="chip-btn ltr"
              onClick={() => {
                const sep = tpl && !/[\s_-]$/.test(tpl) ? "_" : "";
                const v = `${tpl}${sep}${k}`;
                setTpl(v);
                commit(v);
              }}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="faint">
          {t.filenameExample}: <span className="ltr code">{templateExample(tpl, s.siteFolders)}</span>
        </div>
      </div>
      <div className="setting-row">
        <Toggle checked={s.siteFolders} onChange={(siteFolders) => update({ siteFolders })} title={t.siteFolders} hint={t.siteFoldersHint} />
      </div>
      <div className="setting-row">
        <div>
          <div>{t.rateLimit}</div>
          <div className="faint">{t.rateLimitHint}</div>
        </div>
        <Segmented<string>
          label={t.rateLimit}
          value={String(s.rateLimit)}
          onChange={(v) => update({ rateLimit: Number(v) })}
          options={RATES.map((r) => ({ value: String(r), label: r ? t.mbps(r) : t.rateOff }))}
        />
      </div>
    </Section>
  );
}

function BackgroundSection(props: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  return (
    <Section id="background" title={t.secBackground}>
      <div className="setting-row">
        <Toggle checked={s.notify} onChange={(notify) => update({ notify })} title={t.notifyTitle} hint={t.notifyHint} />
      </div>
      {!isMobile && (
        <>
          <div className="setting-row">
            <Toggle checked={s.closeToTray} onChange={(closeToTray) => update({ closeToTray })} title={t.closeToTray} hint={t.closeToTrayHint} />
          </div>
          <div className="setting-row">
            <Toggle checked={s.watchClipboard} onChange={(watchClipboard) => update({ watchClipboard })} title={t.watchClipboard} hint={t.watchClipboardHint} />
          </div>
          <div className="setting-row end">
            <button className="btn btn-danger" onClick={() => api.quitApp()}>
              <Icon name="x" size={16} /> {t.quit}
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

/** المشاريع: لقطة من مجلد الحفظ وخيارات التنزيل، يُبدَّل بينها من شاشة التنزيل */
function ProjectsSection(props: { settings: Settings; update: (p: Partial<Settings>) => void; outputDir: string; toast: (m: string) => void }) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  const [name, setName] = useState("");
  const snapshot = (n: string): Project => ({
    name: n,
    outputDir: s.outputDir,
    kind: s.kind,
    videoFormat: s.videoFormat,
    audioFormat: s.audioFormat,
    quality: s.quality,
    editorReady: s.editorReady,
    filenameTemplate: s.filenameTemplate,
    siteFolders: s.siteFolders,
  });
  const save = () => {
    const n = name.trim();
    if (!n) return;
    update({ projects: [...s.projects.filter((p) => p.name !== n), snapshot(n)], activeProject: n });
    setName("");
    props.toast(t.toastProject(n));
  };
  return (
    <Section id="projects" title={t.secProjects} intro={t.projectsIntro}>
      {s.projects.length === 0 && <p className="faint">{t.projectsEmpty}</p>}
      {s.projects.map((p) => (
        <div className="watch-row project-row" key={p.name}>
          <b className={s.activeProject === p.name ? "accent" : undefined}>{p.name}</b>
          {!isMobile && <span className="path ltr faint" title={p.outputDir ?? props.outputDir}>{p.outputDir ?? props.outputDir}</span>}
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              update({ projects: s.projects.map((x) => (x.name === p.name ? snapshot(p.name) : x)) });
              props.toast(t.toastProject(p.name));
            }}
          >
            {t.updateProject}
          </button>
          <button
            className="icon-btn sm"
            aria-label={t.remove}
            title={t.remove}
            onClick={() =>
              update({ projects: s.projects.filter((x) => x.name !== p.name), activeProject: s.activeProject === p.name ? null : s.activeProject })
            }
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
      <div className="project-new">
        <input className="input wide" value={name} placeholder={t.projectName} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
        <button className="btn" disabled={!name.trim()} onClick={save}>
          <Icon name="plus" size={16} /> {t.saveProject}
        </button>
      </div>
    </Section>
  );
}

function CookiesSection(props: { settings: Settings; update: (p: Partial<Settings>) => void; toast: (m: string) => void }) {
  const { t } = useI18n();
  const { settings: s, update } = props;
  const [text, setText] = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.hasSavedCookies().then(setHasSaved).catch(() => {});
  }, []);

  async function save() {
    setError(null);
    try {
      await api.saveCookies(text);
      setText("");
      setHasSaved(true);
      props.toast(t.toastCookiesSaved);
    } catch (e) {
      setError(asAppError(e));
    }
  }

  async function remove() {
    await api.deleteCookies().catch(() => {});
    setHasSaved(false);
    props.toast(t.toastCookiesDeleted);
  }

  const modes: { value: CookiesMode; title: string; hint: string }[] = [
    { value: "none", title: t.cookiesNone, hint: t.cookiesNoneHint },
    // لا يمكن قراءة كوكيز متصفحات الهاتف من تطبيق آخر
    ...(isMobile ? [] : [{ value: "browser" as CookiesMode, title: t.cookiesBrowser, hint: t.cookiesBrowserHint }]),
    { value: "file", title: t.cookiesFile, hint: t.cookiesFileHint },
  ];

  return (
    <Section id="cookies" title={t.cookiesTitle} intro={t.cookiesIntro}>
      <div className="stack">
        <div className="radio-list" role="radiogroup" aria-label={t.cookiesTitle}>
          {modes.map((m) => (
            <label key={m.value} className="radio">
              <input type="radio" name="cookies" checked={s.cookiesMode === m.value} onChange={() => update({ cookiesMode: m.value })} />
              <span>
                <span>{m.title}</span>
                <span className="faint" style={{ display: "block" }}>{m.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {s.cookiesMode === "browser" && (
          <div>
            <span className="field-label">{t.browser}</span>
            <select className="select" value={s.cookiesBrowser} onChange={(e) => update({ cookiesBrowser: e.target.value })}>
              {BROWSERS.map((b) => (
                <option key={b} value={b}>
                  {browserName(b)}
                  {b === "firefox" ? ` — ${t.recommended}` : ""}
                </option>
              ))}
            </select>
            {s.cookiesBrowser !== "firefox" && s.cookiesBrowser !== "safari" && (
              <div className="faint" style={{ marginTop: 6 }}>{t.chromeNote}</div>
            )}
          </div>
        )}

        {s.cookiesMode === "file" && (
          <div style={{ display: "grid", gap: 10 }}>
            <div className="faint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name={hasSaved ? "check" : "x"} size={16} />
              {hasSaved ? t.cookiesSaved : t.cookiesNotSaved}
            </div>
            <textarea className="textarea" placeholder={t.cookiesPlaceholder} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
            <input
              ref={fileInput}
              type="file"
              accept=".txt,text/plain"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
                e.target.value = "";
              }}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-primary" disabled={!text.trim()} onClick={save}>{t.saveCookies}</button>
              <button className="btn" onClick={() => fileInput.current?.click()}>{t.importFile}</button>
              <span className="spacer" />
              <button className="btn btn-danger" disabled={!hasSaved} onClick={remove}>
                <Icon name="trash" size={16} /> {t.deleteSaved}
              </button>
            </div>
            {error && <ErrorBox error={error} />}
          </div>
        )}

        <details className="tech" style={{ fontSize: 13 }}>
          <summary>{t.cookiesHowTitle}</summary>
          <p style={{ margin: "8px 0 0" }}>{t.cookiesHowBody}</p>
        </details>
      </div>
    </Section>
  );
}

function ToolsSection(props: { toast: (m: string) => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<ToolsInfo | null>(null);
  const [infoError, setInfoError] = useState<AppError | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<AppError | null>(null);

  const load = () =>
    api
      .toolsInfo()
      .then(setInfo)
      .catch((e) => setInfoError(asAppError(e)));

  useEffect(() => {
    load();
  }, []);

  async function updateYtdlp() {
    setUpdating(true);
    setUpdateError(null);
    try {
      const r = await api.updateYtdlp();
      props.toast(r.updated ? t.updatedTo(r.version ?? "") : t.upToDate(r.version ?? ""));
      await load();
    } catch (e) {
      setUpdateError(asAppError(e));
    } finally {
      setUpdating(false);
    }
  }

  const tools: [string, string | null | undefined][] = [
    ["yt-dlp", info?.ytdlp],
    ["FFmpeg", info?.ffmpeg],
    [isMobile ? "QuickJS" : "Deno", info?.deno],
  ];

  return (
    <Section id="tools" title={t.toolsTitle} intro={t.toolsIntro}>
      <div className="stack">
        {infoError ? (
          <ErrorBox error={infoError} />
        ) : (
          <div className="tools-grid">
            {tools.map(([name, v]) => (
              <div key={name} className="tool">
                <b>{name}</b>
                <span className="faint ltr" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {info ? v ?? "—" : "…"}
                </span>
              </div>
            ))}
          </div>
        )}
        <div>
          <button className="btn" disabled={updating} onClick={updateYtdlp}>
            <Icon name="retry" size={16} /> {updating ? t.updating : t.updateYtdlp}
          </button>
        </div>
        {updateError && <ErrorBox error={updateError} />}
      </div>
    </Section>
  );
}

/** المجلدات المراقَبة: كل ملف جديد فيها يُحوَّل تلقائيًا */
function WatchSection(props: { settings: Settings; update: (p: Partial<Settings>) => void }) {
  const { t, lang } = useI18n();
  const list = props.settings.watchFolders;
  const set = (watchFolders: WatchFolder[]) => props.update({ watchFolders });
  const add = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string" && !list.some((w) => w.dir === dir)) {
      set([...list, { dir, preset: props.settings.convertPreset || "edit_h264", enabled: true }]);
    }
  };
  return (
    <Section id="watch" title={t.watchTitle} intro={t.watchIntro}>
      {list.length === 0 && <p className="faint">{t.watchEmpty}</p>}
      {list.map((w, i) => (
        <div className="watch-row" key={w.dir}>
          <label className="toggle" title={w.dir}>
            <input type="checkbox" checked={w.enabled} onChange={(e) => set(list.map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x)))} />
            <span className="switch" />
          </label>
          <span className="path ltr" title={w.dir}>{w.dir}</span>
          <select className="select" value={w.preset} onChange={(e) => set(list.map((x, k) => (k === i ? { ...x, preset: e.target.value } : x)))}>
            {PRESETS.filter((p) => p.kind !== "detect").map((p) => (
              <option key={p.id} value={p.id}>{p.name[lang]}</option>
            ))}
          </select>
          <button className="icon-btn sm" aria-label={t.remove} title={t.remove} onClick={() => set(list.filter((_, k) => k !== i))}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={add} style={{ marginTop: 8 }}>
        <Icon name="plus" size={16} /> {t.addWatch}
      </button>
    </Section>
  );
}
