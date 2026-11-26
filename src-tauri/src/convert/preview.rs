//! معاينة قبل/بعد (D-84): إطار واحد من المصدر وإطار واحد من الناتج بسلسلة الفلاتر نفسها
//! التي يبنيها `video_graph` (القص للنسبة، التدوير، LUT، العلامة المائية، التايم كود...)،
//! حتى يرى المستخدم ما سيخرج قبل أن ينتظر التحويل كله.

use super::*;

/// أكبر ضلع لصورة المعاينة
const PREVIEW_BOX: u32 = 480;

/// صورتا المعاينة كـ data URL
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PreviewFrames {
    pub source: Option<String>,
    pub output: Option<String>,
}

/// وسائط FFmpeg لإطار ناتج واحد عند `at` بفلاتر الصورة نفسها، يُكتب في `out` (JPEG صغير).
/// ما لا يغيّر إطارًا ثابتًا (المعدل، السرعة، الصوت) يُترك. LUT والترجمة يُقرآن من مجلد العمل
/// بالاسمين lut.cube وsub.<ext> كما في التحويل الحقيقي.
pub fn preview_args(p: &Preset, o: &ConvertOptions, info: &MediaInfo, at: f64, out: &Path) -> Result<Vec<String>, AppError> {
    let v = info.video.as_ref().ok_or_else(|| AppError::new("noVideoStream"))?;
    let o = ConvertOptions {
        fps: None,
        speed: None,
        hw: false,
        ..o.clone()
    };
    // ملف VFR يضيف fps=؛ لا معنى له لإطار واحد
    let v = VideoInfo { vfr: false, ..v.clone() };
    // الترجمة والتايم كود يتبعان توقيت المصدر، فنحافظ عليه بعد التقديم
    let keep_ts = o.subtitles.is_some() || o.timecode;
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let mut a = s(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
    if keep_ts {
        a.push("-copyts".into());
    }
    if at > 0.0 {
        a.extend(["-ss".into(), format!("{at:.3}")]);
    }
    a.extend(["-i".into(), info.path.clone()]);
    let wm_idx = (p.kind == PKind::Video).then_some(()).and(o.watermark.as_ref()).map(|path| {
        a.extend(["-i".into(), path.clone()]);
        1
    });
    // GIF: لوحة الألوان تحتاج المقطع كله، والمعاينة تكفيها الصورة قبلها
    let pk = if p.kind == PKind::Gif { PKind::Frame } else { p.kind };
    let p = Preset { kind: pk, ..*p };
    let graph = video_graph(&p, &o, &v, keep_ts, "[0:v:0]", &[], wm_idx);
    let fit = format!("scale={PREVIEW_BOX}:{PREVIEW_BOX}:force_original_aspect_ratio=decrease");
    a.extend([
        "-filter_complex".into(),
        format!("{graph};[vout]{fit}[pv]"),
        "-map".into(),
        "[pv]".into(),
    ]);
    a.extend(s(&["-frames:v", "1", "-update", "1", "-q:v", "4", "-an"]));
    a.push(out.to_string_lossy().into_owned());
    Ok(a)
}

/// امتدادات يُسمح بتشغيلها في المعاينة (صوت أو فيديو فقط)
const PLAYABLE: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "mkv", "mp3", "m4a", "aac", "wav", "flac", "ogg", "opus",
];

/// يسمح للواجهة بتشغيل ملف وسائط واحد عبر asset:// (المعاينة في نتيجة كشف الصمت).
/// النطاق يبدأ فارغًا، ولا يُضاف إليه إلا ملف وسائط موجود يطلبه المستخدم: لا مجلدات ولا ملفات أخرى.
#[tauri::command]
pub fn allow_media(app: AppHandle, path: String) -> Result<(), AppError> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !PLAYABLE.contains(&ext.as_str()) || !p.is_file() {
        return Err(AppError::with_detail("badInput", "not a playable media file"));
    }
    app.asset_protocol_scope()
        .allow_file(p)
        .map_err(|e| AppError::with_detail("badInput", e.to_string()))
}

/// يُلغى الطلب السابق إن طُلب جديد (المستخدم غيّر خيارًا)
static CURRENT: std::sync::Mutex<Option<watch::Sender<bool>>> = std::sync::Mutex::new(None);

/// إطار المصدر وإطار الناتج عند `at` ثانية، أو None إن أُلغي أو لا ينطبق (ليست صيغة صورة)
#[tauri::command]
pub async fn preview_frame(
    app: AppHandle,
    path: String,
    preset_id: String,
    options: ConvertOptions,
    at: f64,
) -> Result<Option<PreviewFrames>, AppError> {
    let (tx, mut cancel) = watch::channel(false);
    if let Ok(mut cur) = CURRENT.lock()
        && let Some(old) = cur.replace(tx)
    {
        let _ = old.send(true);
    }
    let Some(p) = preset(&preset_id).filter(|p| matches!(p.kind, PKind::Video | PKind::Gif | PKind::Frame | PKind::Sequence)) else {
        return Ok(None);
    };
    let tools = tools::resolve(&app)?;
    let info = probe_file(&tools, Path::new(&path)).await?;
    if info.video.is_none() {
        return Ok(None);
    }
    let at = at.clamp(0.0, (info.duration.unwrap_or(0.0) - 0.1).max(0.0));
    let work = std::env::temp_dir().join(format!("khama-preview-{}", std::process::id()));
    std::fs::create_dir_all(&work)?;
    let copy_in = |src: &Option<String>, name: &str| -> Result<(), AppError> {
        if let Some(s) = src {
            std::fs::copy(s, work.join(name)).map_err(|e| AppError::with_detail("badInput", format!("{s}: {e}")))?;
        }
        Ok(())
    };
    copy_in(&options.lut, "lut.cube")?;
    if let Some(sub) = &options.subtitles {
        copy_in(&options.subtitles, &format!("sub.{}", sub_ext(sub)))?;
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let out = work.join(format!("after-{n}.jpg"));
    let _ = std::fs::remove_file(&out);
    let args = preview_args(&p, &options, &info, at, &out)?;
    let mut cmd = tools::command(&tools.ffmpeg);
    cmd.args(&args).current_dir(&work);
    let outcome = tokio::time::timeout(Duration::from_secs(30), run_streaming(cmd, &mut cancel, |_| {})).await;
    let output = match outcome {
        Ok(Ok(RunOutcome::Canceled)) => return Ok(None),
        Ok(Ok(RunOutcome::Exited { success: true, .. })) => std::fs::read(&out).ok().map(|b| {
            use base64::Engine;
            format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))
        }),
        Ok(Ok(RunOutcome::Exited { stderr, .. })) => return Err(crate::errors::ffmpeg_error(&stderr, "encodeFailed", 14)),
        Ok(Err(e)) => return Err(e),
        Err(_) => None,
    };
    let _ = std::fs::remove_file(&out);
    if *cancel.borrow() {
        return Ok(None);
    }
    let source = small_jpeg(&tools, Path::new(&path).as_os_str(), at, PREVIEW_BOX, 4).await;
    Ok(Some(PreviewFrames { source, output }))
}
