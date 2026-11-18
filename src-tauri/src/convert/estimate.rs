//! تقدير الحجم بالقياس (A-30): الصيغ بجودة ثابتة (CRF) يتبع حجمها تعقيد الصورة،
//! فالمعادلة في الواجهة قد تخطئ بالضعف أو أكثر (التقرير §6.6). هنا نحوّل ثلاث
//! شرائح قصيرة من الملف بالإعدادات نفسها ونقيس حجمها ثم نضربه في المدة كلها.

use super::*;

/// ثلاث شرائح عند 20% و50% و80% من المقطع، بطول ثانية ونصف
const SLICES: [f64; 3] = [0.2, 0.5, 0.8];
const SLICE_SECS: f64 = 1.5;

/// بداية كل شريحة ونهايتها داخل [start, end]؛ مقطع قصير يُحوَّل كله في شريحة واحدة
pub(super) fn sample_windows(start: f64, end: f64) -> Vec<(f64, f64)> {
    let span = end - start;
    if span <= SLICE_SECS * SLICES.len() as f64 * 1.5 {
        return vec![(start, end)];
    }
    SLICES
        .iter()
        .map(|f| {
            let s = (start + span * f - SLICE_SECS / 2.0).clamp(start, end - SLICE_SECS);
            (s, s + SLICE_SECS)
        })
        .collect()
}

/// يُلغى التقدير السابق إن طُلب جديد (المستخدم غيّر الصيغة أو الجودة)
static CURRENT: std::sync::Mutex<Option<watch::Sender<bool>>> = std::sync::Mutex::new(None);

/// الحجم المتوقع بالبايت، أو None إن أُلغي أو لا ينطبق (ليست صيغة فيديو)
#[tauri::command]
pub async fn sample_estimate(app: AppHandle, path: String, preset_id: String, options: ConvertOptions) -> Result<Option<u64>, AppError> {
    let (tx, mut cancel) = watch::channel(false);
    if let Ok(mut cur) = CURRENT.lock()
        && let Some(old) = cur.replace(tx)
    {
        let _ = old.send(true);
    }
    let Some(p) = preset(&preset_id).filter(|p| p.kind == PKind::Video) else {
        return Ok(None);
    };
    let tools = tools::resolve(&app)?;
    let info = probe_file(&tools, Path::new(&path)).await?;
    let Some(duration) = info.duration.filter(|d| *d > 0.0) else {
        return Ok(None);
    };
    // ما يحتاج ملفات في مجلد العمل أو مرورًا ثانيًا لا يغيّر الحجم كثيرًا
    let base = ConvertOptions {
        hw: false,
        lut: None,
        subtitles: None,
        watermark: None,
        loudness: None,
        split_at: vec![],
        ..options.clone()
    };
    let full = build_plan(&p, &base, std::slice::from_ref(&info), &[], Path::new("x"), None)?.duration;
    let (start, end) = (base.start.unwrap_or(0.0), base.end.unwrap_or(duration).min(duration));
    let dir = std::env::temp_dir();
    let (mut bytes, mut secs) = (0u64, 0.0);
    for (i, (s, e)) in sample_windows(start, end).into_iter().enumerate() {
        let out = dir.join(format!("khama-estimate-{}-{i}.{}", std::process::id(), p.ext));
        let o = ConvertOptions {
            start: Some(s),
            end: Some(e),
            ..base.clone()
        };
        let plan = build_plan(&p, &o, std::slice::from_ref(&info), &[], &out, None)?;
        let mut cmd = tools::command(&tools.ffmpeg);
        cmd.args(&plan.args).current_dir(&dir);
        let outcome = run_streaming(cmd, &mut cancel, |_| {}).await;
        let size = std::fs::metadata(&out).map(|m| m.len()).ok();
        let _ = std::fs::remove_file(&out);
        match outcome? {
            RunOutcome::Exited { success: true, .. } => {}
            RunOutcome::Canceled => return Ok(None),
            RunOutcome::Exited { stderr, .. } => return Err(crate::errors::ffmpeg_error(&stderr, "encodeFailed", 14)),
        }
        bytes += size.unwrap_or(0);
        secs += plan.duration;
    }
    if secs <= 0.0 || bytes == 0 {
        return Ok(None);
    }
    Ok(Some((bytes as f64 * full / secs) as u64))
}
