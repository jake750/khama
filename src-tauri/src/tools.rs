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
    /// البرنامج الذي نشغّله لـ yt-dlp (على الهاتف: Python، و yt-dlp أول وسيط له)
    pub ytdlp: PathBuf,
    /// وسائط تسبق وسائط yt-dlp (فارغة على الكمبيوتر)
    pub ytdlp_prefix: Vec<String>,
    /// متغيرات بيئة إضافية لكل الأدوات (مكتبات Python/FFmpeg على الهاتف)
    pub env: Vec<(String, String)>,
    /// محرّك JavaScript ليوتيوب: "deno:<path>" على الكمبيوتر، "quickjs:<path>" على الهاتف
    pub js_runtime: String,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// يُمرَّر لـ yt-dlp عبر --ffmpeg-location (مجلد على الكمبيوتر، ملف ffmpeg نفسه على الهاتف)
    pub ffmpeg_dir: PathBuf,
}

#[cfg_attr(mobile, allow(dead_code))]
fn exe_dir() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe()?;
    Ok(exe.parent().map(Path::to_path_buf).unwrap_or_default())
}

#[cfg_attr(mobile, allow(dead_code))]
fn bundled_ytdlp() -> Result<PathBuf, AppError> {
    Ok(exe_dir()?.join(format!("khama-yt-dlp{EXE}")))
}

#[cfg_attr(mobile, allow(dead_code))]
fn managed_ytdlp(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| AppError::with_detail("dataDir", e.to_string()))?
        .join("bin");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("yt-dlp{EXE}")))
}

fn missing(name: &str, path: &Path) -> AppError {
    AppError::with_param("toolMissing", name, path.display().to_string())
}

#[cfg(mobile)]
pub fn resolve(app: &AppHandle) -> Result<Tools, AppError> {
    let p = crate::mobile::paths(app)?;
    Ok(Tools {
        ytdlp: PathBuf::from(&p.python),
        ytdlp_prefix: vec![p.ytdlp.clone()],
        env: p.env.into_iter().collect(),
        js_runtime: format!("quickjs:{}", p.quickjs),
        ffmpeg: PathBuf::from(&p.ffmpeg),
        ffprobe: PathBuf::from(&p.ffprobe),
        ffmpeg_dir: PathBuf::from(&p.ffmpeg),
    })
}

#[cfg(desktop)]
pub fn resolve(app: &AppHandle) -> Result<Tools, AppError> {
    let managed = managed_ytdlp(app)?;
    let ytdlp = if managed.exists() { managed } else { bundled_ytdlp()? };
    let deno = exe_dir()?.join(format!("khama-deno{EXE}"));
    let ffmpeg_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::with_detail("resourceDir", e.to_string()))?
        .join("ffmpeg")
        .join("bin");
    if !deno.exists() {
        return Err(missing("Deno", &deno));
    }
    let tools = Tools {
        ffmpeg: ffmpeg_dir.join(format!("ffmpeg{EXE}")),
        ffprobe: ffmpeg_dir.join(format!("ffprobe{EXE}")),
        ytdlp,
        ytdlp_prefix: Vec::new(),
        env: Vec::new(),
        js_runtime: format!("deno:{}", deno.to_string_lossy()),
        ffmpeg_dir,
    };
    for (name, p) in [
        ("yt-dlp", &tools.ytdlp),
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
        tools.js_runtime.clone(),
    ]
}

/// أمر yt-dlp جاهز (مع Python ومتغيرات البيئة على الهاتف)
pub fn ytdlp_command(tools: &Tools) -> Command {
    let mut c = command(&tools.ytdlp);
    c.args(&tools.ytdlp_prefix).envs(tools.env.iter().map(|(k, v)| (k, v)));
    c
}

/// أمر ffmpeg جاهز
pub fn ffmpeg_command(tools: &Tools) -> Command {
    let mut c = command(&tools.ffmpeg);
    c.envs(tools.env.iter().map(|(k, v)| (k, v)));
    c
}

/// يشغّل yt-dlp وينتظر مخرجاته كاملة
pub async fn run_ytdlp(tools: &Tools, args: &[&str]) -> Result<(bool, String, String), AppError> {
    let out = ytdlp_command(tools)
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

#[cfg_attr(mobile, allow(dead_code))]
async fn first_line(program: &Path, arg: &str) -> Option<String> {
    let (_, out, _) = run_capture(program, &[arg]).await.ok()?;
    out.lines().next().map(|l| l.trim().to_string())
}

/// على الهاتف: نفكّ الأدوات مبكرًا في الخلفية حتى يكون أول تنزيل سريعًا
#[cfg(mobile)]
pub async fn ensure_managed_ytdlp(app: &AppHandle) -> Result<(), AppError> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::mobile::paths(&app).map(|_| ()))
        .await
        .map_err(|e| AppError::with_detail("toolsSetup", e.to_string()))?
}

/// أول تشغيل (أو بعد تحديث التطبيق): انسخ yt-dlp المضمّن إلى مجلد البيانات
/// إن لم يكن موجودًا هناك، أو إن كانت النسخة المضمّنة أحدث.
#[cfg(desktop)]
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

async fn version_of(mut cmd: Command, arg: &str) -> Option<String> {
    let out = cmd.arg(arg).stdout(Stdio::piped()).stderr(Stdio::null()).output().await.ok()?;
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string())
}

#[tauri::command]
pub async fn tools_info(app: AppHandle) -> Result<ToolsInfo, AppError> {
    let t = resolve(&app)?;
    let js = t.js_runtime.split_once(':').map(|(_, p)| PathBuf::from(p)).unwrap_or_default();
    let js_cmd = command(&js);
    let (ytdlp, ffmpeg, deno) = tokio::join!(
        version_of(ytdlp_command(&t), "--version"),
        version_of(ffmpeg_command(&t), "-version"),
        version_of(js_cmd, "--version"),
    );
    Ok(ToolsInfo {
        ytdlp,
        // "ffmpeg version N-12345-gabc Copyright..." ← نأخذ رقم الإصدار فقط
        ffmpeg: ffmpeg.and_then(|l| l.split_whitespace().nth(2).map(str::to_string)),
        // "deno 2.x.y" أو "QuickJS version 2025-04-26": نأخذ أول كلمة تبدأ برقم
        deno: deno.and_then(|l| l.split_whitespace().find(|w| w.starts_with(|c: char| c.is_ascii_digit())).map(str::to_string)),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    version: Option<String>,
    updated: bool,
}

/// تحديث yt-dlp على الهاتف: عبر مكتبة youtubedl-android
#[cfg(mobile)]
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<UpdateResult, AppError> {
    let r = tauri::async_runtime::spawn_blocking(move || crate::mobile::update_ytdlp(&app))
        .await
        .map_err(|e| AppError::with_detail("updateFailed", e.to_string()))??;
    Ok(UpdateResult { updated: r.updated, version: r.version })
}

/// تحديث yt-dlp: يتصل بـ GitHub فقط عندما يضغط المستخدم الزر
#[cfg(desktop)]
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
        return Err(AppError::with_detail("updateFailed", crate::errors::tail(&raw, 12)));
    }
    let after = first_line(&path, "--version").await;
    Ok(UpdateResult { updated: before != after, version: after })
}
