// منطق الريلز: أنواع المواضيع ونقاط تقسيمها، وترجمة كل مقطع يُصدَّر بتوقيت يبدأ من صفره
// (ويُعاد حسابه بعد حذف الصمت)، وأسطر ترجمة جاهزة للمونتاج. كله حساب في الواجهة بلا Rust،
// فتغيير «ما يبقى من الصمت» أو مدة الريل لا يحتاج تحليلًا جديدًا (D14).

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** كلمة بوقتها (من ترجمة يوتيوب json3 أو whisper، أو مقدّرة من طول الكلمة داخل الجملة) */
export interface Word {
  w: string;
  start: number;
  end: number;
  /** true = آخر كلمة في جملتها الأصلية */
  last?: boolean;
}

export type Range = [number, number];

// ======================= الصمت =======================

/**
 * فترات الصمت التي تُحذف، مقصوصة على [start, end]. يبقى `after` بعد الكلام (أول الصمت)
 * و`before` قبل الكلام التالي (آخر الصمت).
 */
export function silenceCuts(silences: Range[], after: number, start = 0, end = Infinity, before = after): Range[] {
  return silences.map(([s, e]) => [Math.max(s + after, start), Math.min(e - before, end)] as Range).filter(([s, e]) => e - s > 0.01);
}

/** ما يبقى من [start, end] بعد حذف `cuts` (مرتبة أو لا) */
export function keptPieces(start: number, end: number, cuts: Range[]): Range[] {
  const out: Range[] = [];
  let at = start;
  for (const [s, e] of [...cuts].sort((a, b) => a[0] - b[0])) {
    if (e <= at || s >= end) continue;
    if (s > at) out.push([at, s]);
    at = Math.max(at, e);
  }
  if (end > at) out.push([at, end]);
  return out.filter(([s, e]) => e - s > 1e-6);
}

/** طول ما يبقى من [start, end] بعد الحذف */
export function keptLength(start: number, end: number, cuts: Range[]): number {
  return keptPieces(start, end, cuts).reduce((sum, [s, e]) => sum + (e - s), 0);
}

/**
 * الخط الزمني للناتج: قطع المصدر المحفوظة بالترتيب، وكل قطعة بموضعها في الناتج.
 * `sections` = المقاطع المختارة (تُوصل متتالية)، و`cuts` = ما يُحذف داخلها.
 */
export function timeline(sections: Range[], cuts: Range[]): { src: Range; at: number }[] {
  const out: { src: Range; at: number }[] = [];
  let at = 0;
  for (const [s, e] of sections) {
    for (const p of keptPieces(s, e, cuts)) {
      out.push({ src: p, at });
      at += p[1] - p[0];
    }
  }
  return out;
}

// ======================= الترجمة لكل مقطع =======================

