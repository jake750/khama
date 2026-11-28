//! «تايم لاين للمونتاج» (R3-F10): ما يبقى بعد حذف الصمت، أو المواضيع المختارة، أو المشاهد، كقطع على
//! تايم لاين تشير إلى الملف الأصلي نفسه. لا يُعاد ترميز شيء: يُكتب ملف XML (Final Cut Pro 7، xmeml
//! الإصدار 4، يفتحه Premiere وDaVinci Resolve) وقائمة قطع EDL (CMX 3600)، ومعهما SRT على التايم
//! لاين نفسه إن وُجدت ترجمة. ثوانٍ بدل دقائق ترميز، والمونتير يعدّل كل قطع بعد ذلك.
//!
//! كل الحساب بالإطارات: بداية كل قطعة ونهايتها تُقرَّب إلى أقرب إطار في المصدر، ومواضعها على التايم
//! لاين مجموع أطوالها بعد التقريب، والترجمة تُنقل إلى هذه المواضع نفسها فلا تنزاح مع كثرة القطع.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use crate::errors::AppError;

/// بداية التايم لاين: 01:00:00:00، كما يبدأ Resolve تايم لاين جديدًا
const RECORD_START_HOURS: u64 = 1;

// ======================= معدل الإطارات والتايم كود =======================

/// معدل الإطارات كما تكتبه برامج المونتاج: timebase صحيح، وntsc للمعدلات ÷1.001 (29.97 = 30 مع ntsc)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rate {
    /// المعدل الفعلي (29.97002…)
    pub fps: f64,
    pub tb: u64,
    pub ntsc: bool,
    /// تايم كود drop-frame (29.97 و59.94 فقط، حين يكون تايم كود الملف نفسه كذلك)
    pub df: bool,
}

/// المعدلات المعتادة: معدل قريب منها (±1%) يُعدّ هو، فـ 29.83 من فيديو هاتف تصير 29.97
const STANDARD: &[(u64, bool)] = &[
    (24, true),
    (24, false),
    (25, false),
    (30, true),
    (30, false),
    (48, true),
    (48, false),
    (50, false),
    (60, true),
    (60, false),
    (120, false),
];

impl Rate {
    pub fn new(fps: f64, df: bool) -> Self {
        let fps = if fps.is_finite() && fps > 1.0 && fps <= 240.0 { fps } else { 30.0 };
        let nominal = |tb: u64, ntsc: bool| if ntsc { tb as f64 * 1000.0 / 1001.0 } else { tb as f64 };
        let (tb, ntsc) = STANDARD
            .iter()
            .copied()
            .min_by(|a, b| (nominal(a.0, a.1) - fps).abs().total_cmp(&(nominal(b.0, b.1) - fps).abs()))
            .filter(|&(tb, ntsc)| ((nominal(tb, ntsc) - fps) / fps).abs() < 0.01)
            .unwrap_or((fps.round() as u64, false));
        Rate {
            fps: nominal(tb, ntsc),
            tb,
            ntsc,
            df: df && ntsc && tb % 30 == 0,
        }
    }

    pub fn frames(&self, sec: f64) -> u64 {
        (sec.max(0.0) * self.fps).round() as u64
    }

    pub fn secs(&self, frames: u64) -> f64 {
        frames as f64 / self.fps
    }

    /// الإطارات التي يحذفها drop-frame كل دقيقة (2 لـ 29.97، و4 لـ 59.94)
    fn dropped(&self) -> u64 {
        if self.df { self.tb / 15 } else { 0 }
    }

    /// إطار ← "01:00:00:00" (أو "01:00:00;00" بـ drop-frame)
    pub fn tc(&self, frames: u64) -> String {
        let tb = self.tb.max(1);
        let mut f = frames;
        let drop = self.dropped();
        if drop > 0 {
            let per_10 = tb * 600 - drop * 9;
            let per_min = tb * 60 - drop;
            let (d, m) = (f / per_10, f % per_10);
            f += drop * 9 * d + if m > drop { drop * ((m - drop) / per_min) } else { 0 };
        }
        let (h, m, s, ff) = (f / (tb * 3600), f / (tb * 60) % 60, f / tb % 60, f % tb);
        format!("{h:02}:{m:02}:{s:02}{}{ff:02}", if drop > 0 { ';' } else { ':' })
    }

    /// "01:00:00:00" ← إطار. يقبل ":" أو ";" أو "." قبل الإطارات
    pub fn parse_tc(&self, s: &str) -> Option<u64> {
        let p: Vec<u64> = s.trim().split([':', ';', '.']).map(|x| x.parse().ok()).collect::<Option<_>>()?;
        let [h, m, sec, f] = p[..] else { return None };
        if m >= 60 || sec >= 60 || f >= self.tb {
            return None;
        }
        let minutes = h * 60 + m;
        Some((h * 3600 + m * 60 + sec) * self.tb + f - self.dropped() * (minutes - minutes / 10))
    }

    fn xml(&self) -> String {
        format!(
            "<rate><timebase>{}</timebase><ntsc>{}</ntsc></rate>",
            self.tb,
            if self.ntsc { "TRUE" } else { "FALSE" }
        )
    }

    fn timecode_xml(&self, frame: u64) -> String {
        format!(
            "<timecode>{}<string>{}</string><frame>{frame}</frame><displayformat>{}</displayformat></timecode>",
            self.xml(),
            self.tc(frame),
            if self.df { "DF" } else { "NDF" }
        )
    }

    /// أول إطار على التايم لاين (01:00:00:00)
    pub fn record_start(&self) -> u64 {
        self.parse_tc(&format!("{RECORD_START_HOURS:02}:00:00:00")).unwrap_or(0)
    }
}

// ======================= الملف الأصلي =======================

/// ما تحتاجه برامج المونتاج عن ملف مصدر
#[derive(Debug, Clone, PartialEq)]
pub struct Media {
    pub path: PathBuf,
    pub rate: Rate,
    /// العرض والارتفاع كما يُعرض (بعد دوران الهاتف)، إن كان فيه فيديو
    pub video: Option<(u64, u64)>,
    /// عدد القنوات ومعدل العينات، إن كان فيه صوت
    pub audio: Option<(u64, u64)>,
    /// المدة بالإطارات
    pub frames: u64,
    /// تايم كود أول إطار في الملف (كاميرات)، بالإطارات. 0 لملفات الهاتف والتنزيلات
    pub tc_start: u64,
}

impl Media {
    fn name(&self) -> String {
        self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }
}

fn fraction(s: &str) -> Option<f64> {
    let (a, b) = s.split_once('/')?;
    let (a, b): (f64, f64) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    (b > 0.0 && a > 0.0).then(|| a / b).filter(|v| v.is_finite())
}

/// من JSON الذي يكتبه `ffprobe -show_format -show_streams`
pub fn media_from_probe(path: &Path, j: &Value) -> Option<Media> {
    let streams = j["streams"].as_array().cloned().unwrap_or_default();
    let video = streams
        .iter()
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64() != Some(1));
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");
    let duration = j["format"]["duration"]
        .as_str()
        .or_else(|| video.or(audio)?["duration"].as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0)?;
    // r_frame_rate هو المعدل الاسمي الذي تعرضه برامج المونتاج؛ avg_frame_rate إن كان الأول غريبًا (90000/1)
    let fps = video.and_then(|v| {
        let r = v["r_frame_rate"].as_str().and_then(fraction).filter(|f| *f <= 120.0);
        r.or_else(|| v["avg_frame_rate"].as_str().and_then(fraction))
    });
    let tag = |v: &Value| v["tags"]["timecode"].as_str().map(str::to_string);
    let tc = j["format"]["tags"]["timecode"]
        .as_str()
        .map(str::to_string)
        .or_else(|| streams.iter().find_map(tag));
    let rate = Rate::new(fps.unwrap_or(30.0), tc.as_deref().is_some_and(|t| t.contains(';')));
    let dims = video.and_then(|v| {
        let (w, h) = (v["width"].as_u64()?, v["height"].as_u64()?);
        let rotation = v["side_data_list"]
            .as_array()
            .and_then(|l| l.iter().find_map(|d| d["rotation"].as_f64()))
            .or_else(|| v["tags"]["rotate"].as_str().and_then(|r| r.parse().ok()))
            .unwrap_or(0.0);
        Some(if (rotation.round() as i64).rem_euclid(180) == 90 {
            (h, w)
        } else {
            (w, h)
        })
    });
    let audio = audio.map(|a| {
        (
            a["channels"].as_u64().unwrap_or(2),
            a["sample_rate"].as_str().and_then(|r| r.parse().ok()).unwrap_or(48_000),
        )
    });
    Some(Media {
        path: path.to_path_buf(),
        rate,
        video: dims,
        audio,
        frames: rate.frames(duration).max(1),
        tc_start: tc.and_then(|t| rate.parse_tc(&t)).unwrap_or(0),
    })
}

