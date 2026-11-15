use super::*;

// ======================= الكشف (مشاهد، سواد، صمت) =======================

pub fn detect_args(kind: &str, input: &str, o: &ConvertOptions) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin"].iter().map(|s| s.to_string()).collect();
    if let Some(st) = o.start.filter(|v| *v > 0.0) {
        a.extend(["-ss".into(), format!("{st:.3}")]);
    }
    if let Some(e) = o.end {
        a.extend(["-to".into(), format!("{e:.3}")]);
    }
    a.extend(["-copyts".into(), "-i".into(), input.to_string()]);
    match kind {
        "detect_silence" => a.extend(
            ["-map", "0:a:0", "-af", "silencedetect=n=-40dB:d=0.6"]
                .iter()
                .map(|s| s.to_string()),
        ),
        "detect_black" => a.extend(
            ["-map", "0:v:0", "-vf", "blackdetect=d=0.3:pix_th=0.10"]
                .iter()
                .map(|s| s.to_string()),
        ),
        // تصغير الصورة قبل التحليل = أسرع بكثير وبنفس الدقة تقريبًا
        _ => a.extend(
            ["-map", "0:v:0", "-vf", "scale=320:-2,select='gt(scene,0.32)',showinfo"]
                .iter()
                .map(|s| s.to_string()),
        ),
    }
    a.extend(["-progress", "pipe:1", "-nostats", "-f", "null", "-"].iter().map(|s| s.to_string()));
    a
}

pub(super) fn field_after(line: &str, key: &str) -> Option<f64> {
    let i = line.find(key)? + key.len();
    let rest = line[i..].trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    num(&rest[..end])
}

/// يقرأ نتائج الكشف من مخرجات FFmpeg (stderr)
pub fn parse_markers(kind: &str, log: &str) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    match kind {
        "detect_black" => {
            for l in log.lines().filter(|l| l.contains("black_start")) {
                if let (Some(s), Some(e)) = (field_after(l, "black_start:"), field_after(l, "black_end:")) {
                    out.push([s, e]);
                }
            }
        }
        "detect_silence" => {
            let mut open: Option<f64> = None;
            for l in log.lines() {
                if let Some(s) = field_after(l, "silence_start:") {
                    open = Some(s);
                } else if let Some(e) = field_after(l, "silence_end:") {
                    out.push([open.take().unwrap_or(e).max(0.0), e]);
                }
            }
        }
        _ => {
            for l in log.lines().filter(|l| l.contains("Parsed_showinfo") && l.contains("pts_time:")) {
                if let Some(t) = field_after(l, "pts_time:") {
                    out.push([t, t]);
                }
            }
        }
    }
    out
}
