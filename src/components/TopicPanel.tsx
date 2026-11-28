import { useState } from "react";
import type { Cue, SilenceLevels, TimelineMarker } from "../api";
import { formatDuration, formatTimecode } from "../format";
import { useI18n } from "../i18n";
import type { Range, TopicPlan } from "../reels";
import { isMobile } from "../platform";
import { adjusted, NUDGE, nudged, selectedClips, topicMarkers } from "../topics";
import { Icon } from "./Icon";
import type { TopicRow } from "./JobCard";
import { Pick } from "./Pick";
import { useRangePlayer } from "./SilenceView";

export interface ExportOptions {
  /** true = فيديو واحد، false = ملف لكل مقطع */
  join: boolean;
  /** بلا صمت */
  tight: boolean;
  /** ملف SRT بجانب كل مقطع */
  subs: boolean;
  maxWords: number | null;
  maxSecs: number | null;
  /**
   * "timeline" = XML وEDL (وSRT) تشير إلى الأصل بلا تحويل (R3-F10)، و"markers" = المواضيع علاماتٍ
   * على الملف كله (R3-F11). فارغ = ملفات فيديو
   */
  as?: "video" | "timeline" | "markers";
  /** علامات المواضيع بثواني المصدر: تُكتب على التايم لاين وفي ملفات العلامات */
  marks?: TimelineMarker[];
  /** اسم ملف كل مقطع بترتيب المقاطع (R3-U5): عنوان الموضوع، و«عنوانه · جزء n» للجزء. فارغ = الاسم المعتاد */
  names?: string[];
}

/** حدّا المقطع، وحولهما أزرار التقديم والتأخير بنصف ثانية (R3-U5) */
function RangeChip(props: { range: Range; onNudge?: (edge: 0 | 1, by: number) => void }) {
  const { t } = useI18n();
  const [s, e] = props.range;
  const nudge = props.onNudge;
  if (!nudge) {
    return (
      <span className="chip ltr">
        {formatTimecode(s)}–{formatTimecode(e)}
      </span>
    );
  }
  const button = (edge: 0 | 1, by: number, label: string, text: string) => (
    <button type="button" className="topic-nudge" aria-label={label} title={label} onClick={() => nudge(edge, by)}>
      {text}
    </button>
  );
  return (
    <span className="chip ltr topic-range">
      {button(0, -NUDGE, t.nudgeStart(false), "‹")}
      {formatTimecode(s)}
      {button(0, NUDGE, t.nudgeStart(true), "›")}–{button(1, -NUDGE, t.nudgeEnd(false), "‹")}
      {formatTimecode(e)}
      {button(1, NUDGE, t.nudgeEnd(true), "›")}
    </span>
  );
}

/** مستويات الصمت المقيسة، ليعرف المستخدم أين يضع المستوى اليدوي */
export function LevelsLine({ levels }: { levels: SilenceLevels }) {
  const { t } = useI18n();
  const f = (v: number) => v.toFixed(1);
  return (
    <div className="faint levels-line" title={t.silenceLevelsHint}>
      <Icon name="wave" size={14} />{" "}
      <span dir="auto">
        {t.silenceLevels(f(levels.speech), f(levels.noise), levels.threshold == null ? null : f(levels.threshold), levels.manual)}
      </span>
    </div>
  );
}

/**
 * المواضيع بأنواعها الثلاثة: «يصلح ريلًا»، و«يصلح بعد تقسيمه» بأجزائه المقترحة، و«لا يصلح».
 * مربع اختيار لكل موضوع ولكل جزء، ثم تصديرها فيديو واحدًا أو ملفات منفصلة، مع ترجمة لكل مقطع.
 */
