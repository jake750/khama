//! تحليل المواضيع: يقرأ كلام الملف نصًا، ويقسّمه إلى مواضيع بأوقاتها، ويكشف الصمت
//! لتعرض الواجهة مدة كل موضوع قبل حذف الصمت وبعده، وأيّها يصلح ريلًا.
//!
//! النص، بالترتيب:
//!   1. ملف ترجمة بجانب الملف بنفس الاسم (.srt / .vtt، مثل «اسم.ar.srt»)
//!   2. ترجمة نصية داخل الملف
//!   3. ترجمة الموقع الذي نُزّل منه (يدوية، وإلا التلقائية بلغة الفيديو) عبر yt-dlp
//!   4. تفريغ الكلام بـ whisper.cpp (نموذج small، ~200MB تُنزَّل مرة واحدة ويُفحص بصمتها).
//!      متاح على Windows وLinux؛ على macOS وأندرويد يلزم ملف ترجمة.
//!
//! التقسيم بلا نموذج ولا إنترنت (TextTiling): نقسم الوقت إلى قطع من 10 ثوانٍ، ونقيس تشابه
//! الكلمات بين نصف دقيقة قبل كل حدّ ونصف دقيقة بعده. حيث يهبط التشابه بعمق (تغيّرت المفردات)
//! يبدأ موضوع جديد، عند أطول وقفة قريبة. عنوان الموضوع أكثر كلماته تميّزًا عن باقي الملف.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use super::*;
use crate::srt::{self, Cue};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub start: f64,
    pub end: f64,
    /// أكثر الكلمات تميّزًا (2–3) مفصولة بـ « · »
    pub title: String,
    /// أول الكلام (حتى ~160 حرفًا)
    pub text: String,
}

// ======================= النص =======================

const ARTICLES: &[&str] = &["وال", "بال", "كال", "فال", "لل", "ال"];

const STOP_EN: &str = "the a an and or but if then so of to in on at by for with from as is are was were be been being am \
    it its this that these those there here i you he she we they me him her us them my your his our their what which who whom \
    whose when where why how all any both each few more most other some such no nor not only own same than too very can will \
    just don should now do does did done have has had having would could also into about over after before again out up down \
    off just like yeah okay oh um uh really thing things gonna know think going get got one two well right lot kind sort mean \
    say said see way let make made want because even much many still back actually something people time";

const STOP_AR: &str = "في من على إلى الى عن مع هذا هذه ذلك تلك هذي هاذا هاد هادا التي الذي الذين اللي اللى هو هي هم هن انا أنا \
    انت أنت نحن انتم أنتم كان كانت يكون تكون كانوا يعني بس لكن ولكن لان لأن عشان علشان كل بعض اي أي ايش إيش شو وش ماذا لماذا \
    كيف متى اين أين هل لا لم لن ما ماهو مش مو ليس قد لقد ثم او أو اذا إذا لو حتى عند عندي عنده بين فيه فيها منه منها عليه \
    عليها له لها لهم لي به بها انه أنه انها أنها ان إن أن يا ايه إيه طيب يعني كذا كده هيك هنا هناك الان الآن جدا جداً اكثر \
    أكثر شي شيء حاجة واحد نفس غير مثل زي برضو كمان ايضا أيضا قال قالت يقول تقول احنا إحنا اللي ولا وما وهو وهي وفي     بعدين واللي مثلا مثلاً ابغى أبغى ابي أبي ابغا امم ممم اه آه ايوه إي يعني طب خلاص عارف شوف تعرف تشوف     كمان برضه برده لما لمن حنا راح رح ممكن لازم صار يصير اشي شيء عشان علشان كلش وايد مره مرة كثير";

fn stopwords() -> &'static HashSet<String> {
    static SET: OnceLock<HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| {
        STOP_EN
            .split_whitespace()
            .chain(STOP_AR.split_whitespace())
            .map(normalize_word)
            .collect()
    })
}

/// حروف صغيرة، بلا تشكيل ولا تطويل، والألف والياء والتاء المربوطة بشكل واحد
fn normalize_word(w: &str) -> String {
    w.chars()
        .filter(|c| !matches!(c, '\u{064B}'..='\u{065F}' | '\u{0670}' | '\u{0640}'))
        .map(|c| match c {
            'أ' | 'إ' | 'آ' | 'ٱ' => 'ا',
            'ى' => 'ي',
            'ة' => 'ه',
            _ => c,
        })
        .flat_map(char::to_lowercase)
        .collect()
}

