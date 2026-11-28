// Converts docs/report/*.md into one Arabic (RTL) Word report.
// usage: node md-to-docx.cjs <reportDir> <out.docx> [--submit] [--ref=<git ref>] [--keep-codes]
//   (needs: npm i docx@9 marked@15 @mermaid-js/mermaid-cli@11 with PUPPETEER_SKIP_DOWNLOAD=1)
// The packages can live outside the repository: run from their folder, or set NODE_PATH to its node_modules.
// Copy of the arabic-academic-report skill template, extended for this report (figures, checks).
//
// Draft and submitted copy (review item R3-A20):
//   - review codes such as "(A-41)", "(T-1)", "A-30، A-31" are removed from the text in both modes; they stay in the
//     Markdown for traceability (--keep-codes keeps them in the Word file too). Objective and hypothesis labels (O4, H2) stay.
//   - relative links to repository files become links to GitHub at <ref>: "main" for a draft, the defense tag
//     "v1.0-defense" (report.json "defenseTag") with --submit. Links between files of the report keep the text only.
//   - --submit refuses to export while a "[يكتبه الطالب]" placeholder is left, and lists where.
const fs = require("fs");
const path = require("path");
const NODE_MODULES = (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)[0] || path.join(process.cwd(), "node_modules");
const { marked } = require("marked");
const D = require("docx");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, PageBreak, Footer, Header, PageNumber, TableOfContents,
  LevelFormat, ExternalHyperlink, TabStopType, NumberFormat, StyleLevel,
} = D;

const argv = process.argv.slice(2);
const opt = (name) => {
  const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.includes("=") ? a.slice(a.indexOf("=") + 1) : true;
};
const [dir, out] = argv.filter((a) => !a.startsWith("--"));
if (!dir || !out) {
  console.error("usage: node md-to-docx.cjs <reportDir> <out.docx> [--submit] [--ref=<git ref>] [--keep-codes]");
  process.exit(2);
}
// Optional <reportDir>/report.json: { "files": [...], "title", "subtitle", "header", "degree", "year", "chrome",
//   "repo" (GitHub URL), "defenseTag" }
const CFG = fs.existsSync(path.join(dir, "report.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) : {};
const SUBMIT = !!opt("submit");
const KEEP_CODES = !!opt("keep-codes");
const REPO = (CFG.repo || "https://github.com/jake750/khama").replace(/\/$/, "");
const REF = opt("ref") || (SUBMIT ? CFG.defenseTag || "v1.0-defense" : "main");
const REPO_ROOT = path.resolve(dir, "../..");
const SKIP = /^(README|defense|PROCESS)/i; // notes that are not part of the submitted report
const FILES = CFG.files || fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !SKIP.test(f)).sort();
// Front matter (numbered with Arabic abjad letters; chapter 1 starts at page 1): report.json "front", where "toc"
// marks the place of the contents and the lists of figures and tables.
const FRONT = CFG.front || ["toc"];
const ALL = [...FRONT.filter((f) => f !== "toc"), ...FILES];
const TITLE = CFG.title || "[يكتبه الطالب] عنوان المشروع";
const SUBTITLE = CFG.subtitle || "";
const HEADER = CFG.header || `${TITLE} · تقرير مشروع التخرج`;
const CHROME = CFG.chrome || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const FONT = "Arial";
const MONO = "Consolas";
const BODY = 24; // 12 pt
const PAGE_W = 11906, MARGIN = 1418; // A4, 2.5 cm
const TEXT_W = PAGE_W - 2 * MARGIN;
const ACCENT = "1F3A5F";
const STUDENT = "يكتبه الطالب";

const arabic = /[؀-ۿ]/;
const isRtlText = (s) => arabic.test(s);

let listInstance = 0;

// ---------- inline ----------
function inline(tokens, fmt = {}) {
  const runs = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case "strong": runs.push(...inline(t.tokens, { ...fmt, bold: true })); break;
      case "em": runs.push(...inline(t.tokens, { ...fmt, italics: true })); break;
      case "del": runs.push(...inline(t.tokens, { ...fmt, strike: true })); break;
      case "codespan": runs.push(run(unescape(t.text), { ...fmt, mono: true })); break;
      case "br": runs.push(new TextRun({ break: 1 })); break;
      case "link": {
        const url = linkTarget(t.href);
        const kids = inline(t.tokens, { ...fmt, link: !!url });
        if (url) runs.push(new ExternalHyperlink({ link: url, children: kids }));
        else runs.push(...kids); // a link to another chapter of the report: keep the text only
        break;
      }
      case "text":
        if (t.tokens && t.tokens.length) runs.push(...inline(t.tokens, fmt));
        else runs.push(...textRuns(unescape(t.text), fmt));
        break;
      case "escape": runs.push(run(t.text, fmt)); break;
      case "html": break;
      default: runs.push(...textRuns(unescape(t.raw || t.text || ""), fmt));
    }
  }
  return runs;
}

