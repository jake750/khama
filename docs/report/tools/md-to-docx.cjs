// Converts docs/report/*.md into one Arabic (RTL) Word report.
// usage: node md-to-docx.cjs <reportDir> <out.docx>   (needs: npm i docx@9 marked@15 @mermaid-js/mermaid-cli@11 with PUPPETEER_SKIP_DOWNLOAD=1)
// The packages can live outside the repository: run from their folder, or set NODE_PATH to its node_modules.
// Copy of the arabic-academic-report skill template, extended for this report (figures, checks).
const fs = require("fs");
const path = require("path");
const NODE_MODULES = (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)[0] || path.join(process.cwd(), "node_modules");
const { marked } = require("marked");
const D = require("docx");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, PageBreak, Footer, Header, PageNumber, TableOfContents,
  LevelFormat, ExternalHyperlink, TabStopType,
} = D;

const [, , dir, out] = process.argv;
// Optional <reportDir>/report.json: { "files": [...], "title", "subtitle", "header", "degree", "year", "chrome" }
const CFG = fs.existsSync(path.join(dir, "report.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8")) : {};
const SKIP = /^(README|defense|PROCESS)/i; // notes that are not part of the submitted report
const FILES = CFG.files || fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !SKIP.test(f)).sort();
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
        const kids = inline(t.tokens, { ...fmt, link: /^https?:/.test(t.href) });
        if (/^https?:/.test(t.href)) runs.push(new ExternalHyperlink({ link: t.href, children: kids }));
        else runs.push(...kids); // relative links to repo files: keep the text only
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
        const caption = /^\*\*(الجدول|الشكل)/.test(t.raw);
        const ltr = isLtr(t.raw);
        out.push(para(inline(t.tokens), caption ? { extra: { keepNext: true }, align: AlignmentType.CENTER } : { ltr, align: ltr ? AlignmentType.BOTH : undefined }));
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
  const mm = path.join(base, "mermaid.json");
  fs.writeFileSync(mm, JSON.stringify({ theme: "neutral", themeVariables: { fontFamily: "Arial" } }));
  execFileSync(process.execPath, [path.join(NODE_MODULES, "@mermaid-js/mermaid-cli/src/cli.js"), "-i", inF, "-o", outF, "-p", cfg, "-c", mm, "-b", "white", "-s", "2", "-w", "1100"], { stdio: "pipe" });
  const png = fs.readFileSync(outF);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const maxW = 600, maxH = 760; // px at 96 dpi, inside the text block
  const k = Math.min(maxW / w, maxH / h, 1);
  return [new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 120, after: 200 },
    children: [new D.ImageRun({ type: "png", data: png, transformation: { width: Math.round(w * k), height: Math.round(h * k) } })],
  })];
}

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
      else if (t.type === "link") r.push(...walk(t.tokens, f));
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

const cover = [
  center("[يكتبه الطالب] الجامعة · الكلية · القسم", 26, { after: 1600 }),
  center(`مشروع تخرّج لنيل شهادة ${CFG.degree || "[يكتبه الطالب]"}`, 26, { after: 700 }),
  center(TITLE, 72, { bold: true, color: ACCENT, after: 200 }),
  ...(SUBTITLE ? [center(SUBTITLE, 30, { after: 1400 })] : [new Paragraph({ spacing: { after: 1400 } })]),
  center("إعداد الطالب: [يكتبه الطالب]", 26),
  center("إشراف: [يكتبه الطالب]", 26, { after: 1400 }),
  center(`السنة الجامعية ${CFG.year || "[يكتبه الطالب]"}`, 24),
  new Paragraph({ children: [new PageBreak()] }),
  new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: true, children: [run("الإهداء", { rtl: true })] }),
  para(textRuns("[يكتبه الطالب]", {})),
  new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: true, pageBreakBefore: true, children: [run("شكر وتقدير", { rtl: true })] }),
  para(textRuns("[يكتبه الطالب]", {})),
  new Paragraph({ heading: HeadingLevel.HEADING_1, bidirectional: true, pageBreakBefore: true, children: [run("فهرس المحتويات", { rtl: true })] }),
  new TableOfContents("فهرس المحتويات", { hyperlink: true, headingStyleRange: "1-3" }),
  para(textRuns("(إن لم يظهر الفهرس: انقر عليه بالزر الأيمن ← تحديث الحقل ← تحديث الجدول بأكمله)", { size: 18, color: "777777" })),
  new Paragraph({ children: [new PageBreak()] }),
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
for (const f of FILES) problems.push(...checkTables(f, fs.readFileSync(path.join(dir, f), "utf8")));
if (problems.length) {
  console.error("Tables with a wrong number of cells:\n  " + problems.join("\n  "));
  process.exit(1);
}

// ---------- body ----------
const body = [];
const ctx = { first: true };
for (const f of FILES) {
  let md = fs.readFileSync(path.join(dir, f), "utf8");
  // the French résumé is a placeholder section: keep it
  body.push(...blocks(marked.lexer(md), ctx));
}

const heading = (size, before, after, color = ACCENT) => ({
  run: { font: FONT, size, bold: true, color },
  paragraph: { spacing: { before, after }, keepNext: true, keepLines: true },
});

const doc = new Document({
  creator: "report", title: `${TITLE}: تقرير مشروع التخرج`,
  features: { updateFields: true },
  styles: {
    default: {
      document: { run: { font: FONT, size: BODY } },
      heading1: heading(36, 0, 280),
      heading2: heading(30, 320, 160),
      heading3: heading(26, 240, 120, "2F5A86"),
      heading4: heading(24, 200, 100, "2F5A86"),
    },
    paragraphStyles: [1, 2, 3].map((l) => ({ id: `TOC${l}`, name: `toc ${l}`, basedOn: "Normal", run: { font: FONT, size: l === 1 ? 24 : 22, bold: l === 1, rightToLeft: true }, paragraph: { bidirectional: true, indent: { right: (l - 1) * 360 }, spacing: { after: 60 } } })),
  },
  numbering: {
    config: [
      { reference: "bullet", levels: [0, 1, 2].map((level) => ({ level, format: LevelFormat.BULLET, text: ["●", "○", "▪"][level], alignment: AlignmentType.START, style: { paragraph: { indent: { right: 540 + level * 360, hanging: 300 } }, run: { font: FONT, size: 16 } } })) },
      { reference: "num", levels: [0, 1, 2].map((level) => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level], text: `%${level + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { right: 540 + level * 360, hanging: 360 } } } })) },
    ],
  },
  sections: [
    {
      properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } }, titlePage: true, rightToLeft: true },
      headers: {
        default: new Header({ children: [new Paragraph({ bidirectional: true, alignment: AlignmentType.START, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "B7C3D0", space: 4 } }, children: [run(HEADER, { size: 18, color: "6B7785", rtl: true })] })] }),
        first: new Header({ children: [new Paragraph({ children: [] })] }),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 })] })] }),
        first: new Footer({ children: [new Paragraph({ children: [] })] }),
      },
      children: [...cover, ...body],
    },
  ],
});

Packer.toBuffer(doc).then((b) => { fs.writeFileSync(out, b); console.log("wrote", out, b.length); });