/// كلمات النص المهمة: (الشكل الموحّد للمقارنة، الكلمة كما كُتبت للعنوان)
pub fn keywords(text: &str) -> Vec<(String, String)> {
    let stop = stopwords();
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .filter_map(|surface| {
            let mut n = normalize_word(surface);
            if stop.contains(&n) {
                return None;
            }
            for a in ARTICLES {
                if let Some(rest) = n.strip_prefix(a)
                    && rest.chars().count() >= 3
                {
                    n = rest.to_string();
                    break;
                }
            }
            // جمع إنجليزي بسيط: topics = topic
            if n.is_ascii() && n.len() > 3 && n.ends_with('s') && !n.ends_with("ss") {
                n.pop();
            }
            // آآآ، ممم: حرف واحد مكرر
            let distinct = n.chars().collect::<HashSet<_>>().len();
            (n.chars().count() >= 3 && distinct > 1 && !n.chars().all(|c| c.is_numeric()) && !stop.contains(&n))
                .then(|| (n, surface.to_string()))
        })
        .collect()
}

/// ينظّف الجمل: بلا وسوم HTML/VTT، وبلا التكرار المتدحرج في ترجمة يوتيوب التلقائية
/// (كل جملة فيها السطر السابق ثم الجديد)، فيبقى كل سطر مرة واحدة بوقته.
pub fn clean_cues(cues: Vec<Cue>) -> Vec<Cue> {
    let mut out: Vec<Cue> = Vec::new();
    let mut recent: Vec<String> = Vec::new();
    for c in cues {
        let mut text = String::new();
        let mut in_tag = false;
        for ch in c.text.chars() {
            match ch {
                '<' => in_tag = true,
                '>' if in_tag => in_tag = false,
                _ if !in_tag => text.push(ch),
                _ => {}
            }
        }
        let text = text
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&nbsp;", " ")
            .replace(">>", " ");
        // [موسيقى] [Music] (تصفيق) داخل السطر
        let mut plain = String::new();
        let mut depth = 0;
        for ch in text.chars() {
            match ch {
                '[' => depth += 1,
                ']' if depth > 0 => depth -= 1,
                _ if depth == 0 => plain.push(ch),
                _ => {}
            }
        }
        let text = plain;
        for line in text.lines() {
            let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
            if line.is_empty() || recent.contains(&line) {
                continue;
            }
            recent.push(line.clone());
            if recent.len() > 3 {
                recent.remove(0);
            }
            out.push(Cue {
                start: c.start,
                end: c.end.max(c.start),
                text: line,
            });
        }
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

// ======================= التقسيم =======================

pub struct SegParams {
    /// طول القطعة (ث)
    pub block: f64,
    /// كم قطعة في كل جهة عند المقارنة
    pub window: usize,
    /// أقصر موضوع (ث)
    pub min_len: f64,
}

impl Default for SegParams {
    fn default() -> Self {
        Self {
            block: 10.0,
            window: 3,
            min_len: 25.0,
        }
    }
}

type Bag = HashMap<String, f64>;

fn cosine(a: &Bag, b: &Bag) -> f64 {
    let dot: f64 = a.iter().filter_map(|(k, v)| b.get(k).map(|w| v * w)).sum();
    let na: f64 = a.values().map(|v| v * v).sum::<f64>().sqrt();
    let nb: f64 = b.values().map(|v| v * v).sum::<f64>().sqrt();
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
}

/// يقسّم الجمل إلى مواضيع متتالية (أرقام الجمل: [من، إلى))
pub fn boundaries(cues: &[Cue], p: &SegParams) -> Vec<(usize, usize)> {
    let n = cues.len();
    if n == 0 {
        return vec![];
    }
    let t0 = cues[0].start;
    let t1 = cues.iter().map(|c| c.end).fold(t0, f64::max);
    let nblocks = ((t1 - t0) / p.block).ceil().max(1.0) as usize;
    if t1 - t0 < p.min_len * 2.0 || nblocks < 2 * p.window {
        return vec![(0, n)];
    }
    let mut blocks: Vec<Bag> = vec![Bag::new(); nblocks];
    for c in cues {
        let mid = (c.start + c.end) / 2.0;
        let b = (((mid - t0) / p.block) as usize).min(nblocks - 1);
        for (k, _) in keywords(&c.text) {
            *blocks[b].entry(k).or_default() += 1.0;
        }
    }
    let sum = |r: std::ops::Range<usize>| {
        let mut bag = Bag::new();
        for b in &blocks[r] {
            for (k, v) in b {
                *bag.entry(k.clone()).or_default() += v;
            }
        }
        bag
    };
    // التشابه عند كل حد بين قطعتين (الحد g بين القطعة g-1 والقطعة g)
    let raw: Vec<f64> = (1..nblocks)
        .map(|g| cosine(&sum(g.saturating_sub(p.window)..g), &sum(g..(g + p.window).min(nblocks))))
        .collect();
    // تنعيم بسيط
    let sims: Vec<f64> = (0..raw.len())
        .map(|i| {
            let lo = i.saturating_sub(1);
            let hi = (i + 2).min(raw.len());
            raw[lo..hi].iter().sum::<f64>() / (hi - lo) as f64
        })
        .collect();
    // العمق: كم يرتفع التشابه على الجانبين قبل أن يهبط
    let depth: Vec<f64> = (0..sims.len())
        .map(|i| {
            let mut l = sims[i];
            for j in (0..i).rev() {
                if sims[j] < l {
                    break;
                }
                l = sims[j];
            }
            let mut r = sims[i];
            for &s in &sims[i + 1..] {
                if s < r {
                    break;
                }
                r = s;
            }
            (l - sims[i]) + (r - sims[i])
        })
        .collect();
    let mean = depth.iter().sum::<f64>() / depth.len() as f64;
    let sd = (depth.iter().map(|d| (d - mean).powi(2)).sum::<f64>() / depth.len() as f64).sqrt();
    let cutoff = (mean + sd * 0.25).max(0.05);
    let mut cand: Vec<(usize, f64)> = depth
        .iter()
        .enumerate()
        .filter(|(i, d)| **d > cutoff && (*i == 0 || sims[*i] <= sims[*i - 1]) && (*i + 1 == sims.len() || sims[*i] <= sims[*i + 1]))
        .map(|(i, d)| (i, *d))
        .collect();
    cand.sort_by(|a, b| b.1.total_cmp(&a.1));

    // الحدّ ينتقل إلى أطول وقفة بين جملتين قريبًا منه (±6 ث)
    let snap = |t: f64| -> Option<usize> {
        (1..n).filter(|&j| (cues[j].start - t).abs() <= 6.0).max_by(|&a, &b| {
            let ga = cues[a].start - cues[a - 1].end;
            let gb = cues[b].start - cues[b - 1].end;
            ga.total_cmp(&gb)
                .then((cues[b].start - t).abs().total_cmp(&(cues[a].start - t).abs()))
        })
    };
    let mut cuts: Vec<usize> = Vec::new();
    for (g, _) in cand {
        let t = t0 + (g + 1) as f64 * p.block;
        let Some(j) = snap(t) else { continue };
        let at = cues[j].start;
        let far = |x: f64| (x - at).abs() >= p.min_len;
        if far(t0) && far(t1) && cuts.iter().all(|&c| far(cues[c].start)) {
            cuts.push(j);
        }
    }
    cuts.sort_unstable();
    let mut out = Vec::new();
    let mut from = 0;
    for c in cuts {
        out.push((from, c));
        from = c;
    }
    out.push((from, n));
    out
}

/// المواضيع بعناوينها: أكثر الكلمات تكرارًا في الموضوع وأقلها في غيره
pub fn topics_from(cues: &[Cue], p: &SegParams) -> Vec<Topic> {
    let ranges = boundaries(cues, p);
    // لكل موضوع: تكرار كل كلمة، وأشكالها كما كُتبت
    type Forms = HashMap<String, HashMap<String, usize>>;
    let bags: Vec<(Bag, Forms)> = ranges
        .iter()
        .map(|&(a, b)| {
            let mut tf: HashMap<String, f64> = HashMap::new();
            let mut forms: HashMap<String, HashMap<String, usize>> = HashMap::new();
            for c in &cues[a..b] {
                for (k, s) in keywords(&c.text) {
                    *tf.entry(k.clone()).or_default() += 1.0;
                    *forms.entry(k).or_default().entry(s).or_default() += 1;
                }
            }
            (tf, forms)
        })
        .collect();
    let nt = ranges.len() as f64;
    let mut df: HashMap<&str, f64> = HashMap::new();
    for (tf, _) in &bags {
        for k in tf.keys() {
            *df.entry(k.as_str()).or_default() += 1.0;
        }
    }
    ranges
        .iter()
        .zip(&bags)
        .map(|(&(a, b), (tf, forms))| {
            let mut scored: Vec<(&String, f64)> = tf
                .iter()
                .map(|(k, v)| (k, v * (1.0 + (nt / df[k.as_str()]).ln()) + if *v >= 2.0 { 0.5 } else { 0.0 }))
                .collect();
            scored.sort_by(|x, y| y.1.total_cmp(&x.1).then(x.0.cmp(y.0)));
            let title = scored
                .iter()
                .take(3)
                .filter_map(|(k, _)| {
                    forms[*k]
                        .iter()
                        .max_by(|x, y| x.1.cmp(y.1).then(y.0.cmp(x.0)))
                        .map(|(s, _)| s.clone())
                })
                .collect::<Vec<_>>()
                .join(" · ");
            let mut text = String::new();
            for c in &cues[a..b] {
                if text.chars().count() > 160 {
                    break;
                }
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(&c.text);
            }
            if text.chars().count() > 160 {
                let cut: String = text.chars().take(160).collect();
                text = format!("{}…", cut.rsplit_once(' ').map_or(cut.as_str(), |(h, _)| h));
            }
            Topic {
                start: cues[a].start,
                end: cues[a..b].iter().map(|c| c.end).fold(cues[a].start, f64::max),
                title,
                text,
            }
        })
        .collect()
}

// ======================= مصادر النص =======================

/// ملف ترجمة بجانب الملف: «اسم.srt» أو «اسم.ar.vtt»…
fn sidecar(input: &Path) -> Option<PathBuf> {
    let dir = input.parent()?;
    let stem = input.file_stem()?.to_string_lossy().to_lowercase();
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
            (name.ends_with(".srt") || name.ends_with(".vtt"))
                && (name.strip_suffix(".srt").or(name.strip_suffix(".vtt")) == Some(stem.as_str()) || name.starts_with(&format!("{stem}.")))
        })
        .collect();
    found.sort();
    found.into_iter().next()
}

