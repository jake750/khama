import { useEffect, useRef, useState } from "react";
import { api, asAppError, type AppError, type CookiesMode, type Language, type Settings, type Theme, type ToolsInfo } from "../api";
import { useI18n } from "../i18n";
import { ErrorBox } from "./ErrorBox";
import { Icon } from "./Icon";
import { Segmented } from "./Segmented";

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
}) {
  const { t } = useI18n();
  const { settings: s, update } = props;

  return (
    <>
      {/* ---------- عام ---------- */}
      <div className="card settings-section">
        <h2>{t.general}</h2>
        <div>
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
              <div className="faint ltr" style={{ wordBreak: "break-all" }}>{props.outputDir}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={props.onOpenDir}><Icon name="folder" size={16} /> {t.open}</button>
              <button className="btn" onClick={props.onChooseDir}>{t.choose}</button>
            </div>
          </div>
        </div>
      </div>

      <CookiesSection settings={s} update={update} toast={props.toast} />
      <ToolsSection toast={props.toast} />

      {/* ---------- حول ---------- */}
      <div className="card">
        <h2>{t.aboutTitle}</h2>
        <p className="muted" style={{ margin: "4px 0 8px" }}>{t.aboutBody}</p>
        <p className="faint" style={{ margin: 0 }}>{t.notice}</p>
      </div>
    </>
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
    { value: "browser", title: t.cookiesBrowser, hint: t.cookiesBrowserHint },
    { value: "file", title: t.cookiesFile, hint: t.cookiesFileHint },
  ];

  return (
    <div className="card settings-section">
      <div>
        <h2>{t.cookiesTitle}</h2>
        <p className="faint" style={{ margin: 0 }}>{t.cookiesIntro}</p>
      </div>

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
            <Icon name={hasSaved ? "check" : "x"} size={14} />
            {hasSaved ? t.cookiesSaved : t.cookiesNotSaved}
          </div>
          <textarea
            className="textarea"
            placeholder={t.cookiesPlaceholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
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
    ["Deno", info?.deno],
  ];

  return (
    <div className="card settings-section">
      <div>
        <h2>{t.toolsTitle}</h2>
        <p className="faint" style={{ margin: 0 }}>{t.toolsIntro}</p>
      </div>
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
  );
}
