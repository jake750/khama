//! تحديد أماكن الأدوات المضمّنة وتشغيلها.
//!
//! - khama-yt-dlp و khama-deno: ملفات "sidecar" يضعها Tauri بجانب ملف التطبيق التنفيذي.
//! - ffmpeg و ffprobe: داخل مجلد الموارد (resources/ffmpeg/bin).
//!
//! لماذا ننسخ yt-dlp إلى مجلد بيانات التطبيق؟
//! لأن مجلد التثبيت غالبًا للقراءة فقط (Program Files، أو داخل .app على macOS)،
//! وyt-dlp يحتاج أن يستبدل نفسه عند التحديث (yt-dlp -U). فننسخه مرة واحدة إلى
//! مجلد قابل للكتابة ونحدّثه هناك.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::process::Command;

use crate::errors::AppError;

pub const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

pub struct Tools {
    pub ytdlp: PathBuf,
    pub deno: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// المجلد الذي فيه ffmpeg (يُمرَّر لـ yt-dlp عبر --ffmpeg-location)
    pub ffmpeg_dir: PathBuf,
}

fn exe_dir() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe()?;
    Ok(exe.parent().map(Path::to_path_buf).unwrap_or_default())
}

fn bundled_ytdlp() -> Result<PathBuf, AppError> {
    Ok(exe_dir()?.join(format!("khama-yt-dlp{EXE}")))
}

fn managed_ytdlp(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| AppError::with_detail("تعذّر تحديد مجلد بيانات التطبيق.", e.to_string()))?
        .join("bin");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("yt-dlp{EXE}")))
}

fn missing(name: &str, path: &Path) -> AppError {
    AppError::with_detail(
        format!("الأداة {name} غير موجودة. أعد تثبيت التطبيق."),
        path.display().to_string(),
    )
}

pub fn resolve(app: &AppHandle) -> Result<Tools, AppError> {
    let managed = managed_ytdlp(app)?;
    let ytdlp = if managed.exists() { managed } else { bundled_ytdlp()? };
    let deno = exe_dir()?.join(format!("khama-deno{EXE}"));
    let ffmpeg_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::with_detail("تعذّر تحديد مجلد موارد التطبيق.", e.to_string()))?
        .join("ffmpeg")
        .join("bin");
    let tools = Tools {
        ffmpeg: ffmpeg_dir.join(format!("ffmpeg{EXE}")),
        ffprobe: ffmpeg_dir.join(format!("ffprobe{EXE}")),
        ytdlp,
        deno,
        ffmpeg_dir,
    };
    for (name, p) in [
        ("yt-dlp", &tools.ytdlp),
        ("Deno", &tools.deno),
        ("FFmpeg", &tools.ffmpeg),
        ("FFprobe", &tools.ffprobe),
    ] {
        if !p.exists() {
            return Err(missing(name, p));
        }
    }
    Ok(tools)
}

/// أمر جاهز لتشغيل أداة: بلا نافذة سوداء على Windows، وبترميز UTF-8 (للعناوين العربية)
pub fn command(program: &Path) -> Command {
    let mut c = Command::new(program);
    c.stdin(Stdio::null())
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        // مجموعة عمليات خاصة، حتى نستطيع إيقاف yt-dlp وكل ما شغّله (ffmpeg) معًا عند الإلغاء
        c.process_group(0);
    }
    c
}

/// الخيارات المشتركة لكل استدعاءات yt-dlp
pub fn ytdlp_base_args(tools: &Tools) -> Vec<String> {
    vec![
        "--ignore-config".into(), // لا نتأثر بملف إعدادات yt-dlp لو وُجد على الجهاز
        "--encoding".into(),
        "utf-8".into(),
        "--no-playlist".into(),
        "--ffmpeg-location".into(),
        tools.ffmpeg_dir.to_string_lossy().into_owned(),
        "--js-runtimes".into(),
        format!("deno:{}", tools.deno.to_string_lossy()),
    ]
}

/// يشغّل أداة وينتظر مخرجاتها كاملة
pub async fn run_capture(program: &Path, args: &[&str]) -> Result<(bool, String, String), AppError> {
    let out = command(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

async fn first_line(program: &Path, arg: &str) -> Option<String> {
    let (_, out, _) = run_capture(program, &[arg]).await.ok()?;
    out.lines().next().map(|l| l.trim().to_string())
}

/// أول تشغيل (أو بعد تحديث التطبيق): انسخ yt-dlp المضمّن إلى مجلد البيانات
/// إن لم يكن موجودًا هناك، أو إن كانت النسخة المضمّنة أحدث.
pub async fn ensure_managed_ytdlp(app: &AppHandle) -> Result<(), AppError> {
    let bundled = bundled_ytdlp()?;
    let managed = managed_ytdlp(app)?;
    if !bundled.exists() {
        return Ok(()); // لا شيء لننسخه؛ resolve() سيبلّغ عن النقص
    }
    let copy = if !managed.exists() {
        true
    } else {
        // إصدارات yt-dlp بصيغة YYYY.MM.DD، فالمقارنة النصية تكفي
        let b = first_line(&bundled, "--version").await.unwrap_or_default();
        let m = first_line(&managed, "--version").await.unwrap_or_default();
        b > m
    };
    if copy {
        tokio::fs::copy(&bundled, &managed).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

// ---------------- أوامر تستدعيها الواجهة ----------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsInfo {
    ytdlp: Option<String>,
    ffmpeg: Option<String>,
    deno: Option<String>,
}

#[tauri::command]
pub async fn tools_info(app: AppHandle) -> Result<ToolsInfo, AppError> {
    let t = resolve(&app)?;
    let (ytdlp, ffmpeg, deno) = tokio::join!(
        first_line(&t.ytdlp, "--version"),
        first_line(&t.ffmpeg, "-version"),
        first_line(&t.deno, "--version"),
    );
    Ok(ToolsInfo {
        ytdlp,
        // "ffmpeg version N-12345-gabc Copyright..." ← نأخذ رقم الإصدار فقط
        ffmpeg: ffmpeg.and_then(|l| l.split_whitespace().nth(2).map(str::to_string)),
        deno: deno.and_then(|l| l.split_whitespace().nth(1).map(str::to_string)),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    version: Option<String>,
    updated: bool,
}

/// تحديث yt-dlp: يتصل بـ GitHub فقط عندما يضغط المستخدم الزر
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<UpdateResult, AppError> {
    ensure_managed_ytdlp(&app).await?;
    let path = managed_ytdlp(&app)?;
    if !path.exists() {
        return Err(missing("yt-dlp", &path));
    }
    let before = first_line(&path, "--version").await;
    let (ok, out, err) = run_capture(&path, &["-U"]).await?;
    if !ok {
        let raw = format!("{out}\n{err}");
        let mut e = crate::errors::friendly_ytdlp_error(&raw);
        if !raw.to_lowercase().contains("unable to download") {
            e.message = "تعذّر تحديث yt-dlp. تحقق من اتصالك بالإنترنت ثم أعد المحاولة.".into();
        }
        return Err(e);
    }
    let after = first_line(&path, "--version").await;
    Ok(UpdateResult { updated: before != after, version: after })
}