const SENTENCE_END = /[.!?؟…۔]["»”')\]]*$/;
const CLAUSE_END = /[,،;؛:]["»”')\]]*$/;

/** كلمات الجملة بأوقات مقدّرة: مدة الجملة تُوزَّع على كلماتها بطول حروفها */
export function estimateWords(cue: Cue): Word[] {
  const parts = cue.text.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const weights = parts.map((p) => p.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const dur = Math.max(0, cue.end - cue.start);
  let t = cue.start;
  return parts.map((w, i) => {
    const d = (dur * weights[i]) / total;
    const word: Word = { w, start: t, end: t + d, last: i === parts.length - 1 };
    t += d;
    return word;
  });
}

/** أبعد مسافة تُسحب فيها بداية كلمة إلى نهاية الصمت قبلها (ث): للخلف، وللأمام */
const SNAP_BACK = 0.35;
const SNAP_FWD = 0.25;

/**
 * يصحّح الكلمات بالصمت المكتشف:
 * - النهاية: نهاية الكلمة من whisper هي بداية التالية، فلا تظهر الوقفات بينهما. كلمة يبدأ داخلها صمت تنتهي عند بدايته.
 * - البداية: الكلمة بعد وقفة تُعطى متأخرة (قيس على محاضرة: +0.06 ث من يوتيوب و+0.10 من whisper عن بدء الصوت)،
 *   فتُسحب إلى نهاية الصمت إن كانت قريبة، فيظهر أول سطر بعد الوقفة مع أول صوت. خطأ البداية بعد الوقفات
 *   نزل بذلك من 0.15–0.16 ث إلى 0.11، وتحركت 38 كلمة من 244 فقط (D17 في DECISIONS.md).
 */
export function trimToSilences(words: Word[], silences: Range[]): Word[] {
  if (!silences.length) return words;
  const out: Word[] = [];
  for (const w of words) {
    const cut = silences.find(([a]) => a > w.start + 0.05 && a < w.end);
    let start = w.start;
    const end = cut ? cut[0] : w.end;
    const prevEnd = out.length ? out[out.length - 1].end : -Infinity;
    const resume = silences.find(([, b]) => b - start >= -SNAP_BACK && b - start <= SNAP_FWD);
    if (resume && resume[1] >= prevEnd && resume[1] < end - 0.05) start = resume[1];
    out.push(start === w.start && end === w.end ? w : { ...w, start, end });
  }
  return out;
}

/** يضع كلمات المصدر على الخط الزمني للناتج. كلمة تقع كلها في جزء محذوف تسقط */
export function mapWords(words: Word[], tl: { src: Range; at: number }[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    // أول قطعة تتقاطع مع الكلمة وآخر قطعة
    const hits = tl.filter(({ src }) => w.end > src[0] && w.start < src[1]);
    if (!hits.length) continue;
    const a = hits[0];
    const b = hits[hits.length - 1];
    const start = a.at + Math.max(w.start, a.src[0]) - a.src[0];
    const end = b.at + Math.min(w.end, b.src[1]) - b.src[0];
    if (end - start < 0.01) continue;
    out.push({ ...w, start, end });
  }
  return out;
}

export interface LineOptions {
  /** أقصى عدد كلمات في السطر. فارغ = الجملة كما هي */
  maxWords?: number | null;
  /** أقصى مدة للسطر (ث). فارغ = بلا حد */
  maxSecs?: number | null;
}

/** وقفة بين كلمتين تكفي لكسر السطر */
const PAUSE = 0.35;
/** فجوة أقصر من هذه بين سطرين تُسدّ (لا ومضة فراغ بين سطرين متتاليين) */
/** أقصر فراغ مسموح بين سطرين بعد HOLD (ث): أقصر منه يومض */
const MIN_GAP = 0.12;
const SMALL_GAP = 0.3;
/** يبقى السطر بعد آخر كلمة قليلًا ليُقرأ، ما لم يبدأ التالي */
const HOLD = 0.25;

/**
 * يجمع الكلمات في أسطر: ينكسر السطر عند نهاية جملة، أو عند وقفة، أو عند فاصلة إن امتلأ نصفه،
 * أو عند بلوغ الحد. يبدأ كل سطر مع أول كلمة فيه (لا يظهر قبل أن تُنطق)، ولا يتداخل سطران،
 * والفجوة الصغيرة بينهما تُسدّ.
 */
export function wordsToLines(words: Word[], opt: LineOptions, total = Infinity): Cue[] {
  const maxWords = opt.maxWords && opt.maxWords > 0 ? opt.maxWords : Infinity;
  const maxSecs = opt.maxSecs && opt.maxSecs > 0 ? opt.maxSecs : Infinity;
  const lines: Word[][] = [];
  let cur: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // while لا if: ما يبقى بعد الكسر عند وقفة قد يبلغ الحد هو أيضًا مع الكلمة الجديدة
    while (cur.length && (cur.length >= maxWords || w.end - cur[0].start > maxSecs)) {
      // بلغ الحد: يُكسر عند أطول وقفة في نصفه الثاني إن وُجدت، لا عند الكلمة التي صادفت الحد
      let at = cur.length;
      let gap = 0.12;
      for (let k = Math.ceil(cur.length / 2); k < cur.length; k++) {
        const g = cur[k].start - cur[k - 1].end;
        if (g > gap) [at, gap] = [k, g];
      }
      lines.push(cur.slice(0, at));
      cur = cur.slice(at);
    }
    cur.push(w);
    const next = words[i + 1];
    const pause = next ? next.start - w.end >= PAUSE : true;
    const sentence = SENTENCE_END.test(w.w) || (w.last && opt.maxWords == null);
    const clause = CLAUSE_END.test(w.w) && maxWords !== Infinity && cur.length >= Math.ceil(maxWords / 2);
    if (sentence || pause || clause) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length) lines.push(cur);
  // سطر من كلمة واحدة بعد سطر ممتلئ في الجملة نفسها: تؤخذ له كلمة من السابق (أسطر متوازنة)
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    const joined = !SENTENCE_END.test(prev[prev.length - 1].w) && line[0].start - prev[prev.length - 1].end < PAUSE;
    if (line.length === 1 && prev.length >= 3 && joined && line[0].end - prev[prev.length - 1].start <= maxSecs) {
      line.unshift(prev.pop()!);
    }
  }
  const kept = lines.filter((l) => l.length);
  // يبقى السطر بعد آخر كلمة HOLD ثانية، دون أن تتجاوز مدة عرضه الحد (إلا إن كان كلامه نفسه أطول)
  const out: Cue[] = kept.map((l) => {
    const spoken = l[l.length - 1].end;
    return { start: l[0].start, end: Math.max(spoken, Math.min(spoken + HOLD, l[0].start + maxSecs)), text: l.map((w) => w.w).join(" ") };
  });
  for (let i = 0; i < out.length - 1; i++) {
    const next = out[i + 1];
    const spoken = kept[i][kept[i].length - 1].end;
    // فجوة صغيرة بين سطرين (من الكلام، أو مما يبقى بعد HOLD) تُغلق: ومضة فارغة أقصر من MIN_GAP تزعج العين.
    // الإغلاق لا يمدّ السطر فوق الحد الذي اختاره المستخدم، ولا يتداخل مع التالي
    const gap = next.start - out[i].end;
    if (next.start - spoken < SMALL_GAP || gap < MIN_GAP) {
      out[i].end = Math.max(spoken, Math.min(next.start, out[i].start + maxSecs));
    }
  }
  // لا يتجاوز آخر سطر نهاية المقطع
  return out.map((c) => ({ ...c, start: round3(c.start), end: round3(Math.min(total, Math.max(c.end, c.start + 0.05))) }));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * ترجمة مقطع يُصدَّر: الجمل الواقعة في `sections` (تُوصل متتالية) بعد حذف `cuts`، بتوقيت يبدأ من صفر الناتج.
 * بلا حدود للأسطر تبقى كل جملة سطرًا كما هي (مقصوصة على المقطع).
 */
export function exportCues(
  cues: Cue[],
  sections: Range[],
  cuts: Range[],
  opt: LineOptions = {},
  words?: Word[],
  silences: Range[] = [],
): Cue[] {
  const tl = timeline(sections, cuts);
  if (!tl.length) return [];
  const limited = !!(opt.maxWords || opt.maxSecs);
  if (!limited && !words?.length) {
    // كل جملة: من أول ما يبقى منها إلى آخره على الخط الزمني للناتج
    const out: Cue[] = [];
    for (const c of cues) {
      const hits = tl.filter(({ src }) => c.end > src[0] && c.start < src[1]);
      if (!hits.length) continue;
      const a = hits[0];
      const b = hits[hits.length - 1];
      const start = a.at + Math.max(c.start, a.src[0]) - a.src[0];
      const end = b.at + Math.min(c.end, b.src[1]) - b.src[0];
      if (end - start >= 0.05) out.push({ start: round3(start), end: round3(end), text: c.text });
    }
    return out;
  }
  // لا تبدأ كلمة قبل أن تنتهي التي قبلها (مصادر الوقت قد تتداخل قليلًا)، فلا يتداخل سطران
  const all: Word[] = [];
  for (const w of trimToSilences(words?.length ? words : cues.flatMap(estimateWords), silences)) {
    const prev = all[all.length - 1];
    if (prev && w.start < prev.end) all.push({ ...w, start: prev.end, end: Math.max(w.end, prev.end + 0.02) });
    else all.push(w);
  }
  const last = tl[tl.length - 1];
  return wordsToLines(mapWords(all, tl), limited ? opt : { maxWords: null }, last.at + last.src[1] - last.src[0]);
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join("\n");
}

// ======================= أنواع المواضيع =======================

export type TopicKind = "reel" | "split" | "no";

export interface TopicPlan {
  kind: TopicKind;
  /** أجزاء مقترحة لموضوع «يصلح بعد تقسيمه» (بثواني المصدر)، وإلا فارغة */
  parts: Range[];
  /** لموضوع «لا يصلح»: قصير، أو طويل بلا حدود نظيفة يُقسَّم عندها */
  reason?: "short" | "long";
}

// كلمات لا يبدأ بها كلام يقف وحده (يعود على ما قبله)
const CONNECTIVES = new Set(
  [
    "ثم",
    "لكن",
    "ولكن",
    "لكنه",
    "بل",
    "لأن",
    "لان",
    "لأنه",
    "لانه",
    "فلذلك",
    "ولذلك",
    "لذلك",
    "وهذا",
    "فهذا",
    "وهذه",
    "فهذه",
    "وكذلك",
    "أيضا",
    "أيضًا",
    "ايضا",
    "يعني",
    "and",
    "but",
    "so",
    "because",
    "then",
    "which",
    "also",
  ].map((w) => w.normalize("NFC")),
);

function firstWord(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? "")
    .replace(/[ً-ْـ]/g, "")
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
    .toLowerCase();
}

/** ثمن كل جزء إضافي: أكبر من أي فرق في قوة الحدود، فيفوز التقسيم الأقل أجزاءً دائمًا */
const PART_COST = 100;

/** حدود ممكنة داخل موضوع: الوقفات (منتصفها) ونهايات الجمل، مع قوتها */
export function splitPoints(start: number, end: number, cues: Cue[], silences: Range[]): { t: number; strength: number }[] {
  const pts: { t: number; strength: number }[] = [];
  const endsSentence = (t: number) => cues.some((c) => Math.abs(c.end - t) < 0.6 && SENTENCE_END.test(c.text.trim()));
  for (const [s, e] of silences) {
    const len = e - s;
    if (len < 0.3 || s <= start + 1 || e >= end - 1) continue;
    pts.push({ t: (s + e) / 2, strength: Math.min(len, 2) + (endsSentence(s) ? 1 : 0) });
  }
  for (const c of cues) {
    if (c.end <= start + 1 || c.end >= end - 1 || !SENTENCE_END.test(c.text.trim())) continue;
    if (pts.some((p) => Math.abs(p.t - c.end) < 0.8)) continue;
    pts.push({ t: c.end, strength: 0.6 });
  }
  return pts.sort((a, b) => a.t - b.t);
}

/**
 * يصنّف الموضوع: «يصلح ريلًا» إن كانت مدته (بعد حذف الصمت) في المدى، و«يصلح بعد تقسيمه» إن كان أطول
 * وأمكن تقسيمه عند وقفات أو نهايات جمل إلى أجزاء كلها في المدى ولا يبدأ أحدها بكلمة وصل، وإلا «لا يصلح».
 */
export function planTopic(start: number, end: number, cues: Cue[], silences: Range[], cuts: Range[], reel: [number, number]): TopicPlan {
  const len = keptLength(start, end, cuts);
  if (len < reel[0]) return { kind: "no", parts: [], reason: "short" };
  if (len <= reel[1]) return { kind: "reel", parts: [] };
  const pts = [{ t: start, strength: 0 }, ...splitPoints(start, end, cues, silences), { t: end, strength: 0 }];
  // يبدأ الجزء بعد الحد بكلمة وصل؟
  const dangling = (t: number) => {
    const c = cues.find((q) => q.start >= t - 0.3);
    return !!c && CONNECTIVES.has(firstWord(c.text));
  };
  // أفضل تقسيم: أقل عدد من الأجزاء أولًا (موضوع يصلح بعد تقسيمه لا يُفتَّت)، ثم أقوى الحدود،
  // وعقوبة على كل جزء يبدأ بكلمة وصل
  const best: { score: number; prev: number }[] = pts.map(() => ({ score: -Infinity, prev: -1 }));
  best[0].score = 0;
  for (let i = 1; i < pts.length; i++) {
    for (let j = 0; j < i; j++) {
      if (best[j].score === -Infinity) continue;
      const l = keptLength(pts[j].t, pts[i].t, cuts);
      if (l < reel[0] || l > reel[1]) continue;
      const score = best[j].score + pts[i].strength - (j > 0 && dangling(pts[j].t) ? 3 : 0) - PART_COST;
      if (score > best[i].score) best[i] = { score, prev: j };
    }
  }
  const last = pts.length - 1;
  if (best[last].score === -Infinity) return { kind: "no", parts: [], reason: "long" };
  const parts: Range[] = [];
  for (let i = last; i > 0; i = best[i].prev) parts.unshift([pts[best[i].prev].t, pts[i].t]);
  return { kind: "split", parts };
}