export function TopicPanel(props: {
  rows: TopicRow[];
  plans: TopicPlan[];
  summary: string;
  levels?: SilenceLevels;
  /** طول الجزء بعد حذف الصمت */
  partLength: (r: Range) => number;
  hasCues: boolean;
  /** النص كله بأوقاته: يُعرض منه كلام الموضوع كاملًا عند الطلب */
  cues?: Cue[];
  onExport?: (sections: Range[], o: ExportOptions) => void;
  onCopyTopics?: () => void;
  /** الملف المحلي للتشغيل (R3-U5)، أو لا شيء (رابط لم يُنزَّل) */
  path?: string | null;
  /** الصمت الذي يُحذف: يُقفز فوقه في التشغيل إن اختير «بلا صمت» */
  cuts?: Range[];
}) {
  const { t } = useI18n();
  // المواضيع التي فُتح نصها كاملًا
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggleOpen = (i: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  const fullText = (r: { start: number; end: number }) =>
    (props.cues ?? [])
      .filter((c) => c.start >= r.start - 0.05 && c.start < r.end)
      .map((c) => c.text)
      .join(" ");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [o, setO] = useState<ExportOptions>({ join: false, tight: true, subs: true, maxWords: 7, maxSecs: 3.5 });
  // R3-U5: حدود كل موضوع وجزء بعد التعديل (فرقها عن المقترح)، وعنوان كل موضوع (اسم ملفه عند التصدير)
  const [shift, setShift] = useState<Record<string, Range>>({});
  const [titles, setTitles] = useState<Record<number, string>>({});
  const player = useRangePlayer(props.path, props.cuts ?? []);
  const at = (key: string, base: Range) => adjusted(base, shift[key]);
  const nudge = (key: string, base: Range) => (edge: 0 | 1, by: number) =>
    setShift((cur) => ({ ...cur, [key]: nudged(base, cur[key], edge, by) }));
  const titleOf = (i: number) => titles[i] ?? props.rows[i]?.title ?? "";
  const clips = selectedClips(props.rows, props.plans, picked, at, titleOf, t.topicPart);
  const sections = clips.map((c) => c.range);
  const names = clips.map((c) => c.name);
  /** المواضيع بحدودها وعناوينها بعد التعديل */
  const rowsNow = () =>
    props.rows.map((r, i) => {
      const [start, end] = at(`${i}`, [r.start, r.end]);
      return { ...r, start, end, title: titleOf(i) };
    });
  const plansNow = () => props.plans.map((p, i) => ({ ...p, parts: p.parts.map((q, k) => at(`${i}.${k}`, q)) }));
  const marks = () => topicMarkers(rowsNow(), plansNow(), { topic: t.markerTopic, part: t.topicPart, kind: t.topicKind });
  /** المواضيع كلها بالترتيب: مدى ما يُنزَّل لتحليل رابط */
  const allTopics = () =>
    rowsNow()
      .map((r) => [r.start, r.end] as Range)
      .sort((a, b) => a[0] - b[0]);
  /** زر التشغيل لمقطع: يشغّله بحدوده الآن، ويقفز فوق الصمت إن اختير «بلا صمت» */
  const playButton = (key: string, range: Range) =>
    player.available && (
      <button
        type="button"
        className="btn btn-sm btn-ghost topic-play"
        aria-label={player.playing === key ? t.svPause : t.svPlay}
        title={player.playing === key ? t.svPause : t.svPlay}
        onClick={() => player.toggle(key, range, o.tight)}
      >
        <Icon name={player.playing === key ? "pause" : "play"} size={14} />
      </button>
    );

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      const [i] = key.split(".");
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        // الموضوع كاملًا أو أجزاؤه، لا الاثنان
        for (const k of [...next]) if (k !== key && k.split(".")[0] === i && (k === i || key === i)) next.delete(k);
      }
      return next;
    });
  const pickFitting = () => {
    const next = new Set<string>();
    props.plans.forEach((p, i) => {
      if (p.kind === "reel") next.add(`${i}`);
      if (p.kind === "split") p.parts.forEach((_, k) => next.add(`${i}.${k}`));
    });
    setPicked(next);
  };

  return (
    <div className="markers topics">
      <div className="faint">{props.summary}</div>
      {props.levels && <LevelsLine levels={props.levels} />}
      {props.onExport && (
        <div className="topic-tools">
          <button className="btn btn-sm" onClick={pickFitting}>
            <Icon name="check" size={14} /> {t.selectReels}
          </button>
          {picked.size > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => setPicked(new Set())}>
              {t.selectNone}
            </button>
          )}
        </div>
      )}
      <ol className="topic-list">
        {props.rows.map((r, i) => {
          const plan = props.plans[i] ?? { kind: r.reel ? "reel" : "no", parts: [] };
          const base: Range = [r.start, r.end];
          const rng = at(`${i}`, base);
          const moved = !!shift[`${i}`];
          return (
            <li key={i} className={`topic kind-${plan.kind}${r.reel ? " is-reel" : ""}`}>
              <div className="topic-head">
                {props.onExport && (
                  <input
                    type="checkbox"
                    className="topic-check"
                    checked={picked.has(`${i}`)}
                    onChange={() => toggle(`${i}`)}
                    aria-label={`${formatTimecode(rng[0])}–${formatTimecode(rng[1])} ${titleOf(i)}`}
                  />
                )}
                {playButton(`${i}`, rng)}
                <RangeChip range={rng} onNudge={props.onExport && nudge(`${i}`, base)} />
                <span
                  className={`chip chip-kind chip-${plan.kind}`}
                  title={plan.kind === "no" && plan.reason ? t.topicNo[plan.reason] : plan.kind === "split" ? t.topicSplitHint : undefined}
                >
                  {t.topicKind[plan.kind]}
                </span>
                <span className="faint">
                  {moved
                    ? t.topicLength(formatDuration(rng[1] - rng[0]), formatDuration(props.partLength(rng)))
                    : t.topicLength(formatDuration(r.before), formatDuration(r.after))}
                </span>
              </div>
              {/* العنوان قابل للتعديل، ويصير اسم الملف عند التصدير (R3-U5) */}
              {props.onExport ? (
                <input
                  className="input topic-title-input"
                  dir="auto"
                  value={titleOf(i)}
                  placeholder={t.markerTopic(i + 1)}
                  aria-label={t.topicTitleLabel}
                  title={t.topicTitleHint}
                  onChange={(e) => setTitles((cur) => ({ ...cur, [i]: e.target.value }))}
                />
              ) : (
                r.title && (
                  <div className="topic-title" dir="auto">
                    {r.title}
                  </div>
                )
              )}
              <div className="faint topic-text" dir="auto">
                {open.has(i) ? fullText(r) : r.text}
              </div>
              {/* الملخص أول 160 حرفًا فقط: النص كاملًا من الترجمة نفسها، ليعرف ما في الموضوع قبل تصديره */}
              {(props.cues?.length ?? 0) > 0 && r.text.endsWith("…") && (
                <div className="topic-more">
                  <button className="btn btn-sm btn-ghost" aria-expanded={open.has(i)} onClick={() => toggleOpen(i)}>
                    <Icon name="captions" size={16} /> {open.has(i) ? t.topicTextLess : t.topicTextAll}
                  </button>
                  {open.has(i) && (
                    <button className="btn btn-sm btn-ghost" onClick={() => navigator.clipboard?.writeText(fullText(r)).catch(() => {})}>
                      <Icon name="copy" size={16} /> {t.topicTextCopy}
                    </button>
                  )}
                </div>
              )}
              {plan.kind === "no" && plan.reason && <div className="faint topic-why">{t.topicNo[plan.reason]}</div>}
              {plan.parts.length > 0 && (
                <ul className="topic-parts">
                  {plan.parts.map((p, k) => {
                    const key = `${i}.${k}`;
                    const pr = at(key, p);
                    return (
                      <li key={k}>
                        <label>
                          {props.onExport && <input type="checkbox" checked={picked.has(key)} onChange={() => toggle(key)} />}
                          <span>{t.topicPart(k + 1)}</span>
                        </label>
                        {playButton(key, pr)}
                        <RangeChip range={pr} onNudge={props.onExport && nudge(key, p)} />
                        <span className="faint">{formatDuration(props.partLength(pr))}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      {props.onExport && sections.length > 0 && (
        <div className="topic-export">
          <div className="pick-grid">
            <Pick<string>
              label={t.exportAs}
              value={o.join ? "join" : "split"}
              onChange={(v) => setO({ ...o, join: v === "join" })}
              options={[
                { value: "split", label: t.exportSeparate },
                { value: "join", label: t.exportJoin },
              ]}
            />
            {props.hasCues && (
              <>
                <Pick<number | null>
                  label={t.lineWords}
                  value={o.subs ? o.maxWords : null}
                  onChange={(v) => setO({ ...o, maxWords: v })}
                  options={[{ value: null, label: t.noLimit }, ...[3, 5, 7, 10, 14].map((v) => ({ value: v, label: String(v) }))]}
                />
                <Pick<number | null>
                  label={t.lineSecs}
                  value={o.maxSecs}
                  onChange={(v) => setO({ ...o, maxSecs: v })}
                  options={[{ value: null, label: t.noLimit }, ...[2, 3, 3.5, 5, 7].map((v) => ({ value: v, label: t.secs(v) }))]}
                />
              </>
            )}
          </div>
          <div className="topic-toggles">
            <label>
              <input type="checkbox" checked={o.tight} onChange={(e) => setO({ ...o, tight: e.target.checked })} /> {t.exportTight}
            </label>
            {props.hasCues && (
              <label>
                <input type="checkbox" checked={o.subs} onChange={(e) => setO({ ...o, subs: e.target.checked })} /> {t.exportSubs}
              </label>
            )}
          </div>
          {props.hasCues && o.subs && <div className="faint">{t.exportHint}</div>}
          <div className="topic-export-actions">
            <button className="btn btn-primary btn-sm mt-2" onClick={() => props.onExport!(sections, { ...o, names })}>
              <Icon name="scissors" size={14} /> {t.exportSelected(o.join ? 1 : sections.length)}
            </button>
            {/* تايم لاين للمونتاج: المقاطع متتالية بقطعها على الأصل، بلا تحويل (R3-F10) */}
            {!isMobile && (
              <button
                className="btn btn-sm mt-2"
                title={t.timelineExportHint}
                onClick={() => props.onExport!(sections, { ...o, join: true, as: "timeline", marks: marks(), names })}
              >
                <Icon name="timeline" size={14} /> {t.timelineExport}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="topic-export-actions">
        {props.onCopyTopics && (
          <button className="btn btn-sm mt-2" onClick={props.onCopyTopics}>
            <Icon name="copy" size={16} /> {t.copyTopics}
          </button>
        )}
        {/* علامات للمونتاج (R3-F11): كل موضوع باسمه ولون صلاحيته ريلًا، على الملف كله */}
        {props.onExport && !isMobile && props.rows.length > 0 && (
          <button
            className="btn btn-sm mt-2"
            title={t.topicMarkersHint}
            onClick={() => props.onExport!(allTopics(), { ...o, join: true, as: "markers", marks: marks() })}
          >
            <Icon name="list" size={16} /> {t.markersExport}
          </button>
        )}
      </div>
      {player.element}
    </div>
  );
}
