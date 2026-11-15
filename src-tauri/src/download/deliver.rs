use super::*;

// ======================= نقل الملف النهائي =======================

/// اسم غير مستخدم: "اسم.mp4" ← "اسم (1).mp4" ← "اسم (2).mp4"
pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    reserve(dir, name, |p| {
        std::fs::OpenOptions::new().write(true).create_new(true).open(p).map(drop)
    })
}

/// مثل unique_path لمجلد: يُنشأ المجلد فارغًا ويُعاد مساره
pub(crate) fn unique_dir(dir: &Path, name: &str) -> PathBuf {
    reserve(dir, name, |p| std::fs::create_dir(p))
}

/// يحجز أول اسم غير مستخدم: "name"، ثم "name (1)"، "name (2)"...
/// الحجز ذرّي (create_new / create_dir يفشلان إن سبقنا أحد)، فعمليتان تنتهيان معًا
/// لا تأخذان نفس الاسم ولا يكتب إحداهما فوق الأخرى (T-47). المستدعي يستبدل الحجز بالملف الحقيقي.
fn reserve(dir: &Path, name: &str, create: impl Fn(&Path) -> std::io::Result<()>) -> PathBuf {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let candidates = std::iter::once(dir.join(name)).chain((1..).map(|i| dir.join(format!("{stem} ({i}){ext}"))));
    for p in candidates {
        match create(&p) {
            Ok(()) => return p,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            // لا يمكن الحجز (المجلد غير موجود مثلًا): الخطوة التالية تُظهر الخطأ الحقيقي
            Err(_) => return p,
        }
    }
    unreachable!("infinite iterator")
}

pub(super) async fn move_into(src: &Path, dir: &Path) -> Result<PathBuf, AppError> {
    let name = src.file_name().and_then(|s| s.to_str()).unwrap_or("download");
    let dest = unique_path(dir, name);
    // rename يفشل إن كان المجلدان على قرصين مختلفين، فننسخ ثم نحذف
    if tokio::fs::rename(src, &dest).await.is_err() {
        if let Err(e) = tokio::fs::copy(src, &dest).await {
            let _ = tokio::fs::remove_file(&dest).await;
            return Err(AppError::with_detail("moveFailed", e.to_string()));
        }
        let _ = tokio::fs::remove_file(src).await;
    }
    Ok(dest)
}
