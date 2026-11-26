//! وقت كل كلمة، لترجمة جاهزة للمونتاج (أسطر قصيرة لا تظهر قبل أن تُنطق كلماتها).
//!
//! مصدران بلا نموذج إضافي:
//!   1. ترجمة يوتيوب التلقائية بصيغة json3: لكل كلمة `tOffsetMs` من بداية حدثها.
//!   2. whisper.cpp مع DTW (`--dtw small -ojf`): وقت كل رمز من محاذاة الانتباه، كما في مهارة arabic-word-timing
//!      (يُقدَّم 80 ms لأن DTW يقع داخل أول صوت الكلمة).
//!
//! «موازنة الترجمة مع الصوت»: نص الترجمة يُحاذى على الكلمات المسموعة (مسافة تحرير على تهجئة موحّدة)،
//! والكلمات التي لم تُسمع توزَّع بين جارتيها بطولها.

use serde::Serialize;
use serde_json::Value;

use crate::srt::Cue;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Word {
    pub w: String,
    pub start: f64,
    pub end: f64,
    /// آخر كلمة في جملتها
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub last: bool,
}

/// DTW يقع داخل أول صوت الكلمة: نقدّمه قليلًا
const DTW_LEAD: f64 = 0.08;
/// أطول مدة معقولة لكلمة واحدة (ما زاد فهو وقفة بعدها)
const MAX_WORD: f64 = 1.2;

fn finish(mut words: Vec<Word>, ends: &[f64]) -> Vec<Word> {
    // نهاية كل كلمة: بداية التالية، أو نهاية جملتها، بحد أقصى معقول
    for i in 0..words.len() {
        let next = words.get(i + 1).map(|w| w.start);
        let cap = ends.get(i).copied().unwrap_or(f64::INFINITY);
        let end = next.unwrap_or(cap).min(cap).min(words[i].start + MAX_WORD);
        words[i].end = end.max(words[i].start + 0.05);
    }
    words
}

/// ترجمة يوتيوب json3: الجمل (حدث لكل سطر) وكلماتها بأوقاتها
pub fn parse_json3(text: &str) -> (Vec<Cue>, Vec<Word>) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return (Vec::new(), Vec::new());
    };
    let mut cues = Vec::new();
    let mut words = Vec::new();
    let mut ends = Vec::new();
    for ev in v["events"].as_array().into_iter().flatten() {
        let Some(segs) = ev["segs"].as_array() else { continue };
        let t0 = ev["tStartMs"].as_f64().unwrap_or(0.0) / 1000.0;
        let dur = ev["dDurationMs"].as_f64().unwrap_or(0.0) / 1000.0;
        let mut line: Vec<Word> = Vec::new();
        for s in segs {
            let raw = s["utf8"].as_str().unwrap_or("");
            let at = t0 + s["tOffsetMs"].as_f64().unwrap_or(0.0) / 1000.0;
            // «>>» علامة تغيّر المتكلم في ترجمة يوتيوب التلقائية، لا كلام
            for (k, part) in raw.split_whitespace().filter(|p| *p != ">>").enumerate() {
                // مقطع فيه أكثر من كلمة (الترجمة اليدوية): وقت واحد للمقطع، يوزَّع لاحقًا بين جارتيه
                line.push(Word {
                    w: part.to_string(),
                    start: at + k as f64 * 0.001,
                    end: at,
                    last: false,
                });
            }
        }
        if line.is_empty() {
            continue;
        }
        let end = t0 + dur;
        let text = line.iter().map(|w| w.w.as_str()).collect::<Vec<_>>().join(" ");
        cues.push(Cue { start: t0, end, text });
        if let Some(l) = line.last_mut() {
            l.last = true;
        }
        ends.extend(std::iter::repeat_n(end, line.len()));
        words.extend(line);
    }
    // أحداث يوتيوب التلقائية تتداخل (السطر يبقى حتى يظهر التالي): نهاية الجملة = بداية التالية
    for i in 0..cues.len().saturating_sub(1) {
        let next = cues[i + 1].start;
        if cues[i].end > next {
            cues[i].end = next;
        }
    }
    (cues, finish(spread_ties(words), &ends))
}

/// كلمات تشترك في الوقت نفسه (مقطع فيه عدة كلمات): توزَّع بين وقتها ووقت ما بعدها بطولها
fn spread_ties(mut words: Vec<Word>) -> Vec<Word> {
    let mut i = 0;
    while i < words.len() {
        let mut j = i + 1;
        while j < words.len() && (words[j].start - words[i].start).abs() < 0.01 {
            j += 1;
        }
        if j - i > 1 {
            let from = words[i].start;
            let to = words.get(j).map_or(from + 0.35 * (j - i) as f64, |w| w.start).max(from + 0.05);
            let total: usize = words[i..j].iter().map(|w| w.w.chars().count() + 1).sum();
            let mut t = from;
            for w in &mut words[i..j] {
                w.start = t;
                t += (to - from) * (w.w.chars().count() + 1) as f64 / total as f64;
            }
        }
        i = j;
    }
    words
}