// A link in the Markdown → the URL it gets in Word, or null to keep the text only.
// Relative links point at files of the repository, which do not exist next to a PDF: link them on GitHub at REF.
function linkTarget(href) {
  if (/^(https?:|mailto:)/.test(href)) return href;
  if (!href || href.startsWith("#")) return null;
  const [p, hash] = href.split("#");
  const abs = path.resolve(dir, decodeURI(p));
  if (path.dirname(abs) === path.resolve(dir) && ALL.includes(path.basename(abs))) return null;
  const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return null;
  const isDir = p.endsWith("/") || (fs.existsSync(abs) && fs.statSync(abs).isDirectory());
  return `${REPO}/${isDir ? "tree" : "blob"}/${REF}/${encodeURI(rel)}${hash ? "#" + hash : ""}`;
}

function unescape(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// split out the student placeholder so it can be highlighted
function textRuns(s, fmt) {
  const parts = s.split(/(\[يكتبه الطالب\])/);
  return parts.filter(Boolean).map((p) => run(p, p === `[${STUDENT}]` ? { ...fmt, bold: true, highlight: "yellow" } : fmt));
}

function run(text, f = {}) {
  return new TextRun({
    text,
    bold: f.bold, italics: f.italics, strike: f.strike,
    font: f.mono ? MONO : FONT,
    size: f.size || (f.mono ? BODY - 4 : BODY),
    color: f.link ? "1F5FA8" : f.color,
    underline: f.link ? {} : undefined,
    highlight: f.highlight,
    rightToLeft: f.mono ? false : isRtlText(text) || f.rtl,
  });
}

// ---------- blocks ----------
function para(children, opts = {}) {
  return new Paragraph({
    children, bidirectional: opts.ltr ? false : true,
    alignment: opts.align || (opts.ltr ? AlignmentType.LEFT : AlignmentType.BOTH),
    spacing: { after: opts.after ?? 120, line: opts.line ?? 312 },
    ...opts.extra,
  });
}

function blocks(tokens, ctx) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][t.depth - 1];
        const hl = isLtr(t.text);
        out.push(new Paragraph({
          heading: level, bidirectional: !hl, alignment: hl ? AlignmentType.LEFT : AlignmentType.START,
          pageBreakBefore: t.depth === 1 && !ctx.first,
          children: inline(t.tokens, { rtl: true }),
        }));
        ctx.first = false;
        break;
      }
      case "paragraph": {
        const imgs = (t.tokens || []).filter((x) => x.type === "image");
        if (imgs.length && (t.tokens || []).every((x) => x.type === "image" || (x.type === "text" && !x.text.trim()))) {
          out.push(...imgs.map((x) => image(x.href)));
          break;
        }
        // captions: a table caption sits above its table and keeps with it; a figure caption sits below the
        // figure (the figure paragraph keeps with it), so it does not keep with what follows
        const caption = /^\*\*(الجدول|الشكل|المقتطف)/.exec(t.raw);
        const ltr = isLtr(t.raw);
        if (caption && t.tokens[0].type === "strong") {
          // The bold title is the caption proper, in a caption style that the lists of figures and tables collect;
          // what follows it (source file, notes) goes on a smaller line under it, so it stays out of the lists.
          const keepNext = caption[1] !== "الشكل";
          const style = { الجدول: "TableCaption", الشكل: "FigureCaption" }[caption[1]];
          const rest = t.tokens.slice(1);
          const hasRest = plain(rest).trim().length > 0;
          out.push(new Paragraph({
            style, bidirectional: true, alignment: AlignmentType.CENTER, keepNext: keepNext || hasRest,
            spacing: { after: hasRest ? 0 : 120, line: 312 },
            children: inline(t.tokens[0].tokens, { bold: true }),
          }));
          if (hasRest) {
            if (rest[0].type === "text") rest[0] = { ...rest[0], text: rest[0].text.replace(/^\s+/, ""), tokens: undefined };
            out.push(new Paragraph({
              bidirectional: true, alignment: AlignmentType.CENTER, keepNext, spacing: { after: 120, line: 276 },
              children: inline(rest, { size: 20, color: "555555" }),
            }));
          }
          break;
        }
        out.push(para(inline(t.tokens), { ltr, align: ltr ? AlignmentType.BOTH : undefined }));
        break;
      }
      case "list": out.push(...list(t, 0)); break;
      case "table": out.push(table(t), para([], { after: 120 })); break;
      case "code": out.push(...(t.lang === "mermaid" ? diagram(t.text) : code(t.text))); break;
      case "blockquote": out.push(...blocks(t.tokens, ctx)); break;
      case "hr": out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } }, spacing: { after: 160 } })); break;
      case "space": case "html": break;
      default: if (t.text) out.push(para(textRuns(t.text, {})));
    }
  }
  return out;
}

