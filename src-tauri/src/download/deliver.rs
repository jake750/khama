use super::*;

// ======================= نقل الملف النهائي =======================

/// اسم غير مستخدم: "اسم.mp4" ← "اسم (1).mp4" ← "اسم (2).mp4"
pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    (1..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|p| !p.exists())
        .expect("infinite iterator")
}

pub(super) async fn move_into(src: &Path, dir: &Path) -> Result<PathBuf, AppError> {
    let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("download");
    let dest = unique_path(dir, name);
    // rename يفشل إن كان المجلدان على قرصين مختلفين، فننسخ ثم نحذف
    if tokio::fs::rename(src, &dest).await.is_err() {
        tokio::fs::copy(src, &dest)
            .await
            .map_err(|e| AppError::with_detail("moveFailed", e.to_string()))?;
        let _ = tokio::fs::remove_file(src).await;
    }
    Ok(dest)
}