/// مخرجات whisper-cli `-ojf` مع `--dtw`: كلمات بأوقاتها (`offset` = بداية المقطع في الملف)
pub fn parse_whisper_json(text: &str, offset: f64) -> Vec<Word> {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let mut words: Vec<Word> = Vec::new();
    let mut ends = Vec::new();
    for seg in v["transcription"].as_array().into_iter().flatten() {
        let seg_end = seg["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0 + offset;
        let before = words.len();
        for tok in seg["tokens"].as_array().into_iter().flatten() {
            let t = tok["text"].as_str().unwrap_or("");
            // رموز خاصة: [_BEG_]، [_TT_123]…
            if t.starts_with("[_") || t.is_empty() {
                continue;
            }
            let dtw = tok["t_dtw"].as_f64().filter(|v| *v >= 0.0);
            let from = tok["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
            let at = dtw.map_or(from, |d| d / 100.0 - DTW_LEAD).max(0.0) + offset;
            // رمز يبدأ بمسافة = كلمة جديدة، وإلا فهو تكملة الكلمة السابقة
            if t.starts_with(' ') || words.len() == before {
                let w = t.trim();
                if w.is_empty() {
                    continue;
                }
                words.push(Word {
                    w: w.to_string(),
                    start: at,
                    end: at,
                    last: false,
                });
            } else if let Some(last) = words.last_mut() {
                last.w.push_str(t);
            }
        }
        if words.len() > before {
            if let Some(l) = words.last_mut() {
                l.last = true;
            }
            ends.extend(std::iter::repeat_n(seg_end, words.len() - before));
        }
    }
    // DTW قد يعيد وقتًا أقدم من الكلمة السابقة: لا رجوع للخلف
    for i in 1..words.len() {
        if words[i].start < words[i - 1].start {
            words[i].start = words[i - 1].start + 0.01;
        }
    }
    finish(words, &ends)
}

/// تهجئة موحّدة للمقارنة: بلا تشكيل ولا تطويل ولا علامات، والهمزات ألف، والتاء المربوطة هاء، والألف المقصورة ياء
pub fn norm(w: &str) -> String {
    w.chars()
        .filter(|c| !matches!(c, '\u{064B}'..='\u{0652}' | '\u{0670}' | '\u{0640}') && (c.is_alphanumeric()))
        .map(|c| match c {
            'أ' | 'إ' | 'آ' | 'ٱ' => 'ا',
            'ى' => 'ي',
            'ة' => 'ه',
            c => c.to_lowercase().next().unwrap_or(c),
        })
        .collect()
}

fn similar(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let n = a.len().max(b.len());
    if n < 3 {
        return false;
    }
    // مسافة تحرير بسيطة: كلمة تختلف في حرف أو حرفين تُعدّ نفسها (whisper يخطئ في الهمزات والحروف المتقاربة)
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1)
                .min(cur[j - 1] + 1)
                .min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = cur;
    }
    prev[b.len()] * 3 <= n
}