function list(t, level) {
  const instance = ++listInstance;
  const ref = t.ordered ? "num" : "bullet";
  const out = [];
  for (const item of t.items) {
    const inl = [];
    const nested = [];
    for (const c of item.tokens) {
      if (c.type === "list") nested.push(c);
      else if (c.type === "text" || c.type === "paragraph") {
        if (inl.length) inl.push(new TextRun({ break: 1 }));
        inl.push(...inline(c.tokens && c.tokens.length ? c.tokens : [{ type: "text", text: c.text }]));
      }
    }
    out.push(new Paragraph({
      children: inl, bidirectional: true, alignment: AlignmentType.BOTH,
      numbering: { reference: ref, level, instance },
      spacing: { after: 60, line: 300 },
    }));
    for (const n of nested) out.push(...list(n, level + 1));
  }
  return out;
}

// a paragraph with Latin letters and no Arabic is laid out left to right (Abstract, keywords)
function isLtr(s) {
  return !arabic.test(s) && /[A-Za-z]{3}/.test(s);
}

// Mermaid source → PNG via mermaid-cli and the local Chrome
let diagramN = 0;
function diagram(src) {
  const { execFileSync } = require("child_process");
  const n = ++diagramN;
  const base = path.join(path.dirname(path.resolve(out)), ".diagrams");
  fs.mkdirSync(base, { recursive: true });
  const inF = path.join(base, `d${n}.mmd`), outF = path.join(base, `d${n}.png`);
  fs.writeFileSync(inF, src);
  const cfg = path.join(base, "puppeteer.json");
  fs.writeFileSync(cfg, JSON.stringify({ executablePath: CHROME, args: ["--no-sandbox"] }));
  // 16 px text on a 1200 px page (review item R3-A48: the old 1100 px default-font export printed faint and small)
  const mm = path.join(base, "mermaid.json");
  fs.writeFileSync(mm, JSON.stringify({
    theme: "neutral",
    themeVariables: { fontFamily: "Arial", fontSize: `${DIAGRAM_FONT}px`, primaryTextColor: "#111111", lineColor: "#333333" },
    sequence: { actorFontSize: DIAGRAM_FONT, messageFontSize: DIAGRAM_FONT, noteFontSize: DIAGRAM_FONT, mirrorActors: false, width: 120, actorMargin: 30, messageMargin: 30 },
    flowchart: { useMaxWidth: false }, sequenceDiagram: { useMaxWidth: false }, state: { useMaxWidth: false },
  }));
  execFileSync(process.execPath, [path.join(NODE_MODULES, "@mermaid-js/mermaid-cli/src/cli.js"), "-i", inF, "-o", outF, "-p", cfg, "-c", mm, "-b", "white", "-s", "2", "-w", "1200"], { stdio: "pipe" });
  const png = fs.readFileSync(outF);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const maxW = 600, maxH = 760; // px at 96 dpi, inside the text block
  const k = Math.min(maxW / w, maxH / h, 1);
  // the PNG is at scale 2, so the printed text is DIAGRAM_FONT · 2k px; warn below 9 px (about 7 pt)
  const printed = DIAGRAM_FONT * 2 * k;
  if (printed < 9) console.warn(`diagram ${n}: text prints at ${printed.toFixed(1)} px; draw it narrower (e.g. TB instead of LR)`);
  return [new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 120, after: 80 }, keepNext: true,
    children: [new D.ImageRun({ type: "png", data: png, transformation: { width: Math.round(w * k), height: Math.round(h * k) } })],
  })];
}
const DIAGRAM_FONT = 16;