// ======================= القطع على التايم لاين =======================

/// قطعة من الملف على التايم لاين، بالإطارات
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clip {
    /// رقم الملف في قائمة الملفات (0 لتايم لاين من ملف واحد)
    pub file: usize,
    pub src_in: u64,
    pub src_out: u64,
    /// موضعها على التايم لاين
    pub at: u64,
}

impl Clip {
    fn len(&self) -> u64 {
        self.src_out - self.src_in
    }
}

/// القطع بالترتيب: كل قطعة تُقرَّب إلى الإطارات، والمتلاصقة في المصدر تُدمج، والفارغة تسقط
pub fn layout(pieces: &[[f64; 2]], rate: Rate, max: u64) -> Vec<Clip> {
    layout_with(pieces, rate, max, true)
}

/// مثل `layout`، و`merge = false` يُبقي كل قطعة مقطعًا وحده ولو لاصقت ما قبلها (مشاهد الفيديو)
pub fn layout_with(pieces: &[[f64; 2]], rate: Rate, max: u64, merge: bool) -> Vec<Clip> {
    let mut out: Vec<Clip> = Vec::new();
    let mut at = 0;
    for &[a, b] in pieces {
        let (src_in, src_out) = (rate.frames(a).min(max), rate.frames(b).min(max));
        if src_out <= src_in {
            continue;
        }
        match out.last_mut() {
            Some(prev) if merge && prev.src_out == src_in => prev.src_out = src_out,
            _ => out.push(Clip {
                file: 0,
                src_in,
                src_out,
                at,
            }),
        }
        at += src_out - src_in;
    }
    out
}

/// طول التايم لاين بالإطارات
pub fn total(clips: &[Clip]) -> u64 {
    clips.last().map_or(0, |c| c.at + c.len())
}

/// موضع إطار من المصدر على التايم لاين. إطار في جزء محذوف: بداية القطعة التالية (`end = false`)
/// أو نهاية السابقة (`end = true`)، فعلامة تبدأ في صمت محذوف تقع على أول كلام بعده
pub fn source_to_timeline(x: f64, clips: &[Clip], end: bool) -> Option<f64> {
    if let Some(c) = clips.iter().find(|c| {
        let (i, o) = (c.src_in as f64, c.src_out as f64);
        if end { x > i && x <= o } else { x >= i && x < o }
    }) {
        return Some(c.at as f64 + x - c.src_in as f64);
    }
    if end {
        clips.iter().rev().find(|c| (c.src_out as f64) < x).map(|c| (c.at + c.len()) as f64)
    } else {
        clips.iter().find(|c| (c.src_in as f64) > x).map(|c| c.at as f64)
    }
}

/// وقت على ناتج الواجهة (القطع موصولة بأطوالها قبل التقريب، كما يحسب exportCues) ← ثوانٍ على التايم لاين
pub fn output_to_timeline(t: f64, pieces: &[[f64; 2]], clips: &[Clip], rate: Rate, end: bool) -> Option<f64> {
    let mut at = 0.0;
    let last = pieces.iter().rposition(|[a, b]| b > a)?;
    for (i, &[a, b]) in pieces.iter().enumerate() {
        let len = (b - a).max(0.0);
        let inside = if end { t > at && t <= at + len } else { t >= at && t < at + len };
        if inside || i == last {
            let src = a + (t - at).clamp(0.0, len);
            return source_to_timeline(src * rate.fps, clips, end).map(|f| f / rate.fps);
        }
        at += len;
    }
    None
}

// ======================= XML (Final Cut Pro 7، xmeml 4) =======================

pub fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect()
}

/// مسار ملف بصيغة file:// (المسافات والرموز والحروف العربية مرمّزة)
pub fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let mut out = String::from(if s.starts_with('/') {
        "file://localhost"
    } else {
        "file://localhost/"
    });
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// عنصر <file> كاملًا (أول مرة يُذكر فيها الملف)، وبعدها يكفي معرّفه
fn file_xml(m: &Media, id: usize) -> String {
    let r = m.rate;
    let mut media = String::new();
    if let Some((w, h)) = m.video {
        media.push_str(&format!(
            "<video><samplecharacteristics>{}<width>{w}</width><height>{h}</height></samplecharacteristics></video>",
            r.xml()
        ));
    }
    if let Some((ch, sr)) = m.audio {
        media.push_str(&format!(
            "<audio><samplecharacteristics><depth>16</depth><samplerate>{sr}</samplerate></samplecharacteristics><channelcount>{ch}</channelcount></audio>"
        ));
    }
    let tc = if m.tc_start > 0 {
        r.timecode_xml(m.tc_start)
    } else {
        String::new()
    };
    format!(
        "<file id=\"file-{id}\"><name>{}</name><pathurl>{}</pathurl>{}<duration>{}</duration>{tc}<media>{media}</media></file>",
        xml_escape(&m.name()),
        xml_escape(&file_url(&m.path)),
        r.xml(),
        m.frames
    )
}

/// تايم لاين بالقطع `clips` من الملفات `files`. الصورة على مسار والصوت على مسار، وكل قطعة صورة
/// مربوطة بقطعة صوتها (تتحرك معها في برنامج المونتاج)
pub fn xmeml(files: &[Media], clips: &[Clip], name: &str) -> String {
    xmeml_marked(files, clips, name, &[])
}

/// مثل `xmeml`، وعلى التسلسل علامات `marks` (R3-F11)
pub fn xmeml_marked(files: &[Media], clips: &[Clip], name: &str, marks: &[Mark]) -> String {
    let Some(first) = files.first() else { return String::new() };
    let r = first.rate;
    let has_video = files.iter().any(|m| m.video.is_some());
    let has_audio = files.iter().any(|m| m.audio.is_some());
    let mut seen = vec![false; files.len()];
    let mut file_of = |i: usize| -> String {
        if std::mem::replace(&mut seen[i], true) {
            format!("<file id=\"file-{}\"/>", i + 1)
        } else {
            file_xml(&files[i], i + 1)
        }
    };
    let mut video = String::new();
    let mut audio = String::new();
    for (n, c) in clips.iter().enumerate() {
        let m = &files[c.file];
        let k = n + 1;
        let fname = xml_escape(&m.name());
        let both = m.video.is_some() && m.audio.is_some();
        let links = if both {
            format!(
                "<link><linkclipref>clipitem-v{k}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>{k}</clipindex></link>\
                 <link><linkclipref>clipitem-a{k}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>{k}</clipindex><groupindex>1</groupindex></link>"
            )
        } else {
            String::new()
        };
        let head = |kind: char| {
            format!(
                "<clipitem id=\"clipitem-{kind}{k}\"><name>{fname}</name><enabled>TRUE</enabled><duration>{}</duration>{}\
                 <start>{}</start><end>{}</end><in>{}</in><out>{}</out>",
                m.frames,
                m.rate.xml(),
                c.at,
                c.at + c.len(),
                c.src_in,
                c.src_out
            )
        };
        if m.video.is_some() {
            video.push_str(&format!("{}{}{links}</clipitem>", head('v'), file_of(c.file)));
        }
        if m.audio.is_some() {
            audio.push_str(&format!(
                "{}{}<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>{links}</clipitem>",
                head('a'),
                file_of(c.file)
            ));
        }
    }
    let (w, h) = files.iter().find_map(|m| m.video).unwrap_or((1920, 1080));
    let sr = files.iter().find_map(|m| m.audio).map_or(48_000, |a| a.1);
    let video_track = if has_video {
        format!("<track>{video}</track>")
    } else {
        String::new()
    };
    let audio_part = if has_audio {
        format!(
            "<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>{sr}</samplerate></samplecharacteristics></format><track>{audio}</track></audio>"
        )
    } else {
        String::new()
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE xmeml>\n<xmeml version=\"4\"><sequence id=\"sequence-1\"><name>{}</name><duration>{}</duration>{}{}\
         <media><video><format><samplecharacteristics>{}<width>{w}</width><height>{h}</height><pixelaspectratio>square</pixelaspectratio>\
         <fielddominance>none</fielddominance></samplecharacteristics></format>{video_track}</video>{audio_part}</media>{}</sequence></xmeml>\n",
        xml_escape(name),
        total(clips),
        r.xml(),
        r.timecode_xml(r.record_start()),
        r.xml(),
        markers_xml(marks),
    )
}