fn read_subs(path: &Path) -> Vec<Cue> {
    std::fs::read(path)
        .map(|b| clean_cues(srt::parse(&String::from_utf8_lossy(&b))))
        .unwrap_or_default()
}

/// أي ترجمة من الموقع نأخذ؟ اليدوية بلغة الفيديو، ثم التلقائية الأصلية، ثم أي يدوية
pub fn pick_caption(info: &Value) -> Option<(String, bool)> {
    let keys = |field: &str| -> Vec<String> {
        let mut k: Vec<String> = info[field]
            .as_object()
            .map(|m| m.keys().filter(|k| *k != "live_chat").cloned().collect())
            .unwrap_or_default();
        k.sort();
        k
    };
    let manual = keys("subtitles");
    let auto = keys("automatic_captions");
    let lang = info["language"].as_str().unwrap_or("");
    // "en-US" يطابق "en" و"en-US" و"en-GB"…
    let primary = lang.split('-').next().unwrap_or("");
    let matches = |k: &str| !primary.is_empty() && (k == lang || k == primary || k.starts_with(&format!("{primary}-")));
    if let Some(k) = manual.iter().find(|k| matches(k)) {
        return Some((k.clone(), false));
    }
    if let Some(k) = auto.iter().find(|k| k.ends_with("-orig")) {
        return Some((k.clone(), true));
    }
    if let Some(k) = auto.iter().find(|k| !lang.is_empty() && *k == lang) {
        return Some((k.clone(), true));
    }
    manual.first().map(|k| (k.clone(), false))
}

