//! ملفات الترجمة SRT: قراءة، ثم قصّ ونقل التوقيت حتى تطابق الجزء الذي نُزّل.
//!
//! yt-dlp ينزّل ترجمة الفيديو كاملًا حتى لو طلبنا جزءًا منه، فنقصّها نحن
//! (بلا ffmpeg، فيعمل الشيء نفسه على الهاتف).

/// نص ملف ترجمة أيًّا كان ترميزه (RC10): UTF-8 (مع BOM أو بدونه)، UTF-16 بـ BOM،
/// وإلا يُخمَّن الترميز القديم (ملفات عربية كثيرة بـ Windows-1256) بدل أحرف مكسورة.
pub fn decode(bytes: &[u8]) -> String {
    if let Some((enc, bom)) = encoding_rs::Encoding::for_bom(bytes) {
        return enc.decode_without_bom_handling(&bytes[bom..]).0.into_owned();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    det.guess(None, true).decode_without_bom_handling(bytes).0.into_owned()
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// "00:01:15,500" ← 75.5
fn parse_ts(s: &str) -> Option<f64> {
    let s = s.trim().replace(',', ".");
    // VTT يسمح بـ "01:15.500" بلا ساعات
    let parts: Vec<f64> = s.split(':').map(|p| p.trim().parse().ok()).collect::<Option<_>>()?;
    let t = match parts[..] {
        [h, m, sec] => h * 3600.0 + m * 60.0 + sec,
        [m, sec] => m * 60.0 + sec,
        _ => return None,
    };
    // f64::parse يقبل "inf" و"NaN" وأرقامًا سالبة: وقت كهذا يفسد القص وتقسيم المواضيع (مصفوفة بحجم لا نهائي)
    (t.is_finite() && t >= 0.0).then_some(t)
}

/// 75.5 ← "00:01:15,500"
fn fmt_ts(sec: f64) -> String {
    let ms = (sec.max(0.0) * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
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
        let (Some(start), Some(end)) = (parse_ts(a), parse_ts(b)) else {
            continue;
        };
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

    #[test]
    fn decode_handles_legacy_and_bom_encodings() {
        let text = "1
00:00:01,000 --> 00:00:02,000
مرحبا بكم في هذا الفيديو، أهلًا وسهلًا
";
        let (cp1256, _, bad) = encoding_rs::WINDOWS_1256.encode(text);
        assert!(!bad);
        assert_eq!(decode(&cp1256), text, "Windows-1256");
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(text.as_bytes());
        assert_eq!(decode(&bom), text, "UTF-8 BOM");
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode(&utf16), text, "UTF-16LE");
        assert_eq!(decode(text.as_bytes()), text);
    }

    const SAMPLE: &str = "1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\n\r\n2\r\n00:00:05,500 --> 00:00:08,000 align:start\r\nWorld\r\nline 2\r\n\r\n3\r\n00:01:00,000 --> 00:01:02,000\r\nLater\r\n";

    #[test]
    fn timestamps_round_trip() {
        assert_eq!(parse_ts("00:01:15,500"), Some(75.5));
        assert_eq!(parse_ts("1:02:03.25"), Some(3723.25), "نقطة بدل الفاصلة");
        assert_eq!(parse_ts("01:15.5"), Some(75.5), "VTT بلا ساعات");
        assert_eq!((parse_ts("0:0:1:2"), parse_ts("x:0:0"), parse_ts("15")), (None, None, None));
        assert_eq!(fmt_ts(75.5), "00:01:15,500");
        assert_eq!(fmt_ts(-3.0), "00:00:00,000", "لا وقت سالب");
        assert_eq!(fmt_ts(3723.2496), "01:02:03,250");
    }

    #[test]
    fn parses_and_writes() {
        let c = parse(SAMPLE);
        assert_eq!(c.len(), 3);
        assert_eq!(
            c[1],
            Cue {
                start: 5.5,
                end: 8.0,
                text: "World\nline 2".into()
            }
        );
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
