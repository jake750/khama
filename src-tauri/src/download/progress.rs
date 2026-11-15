// ======================= قراءة أسطر التقدّم =======================

pub(crate) fn num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

pub(super) struct DlProgress {
    pub(super) finished: bool,
    pub(super) stage: &'static str,
    pub(super) percent: Option<f64>,
    pub(super) speed: Option<f64>,
    pub(super) eta: Option<f64>,
}

/// "KHAMA_DL downloading|1024|433081|NA|144344.3|3|avc1.4D400C|none|NA|NA"
pub(super) fn parse_dl_line(rest: &str) -> Option<DlProgress> {
    let f: Vec<&str> = rest.split('|').collect();
    if f.len() < 10 {
        return None;
    }
    let downloaded = num(f[1]);
    let total = num(f[2]).or(num(f[3]));
    let mut percent = match (downloaded, total) {
        (Some(d), Some(t)) if t > 0.0 => Some(d / t * 100.0),
        _ => None,
    };
    if percent.is_none() {
        // بث مقسّم إلى أجزاء (HLS/DASH): نحسب بعدد الأجزاء
        if let (Some(i), Some(c)) = (num(f[8]), num(f[9]))
            && c > 0.0
        {
            percent = Some(i / c * 100.0);
        }
    }
    let (v, a) = (f[6], f[7]);
    let stage = if v == "none" && a != "none" {
        "audio"
    } else if v != "none" && v != "NA" && a == "none" {
        "video"
    } else {
        "file"
    };
    Some(DlProgress {
        finished: f[0] == "finished",
        stage,
        percent: percent.map(|p| p.clamp(0.0, 100.0)),
        speed: num(f[4]),
        eta: num(f[5]),
    })
}