async fn site_captions(tools: &Tools, url: &str, work: &Path) -> Option<Vec<Cue>> {
    let (ok, out, _) = tools::run_ytdlp(tools, &["-J", "--skip-download", "--no-playlist", url])
        .await
        .ok()?;
    if !ok {
        return None;
    }
    let info: Value = serde_json::from_str(out.lines().last()?).ok()?;
    let (key, auto) = pick_caption(&info)?;
    let tmpl = work.join("cap.%(ext)s").to_string_lossy().into_owned();
    let (ok, _, err) = tools::run_ytdlp(
        tools,
        &[
            "--skip-download",
            "--no-playlist",
            if auto { "--write-auto-subs" } else { "--write-subs" },
            "--sub-langs",
            &key,
            "--sub-format",
            "vtt/srt/best",
            "--convert-subs",
            "srt",
            "-o",
            &tmpl,
            url,
        ],
    )
    .await
    .ok()?;
    if !ok {
        log::warn!("captions: {}", tail(&err, 3));
        return None;
    }
    let file = std::fs::read_dir(work).ok()?.filter_map(|e| e.ok().map(|e| e.path())).find(|p| {
        p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("cap.")) && p.extension().is_some_and(|e| e == "srt" || e == "vtt")
    })?;
    Some(read_subs(&file)).filter(|c| !c.is_empty())
}