// ![](relative/path.png): a PNG from the repository (results figures, screenshots), fitted to the text block.
// The figure keeps with the caption paragraph that follows it.
function image(href) {
  const file = path.resolve(dir, decodeURI(href));
  if (!fs.existsSync(file) || !/\.png$/i.test(file)) {
    console.error(`missing or non-PNG figure: ${href}`);
    process.exit(1);
  }
  return picture(fs.readFileSync(file), 600, 700);
}

function picture(png, maxW, maxH) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const k = Math.min(maxW / w, maxH / h, 1);
  return new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 120, after: 80 }, keepNext: true,
    children: [new D.ImageRun({ type: "png", data: png, transformation: { width: Math.round(w * k), height: Math.round(h * k) } })],
  });
}

function code(text) {
  return text.split("\n").map((line, i, a) => new Paragraph({
    bidirectional: false, alignment: AlignmentType.LEFT,
    shading: { type: ShadingType.CLEAR, fill: "F3F4F6", color: "auto" },
    spacing: { after: i === a.length - 1 ? 160 : 0, line: 260 },
    indent: { left: 120, right: 120 },
    children: [new TextRun({ text: line || " ", font: MONO, size: 17, rightToLeft: false })],
  }));
}

function plain(tokens) {
  return (tokens || []).map((t) => (t.tokens ? plain(t.tokens) : t.text || "")).join("");
}

function table(t) {
  const n = t.header.length;
  // column widths from content length (sqrt to soften), min share
  const lens = t.header.map((h, i) => {
    const all = [plain(h.tokens), ...t.rows.map((r) => plain(r[i].tokens))];
    return Math.sqrt(Math.max(...all.map((s) => s.length), 3));
  });
  const sum = lens.reduce((a, b) => a + b, 0);
  let widths = lens.map((l) => Math.max(Math.round((l / sum) * TEXT_W), 700));
  const scale = TEXT_W / widths.reduce((a, b) => a + b, 0);
  widths = widths.map((w) => Math.floor(w * scale));
  widths[0] += TEXT_W - widths.reduce((a, b) => a + b, 0);
  const small = n >= 5 ? 18 : 20;
  const border = { style: BorderStyle.SINGLE, size: 4, color: "B7C3D0" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (c, i, head) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    borders,
    shading: head ? { type: ShadingType.CLEAR, fill: "E4EAF1", color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new Paragraph({
      bidirectional: true, alignment: AlignmentType.START, spacing: { after: 0, line: 276 },
      children: inline(c.tokens, { bold: head, size: small }).map((r) => r),
    })],
  });
  // inline() uses BODY size; rebuild runs at table size
  const rows = [
    new TableRow({ tableHeader: true, children: t.header.map((c, i) => cellSized(c, i, true)) }),
    ...t.rows.map((r) => new TableRow({ cantSplit: true, children: r.map((c, i) => cellSized(c, i, false)) })),
  ];
  function cellSized(c, i, head) {
    return new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      borders,
      shading: head ? { type: ShadingType.CLEAR, fill: "E4EAF1", color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [new Paragraph({
        bidirectional: true, alignment: AlignmentType.START, spacing: { after: 0, line: 276 },
        children: inlineSized(c.tokens, head, small),
      })],
    });
  }
  return new Table({ width: { size: TEXT_W, type: WidthType.DXA }, columnWidths: widths, visuallyRightToLeft: true, rows });
}