/// «موازنة الترجمة مع الصوت»: كلمات الترجمة بأوقات الكلمات المسموعة.
/// المطابقة بمحاذاة تسلسلين (LCS على التهجئة الموحّدة)؛ ما لم يُطابَق يوزَّع بين جارتيه داخل جملته.
pub fn align(cues: &[Cue], heard: &[Word]) -> Vec<Word> {
    let script: Vec<(String, usize)> = cues
        .iter()
        .enumerate()
        .flat_map(|(ci, c)| c.text.split_whitespace().map(move |w| (w.to_string(), ci)))
        .collect();
    let (a, b): (Vec<String>, Vec<String>) = (
        script.iter().map(|(w, _)| norm(w)).collect(),
        heard.iter().map(|w| norm(&w.w)).collect(),
    );
    // LCS بالبرمجة الديناميكية (نص ساعة ≈ 9000 كلمة: نافذة حول القطر تكفي لأن النصين متقاربان)
    let (n, m) = (a.len(), b.len());
    let mut times: Vec<Option<(f64, f64)>> = vec![None; n];
    if n > 0 && m > 0 {
        let band = 200usize.max(n.abs_diff(m) + 50);
        let mut dp = vec![vec![0u16; m + 1]; n + 1];
        for i in 1..=n {
            let center = i * m / n;
            let (lo, hi) = (center.saturating_sub(band).max(1), (center + band).min(m));
            for j in lo..=hi {
                dp[i][j] = if similar(&a[i - 1], &b[j - 1]) {
                    dp[i - 1][j - 1] + 1
                } else {
                    dp[i - 1][j].max(dp[i][j - 1])
                };
            }
        }
        let (mut i, mut j) = (n, m);
        while i > 0 && j > 0 {
            if similar(&a[i - 1], &b[j - 1]) && dp[i][j] == dp[i - 1][j - 1] + 1 {
                times[i - 1] = Some((heard[j - 1].start, heard[j - 1].end));
                i -= 1;
                j -= 1;
            } else if dp[i - 1][j] >= dp[i][j - 1] {
                i -= 1;
            } else {
                j -= 1;
            }
        }
    }
    // ما لم يُطابَق: بين آخر مطابَق قبله وأول مطابَق بعده (أو حدود الجملة)، بطول الكلمة
    let mut out: Vec<Word> = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        if let Some((s, e)) = times[i] {
            out.push(Word {
                w: script[i].0.clone(),
                start: s,
                end: e,
                last: false,
            });
            i += 1;
            continue;
        }
        let mut j = i;
        while j < n && times[j].is_none() {
            j += 1;
        }
        let cue = &cues[script[i].1];
        let from = out
            .last()
            .map_or(cue.start, |w| w.end)
            .max(cue.start.min(out.last().map_or(cue.start, |w| w.end)));
        let to = if j < n { times[j].unwrap().0 } else { cues[script[j - 1].1].end }.max(from + 0.05 * (j - i) as f64);
        let total: usize = (i..j).map(|k| script[k].0.chars().count() + 1).sum();
        let mut t = from;
        for (w, _) in &script[i..j] {
            let d = (to - from) * (w.chars().count() + 1) as f64 / total as f64;
            out.push(Word {
                w: w.clone(),
                start: t,
                end: t + d,
                last: false,
            });
            t += d;
        }
        i = j;
    }
    for k in 0..out.len() {
        out[k].last = script.get(k + 1).is_none_or(|(_, c)| *c != script[k].1);
        if k > 0 && out[k].start < out[k - 1].start {
            out[k].start = out[k - 1].start;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_youtube_json3_word_times() {
        let j = r#"{"events":[
            {"tStartMs":1000,"dDurationMs":3000,"segs":[{"utf8":"السلام"},{"utf8":" عليكم","tOffsetMs":600},{"utf8":" ورحمة","tOffsetMs":1200}]},
            {"tStartMs":3500,"dDurationMs":10,"aAppend":1,"segs":[{"utf8":"\n"}]},
            {"tStartMs":3600,"dDurationMs":2000,"segs":[{"utf8":">> الله"}]}
        ]}"#;
        let (cues, words) = parse_json3(j);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "السلام عليكم ورحمة");
        assert_eq!(cues[0].end, 3.6, "السطر ينتهي حين يبدأ التالي");
        let w: Vec<(&str, f64)> = words.iter().map(|w| (w.w.as_str(), w.start)).collect();
        assert_eq!(w, vec![("السلام", 1.0), ("عليكم", 1.6), ("ورحمة", 2.2), ("الله", 3.6)]);
        assert!((words[0].end - 1.6).abs() < 1e-9);
        assert!(words[2].last && !words[1].last);
    }

    #[test]
    fn reads_whisper_dtw_tokens() {
        let j = r#"{"transcription":[{"offsets":{"from":0,"to":2000},"tokens":[
            {"text":"[_BEG_]","offsets":{"from":0,"to":0},"t_dtw":-1},
            {"text":" الحج","offsets":{"from":0,"to":400},"t_dtw":30},
            {"text":" عب","offsets":{"from":400,"to":600},"t_dtw":70},
            {"text":"ادة","offsets":{"from":600,"to":800},"t_dtw":80},
            {"text":"[_TT_100]","offsets":{"from":2000,"to":2000},"t_dtw":-1}
        ]}]}"#;
        let w = parse_whisper_json(j, 10.0);
        assert_eq!(w.len(), 2);
        assert_eq!(w[1].w, "عبادة");
        assert!((w[0].start - 10.22).abs() < 1e-9, "{}", w[0].start);
        assert!((w[1].start - 10.62).abs() < 1e-9);
        assert!((w[1].end - 11.82).abs() < 1e-9, "لا تتجاوز الكلمة أقصى مدة: {}", w[1].end);
        assert!(w[1].last);
    }

    #[test]
    fn aligns_subtitle_text_to_heard_words() {
        let cues = vec![Cue {
            start: 0.0,
            end: 4.0,
            text: "إنّ الحجَّ عبادةٌ عظيمة جداً".into(),
        }];
        let h = |w: &str, s: f64| Word {
            w: w.into(),
            start: s,
            end: s + 0.4,
            last: false,
        };
        // whisper سمع «ان الحج عباده عظيمه» وفاتته «جداً»
        let heard = vec![h("ان", 0.5), h("الحج", 1.0), h("عباده", 1.5), h("عظيمه", 2.0)];
        let out = align(&cues, &heard);
        assert_eq!(out.len(), 5);
        assert_eq!(out[0].w, "إنّ");
        assert_eq!((out[0].start, out[2].start, out[3].start), (0.5, 1.5, 2.0));
        // الكلمة التي لم تُسمع: بعد السابقة وقبل نهاية الجملة
        assert!(out[4].start >= out[3].end - 1e-9 && out[4].end <= 4.0 + 1e-9);
        assert!(out[4].last);
    }

    #[test]
    fn normalizes_arabic_spelling() {
        assert_eq!(norm("الصَّلاةُ"), "الصلاه");
        assert_eq!(norm("إلى،"), "الي");
        assert!(similar("استشفينا", "استشفيناه"));
        assert!(!similar("قال", "قوله"));
    }
}
