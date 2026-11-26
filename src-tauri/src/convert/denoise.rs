//! إزالة الضجيج من الكلام: RNNoise عبر مرشّح arnndn في FFmpeg المضمّن.
//!
//! النموذج `std.rnnn` (المرفق أصلًا مع RNNoise من Xiph، رخصة BSD-3، ~300 KB) يُنزَّل عند أول استعمال
//! ويُفحص بـ SHA-256 كنموذج الفصل. أسرع من الوقت الحقيقي بنحو 70 مرة على المعالج.
//! جُرّب afftdn وanlmdn (بلا نموذج) على تسجيل صوتي حقيقي: لم يخفضا ما بين الكلمات (صدى الغرفة والنَّفَس
//! ليسا ضجيجًا ثابتًا)، وRNNoise خفضه من −39 إلى −71 dB مع بقاء الكلام. انظر docs/PLAN-REELS.md.

use std::path::PathBuf;

use tokio::sync::watch;

use super::*;
use crate::separate;

const MODEL_URL: &str = "https://raw.githubusercontent.com/richardpl/arnndn-models/0fda24c46d78f0207d820bb970fbe85c1971b39c/std.rnnn";
const MODEL_SHA: &str = "6b8943dc4a9b6b24425873992a44f29c0577503276456af46a8854774faeb294";
const MODEL_NAME: &str = "rnnoise-std.rnnn";

/// المرشّح: RNNoise ثم رفع خفيف يعيد الكلام إلى مستواه (يخفضه النموذج نحو 2 dB)
pub fn filter(model_file: &str) -> String {
    format!("arnndn=m={model_file},volume=2dB,alimiter=limit=0.97")
}

/// ينزّل النموذج مرة واحدة. None = أُلغي
async fn ensure_model(c: &Ctx<'_>, cancel: &mut watch::Receiver<bool>) -> Result<Option<PathBuf>, AppError> {
    let dir = separate::ai_dir(c.app)?;
    std::fs::create_dir_all(&dir)?;
    let model = dir.join(MODEL_NAME);
    let ok = model.with_extension("rnnn.ok");
    if model.exists() && std::fs::read_to_string(&ok).is_ok_and(|s| s.trim() == MODEL_SHA) {
        return Ok(Some(model));
    }
    emit(
        c.app,
        JobUpdate {
            id: c.id,
            state: "preparing",
            ..Default::default()
        },
    );
    let tmp = dir.join("rnnoise.download");
    if !separate::fetch(c.app, MODEL_URL, &tmp, &mut |_| {}, cancel).await? {
        return Ok(None);
    }
    let hash = separate::sha256_async(&tmp).await?;
    if hash != MODEL_SHA {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::with_detail("aiChecksum", format!("{MODEL_URL}: {hash}")));
    }
    std::fs::rename(&tmp, &model)?;
    std::fs::write(&ok, MODEL_SHA)?;
    Ok(Some(model))
}

/// يكتب الملف بصوت نظيف: الفيديو يُنسخ كما هو، والصوت يُرمَّز (AAC، أو WAV لملف صوت)
pub(super) async fn run_denoise(
    c: &Ctx<'_>,
    p: &Preset,
    info: &MediaInfo,
    o: &ConvertOptions,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<(PathBuf, Option<Found>)>, AppError> {
    let src = PathBuf::from(&info.path);
    if info.audio.is_empty() {
        return Err(AppError::new("noAudioStream"));
    }
    let Some(model) = ensure_model(c, cancel).await? else {
        return Ok(None);
    };
    // المرشّح يقرأ النموذج باسم بسيط من مجلد العمل (مسار Windows فيه «:» يكسر صياغة المرشّح)
    std::fs::copy(&model, c.work.join("voice.rnnn"))?;
    let src_ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let ext = match (info.video.is_some(), src_ext.as_str()) {
        (true, "mp4" | "mov" | "mkv") => src_ext.as_str(),
        (true, _) => "mkv",
        (false, _) => "wav",
    };
    let dir = output_dir_for(c.app, o, &src)?;
    std::fs::create_dir_all(&dir).map_err(|e| AppError::with_detail("outputDirCreate", e.to_string()))?;
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let parts = PartDir::new(&dir)?;
    let temp = parts.0.join(format!("{}-part.{ext}", c.id));
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y"].iter().map(|s| s.to_string()).collect();
    let start = o.start.filter(|v| *v > 0.0);
    if let Some(s) = start {
        a.extend(["-ss".into(), format!("{s:.3}")]);
    }
    if let Some(e) = o.end {
        a.extend(["-to".into(), format!("{e:.3}")]);
    }
    a.extend(["-i".into(), info.path.clone()]);
    if info.video.is_some() {
        a.extend(["-map", "0:v:0", "-c:v", "copy"].iter().map(|s| s.to_string()));
    }
    a.extend(["-map".into(), "0:a:0".into(), "-af".into(), filter("voice.rnnn")]);
    if ext == "wav" {
        a.extend(["-c:a", "pcm_s16le"].iter().map(|s| s.to_string()));
    } else {
        a.extend(["-c:a", "aac", "-b:a", "256k"].iter().map(|s| s.to_string()));
    }
    a.extend(["-progress", "pipe:1", "-nostats"].iter().map(|s| s.to_string()));
    a.push(temp.to_string_lossy().into_owned());
    let dur = o.end.or(info.duration).unwrap_or(0.0) - start.unwrap_or(0.0);
    if run_ffmpeg(c.app, c.id, c.tools, &a, c.work, dur, "converting", cancel)
        .await?
        .is_none()
    {
        let _ = std::fs::remove_file(&temp);
        return Ok(None);
    }
    let dest = unique_path(&dir, &format!("{stem} [{}].{ext}", p.suffix));
    std::fs::rename(&temp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&dest);
        AppError::with_detail("moveFailed", e.to_string())
    })?;
    Ok(Some((deliver(c.app, dest).await?, None)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_uses_a_plain_model_name() {
        let f = filter("voice.rnnn");
        assert!(f.starts_with("arnndn=m=voice.rnnn,"));
        assert!(!std::path::Path::new("voice.rnnn").is_absolute());
    }
}