function inlineSized(tokens, bold, size) {
  const walk = (toks, f) => {
    const r = [];
    for (const t of toks || []) {
      if (t.type === "strong") r.push(...walk(t.tokens, { ...f, bold: true }));
      else if (t.type === "em") r.push(...walk(t.tokens, { ...f, italics: true }));
      else if (t.type === "codespan") r.push(run(unescape(t.text), { ...f, mono: true, size: size - 2 }));
      else if (t.type === "link") {
        const url = linkTarget(t.href);
        const kids = walk(t.tokens, { ...f, link: !!url });
        if (url) r.push(new ExternalHyperlink({ link: url, children: kids }));
        else r.push(...kids);
      }
      else if (t.type === "br") r.push(new TextRun({ break: 1 }));
      else if (t.tokens && t.tokens.length) r.push(...walk(t.tokens, f));
      else r.push(...textRuns(unescape(t.text ?? t.raw ?? ""), f));
    }
    return r;
  };
  return walk(tokens, { bold, size });
}

// ---------- front matter ----------
function center(text, size, opts = {}) {
  return new Paragraph({
    bidirectional: true, alignment: AlignmentType.CENTER, spacing: { after: opts.after ?? 200 },
    children: textRuns(text, { size, bold: opts.bold, color: opts.color, rtl: true }),
  });
}

// Cover fields come from report.json ("university", "student", "supervisor", "degree", "year", "dedication",
// "thanks"); a missing one is a highlighted placeholder in a draft and an error with --submit.
const P = `[${STUDENT}]`;
const field = (k) => CFG[k] || P;
const cover = [
  center(CFG.university || `${P} الجامعة · الكلية · القسم`, 26, { after: 1600 }),
  center(`مشروع تخرّج لنيل شهادة ${field("degree")}`, 26, { after: 700 }),
  center(TITLE, 72, { bold: true, color: ACCENT, after: 200 }),
  ...(SUBTITLE ? [center(SUBTITLE, 30, { after: 1400 })] : [new Paragraph({ spacing: { after: 1400 } })]),
  center(`إعداد الطالب: ${field("student")}`, 26),
  center(`إشراف: ${field("supervisor")}`, 26, { after: 1400 }),
  center(`السنة الجامعية ${field("year")}`, 24),
  new Paragraph({ children: [new PageBreak()] }),
  frontTitle("الإهداء", false),
  para(textRuns(field("dedication"), {})),
  frontTitle("شكر وتقدير"),
  para(textRuns(field("thanks"), {})),
];

// A title of the front matter that looks like a chapter title but stays out of the table of contents.
function frontTitle(text, newPage = true) {
  return new Paragraph({
    bidirectional: true, alignment: AlignmentType.START, pageBreakBefore: newPage, keepNext: true,
    spacing: { after: 280 }, children: [run(text, { size: 36, bold: true, color: ACCENT, rtl: true })],
  });
}

// Contents, then the lists of figures and of tables: Word fields filled when export-pdf.ps1 updates them.
// The lists collect the paragraphs in the caption styles (the bold caption only, see blocks()).
const contents = [
  frontTitle("فهرس المحتويات"),
  new TableOfContents("فهرس المحتويات", { hyperlink: true, headingStyleRange: "1-3" }),
  para(textRuns("(إن لم يظهر الفهرس: انقر عليه بالزر الأيمن ← تحديث الحقل ← تحديث الجدول بأكمله)", { size: 18, color: "777777" })),
  frontTitle("قائمة الأشكال"),
  new TableOfContents("قائمة الأشكال", { hyperlink: true, stylesWithLevels: [new StyleLevel("FigureCaption", 1)] }),
  frontTitle("قائمة الجداول"),
  new TableOfContents("قائمة الجداول", { hyperlink: true, stylesWithLevels: [new StyleLevel("TableCaption", 1)] }),
];