// ======================= EDL (CMX 3600) =======================

fn edl_header(title: &str, r: Rate) -> String {
    // سطر واحد: سطر جديد في العنوان يكسر الملف
    let title: String = title.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    format!(
        "TITLE: {}\nFCM: {}\n\n",
        title.trim(),
        if r.df { "DROP FRAME" } else { "NON-DROP FRAME" }
    )
}

/// قائمة قطع: حدث لكل قطعة، بتايم كود المصدر (من تايم كود الملف إن كان له) وموضعها من 01:00:00:00.
/// المسار "V" لملف فيه صورة (Resolve يقرأ الصورة وحدها من EDL)، و"AA" لملف صوت
pub fn edl_cuts(m: &Media, clips: &[Clip], title: &str) -> String {
    let r = m.rate;
    let rec0 = r.record_start();
    let track = if m.video.is_some() { "V" } else { "AA" };
    let mut out = edl_header(title, r);
    for (n, c) in clips.iter().enumerate() {
        out.push_str(&format!(
            "{:03}  AX       {track:<5} C        {} {} {} {}\n* FROM CLIP NAME: {}\n\n",
            n + 1,
            r.tc(m.tc_start + c.src_in),
            r.tc(m.tc_start + c.src_out),
            r.tc(rec0 + c.at),
            r.tc(rec0 + c.at + c.len()),
            m.name().replace(['\r', '\n'], " ")
        ));
    }
    out
}

// ======================= العلامات (R3-F11) =======================

/// علامة من الواجهة بثواني المصدر
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct TimelineMarker {
    pub start: f64,
    /// = start لعلامة نقطة
    pub end: f64,
    pub name: String,
    /// تعليق العلامة (نوعها ومدتها وملخصها)
    #[serde(default)]
    pub note: String,
    /// لون Resolve بالإنجليزية (Green، Yellow، Red، …). غير معروف = الأزرق
    #[serde(default)]
    pub color: String,
}

/// ألوان علامات Resolve كما يكتبها في EDL العلامات
const RESOLVE_COLORS: &[&str] = &[
    "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa",
    "Cream",
];

fn resolve_color(c: &str) -> &'static str {
    RESOLVE_COLORS
        .iter()
        .find(|n| n.eq_ignore_ascii_case(c.trim()))
        .copied()
        .unwrap_or("Blue")
}

/// علامة على التايم لاين، بالإطارات
#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub at: u64,
    /// 0 = علامة نقطة
    pub len: u64,
    pub name: String,
    pub note: String,
    pub color: String,
    /// موضعها في المصدر (ث)، للجدول
    pub src: (f64, f64),
}

fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// علامات المصدر على التايم لاين. علامة بمدى تبقى إن بقي شيء منها، وتبدأ من أول ما بقي؛
/// وعلامة نقطة في جزء محذوف تنتقل إلى أول ما بعده. ما خرج كله يسقط
pub fn place_marks(marks: &[TimelineMarker], clips: &[Clip], rate: Rate) -> Vec<Mark> {
    let (Some(lo), Some(hi)) = (clips.iter().map(|c| c.src_in).min(), clips.iter().map(|c| c.src_out).max()) else {
        return Vec::new();
    };
    let last = total(clips).saturating_sub(1);
    let mut out: Vec<Mark> = marks
        .iter()
        .filter_map(|m| {
            let ranged = m.end > m.start;
            // قبل أول الملف كلها (موضوع قبل ما نُزّل من رابط): لا تصير علامة عند صفره
            if m.end.max(m.start) < 0.0 || (ranged && m.end <= 0.0) {
                return None;
            }
            let (s, e) = (m.start.max(0.0) * rate.fps, m.end.max(m.start) * rate.fps);
            let keep = if ranged {
                clips.iter().any(|c| (c.src_in as f64) < e && (c.src_out as f64) > s)
            } else {
                s >= lo as f64 && s < hi as f64
            };
            if !keep {
                return None;
            }
            let a = source_to_timeline(s, clips, false)?;
            let b = if ranged {
                source_to_timeline(e, clips, true).unwrap_or(a)
            } else {
                a
            };
            let at = (a.round() as u64).min(last);
            Some(Mark {
                at,
                len: (b.round() as u64).saturating_sub(at),
                name: one_line(&m.name),
                note: one_line(&m.note),
                color: m.color.clone(),
                src: (m.start, m.end.max(m.start)),
            })
        })
        .collect();
    out.sort_by_key(|m| m.at);
    out
}

/// علامات التسلسل في xmeml: يقرؤها Premiere (اسم وتعليق ومدة). اللون لا يُكتب: ترميز Premiere
/// له غير موثّق، فالنوع في التعليق، واللون في EDL العلامات لـ Resolve
fn markers_xml(marks: &[Mark]) -> String {
    marks
        .iter()
        .map(|m| {
            let out = if m.len > 0 { (m.at + m.len).to_string() } else { "-1".into() };
            format!(
                "<marker><name>{}</name><comment>{}</comment><in>{}</in><out>{out}</out></marker>",
                xml_escape(&m.name),
                xml_escape(&m.note),
                m.at
            )
        })
        .collect()
}