// ======================= تفريغ الكلام (whisper.cpp) =======================

// لا يُبنى على macOS وأندرويد (لا نسخة جاهزة من whisper.cpp لهما)
#[allow(dead_code)]
struct Archive {
    url: &'static str,
    sha256: &'static str,
    size: u64,
    /// المجلد الأعلى داخل الأرشيف
    top: &'static str,
}

const WHISPER_BASE: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/b5907/";

#[cfg(all(windows, target_arch = "x86_64"))]
const WHISPER: Option<Archive> = Some(Archive {
    url: "whisper-bin-x64.zip",
    sha256: "ecca07b277d943e9b9f4712856a144b857271a6b333104e511e1988e80db582b",
    size: 9_168_428,
    top: "Release",
});
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const WHISPER: Option<Archive> = Some(Archive {
    url: "whisper-bin-ubuntu-x64.tar.gz",
    sha256: "a6199027fe5b4239c84171d2bca4c0ff44ec86a515494d5a39b237b212d429bd",
    size: 10_413_708,
    top: "whisper-bin-ubuntu-x64",
});
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const WHISPER: Option<Archive> = Some(Archive {
    url: "whisper-bin-ubuntu-arm64.tar.gz",
    sha256: "da2e86ac058e1db0281167355428665b82c0d92e4506d186a3894bec55ceefef",
    size: 4_623_550,
    top: "whisper-bin-ubuntu-arm64",
});
#[cfg(not(any(
    all(windows, target_arch = "x86_64"),
    all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))
)))]
const WHISPER: Option<Archive> = None;

/// نموذج small المضغوط (q5_1): أدق بكثير من base في العربية، ويعمل على المعالج بسرعة مقبولة
const WHISPER_MODEL: (&str, &str, u64) = (
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
    "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    190_085_487,
);
const MODEL_NAME: &str = "ggml-small-q5_1.bin";

static SETUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// ينزّل whisper.cpp والنموذج مرة واحدة (مع فحص البصمة). يعيد (البرنامج، النموذج)، أو None إن أُلغي
async fn ensure_whisper(c: &Ctx<'_>, cancel: &mut watch::Receiver<bool>) -> Result<Option<(PathBuf, PathBuf)>, AppError> {
    let arch = WHISPER.ok_or_else(|| AppError::new("transcribeUnsupported"))?;
    let _guard = SETUP.lock().await;
    let dir = separate::ai_dir(c.app)?;
    std::fs::create_dir_all(&dir)?;
    let bin_dir = dir.join("whisper");
    let cli = bin_dir.join(format!("whisper-cli{}", tools::EXE));
    let model = dir.join(MODEL_NAME);
    let ok_file = |p: &Path| p.with_extension(format!("{}.ok", p.extension().map(|e| e.to_string_lossy()).unwrap_or_default()));
    let bin_ok = cli.exists() && std::fs::read_to_string(bin_dir.join(".ok")).is_ok_and(|s| s.trim() == arch.sha256);
    let model_ok = std::fs::metadata(&model).is_ok_and(|m| m.len() == WHISPER_MODEL.2)
        && std::fs::read_to_string(ok_file(&model)).is_ok_and(|s| s.trim() == WHISPER_MODEL.1);
    if bin_ok && model_ok {
        return Ok(Some((cli, model)));
    }
    let total = (if bin_ok { 0 } else { arch.size }) + (if model_ok { 0 } else { WHISPER_MODEL.2 });
    let mut base = 0u64;
    let mut last = Instant::now() - Duration::from_secs(1);
    let jobs: [(String, &str, u64, bool); 2] = [
        (format!("{WHISPER_BASE}{}", arch.url), arch.sha256, arch.size, !bin_ok),
        (WHISPER_MODEL.0.to_string(), WHISPER_MODEL.1, WHISPER_MODEL.2, !model_ok),
    ];
    for (i, (url, sha, size, needed)) in jobs.into_iter().enumerate() {
        if !needed {
            continue;
        }
        let tmp = dir.join(if i == 0 { "whisper.download" } else { "whisper-model.download" });
        let b0 = base;
        let mut on_bytes = |b: u64| {
            if last.elapsed() >= Duration::from_millis(250) {
                last = Instant::now();
                emit(
                    c.app,
                    JobUpdate {
                        id: c.id,
                        state: "preparing",
                        percent: Some(((b0 + b) as f64 / total as f64 * 100.0).min(100.0)),
                        ..Default::default()
                    },
                );
            }
        };
        if !separate::fetch(c.app, &url, &tmp, &mut on_bytes, cancel).await? {
            return Ok(None);
        }
        let hash = separate::sha256_file(&tmp)?;
        if hash != sha {
            let _ = std::fs::remove_file(&tmp);
            return Err(AppError::with_detail("aiChecksum", format!("{url}: {hash}")));
        }
        if i == 0 {
            let unpack = dir.join("whisper-unpack");
            let _ = std::fs::remove_dir_all(&unpack);
            std::fs::create_dir_all(&unpack)?;
            let out = tools::command(&separate::tar())
                .arg("-xf")
                .arg(&tmp)
                .arg("-C")
                .arg(&unpack)
                .output()
                .await
                .map_err(|e| AppError::with_detail("aiDownload", format!("tar: {e}")))?;
            if !out.status.success() {
                return Err(AppError::with_detail(
                    "aiDownload",
                    String::from_utf8_lossy(&out.stderr).into_owned(),
                ));
            }
            let _ = std::fs::remove_dir_all(&bin_dir);
            std::fs::rename(unpack.join(arch.top), &bin_dir)?;
            let _ = std::fs::remove_dir_all(&unpack);
            let _ = std::fs::remove_file(&tmp);
            std::fs::write(bin_dir.join(".ok"), sha)?;
        } else {
            let _ = std::fs::remove_file(&model);
            std::fs::rename(&tmp, &model)?;
            std::fs::write(ok_file(&model), sha)?;
        }
        base += size;
    }
    Ok(Some((cli, model)))
}