// ---------- checks before converting ----------
// A table whose rows do not all have the delimiter row's number of cells is not a table for marked:
// it falls back to a paragraph of raw pipes in the PDF. Refuse it with file:line instead.
function cellCount(line) {
  let s = line.replace(/`[^`]*`/g, "C").replace(/\\\|/g, "").trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").length;
}
function checkTables(file, md) {
  const lines = md.split(/\r?\n/);
  const bad = [];
  let code = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { code = !code; continue; }
    if (code || !/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")) continue;
    const n = cellCount(lines[i + 1]);
    let j = i;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const c = cellCount(lines[j]);
      if (c !== n) bad.push(`${file}:${j + 1}: ${c} cells, the table has ${n}`);
    }
    i = j;
  }
  return bad;
}
const problems = [];
for (const f of ALL) problems.push(...checkTables(f, fs.readFileSync(path.join(dir, f), "utf8")));
if (problems.length) {
  console.error("Tables with a wrong number of cells:\n  " + problems.join("\n  "));
  process.exit(1);
}

// Review codes (A-41, T-1, M-42, D-84) are for the author, not the jury. In a parenthesis they are removed with
// their separator, and the parenthesis goes when nothing else is left: "(A-9، O4، H2)" → "(O4، H2)",
// "بصراحة (A-45):" → "بصراحة:". "[يكتبه الطالب، A-63]" → "[يكتبه الطالب]". Code blocks are left alone.
const REVIEW_CODE = /^[ATMD]-\d+$/;
const HAS_CODE = /\b[ATMD]-\d+\b/;
function stripCodes(md) {
  let fence = false;
  return md.split("\n").map((line) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || !HAS_CODE.test(line)) return line;
    line = line.replace(/\[يكتبه الطالب[،,]\s*([^\]]*)\]/g, (m, inner) =>
      inner.split(/\s*[،,]\s*|\s+و(?=[ATMD]-)/).every((x) => REVIEW_CODE.test(x.trim())) ? P : m);
    return line.replace(/(\s?)\(([^()\n]*)\)/g, (m, sp, inner) => {
      if (!HAS_CODE.test(inner)) return m;
      const parts = inner.split(/(\s*[،؛;]\s*|,\s+|\s+و(?=[ATMD]-\d))/);
      const kept = [];
      for (let i = 0; i < parts.length; i += 2) if (!REVIEW_CODE.test(parts[i].trim())) kept.push({ sep: parts[i - 1] || "", text: parts[i] });
      if (!kept.length) return "";
      return `${sp}(${kept.map((k, j) => (j ? k.sep : "") + k.text).join("")})`;
    });
  }).join("\n");
}

// ---------- body ----------
const left = [];
const read = (f) => {
  let md = fs.readFileSync(path.join(dir, f), "utf8");
  if (!KEEP_CODES) {
    md = stripCodes(md);
    const rest = md.split("\n").filter((l) => HAS_CODE.test(l) && !/^\s*(```|    )/.test(l)).length;
    if (rest) console.warn(`${f}: ${rest} line(s) still carry a review code outside a parenthesis`);
  }
  md.split("\n").forEach((l, i) => { if (l.includes(STUDENT)) left.push(`${f}:${i + 1}`); });
  return md;
};
const sources = new Map(ALL.map((f) => [f, read(f)]));
const coverLeft = ["degree", "student", "supervisor", "year", "dedication", "thanks", "university"].filter((k) => !CFG[k]);
if (SUBMIT && (left.length || coverLeft.length)) {
  console.error(`--submit: ${left.length} "[${STUDENT}]" placeholder(s) are left:\n  ${left.join("\n  ")}`);
  if (coverLeft.length) console.error(`  report.json lacks: ${coverLeft.join(", ")}`);
  process.exit(1);
}
console.log(`${SUBMIT ? "submitted copy" : "draft"}: links to ${REPO} at ${REF}; ${left.length} placeholder line(s) left`);
const front = [...cover];
const fctx = { first: false };
for (const f of FRONT) front.push(...(f === "toc" ? contents : blocks(marked.lexer(sources.get(f)), fctx)));
const body = [];
const ctx = { first: true }; // the body is a new section, which starts on a new page by itself
for (const f of FILES) body.push(...blocks(marked.lexer(sources.get(f)), ctx));