/// EDL علامات بصيغة Resolve (Timeline → Import → Timeline Markers from EDL): حدث لكل علامة على
/// تايم لاين يبدأ من 01:00:00:00، وتحته سطر « |C:ResolveColorGreen |M:الاسم |D:المدة بالإطارات»
pub fn edl_markers(marks: &[Mark], r: Rate, title: &str) -> String {
    let rec0 = r.record_start();
    let mut out = edl_header(title, r);
    for (n, m) in marks.iter().enumerate() {
        let (a, b) = (r.tc(rec0 + m.at), r.tc(rec0 + m.at + 1));
        let name = m.name.replace('|', "/");
        let name = if name.is_empty() { format!("Marker {}", n + 1) } else { name };
        out.push_str(&format!(
            "{:03}  001      V     C        {a} {b} {a} {b}  \n |C:ResolveColor{} |M:{name} |D:{}\n\n",
            n + 1,
            resolve_color(&m.color),
            m.len.max(1)
        ));
    }
    out
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// وقت المصدر بصيغة 00:01:02.345
fn clock(sec: f64) -> String {
    let ms = (sec.max(0.0) * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

/// جدول العلامات (يفتحه Excel وGoogle Sheets بالعربية كما هي: UTF-8 مع BOM)
pub fn csv_markers(marks: &[Mark], r: Rate) -> String {
    let rec0 = r.record_start();
    let mut out = String::from("\u{feff}#,Name,Timeline in,Timeline out,Duration,Source in,Source out,Colour,Note\r\n");
    for (n, m) in marks.iter().enumerate() {
        let row = [
            (n + 1).to_string(),
            csv_field(&m.name),
            r.tc(rec0 + m.at),
            r.tc(rec0 + m.at + m.len),
            clock(r.secs(m.len)),
            clock(m.src.0),
            clock(m.src.1),
            resolve_color(&m.color).to_string(),
            csv_field(&m.note),
        ];
        out.push_str(&row.join(","));
        out.push_str("\r\n");
    }
    out
}

// ======================= الطلب من الواجهة =======================

/// سطر ترجمة على ناتج الواجهة (ثوانٍ من بداية الناتج)
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct TimelineCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct TimelineRequest {
    /// الملف الأصلي: يشير إليه التايم لاين ولا يُنسخ
    pub input: String,
    /// قطع المصدر التي تبقى، بترتيبها على التايم لاين (ثوانٍ). فارغة = الملف كله
    pub pieces: Vec<[f64; 2]>,
    /// ترجمة على الناتج (من exportCues بالقطع نفسها): تُكتب SRT على التايم لاين
    #[serde(default)]
    pub cues: Vec<TimelineCue>,
    /// اسم الملفات بلا امتداد
    pub name: String,
    /// كل قطعة مقطع وحده ولو لاصقت ما قبلها (تايم لاين المشاهد: قطع عند كل مشهد)
    #[serde(default)]
    pub keep_cuts: bool,
    /// علامات بثواني المصدر (R3-F11): تُكتب في XML، وفي EDL علامات لـ Resolve
    #[serde(default)]
    pub markers: Vec<TimelineMarker>,
    /// true = العلامات على الملف كله بلا قطع: XML وEDL العلامات وجدول CSV
    #[serde(default)]
    pub markers_only: bool,
}

/// الترجمة على التايم لاين: كل سطر يُنقل إلى مواضع القطع بعد تقريبها إلى الإطارات
pub fn timeline_cues(cues: &[TimelineCue], pieces: &[[f64; 2]], clips: &[Clip], rate: Rate) -> Vec<crate::srt::Cue> {
    let end_max = rate.secs(total(clips));
    let mut out: Vec<crate::srt::Cue> = cues
        .iter()
        .filter_map(|c| {
            let start = output_to_timeline(c.start, pieces, clips, rate, false)?;
            let end = output_to_timeline(c.end, pieces, clips, rate, true)?.min(end_max);
            (end - start >= 0.02 && !c.text.trim().is_empty()).then(|| crate::srt::Cue {
                start: (start * 1000.0).round() / 1000.0,
                end: (end * 1000.0).round() / 1000.0,
                text: c.text.trim().to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    // لا يتداخل سطران بعد التقريب
    for i in 1..out.len() {
        if out[i].start < out[i - 1].end {
            out[i - 1].end = out[i].start;
        }
    }
    out.retain(|c| c.end > c.start);
    out
}

/// اسم ملف آمن: بلا فواصل مسار ولا رموز يمنعها Windows، وبطول معقول
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"/\:*?"<>|"#.contains(c) { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.trim_matches(['.', ' ']).chars().take(120).collect();
    let cleaned = cleaned.trim_matches(['.', ' ']).to_string();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"];
    let stem = cleaned.split('.').next().unwrap_or("").to_uppercase();
    if cleaned.is_empty() {
        "Khama".into()
    } else if reserved.contains(&stem.as_str()) {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

/// أول اسم لا يوجد بأي من النهايات («.xml»، « markers.edl»): «اسم»، «اسم (1)»، … فلا تختلط ملفات تصديرين
pub fn free_base(dir: &Path, name: &str, tails: &[&str]) -> String {
    (0..1000)
        .map(|n| if n == 0 { name.to_string() } else { format!("{name} ({n})") })
        .find(|b| tails.iter().all(|t| !dir.join(format!("{b}{t}")).exists()))
        .unwrap_or_else(|| format!("{name} {}", std::process::id()))
}

/// الملفات المكتوبة، كل منها بآخر اسمه: XML، وEDL القطع، وEDL العلامات إن وُجدت علامات، وSRT إن
/// وُجدت ترجمة. وللعلامات وحدها (`markers_only`): XML على الملف كله، وEDL العلامات، وCSV
pub fn render(req: &TimelineRequest, m: &Media) -> Result<Vec<(&'static str, String)>, AppError> {
    let whole = [[0.0, m.rate.secs(m.frames)]];
    let pieces: &[[f64; 2]] = if req.pieces.is_empty() || req.markers_only {
        &whole
    } else {
        &req.pieces
    };
    let clips = if req.keep_cuts {
        layout_with(pieces, m.rate, m.frames, false)
    } else {
        layout(pieces, m.rate, m.frames)
    };
    if clips.is_empty() {
        return Err(AppError::new("timelineEmpty"));
    }
    let marks = place_marks(&req.markers, &clips, m.rate);
    if req.markers_only && marks.is_empty() {
        return Err(AppError::new("markersEmpty"));
    }
    let mut files = vec![(".xml", xmeml_marked(std::slice::from_ref(m), &clips, &req.name, &marks))];
    if req.markers_only {
        files.push((".edl", edl_markers(&marks, m.rate, &req.name)));
        files.push((".csv", csv_markers(&marks, m.rate)));
    } else {
        files.push((".edl", edl_cuts(m, &clips, &req.name)));
        if !marks.is_empty() {
            files.push((" markers.edl", edl_markers(&marks, m.rate, &req.name)));
        }
    }
    let cues = timeline_cues(&req.cues, pieces, &clips, m.rate);
    if !cues.is_empty() {
        files.push((".srt", crate::srt::write(&cues)));
    }
    Ok(files)
}

async fn probe(app: &tauri::AppHandle, input: &Path) -> Result<Media, AppError> {
    let tools = crate::tools::resolve(app)?;
    let p = input.to_string_lossy();
    let (ok, out, err) =
        crate::tools::run_capture(&tools.ffprobe, &["-v", "error", "-show_format", "-show_streams", "-of", "json", &p]).await?;
    if !ok {
        return Err(AppError::with_detail("badInput", err.lines().last().unwrap_or("").to_string()));
    }
    let j: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    media_from_probe(input, &j).ok_or_else(|| AppError::new("badInput"))
}

/// مجلد الحفظ كما في التحويل: مجلد الحفظ العام، أو بجانب الأصل
fn output_dir(app: &tauri::AppHandle, input: &Path) -> Result<PathBuf, AppError> {
    use crate::errors::LockExt;
    use tauri::Manager;
    let s = app.state::<crate::settings::SettingsState>().0.lock_ok().clone();
    if s.convert_dest == "output" {
        crate::settings::resolve_output_dir(app, &s)
    } else {
        Ok(input.parent().map(Path::to_path_buf).unwrap_or_default())
    }
}

/// يكتب ملفات التايم لاين ويعيد مساراتها (XML أولًا)
#[tauri::command]
pub async fn export_timeline(app: tauri::AppHandle, request: TimelineRequest) -> Result<Vec<String>, AppError> {
    let input = PathBuf::from(&request.input);
    if !input.is_file() {
        return Err(AppError::new("badInput"));
    }
    let media = probe(&app, &input).await?;
    let files = render(&request, &media)?;
    let dir = output_dir(&app, &input)?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
    let tails: Vec<&str> = files.iter().map(|(t, _)| *t).collect();
    let base = free_base(&dir, &safe_name(&request.name), &tails);
    let mut written = Vec::new();
    for (tail, body) in files {
        let path = dir.join(format!("{base}{tail}"));
        crate::persist::write_atomic(&path, body.as_bytes())?;
        written.push(path.to_string_lossy().into_owned());
    }
    Ok(written)
}

// ======================= تسمية الناتج بعنوان الموضوع (R3-U5) =======================

/// يعيد تسمية `from` إلى «name.امتداده» في مجلده نفسه، بأول اسم غير موجود، ومعه ترجمته بجانبه
/// («نفس الاسم.srt») إن كانت. يعيد المسار الجديد
pub fn rename_with_sidecar(from: &Path, name: &str) -> std::io::Result<PathBuf> {
    let want = safe_name(name);
    if from.file_stem().is_some_and(|s| s.to_string_lossy() == want) {
        return Ok(from.to_path_buf());
    }
    let dir = from.parent().map(Path::to_path_buf).unwrap_or_default();
    let ext = from.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let srt = from.with_extension("srt");
    let has_srt = !ext.eq_ignore_ascii_case(".srt") && srt.is_file();
    let mut tails = vec![ext.as_str()];
    if has_srt {
        tails.push(".srt");
    }
    let base = free_base(&dir, &want, &tails);
    let to = dir.join(format!("{base}{ext}"));
    // rename في Windows يكتب فوق الموجود: ملف ظهر بين الفحص والنقل لا يُمحى
    if to.exists() {
        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, to.display().to_string()));
    }
    std::fs::rename(from, &to)?;
    if has_srt && let Err(e) = std::fs::rename(&srt, to.with_extension("srt")) {
        log::warn!("rename_export: srt: {e}");
    }
    Ok(to)
}

/// سطر السجلّ يتبع الملف إلى اسمه الجديد (بمعرّفه الجديد، في أول القائمة كما كان)، وعنوانه اسم الملف
async fn retarget_history(app: &tauri::AppHandle, old: &str, new: &str) {
    use tauri::Manager;
    let file_name = |p: &str| {
        Path::new(p)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let Ok(list) = crate::history::get_history(app.clone(), app.state()).await else {
        return;
    };
    let Some(mut entry) = list.into_iter().find(|e| e.file == old) else {
        return;
    };
    if crate::history::remove_history(app.clone(), app.state(), entry.id).is_ok() {
        if entry.title == file_name(old) {
            entry.title = file_name(new);
        }
        entry.file = new.to_string();
        if let Err(e) = crate::history::add_entry(app, entry).await {
            log::warn!("rename_export: history: {e:?}");
        }
    }
}

/// ناتج تصدير موضوع باسم عنوانه: «عنوان الموضوع.mp4» بدل «اسم الأصل [قص].mp4». لا يقبل إلا ملفًا
/// كتبه التطبيق (في السجلّ)، ولا يكتب فوق ملف موجود
#[tauri::command]
pub async fn rename_export(app: tauri::AppHandle, path: String, name: String) -> Result<String, AppError> {
    let from = PathBuf::from(&path);
    if name.trim().is_empty() || !from.is_file() || !crate::history::contains_file(&app, &path) {
        return Err(AppError::new("badInput"));
    }
    let to = rename_with_sidecar(&from, &name).map_err(|e| AppError::with_detail("moveFailed", e.to_string()))?;
    let new = to.to_string_lossy().into_owned();
    if new != path {
        retarget_history(&app, &path, &new).await;
    }
    Ok(new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(fps: f64, video: bool) -> Media {
        Media {
            path: PathBuf::from("C:/v/محاضرة & درس.mp4"),
            rate: Rate::new(fps, false),
            video: video.then_some((1920, 1080)),
            audio: Some((2, 48_000)),
            frames: Rate::new(fps, false).frames(600.0),
            tc_start: 0,
        }
    }

    #[test]
    fn rates_snap_to_editor_rates() {
        let r = Rate::new(30000.0 / 1001.0, false);
        assert_eq!((r.tb, r.ntsc), (30, true));
        assert_eq!((Rate::new(29.83, false).tb, Rate::new(29.83, false).ntsc), (30, true));
        assert_eq!((Rate::new(25.0, false).tb, Rate::new(25.0, false).ntsc), (25, false));
        assert_eq!(Rate::new(23.976, false).tb, 24);
        // معدل غريب يبقى كما هو مقرّبًا
        assert_eq!((Rate::new(15.0, false).tb, Rate::new(15.0, false).ntsc), (15, false));
        assert_eq!(Rate::new(f64::NAN, false).tb, 30);
    }

    #[test]
    fn timecodes_round_trip() {
        let r = Rate::new(25.0, false);
        assert_eq!(r.tc(0), "00:00:00:00");
        assert_eq!(r.tc(25 * 3600 + 25 * 61 + 3), "01:01:01:03");
        assert_eq!(r.record_start(), 90_000);
        assert_eq!(r.parse_tc("01:01:01:03"), Some(25 * 3600 + 25 * 61 + 3));
        assert_eq!(r.parse_tc("00:00:00:25"), None);
        // drop-frame: بعد 00:00:59;29 يأتي 00:01:00;02، وكل عاشر دقيقة لا يُحذف شيء
        let df = Rate::new(29.97, true);
        assert!(df.df);
        assert_eq!(df.tc(1799), "00:00:59;29");
        assert_eq!(df.tc(1800), "00:01:00;02");
        assert_eq!(df.tc(17982), "00:10:00;00");
        assert_eq!(df.record_start(), 107_892);
        for f in [0, 1799, 1800, 17981, 17982, 107_892, 123_456] {
            assert_eq!(df.parse_tc(&df.tc(f)), Some(f), "{f}");
        }
        // drop-frame لا يكون إلا لـ 29.97 و59.94
        assert!(!Rate::new(25.0, true).df);
    }

    #[test]
    fn pieces_become_frame_accurate_clips() {
        let r = Rate::new(25.0, false);
        let clips = layout(&[[1.0, 2.5], [2.5, 3.0], [10.02, 12.0], [20.0, 20.01]], r, 10_000);
        // المتلاصقتان تُدمجان، والأقصر من إطار تسقط
        assert_eq!(
            clips,
            vec![
                Clip {
                    file: 0,
                    src_in: 25,
                    src_out: 75,
                    at: 0
                },
                Clip {
                    file: 0,
                    src_in: 251,
                    src_out: 300,
                    at: 50
                },
            ]
        );
        assert_eq!(total(&clips), 99);
        // لا تتجاوز آخر الملف
        assert_eq!(layout(&[[0.0, 100.0]], r, 250)[0].src_out, 250);
        // المشاهد: القطع المتلاصقة تبقى مقاطع منفصلة
        let scenes = layout_with(&[[0.0, 2.0], [2.0, 5.0], [5.0, 1e9]], r, 250, false);
        assert_eq!(
            scenes.iter().map(|c| (c.src_in, c.src_out, c.at)).collect::<Vec<_>>(),
            vec![(0, 50, 0), (50, 125, 50), (125, 250, 125)]
        );
    }

    #[test]
    fn source_times_map_onto_the_timeline() {
        let r = Rate::new(25.0, false);
        let clips = layout(&[[1.0, 2.0], [5.0, 6.0]], r, 10_000);
        assert_eq!(source_to_timeline(r.fps * 1.5, &clips, false), Some(12.5));
        // في الجزء المحذوف: البداية على أول القطعة التالية، والنهاية على آخر السابقة
        assert_eq!(source_to_timeline(r.fps * 3.0, &clips, false), Some(25.0));
        assert_eq!(source_to_timeline(r.fps * 3.0, &clips, true), Some(25.0));
        assert_eq!(source_to_timeline(r.fps * 2.0, &clips, true), Some(25.0));
        assert_eq!(source_to_timeline(r.fps * 7.0, &clips, false), None);
        assert_eq!(source_to_timeline(r.fps * 0.5, &clips, true), None);
    }

    #[test]
    fn subtitles_follow_the_rounded_clips() {
        // 100 قطعة بطول 1.01 ث على 25 إطارًا: كل قطعة تُقرَّب إلى 25 إطارًا (1 ث)، فبعد 100 قطعة
        // ينزاح الناتج غير المقرَّب ثانية كاملة. الترجمة تُنقل إلى المواضع المقرَّبة فلا تنزاح
        let r = Rate::new(25.0, false);
        let pieces: Vec<[f64; 2]> = (0..100).map(|i| [i as f64 * 2.0, i as f64 * 2.0 + 1.01]).collect();
        let clips = layout(&pieces, r, 100_000);
        assert_eq!(total(&clips), 100 * 25);
        // سطر يبدأ مع القطعة رقم 99 على ناتج الواجهة (99 × 1.01 ث)
        let cue = TimelineCue {
            start: 99.0 * 1.01 + 0.2,
            end: 99.0 * 1.01 + 0.8,
            text: "آخر سطر".into(),
        };
        let out = timeline_cues(&[cue], &pieces, &clips, r);
        assert_eq!(out.len(), 1);
        assert!((out[0].start - 99.2).abs() < 0.001, "{}", out[0].start);
        assert!((out[0].end - 99.8).abs() < 0.001, "{}", out[0].end);
    }

    #[test]
    fn overlapping_cues_are_trimmed() {
        let r = Rate::new(25.0, false);
        let pieces = [[0.0, 10.0]];
        let clips = layout(&pieces, r, 1000);
        let cues = [
            TimelineCue {
                start: 1.0,
                end: 3.0,
                text: "a".into(),
            },
            TimelineCue {
                start: 2.5,
                end: 4.0,
                text: "b".into(),
            },
            TimelineCue {
                start: 9.0,
                end: 30.0,
                text: "c".into(),
            },
            TimelineCue {
                start: 5.0,
                end: 6.0,
                text: " ".into(),
            },
        ];
        let out = timeline_cues(&cues, &pieces, &clips, r);
        assert_eq!(
            out.iter().map(|c| (c.start, c.end)).collect::<Vec<_>>(),
            vec![(1.0, 2.5), (2.5, 4.0), (9.0, 10.0)]
        );
    }

    #[test]
    fn xml_references_the_original_with_in_and_out_points() {
        let m = media(25.0, true);
        let clips = layout(&[[1.0, 2.0], [5.0, 7.5]], m.rate, m.frames);
        let x = xmeml(std::slice::from_ref(&m), &clips, "درس & تايم لاين");
        assert!(x.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE xmeml>\n<xmeml version=\"4\">"));
        assert!(x.contains("<name>درس &amp; تايم لاين</name><duration>88</duration>"));
        assert!(
            x.contains("<timecode><rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate><string>01:00:00:00</string><frame>90000</frame>")
        );
        // الملف كاملًا مرة واحدة، ثم بمعرّفه فقط
        assert_eq!(x.matches("<pathurl>").count(), 1);
        assert_eq!(x.matches("<file id=\"file-1\"/>").count(), 3);
        assert!(x.contains("<pathurl>file://localhost/C:/v/%D9%85%D8%AD%D8%A7%D8%B6%D8%B1%D8%A9%20%26%20%D8%AF%D8%B1%D8%B3.mp4</pathurl>"));
        // القطعة الثانية: 5–7.5 ث = الإطارات 125–188 في المصدر (187.5 تُقرَّب)، في 25–88 على التايم لاين
        assert!(
            x.contains("<clipitem id=\"clipitem-v2\"><name>محاضرة &amp; درس.mp4</name><enabled>TRUE</enabled><duration>15000</duration>")
        );
        assert!(x.contains("<start>25</start><end>88</end><in>125</in><out>188</out>"));
        assert!(x.contains("<linkclipref>clipitem-a2</linkclipref>"));
        assert_eq!(x.matches("<clipitem ").count(), 4);
        // كل وسم مفتوح مغلق (فحص بسيط للبنية)
        for tag in [
            "xmeml", "sequence", "media", "video", "audio", "track", "clipitem", "file", "rate", "link",
        ] {
            let open = x.matches(&format!("<{tag}>")).count() + x.matches(&format!("<{tag} ")).count();
            let self_closed = x.matches(&format!("<{tag} id=\"file-1\"/>")).count();
            assert_eq!(open - self_closed, x.matches(&format!("</{tag}>")).count(), "{tag}");
        }
    }

    #[test]
    fn audio_only_xml_has_no_video_clips() {
        let m = media(30.0, false);
        let clips = layout(&[[0.0, 1.0]], m.rate, m.frames);
        let x = xmeml(std::slice::from_ref(&m), &clips, "صوت");
        assert!(!x.contains("clipitem-v"));
        assert!(x.contains("clipitem-a1"));
        assert!(!x.contains("<link>"));
    }

    #[test]
    fn edl_lists_each_cut_with_source_and_record_timecodes() {
        let mut m = media(25.0, true);
        m.tc_start = m.rate.parse_tc("10:00:00:00").unwrap();
        let clips = layout(&[[1.0, 2.0], [5.0, 7.5]], m.rate, m.frames);
        let e = edl_cuts(&m, &clips, "درس\nسطر");
        let lines: Vec<&str> = e.lines().collect();
        assert_eq!(lines[0], "TITLE: درس سطر");
        assert_eq!(lines[1], "FCM: NON-DROP FRAME");
        assert_eq!(
            lines[3],
            "001  AX       V     C        10:00:01:00 10:00:02:00 01:00:00:00 01:00:01:00"
        );
        assert_eq!(lines[4], "* FROM CLIP NAME: محاضرة & درس.mp4");
        assert!(lines[6].starts_with("002  AX       V     C        10:00:05:00 10:00:07:1"));
        // صوت فقط
        let a = edl_cuts(&media(30.0, false), &clips, "x");
        assert!(a.contains("001  AX       AA    C        "));
    }

    #[test]
    fn probe_json_gives_rate_size_and_timecode() {
        let j: Value = serde_json::from_str(
            r#"{"streams":[
                {"codec_type":"video","width":1080,"height":1920,"r_frame_rate":"30000/1001","avg_frame_rate":"30000/1001","tags":{"timecode":"01:00:00;00"}},
                {"codec_type":"audio","channels":1,"sample_rate":"44100"}],
              "format":{"duration":"12.5"}}"#,
        )
        .unwrap();
        let m = media_from_probe(Path::new("x.mov"), &j).unwrap();
        assert_eq!((m.rate.tb, m.rate.ntsc, m.rate.df), (30, true, true));
        assert_eq!(m.video, Some((1080, 1920)));
        assert_eq!(m.audio, Some((1, 44_100)));
        assert_eq!(m.frames, 375);
        assert_eq!(m.tc_start, 107_892);
        // هاتف مدوَّر، ومعدل اسمي غريب
        let j: Value = serde_json::from_str(
            r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"r_frame_rate":"90000/1","avg_frame_rate":"2997/100",
                "side_data_list":[{"rotation":-90}]}],"format":{"duration":"3"}}"#,
        )
        .unwrap();
        let m = media_from_probe(Path::new("x.mp4"), &j).unwrap();
        assert_eq!(m.video, Some((1080, 1920)));
        assert_eq!((m.rate.tb, m.rate.ntsc), (30, true));
        assert_eq!(m.audio, None);
        // صوت وحده: 30 إطارًا للثانية
        let j: Value =
            serde_json::from_str(r#"{"streams":[{"codec_type":"audio","channels":2,"sample_rate":"48000"}],"format":{"duration":"60"}}"#)
                .unwrap();
        let m = media_from_probe(Path::new("x.wav"), &j).unwrap();
        assert_eq!((m.rate.tb, m.frames, m.video), (30, 1800, None));
    }

    #[test]
    fn render_writes_xml_edl_and_srt() {
        let m = media(25.0, true);
        let req = TimelineRequest {
            input: "x".into(),
            pieces: vec![[1.0, 2.0], [5.0, 7.0]],
            cues: vec![TimelineCue {
                start: 0.5,
                end: 1.5,
                text: "سطر".into(),
            }],
            name: "x".into(),
            keep_cuts: false,
            markers: vec![],
            markers_only: false,
        };
        let files = render(&req, &m).unwrap();
        assert_eq!(files.iter().map(|f| f.0).collect::<Vec<_>>(), vec![".xml", ".edl", ".srt"]);
        assert!(files[2].1.contains("00:00:00,500 --> 00:00:01,500\nسطر"));
        // بلا قطع = الملف كله، وقطع كلها خارج الملف = خطأ واضح
        let whole = TimelineRequest {
            pieces: vec![],
            cues: vec![],
            ..req.clone()
        };
        let files = render(&whole, &m).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0].1.contains("<in>0</in><out>15000</out>"));
        let outside = TimelineRequest {
            pieces: vec![[700.0, 800.0]],
            ..req
        };
        assert_eq!(render(&outside, &m).unwrap_err().code, "timelineEmpty");
        // المشاهد: قطعة لكل مشهد ولو تلاصقت
        let scenes = TimelineRequest {
            input: "x".into(),
            pieces: vec![[0.0, 2.0], [2.0, 5.0], [5.0, 1e9]],
            cues: vec![],
            name: "x".into(),
            keep_cuts: true,
            markers: vec![],
            markers_only: false,
        };
        let edl = &render(&scenes, &m).unwrap()[1].1;
        assert_eq!(edl.matches("* FROM CLIP NAME").count(), 3);
        assert!(edl.contains("003  AX       V     C        00:00:05:00 00:10:00:00 01:00:05:00 01:10:00:00"));
    }

    fn marker(start: f64, end: f64, name: &str, color: &str) -> TimelineMarker {
        TimelineMarker {
            start,
            end,
            name: name.into(),
            note: String::new(),
            color: color.into(),
        }
    }

    #[test]
    fn markers_follow_the_cuts() {
        let r = Rate::new(25.0, false);
        // [1,2] و[5,7.5]: على التايم لاين 0..25 و25..88
        let clips = layout(&[[1.0, 2.0], [5.0, 7.5]], r, 10_000);
        let marks = place_marks(
            &[
                marker(6.0, 7.0, "داخل الثانية", "green"),
                marker(3.0, 3.0, "نقطة في المحذوف", "Red"),
                marker(0.0, 1.5, "يبدأ قبل الأول", "Yellow"),
                marker(2.5, 4.5, "كله محذوف", "Red"),
                marker(9.0, 9.0, "بعد الآخر", "Red"),
                marker(-5.0, -1.0, "قبل الملف", "Red"),
                marker(1.2, 6.0, "عبر  القطع\n", ""),
            ],
            &clips,
            r,
        );
        let got: Vec<(&str, u64, u64)> = marks.iter().map(|m| (m.name.as_str(), m.at, m.len)).collect();
        assert_eq!(
            got,
            vec![
                ("يبدأ قبل الأول", 0, 13),
                ("عبر القطع", 5, 45),
                ("نقطة في المحذوف", 25, 0),
                ("داخل الثانية", 50, 25)
            ]
        );
        assert_eq!(resolve_color("green"), "Green");
        assert_eq!(resolve_color("nope"), "Blue");
        assert!(place_marks(&[marker(1.0, 2.0, "x", "")], &[], r).is_empty());
    }

    #[test]
    fn marker_files_for_premiere_and_resolve() {
        let m = media(25.0, true);
        let req = TimelineRequest {
            input: "x".into(),
            pieces: vec![],
            cues: vec![],
            name: "درس markers".into(),
            keep_cuts: false,
            markers: vec![
                TimelineMarker {
                    start: 10.0,
                    end: 40.0,
                    name: "الصبر | والشكر".into(),
                    note: "يصلح ريلًا · 0:30".into(),
                    color: "Green".into(),
                },
                TimelineMarker {
                    start: 60.0,
                    end: 60.0,
                    name: "Silence, 2".into(),
                    note: "say \"hi\"".into(),
                    color: "nope".into(),
                },
            ],
            markers_only: true,
        };
        let files = render(&req, &m).unwrap();
        assert_eq!(files.iter().map(|f| f.0).collect::<Vec<_>>(), vec![".xml", ".edl", ".csv"]);
        // XML: الملف كله مقطع واحد، والعلامتان على التسلسل
        let xml = &files[0].1;
        assert_eq!(xml.matches("<clipitem").count(), 2);
        assert!(xml.contains("<marker><name>الصبر | والشكر</name><comment>يصلح ريلًا · 0:30</comment><in>250</in><out>1000</out></marker>"));
        assert!(xml.contains("<comment>say &quot;hi&quot;</comment><in>1500</in><out>-1</out></marker>"));
        // EDL العلامات لـ Resolve
        let edl = &files[1].1;
        assert!(edl.starts_with("TITLE: درس markers\nFCM: NON-DROP FRAME\n\n"));
        assert!(edl.contains(
            "001  001      V     C        01:00:10:00 01:00:10:01 01:00:10:00 01:00:10:01  \n |C:ResolveColorGreen |M:الصبر / والشكر |D:750\n"
        ));
        assert!(edl.contains(
            "002  001      V     C        01:01:00:00 01:01:00:01 01:01:00:00 01:01:00:01  \n |C:ResolveColorBlue |M:Silence, 2 |D:1\n"
        ));
        // CSV
        let csv = &files[2].1;
        assert!(csv.starts_with("\u{feff}#,Name,Timeline in,"));
        assert!(
            csv.contains("\r\n1,الصبر | والشكر,01:00:10:00,01:00:40:00,00:00:30.000,00:00:10.000,00:00:40.000,Green,يصلح ريلًا · 0:30\r\n")
        );
        assert!(
            csv.contains("\r\n2,\"Silence, 2\",01:01:00:00,01:01:00:00,00:00:00.000,00:01:00.000,00:01:00.000,Blue,\"say \"\"hi\"\"\"\r\n")
        );
        // تايم لاين بقطع: العلامات في XML وفي EDL علامات بجانب EDL القطع، بلا CSV
        let cut = TimelineRequest {
            pieces: vec![[5.0, 20.0], [50.0, 70.0]],
            markers_only: false,
            ..req.clone()
        };
        let files = render(&cut, &m).unwrap();
        assert_eq!(files.iter().map(|f| f.0).collect::<Vec<_>>(), vec![".xml", ".edl", " markers.edl"]);
        assert!(
            files[0]
                .1
                .contains("<comment>يصلح ريلًا · 0:30</comment><in>125</in><out>375</out></marker>")
        );
        assert!(files[0].1.contains("<in>625</in><out>-1</out></marker>"));
        assert!(files[1].1.contains("* FROM CLIP NAME"));
        // علامات كلها خارج الملف: خطأ واضح
        let none = TimelineRequest {
            markers: vec![marker(700.0, 800.0, "x", "")],
            ..req
        };
        assert_eq!(render(&none, &m).unwrap_err().code, "markersEmpty");
    }

    #[test]
    fn exports_take_the_topic_title() {
        let dir = std::env::temp_dir().join(format!("khama-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("درس [قص].mp4");
        std::fs::write(&clip, "v").unwrap();
        std::fs::write(dir.join("درس [قص].srt"), "s").unwrap();
        // اسم موجود: يأخذ التالي، والترجمة تتبعه
        std::fs::write(dir.join("الصبر.mp4"), "old").unwrap();
        let to = rename_with_sidecar(&clip, "الصبر: عند الصدمة الأولى?").unwrap();
        assert_eq!(to, dir.join("الصبر عند الصدمة الأولى.mp4"));
        assert!(to.with_extension("srt").is_file() && !clip.exists() && !dir.join("درس [قص].srt").exists());
        let again = rename_with_sidecar(&dir.join("الصبر.mp4"), "الصبر عند الصدمة الأولى").unwrap();
        assert_eq!(again, dir.join("الصبر عند الصدمة الأولى (1).mp4"));
        assert_eq!(std::fs::read_to_string(&again).unwrap(), "old");
        // الاسم نفسه: لا شيء يتغيّر
        assert_eq!(rename_with_sidecar(&again, "الصبر عند الصدمة الأولى (1)").unwrap(), again);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_are_safe_and_free() {
        assert_eq!(safe_name("a/b:c*? <d>.  "), "a b c d");
        assert_eq!(safe_name("con"), "_con");
        assert_eq!(safe_name("..."), "Khama");
        assert_eq!(safe_name(&"ب".repeat(300)).chars().count(), 120);
        let dir = std::env::temp_dir().join(format!("khama-tl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.edl"), "").unwrap();
        assert_eq!(free_base(&dir, "x", &[".xml", ".edl"]), "x (1)");
        assert_eq!(free_base(&dir, "y", &[".xml", ".edl"]), "y");
        std::fs::write(dir.join("z markers.edl"), "").unwrap();
        assert_eq!(free_base(&dir, "z", &[".xml", " markers.edl"]), "z (1)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// على ملف حقيقي: الصمت بالكود نفسه، ثم تايم لاين «بلا صمت» بهامش 0.15 ث كما في الواجهة.
    /// `KHAMA_TL_INPUT=<ملف> KHAMA_TL_OUT=<مجلد> cargo test --lib real_file_timeline -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_file_timeline() {
        use std::{process::Command, sync::atomic::AtomicBool};
        let input = PathBuf::from(std::env::var("KHAMA_TL_INPUT").expect("KHAMA_TL_INPUT"));
        let out = PathBuf::from(std::env::var("KHAMA_TL_OUT").expect("KHAMA_TL_OUT"));
        let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/ffmpeg/bin");
        let probe = Command::new(bin.join("ffprobe"))
            .args(["-v", "error", "-show_format", "-show_streams", "-of", "json"])
            .arg(&input)
            .output()
            .unwrap();
        let m = media_from_probe(&input, &serde_json::from_slice(&probe.stdout).unwrap()).unwrap();
        let t0 = std::time::Instant::now();
        let lv = crate::convert::silence::levels_blocking(
            Command::new(bin.join("ffmpeg")),
            &input,
            None,
            None,
            |_| {},
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        let (silences, threshold) = crate::convert::silence::find_silences(&lv, None, None);
        let detect_ms = t0.elapsed().as_millis();
        // silenceCuts ثم keptPieces في الواجهة
        let cuts: Vec<[f64; 2]> = silences
            .iter()
            .map(|[s, e]| [s + 0.15, e - 0.15])
            .filter(|[s, e]| e - s > 0.01)
            .collect();
        let dur = m.rate.secs(m.frames);
        let mut pieces = Vec::new();
        let mut at = 0.0;
        for [s, e] in &cuts {
            if *s > at {
                pieces.push([at, *s]);
            }
            at = f64::max(at, *e);
        }
        if dur > at {
            pieces.push([at, dur]);
        }
        let name = format!("{} timeline", input.file_stem().unwrap().to_string_lossy());
        let req = TimelineRequest {
            input: input.to_string_lossy().into_owned(),
            pieces: pieces.clone(),
            cues: vec![],
            name: name.clone(),
            keep_cuts: false,
            markers: vec![],
            markers_only: false,
        };
        let t1 = std::time::Instant::now();
        let files = render(&req, &m).unwrap();
        let render_us = t1.elapsed().as_micros();
        let mut sizes = Vec::new();
        for (ext, body) in &files {
            std::fs::write(out.join(format!("{name}{ext}")), body).unwrap();
            sizes.push(format!("{ext} {} B", body.len()));
        }
        // العلامات (R3-F11): كل صمت علامة حمراء على الملف كله
        let marks_req = TimelineRequest {
            input: input.to_string_lossy().into_owned(),
            pieces: vec![],
            cues: vec![],
            name: format!("{} silence markers", input.file_stem().unwrap().to_string_lossy()),
            keep_cuts: false,
            markers: silences
                .iter()
                .enumerate()
                .map(|(i, [s, e])| TimelineMarker {
                    start: *s,
                    end: *e,
                    name: format!("Silence {}", i + 1),
                    note: format!("{:.1} s", e - s),
                    color: "Red".into(),
                })
                .collect(),
            markers_only: true,
        };
        let mut marker_sizes = Vec::new();
        for (tail, body) in render(&marks_req, &m).unwrap() {
            std::fs::write(out.join(format!("{}{tail}", marks_req.name)), &body).unwrap();
            marker_sizes.push(format!("{tail} {} B", body.len()));
        }
        let clips = layout(&pieces, m.rate, m.frames);
        let kept: f64 = pieces.iter().map(|[a, b]| b - a).sum();
        let mut stats = serde_json::json!({
            "file": input.file_name().unwrap().to_string_lossy(),
            "duration_s": dur, "fps": m.rate.fps, "video": m.video, "audio": m.audio,
            "threshold_db": threshold, "silences": silences.len(), "detect_ms": detect_ms,
            "clips": clips.len(), "kept_s": kept, "timeline_s": m.rate.secs(total(&clips)),
            "saved_s": dur - kept, "render_us": render_us, "files": sizes, "silence_marker_files": marker_sizes,
        });
        // المشاهد (فيديو فقط): قطع عند كل تغيّر، كما يفعل scenePieces في الواجهة
        if m.video.is_some() {
            let t2 = std::time::Instant::now();
            let a = crate::scenes::analyze_blocking(
                Command::new(bin.join("ffmpeg")),
                &input,
                None,
                None,
                |_| {},
                &AtomicBool::new(false),
            )
            .unwrap()
            .unwrap();
            let found: Vec<[f64; 2]> = crate::scenes::detect(&a.frames, &crate::scenes::Params::default())
                .iter()
                .map(|b| b.marker())
                .collect();
            let scenes_ms = t2.elapsed().as_millis();
            let mut points: Vec<f64> = found.iter().map(|[s, e]| (s + e) / 2.0).filter(|x| *x > 0.001).collect();
            points.sort_by(f64::total_cmp);
            points.insert(0, 0.0);
            points.push(1e9);
            let pieces: Vec<[f64; 2]> = points.windows(2).map(|w| [w[0], w[1]]).filter(|[a, b]| b - a > 0.001).collect();
            let name = format!("{} scenes", input.file_stem().unwrap().to_string_lossy());
            let req = TimelineRequest {
                input: input.to_string_lossy().into_owned(),
                pieces: pieces.clone(),
                cues: vec![],
                name: name.clone(),
                keep_cuts: true,
                markers: vec![],
                markers_only: false,
            };
            let files = render(&req, &m).unwrap();
            for (ext, body) in &files {
                std::fs::write(out.join(format!("{name}{ext}")), body).unwrap();
            }
            let scene_marks = TimelineRequest {
                name: format!("{} scene markers", input.file_stem().unwrap().to_string_lossy()),
                pieces: vec![],
                keep_cuts: false,
                markers: found
                    .iter()
                    .enumerate()
                    .map(|(i, [s, e])| TimelineMarker {
                        start: *s,
                        end: *e,
                        name: format!("Scene {}", i + 2),
                        note: String::new(),
                        color: "Cyan".into(),
                    })
                    .collect(),
                markers_only: true,
                ..req
            };
            // بلا تغيّر مشهد لا علامات: الخطأ markersEmpty كما في التطبيق
            for (tail, body) in render(&scene_marks, &m).unwrap_or_default() {
                std::fs::write(out.join(format!("{}{tail}", scene_marks.name)), &body).unwrap();
            }
            let clips = layout_with(&pieces, m.rate, m.frames, false);
            stats["scenes"] = serde_json::json!({
                "changes": found.len(), "clips": clips.len(), "detect_ms": scenes_ms,
                "timeline_frames": total(&clips), "file_frames": m.frames,
                "first": found.iter().take(5).collect::<Vec<_>>(),
            });
        }
        std::fs::write(
            out.join(format!("{}.stats.json", input.file_stem().unwrap().to_string_lossy())),
            stats.to_string(),
        )
        .unwrap();
        println!(
            "
{stats}"
        );
    }
}