/// "[00:01:02.500 --> 00:01:05.000]  نص" ← 65.0 (نهاية الجملة، للتقدّم)
fn whisper_line_end(line: &str) -> Option<f64> {
    let inner = line.trim_start().strip_prefix('[')?.split(']').next()?;
    let (_, b) = inner.split_once("-->")?;
    let p: Vec<f64> = b.trim().split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    match p[..] {
        [h, m, s] => Some(h * 3600.0 + m * 60.0 + s),
        [m, s] => Some(m * 60.0 + s),
        _ => None,
    }
}

async fn transcribe(
    c: &Ctx<'_>,
    info: &MediaInfo,
    o: &ConvertOptions,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<Vec<Cue>>, AppError> {
    let Some((cli, model)) = ensure_whisper(c, cancel).await? else {
        return Ok(None);
    };
    let start = o.start.filter(|v| *v > 0.0).unwrap_or(0.0);
    let dur = o.end.or(info.duration).unwrap_or(0.0) - start;
    // صوت 16kHz أحادي كما يحتاجه whisper
    let wav = c.work.join("speech.wav");
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y"].iter().map(|s| s.to_string()).collect();
    if start > 0.0 {
        a.extend(["-ss".into(), format!("{start:.3}")]);
    }
    if let Some(e) = o.end {
        a.extend(["-to".into(), format!("{e:.3}")]);
    }
    a.extend(["-i".into(), info.path.clone()]);
    a.extend(
        [
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-progress",
            "pipe:1",
            "-nostats",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    a.push(wav.to_string_lossy().into_owned());
    if run_ffmpeg(c.app, c.id, c.tools, &a, c.work, dur, "analyzing", cancel)
        .await?
        .is_none()
    {
        return Ok(None);
    }
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);
    let out_base = c.work.join("speech");
    let mut cmd = tools::command(&cli);
    cmd.arg("-m")
        .arg(&model)
        .arg("-f")
        .arg(&wav)
        .args(["-l", "auto", "-t", &threads.to_string(), "-osrt", "-of"])
        .arg(&out_base);
    if let Some(d) = cli.parent() {
        cmd.current_dir(d);
        #[cfg(target_os = "linux")]
        cmd.env("LD_LIBRARY_PATH", d);
    }
    let began = Instant::now();
    let mut last = Instant::now() - Duration::from_secs(1);
    emit(
        c.app,
        JobUpdate {
            id: c.id,
            state: "analyzing",
            percent: Some(0.0),
            ..Default::default()
        },
    );
    let outcome = run_streaming(cmd, cancel, |line| {
        if let Some(t) = whisper_line_end(line)
            && dur > 0.0
            && last.elapsed() >= Duration::from_millis(250)
        {
            last = Instant::now();
            let pct = (t / dur * 100.0).clamp(0.0, 100.0);
            emit(
                c.app,
                JobUpdate {
                    id: c.id,
                    state: "analyzing",
                    percent: Some(pct),
                    eta: separate::separation_eta(began.elapsed().as_secs_f64(), pct),
                    ..Default::default()
                },
            );
        }
    })
    .await?;
    match outcome {
        RunOutcome::Canceled => Ok(None),
        RunOutcome::Exited { success: true, .. } => {
            let mut cues = read_subs(&out_base.with_extension("srt"));
            for q in &mut cues {
                q.start += start;
                q.end += start;
            }
            Ok(Some(cues))
        }
        RunOutcome::Exited { stderr, .. } => Err(AppError::with_detail("transcribeFailed", tail(&stderr, 8))),
    }
}

// ======================= التشغيل =======================

pub(super) struct TopicsResult {
    pub silences: Vec<[f64; 2]>,
    pub topics: Vec<Topic>,
    pub source: &'static str,
}

pub(super) async fn run_topics(
    c: &Ctx<'_>,
    info: &MediaInfo,
    o: &ConvertOptions,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<TopicsResult>, AppError> {
    if info.audio.is_empty() {
        return Err(AppError::new("noAudioStream"));
    }
    let input = Path::new(&info.path);
    let lo = o.start.filter(|v| *v > 0.0).unwrap_or(0.0);
    let hi = o.end.filter(|e| *e > lo).unwrap_or(f64::INFINITY);

    // 1–3: ترجمة جاهزة
    let mut source = "subtitles";
    let mut cues = sidecar(input).map(|p| read_subs(&p)).unwrap_or_default();
    if cues.is_empty() && info.subtitles > 0 {
        let out = c.work.join("embedded.srt");
        let a = ["-hide_banner", "-nostdin", "-y", "-i", &info.path, "-map", "0:s:0", "-f", "srt"];
        let mut cmd = tools::command(&c.tools.ffmpeg);
        cmd.args(a).arg(&out);
        if cmd.output().await.is_ok_and(|r| r.status.success()) {
            cues = read_subs(&out);
        }
    }
    if cues.is_empty()
        && let Some(url) = o.source_url.as_deref().filter(|u| u.starts_with("http"))
    {
        emit(
            c.app,
            JobUpdate {
                id: c.id,
                state: "analyzing",
                ..Default::default()
            },
        );
        if let Some(found) = site_captions(c.tools, url, c.work).await {
            cues = found;
            source = "captions";
        }
    }
    cues.retain(|q| q.end > lo && q.start < hi);
    // 4: تفريغ الكلام
    if cues.is_empty() {
        source = "speech";
        match transcribe(c, info, o, cancel).await? {
            Some(found) => cues = found,
            None => return Ok(None),
        }
    }
    if cues.is_empty() {
        return Err(AppError::new("noSpeech"));
    }

    // الصمت، لمدة كل موضوع بعد حذفه
    let dur = o.end.unwrap_or(info.duration.unwrap_or(0.0)) - lo;
    let args = detect_args("detect_silence", &info.path, o);
    let Some(log) = run_ffmpeg(c.app, c.id, c.tools, &args, c.work, dur, "analyzing", cancel).await? else {
        return Ok(None);
    };
    let silences = parse_markers("detect_silence", &log);

    let mut topics = topics_from(&cues, &SegParams::default());
    let end_max = info.duration.unwrap_or(f64::INFINITY).min(hi);
    for t in &mut topics {
        t.start = t.start.max(lo);
        t.end = t.end.min(end_max);
    }
    Ok(Some(TopicsResult { silences, topics, source }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(start: f64, end: f64, text: &str) -> Cue {
        Cue {
            start,
            end,
            text: text.into(),
        }
    }

    #[test]
    fn arabic_words_are_normalized() {
        let k: Vec<String> = keywords("والمَدرسةُ في المدرسة، إلى الأطفال!").into_iter().map(|(n, _)| n).collect();
        assert_eq!(k, vec!["مدرسه", "مدرسه", "اطفال"]);
        let k: Vec<String> = keywords("The cats and the Topics of 2024").into_iter().map(|(n, _)| n).collect();
        assert_eq!(k, vec!["cat", "topic"]);
    }

    #[test]
    fn youtube_rolling_captions_are_deduplicated() {
        let raw = vec![
            cue(0.0, 2.0, "hello <c>world</c>"),
            cue(2.0, 2.01, "hello world"),
            cue(2.0, 4.0, "hello world\nhow are <00:00:03.000><c>you</c>"),
            cue(4.0, 6.0, "how are you\n[Music]"),
        ];
        let out = clean_cues(raw);
        let texts: Vec<&str> = out.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts, vec!["hello world", "how are you"]);
        assert_eq!(out[1].start, 2.0);
    }

    /// ثلاثة مواضيع بمفردات مختلفة (دقيقة لكل واحد) ← ثلاثة مواضيع بحدود قريبة من الحقيقة
    #[test]
    fn splits_where_vocabulary_changes() {
        let subjects = [
            "coffee beans roast grinder espresso brewing",
            "football match goal striker referee stadium",
            "python code compiler function variable debugging",
        ];
        let mut cues = Vec::new();
        for (i, s) in subjects.iter().enumerate() {
            let words: Vec<&str> = s.split(' ').collect();
            for j in 0..15 {
                let t = i as f64 * 60.0 + j as f64 * 4.0;
                // وقفة أطول قبل أول جملة في كل موضوع
                let t = if j == 0 && i > 0 { t + 0.8 } else { t };
                cues.push(cue(
                    t,
                    t + 3.0,
                    &format!("{} {} {}", words[j % 6], words[(j + 1) % 6], words[(j + 3) % 6]),
                ));
            }
        }
        let topics = topics_from(&cues, &SegParams::default());
        assert_eq!(topics.len(), 3, "{topics:?}");
        assert!(
            (topics[1].start - 60.8).abs() < 0.01 && (topics[2].start - 120.8).abs() < 0.01,
            "{topics:?}"
        );
        let from = |i: usize, w: &str| topics[i].title.split(" · ").all(|k| subjects[i].contains(k)) && topics[i].title.contains(w);
        assert!(from(0, "") && from(1, "") && from(2, ""), "{topics:?}");
    }

    #[test]
    fn short_talk_is_one_topic() {
        let cues = vec![cue(0.0, 5.0, "a short intro"), cue(5.0, 20.0, "and the end")];
        let t = topics_from(&cues, &SegParams::default());
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].start, t[0].end), (0.0, 20.0));
    }

    #[test]
    fn picks_the_right_site_caption() {
        let j: Value = serde_json::json!({
            "language": "ar",
            "subtitles": {"en": [], "live_chat": []},
            "automatic_captions": {"ar": [], "ar-orig": [], "en": []}
        });
        assert_eq!(pick_caption(&j), Some(("ar-orig".into(), true)));
        let j: Value = serde_json::json!({"language": "ar", "subtitles": {"ar-SA": []}, "automatic_captions": {"ar-orig": []}});
        assert_eq!(pick_caption(&j), Some(("ar-SA".into(), false)));
        let j: Value = serde_json::json!({"language": "en-US", "subtitles": {"en": []}, "automatic_captions": {"en-orig": []}});
        assert_eq!(pick_caption(&j), Some(("en".into(), false)));
        let j: Value = serde_json::json!({"subtitles": {}, "automatic_captions": {}});
        assert_eq!(pick_caption(&j), None);
    }

    /// تجربة يدوية على ترجمة حقيقية: KHAMA_SRT=ملف.srt cargo test print_topics -- --ignored --nocapture
    #[test]
    #[ignore]
    fn print_topics() {
        let p = std::env::var("KHAMA_SRT").unwrap();
        let cues = read_subs(Path::new(&p));
        println!("{} cues", cues.len());
        for t in topics_from(&cues, &SegParams::default()) {
            println!("{:7.1}–{:7.1} ({:5.1}s) {} | {}", t.start, t.end, t.end - t.start, t.title, t.text);
        }
    }

    #[test]
    fn whisper_progress_lines() {
        assert_eq!(whisper_line_end("[00:01:02.000 --> 00:01:05.500]   مرحبا"), Some(65.5));
        assert_eq!(whisper_line_end("whisper_init: loading"), None);
    }

    #[test]
    fn finds_sidecar_subtitles() {
        let dir = std::env::temp_dir().join(format!("khama-topics-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("حلقة 1.mp4");
        std::fs::write(&video, b"").unwrap();
        assert_eq!(sidecar(&video), None);
        std::fs::write(dir.join("حلقة 1.ar.vtt"), "WEBVTT\n\n00:01.000 --> 00:03.000\nمرحبا\n").unwrap();
        std::fs::write(dir.join("حلقة 10.srt"), "").unwrap();
        let found = sidecar(&video).unwrap();
        assert!(found.ends_with("حلقة 1.ar.vtt"));
        let cues = read_subs(&found);
        assert_eq!(cues.len(), 1);
        assert_eq!((cues[0].start, cues[0].text.as_str()), (1.0, "مرحبا"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