// Document properties (the PDF takes them from Word): keywords from the abstract
const abstractMd = [...sources.values()].find((md) => /\*\*Keywords\*\*/.test(md)) || "";
const KEYWORDS = (/\*\*Keywords\*\*:\s*(.+)/.exec(abstractMd) || [])[1]?.replace(/\.$/, "") || "";

const heading = (size, before, after, color = ACCENT) => ({
  run: { font: FONT, size, bold: true, color },
  paragraph: { spacing: { before, after }, keepNext: true, keepLines: true },
});

const doc = new Document({
  title: `${TITLE}: تقرير مشروع التخرج`,
  subject: SUBTITLE,
  creator: CFG.student || "",
  lastModifiedBy: CFG.student || "",
  keywords: KEYWORDS,
  description: CFG.year ? `السنة الجامعية ${CFG.year}` : "",
  features: { updateFields: true },
  styles: {
    default: {
      document: { run: { font: FONT, size: BODY } },
      heading1: heading(36, 0, 280),
      heading2: heading(30, 320, 160),
      heading3: heading(26, 240, 120, "2F5A86"),
      heading4: heading(24, 200, 100, "2F5A86"),
    },
    paragraphStyles: [
      ...[1, 2, 3].map((l) => ({ id: `TOC${l}`, name: `toc ${l}`, basedOn: "Normal", run: { font: FONT, size: l === 1 ? 24 : 22, bold: l === 1, rightToLeft: true }, paragraph: { bidirectional: true, indent: { right: (l - 1) * 360 }, spacing: { after: 60 } } })),
      // caption styles collected by the lists of figures and tables (TOC \t "FigureCaption,1")
      ...["FigureCaption", "TableCaption"].map((id) => ({ id, name: id, basedOn: "Normal", next: "Normal", run: { font: FONT, size: BODY, bold: true, rightToLeft: true }, paragraph: { bidirectional: true, alignment: AlignmentType.CENTER } })),
    ],
  },
  numbering: {
    config: [
      { reference: "bullet", levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.BULLET, text: ["●", "○", "▪"][level], alignment: AlignmentType.START, style: { paragraph: { indent: { right: 540 + level * 360, hanging: 300 } }, run: { font: FONT, size: 16 } } })) },
      { reference: "num", levels: [0, 1, 2].map((level) => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level], text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { right: 540 + level * 360, hanging: 360 } } } })) },
    ],
  },
  // Two sections: the front matter numbered أ، ب، ج… (the cover counts as أ and shows no number), and the
  // chapters numbered 1, 2, 3… from the first page of chapter 1.
  sections: [
    { ...section(NumberFormat.ARABIC_ABJAD, true), children: front },
    { ...section(NumberFormat.DECIMAL, false), children: body },
  ],
});

function section(format, titlePage) {
  const page = { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN }, pageNumbers: { start: 1, formatType: format } };
  const header = new Header({ children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.START, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "B7C3D0", space: 4 } }, children: [run(HEADER, { size: 18, color: "6B7785", rtl: true })] })] });
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })] })] });
  const empty = () => new Header({ children: [new Paragraph({ children: [] })] });
  return {
    properties: { page, titlePage, rightToLeft: true },
    headers: titlePage ? { default: header, first: empty() } : { default: header },
    footers: titlePage ? { default: footer, first: new Footer({ children: [new Paragraph({ children: [] })] }) } : { default: footer },
  };
}

Packer.toBuffer(doc).then((b) => { fs.writeFileSync(out, b); console.log("wrote", out, b.length); });
