//! ملفات الترجمة SRT: قراءة، ثم قصّ ونقل التوقيت حتى تطابق الجزء الذي نُزّل.
//!
//! yt-dlp ينزّل ترجمة الفيديو كاملًا حتى لو طلبنا جزءًا منه، فنقصّها نحن
//! (بلا ffmpeg، فيعمل الشيء نفسه على الهاتف).

#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// "00:01:15,500" ← 75.5
fn parse_ts(s: &str) -> Option<f64> {
    let s = s.trim().replace(',', ".");
    let mut parts = s.split(':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    let sec: f64 = parts.next()?.trim().parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// 75.5 ← "00:01:15,500"
fn fmt_ts(sec: f64) -> String {
    let ms = (sec.max(0.0) * 1000.0).round() as u64;
    format!("{:02}:{:02}:{:02},{:03}", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

pub fn parse(content: &str) -> Vec<Cue> {
    let content = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut cues = Vec::new();
    for block in content.split("\n\n") {
        let mut lines = block.lines().skip_while(|l| l.trim().is_empty());
        let mut first = lines.next();
        // السطر الأول رقم التسلسل (اختياري)
        if first.is_some_and(|l| !l.contains("-->")) {
            first = lines.next();
        }
        let Some(timing) = first else { continue };
        let Some((a, b)) = timing.split_once("-->") else { continue };
        // قد يأتي بعد التوقيت إعدادات موضع (X1:... ) فنأخذ أول كلمة فقط
        let b = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (parse_ts(a), parse_ts(b)) else { continue };
        let text = lines.collect::<Vec<_>>().join("\n");
        if !text.trim().is_empty() {
            cues.push(Cue { start, end, text });
        }
    }
    cues
}

pub fn write(cues: &[Cue]) -> String {
    let mut out = String::new();
    for (i, c) in cues.iter().enumerate() {
        out.push_str(&format!("{}\n{} --> {}\n{}\n\n", i + 1, fmt_ts(c.start), fmt_ts(c.end), c.text));
    }
    out
}

/// الجمل الواقعة داخل [start, end] بتوقيت يبدأ من offset (ما يقطعه الحدّان يُقصّ)
pub fn cut(cues: &[Cue], start: f64, end: f64, offset: f64) -> Vec<Cue> {
    cues.iter()
        .filter(|c| c.end > start && c.start < end)
        .map(|c| Cue {
            start: c.start.max(start) - start + offset,
            end: c.end.min(end) - start + offset,
            text: c.text.clone(),
        })
        .collect()
}

/// ترجمة لعدة مقاطع: joined = تُدمج المقاطع متتالية في ملف واحد (كما يُدمج الفيديو)
pub fn for_sections(content: &str, sections: &[(f64, f64)]) -> String {
    let cues = parse(content);
    let mut out = Vec::new();
    let mut offset = 0.0;
    for (s, e) in sections {
        out.extend(cut(&cues, *s, *e, offset));
        offset += e - s;
    }
    write(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\n\r\n2\r\n00:00:05,500 --> 00:00:08,000 align:start\r\nWorld\r\nline 2\r\n\r\n3\r\n00:01:00,000 --> 00:01:02,000\r\nLater\r\n";

    #[test]
    fn parses_and_writes() {
        let c = parse(SAMPLE);
        assert_eq!(c.len(), 3);
        assert_eq!(c[1], Cue { start: 5.5, end: 8.0, text: "World\nline 2".into() });
        assert!(write(&c).starts_with("1\n00:00:01,000 --> 00:00:04,000\nHello\n\n2\n"));
    }

    #[test]
    fn cuts_and_shifts() {
        let c = parse(SAMPLE);
        let out = cut(&c, 3.0, 7.0, 0.0);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].start, out[0].end), (0.0, 1.0));
        assert_eq!((out[1].start, out[1].end), (2.5, 4.0));
    }

    #[test]
    fn joins_sections() {
        let s = for_sections(SAMPLE, &[(0.0, 4.0), (59.0, 61.0)]);
        let c = parse(&s);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].start, c[0].end), (1.0, 4.0));
        assert_eq!((c[1].start, c[1].end), (5.0, 6.0));
        assert_eq!(c[1].text, "Later");
    }
}
