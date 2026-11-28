//! إزالة الموسيقى (أو الصوت البشري) بالذكاء الاصطناعي.
//!
//! نستخدم نموذج MDX-Net المفتوح (UVR-MDX-NET-Voc_FT) عبر ONNX Runtime.
//! كلاهما لا يُضمَّن في التطبيق: يُنزَّلان مرة واحدة عند أول استخدام (~140MB على Windows)،
//! ونتحقق من بصمة SHA-256 لكل ملف قبل استخدامه.
//! على أندرويد: ONNX Runtime مضمّن في التطبيق (من Maven)، والنموذج وحده يُنزَّل.
//!
//! طريقة العمل باختصار:
//!   1. ffmpeg يفك صوت الملف إلى أرقام (44.1kHz ستيريو)
//!   2. نقسّم الصوت إلى قطع (~6 ثوانٍ)، ونحوّل كل قطعة إلى طيف ترددي (STFT)
//!   3. النموذج يتوقع طيف "الصوت البشري" وحده
//!   4. نعيده إلى موجة صوتية (iSTFT). الموسيقى = الأصل − الصوت البشري
//!   5. ffmpeg يكتب الناتج، ويعيد تركيبه مع الفيديو إن وُجد

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use rustfft::{Fft, FftPlanner, num_complex::Complex};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex as AsyncMutex, watch};

use crate::{
    download::{JobUpdate, emit},
    errors::{AppError, tail},
    tools::{self, Tools},
};

// ======================= الملفات المطلوبة =======================

struct Asset {
    url: &'static str,
    sha256: &'static str,
    size: u64,
    /// الملف المطلوب داخل الأرشيف (None = الملف نفسه)
    member: Option<&'static str>,
    /// اسمه النهائي داخل مجلد ai
    name: &'static str,
}

/// نموذج فصل من عائلة MDX-Net: ملفه، وإعداداته (من ملف إعدادات UVR الرسمي model_data.json)،
/// وأيّ الجزأين يتنبأ به
pub struct SepModel {
    pub id: &'static str,
    asset: Asset,
    /// نسخ احتياطية للملف نفسه (T-39): المصدر الأصلي مستودع طرف ثالث قد يُحذف. كل نسخة تُفحص
    /// بالبصمة نفسها، فنسخة معدّلة تُرفض كما يُرفض الأصل
    mirrors: &'static [&'static str],
    pub cfg: MdxConfig,
    /// النموذج يتنبأ بالجزء الآخر (الموسيقى مع الأصوات الخلفية): الصوت = الخليط − التنبؤ
    pub predicts_other: bool,
}

/// إزالة الموسيقى (الافتراضي): UVR-MDX-NET-Voc_FT
pub const VOICE: SepModel = SepModel {
    id: "voice",
    asset: Asset {
        url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx",
        sha256: "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111",
        size: 66_762_490,
        member: None,
        name: "UVR-MDX-NET-Voc_FT.onnx",
    },
    // Hugging Face يعلن البصمة في X-Linked-ETag، وطابقت عند الإضافة 2026-11-17
    mirrors: &[
        "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Voc_FT.onnx",
        "https://huggingface.co/AI4future/RVC/resolve/main/UVR-MDX-NET-Voc_FT.onnx",
    ],
    cfg: VOC_FT,
    predicts_other: false,
};

/// الصوت الأساسي وحده (يُسقط الأصوات الخلفية والمرددين مع الموسيقى): UVR_MDXNET_KARA_2.
/// يتنبأ بالمصاحبة (primary_stem = Instrumental)، والصوت الأساسي = الخليط − المصاحبة
pub const LEAD: SepModel = SepModel {
    id: "lead",
    asset: Asset {
        url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR_MDXNET_KARA_2.onnx",
        sha256: "bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4",
        size: 52_786_726,
        member: None,
        name: "UVR_MDXNET_KARA_2.onnx",
    },
    mirrors: &[
        "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR_MDXNET_KARA_2.onnx",
        "https://huggingface.co/AI4future/RVC/resolve/main/UVR_MDXNET_KARA_2.onnx",
    ],
    cfg: MdxConfig {
        n_fft: 5120,
        hop: 1024,
        dim_f: 2048,
        dim_t: 256,
        compensate: 1.065,
    },
    predicts_other: true,
};

impl SepModel {
    /// اسم ملفه داخل مجلد ai
    pub fn file_name(&self) -> &'static str {
        self.asset.name
    }
}

/// النموذج باسمه (والافتراضي إزالة الموسيقى)
pub fn sep_model(id: &str) -> &'static SepModel {
    match id {
        "lead" => &LEAD,
        _ => &VOICE,
    }
}

const ORT_BASE: &str = "https://github.com/microsoft/onnxruntime/releases/download/v1.22.0/";

#[cfg(all(windows, target_arch = "x86_64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    url: "onnxruntime-win-x64-1.22.0.zip",
    sha256: "174c616efc0271194488642a72f1a514e01487da4dfe84c49296d66e40ebe0da",
    size: 72_368_545,
    member: Some("onnxruntime-win-x64-1.22.0/lib/onnxruntime.dll"),
    name: "onnxruntime.dll",
});
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    url: "onnxruntime-osx-arm64-1.22.0.tgz",
    sha256: "cab6dcbd77e7ec775390e7b73a8939d45fec3379b017c7cb74f5b204c1a1cc07",
    size: 25_943_843,
    member: Some("onnxruntime-osx-arm64-1.22.0/lib/libonnxruntime.1.22.0.dylib"),
    name: "libonnxruntime.dylib",
});
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    url: "onnxruntime-osx-x86_64-1.22.0.tgz",
    sha256: "e4ec94a7696de74fb1b12846569aa94e499958af6ffa186022cfde16c9d617f0",
    size: 27_889_590,
    member: Some("onnxruntime-osx-x86_64-1.22.0/lib/libonnxruntime.1.22.0.dylib"),
    name: "libonnxruntime.dylib",
});
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    url: "onnxruntime-linux-x64-1.22.0.tgz",
    sha256: "8344d55f93d5bc5021ce342db50f62079daf39aaafb5d311a451846228be49b3",
    size: 7_798_730,
    member: Some("onnxruntime-linux-x64-1.22.0/lib/libonnxruntime.so.1.22.0"),
    name: "libonnxruntime.so",
});
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const RUNTIME: Option<Asset> = Some(Asset {
    url: "onnxruntime-linux-aarch64-1.22.0.tgz",
    sha256: "bb76395092d150b52c7092dc6b8f2fe4d80f0f3bf0416d2f269193e347e24702",
    size: 6_849_865,
    member: Some("onnxruntime-linux-aarch64-1.22.0/lib/libonnxruntime.so.1.22.0"),
    name: "libonnxruntime.so",
});
#[cfg(not(any(
    all(windows, target_arch = "x86_64"),
    target_os = "macos",
    all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))
)))]
#[cfg_attr(mobile, allow(dead_code))]
const RUNTIME: Option<Asset> = None;

/// تنزيل واحد في كل مرة (لو بدأ المستخدم عمليتين معًا)
static SETUP: AsyncMutex<()> = AsyncMutex::const_new(());
/// ONNX Runtime يُحمَّل مرة واحدة في عمر التطبيق
static ORT_READY: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();

pub(crate) fn ai_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| AppError::with_detail("dataDir", e.to_string()))?
        .join("ai"))
}

/// sha256_file خارج خيوط tokio: ملف 66–190 MB يأخذ ثانية تقريبًا
pub(crate) async fn sha256_async(path: &Path) -> std::io::Result<String> {
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || sha256_file(&path))
        .await
        .map_err(std::io::Error::other)?
}

pub(crate) fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// مسار curl: موجود افتراضيًا في Windows 10+ و macOS ومعظم توزيعات Linux
fn curl() -> PathBuf {
    if cfg!(windows) {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let p = Path::new(&sys).join("System32").join("curl.exe");
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("curl")
}

pub(crate) fn tar() -> PathBuf {
    if cfg!(windows) {
        // tar الخاص بـ Windows (bsdtar) يفك ملفات zip أيضًا
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        return Path::new(&sys).join("System32").join("tar.exe");
    }
    PathBuf::from("tar")
}

/// ينزّل ملفًا مع إرسال التقدّم (نقيس حجم الملف الجزئي) وإمكانية الإلغاء
pub(crate) async fn fetch(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    on_bytes: &mut (dyn FnMut(u64) + Send),
    cancel: &mut watch::Receiver<bool>,
) -> Result<bool, AppError> {
    let _ = std::fs::remove_file(dest);
    // أندرويد: بشبكة النظام نفسه (لا curl هناك، وتشغيل عملية جديدة أثقل)
    #[cfg(target_os = "android")]
    {
        let (app2, url2, dest2) = (app.clone(), url.to_string(), dest.to_path_buf());
        let mut task = tauri::async_runtime::spawn_blocking(move || crate::mobile::fetch_file(&app2, &url2, &dest2));
        loop {
            tokio::select! {
                r = &mut task => {
                    r.map_err(|e| AppError::with_detail("aiDownload", e.to_string()))??;
                    on_bytes(std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0));
                    return Ok(true);
                }
                _ = tokio::time::sleep(Duration::from_millis(300)) => {
                    on_bytes(std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0));
                }
                _ = crate::download::canceled(cancel) => {
                    crate::mobile::cancel_fetch(app);
                    let _ = task.await;
                    let _ = std::fs::remove_file(dest);
                    return Ok(false);
                }
            }
        }
    }
    #[allow(unreachable_code)]
    let _ = app;
    let mut cmd = tools::command(&curl());
    cmd.args(["-L", "--fail", "--silent", "--show-error", "--retry", "3", "-o"])
        .arg(dest)
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| AppError::with_detail("aiDownload", format!("curl: {e}")))?;
    loop {
        tokio::select! {
            status = child.wait() => {
                let status = status?;
                if !status.success() {
                    let mut err = String::new();
                    if let Some(mut s) = child.stderr.take() {
                        use tokio::io::AsyncReadExt;
                        let _ = s.read_to_string(&mut err).await;
                    }
                    return Err(AppError::with_detail("aiDownload", tail(&err, 5)));
                }
                on_bytes(std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0));
                return Ok(true);
            }
            _ = tokio::time::sleep(Duration::from_millis(300)) => {
                on_bytes(std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0));
            }
            _ = crate::download::canceled(cancel) => {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(dest);
                return Ok(false);
            }
        }
    }
}

/// يتأكد أن ONNX Runtime والنموذج موجودان وسليمان، وينزّلهما إن لزم.
/// يعيد (مسار المكتبة، مسار النموذج)، أو None إن ألغى المستخدم.
/// هل ملف النموذج سليم؟ الحجم في كل مرة، والبصمة مرة في كل تشغيل للتطبيق (وكلما تغيّر الملف):
/// الملف قد يتلف على القرص بعد تنزيله، ونموذج تالف يعطي ضجيجًا أو يُسقط ONNX (T-102).
/// ~60MB تُحسب في أقل من ثانية على خيط جانبي.
async fn model_intact(m: &SepModel, model: &Path) -> bool {
    use crate::errors::LockExt;
    static CHECKED: std::sync::Mutex<Option<(&str, u64, std::time::SystemTime)>> = std::sync::Mutex::new(None);
    let Ok(meta) = std::fs::metadata(model) else {
        return false;
    };
    if meta.len() != m.asset.size {
        return false;
    }
    let stamp = (m.id, meta.len(), meta.modified().unwrap_or(std::time::UNIX_EPOCH));
    if *CHECKED.lock_ok() == Some(stamp) {
        return true;
    }
    let path = model.to_path_buf();
    let hash = tauri::async_runtime::spawn_blocking(move || sha256_file(&path)).await;
    let ok = matches!(hash, Ok(Ok(h)) if h == m.asset.sha256);
    if ok {
        *CHECKED.lock_ok() = Some(stamp);
    } else {
        log::warn!("model hash mismatch, downloading it again");
    }
    ok
}

/// الثواني الباقية بنسبة ما مضى إلى ما أُنجز. قبل 2% أو أول 3 ثوانٍ التقدير قفزات، فلا نعرضه
pub(crate) fn separation_eta(elapsed: f64, percent: f64) -> Option<f64> {
    (percent >= 2.0 && elapsed >= 3.0 && percent < 100.0).then(|| elapsed * (100.0 - percent) / percent)
}

/// هل النموذج (والمكتبة على الكمبيوتر) موجودان؟ فحص سريع بالوجود والحجم لا بالبصمة،
/// لتسأل الواجهة قبل تنزيل ~140MB أول مرة (U-29). ensure_assets يبقى الفحص الكامل.
#[tauri::command]
pub fn ai_ready(app: AppHandle, model: Option<String>) -> bool {
    let m = sep_model(model.as_deref().unwrap_or("voice"));
    let Ok(dir) = ai_dir(&app) else { return false };
    let model_ok = std::fs::metadata(dir.join(m.asset.name)).is_ok_and(|f| f.len() == m.asset.size);
    #[cfg(not(target_os = "android"))]
    let lib_ok = RUNTIME.is_some_and(|r| dir.join(r.name).exists());
    #[cfg(target_os = "android")]
    let lib_ok = true;
    model_ok && lib_ok
}

pub async fn ensure_assets(
    app: &AppHandle,
    m: &SepModel,
    id: u64,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<(PathBuf, PathBuf)>, AppError> {
    let _guard = SETUP.lock().await;
    let dir = ai_dir(app)?;
    std::fs::create_dir_all(&dir)?;
    let model = dir.join(m.asset.name);

    // أندرويد: المكتبة مضمّنة في التطبيق
    #[cfg(target_os = "android")]
    let (runtime, lib, lib_ok, need_lib) = {
        let libdir = crate::mobile::paths(app)?.libdir;
        let lib = Path::new(&libdir).join("libonnxruntime.so");
        if !lib.exists() {
            return Err(AppError::with_detail("aiUnsupported", lib.display().to_string()));
        }
        (
            Asset {
                url: "",
                sha256: "",
                size: 0,
                member: None,
                name: "",
            },
            lib,
            PathBuf::new(),
            false,
        )
    };
    #[cfg(not(target_os = "android"))]
    let (runtime, lib, lib_ok, need_lib) = {
        let runtime = RUNTIME.ok_or_else(|| AppError::new("aiUnsupported"))?;
        let lib = dir.join(runtime.name);
        // ملف صغير يسجّل أننا تحققنا من المكتبة بعد استخراجها (بصمتها تخص الأرشيف لا الملف)
        let lib_ok = dir.join(format!("{}.ok", runtime.name));
        let need = !(lib.exists() && std::fs::read_to_string(&lib_ok).is_ok_and(|s| s.trim() == runtime.sha256));
        (runtime, lib, lib_ok, need)
    };
    let need_model = !model_intact(m, &model).await;
    if !need_lib && !need_model {
        return Ok(Some((lib, model)));
    }

    let total = (if need_lib { runtime.size } else { 0 }) + (if need_model { m.asset.size } else { 0 });
    let mut done_before = 0u64;
    let mut last = std::time::Instant::now() - Duration::from_secs(1);
    emit(
        app,
        JobUpdate {
            id,
            state: "preparing",
            percent: Some(0.0),
            ..Default::default()
        },
    );

    for (asset, needed) in [(&runtime, need_lib), (&m.asset, need_model)] {
        if !needed {
            continue;
        }
        let primary = if asset.url.starts_with("http") {
            asset.url.to_string()
        } else {
            format!("{ORT_BASE}{}", asset.url)
        };
        let mirrors: &[&str] = if asset.name == m.asset.name { m.mirrors } else { &[] };
        let tmp = dir.join(format!("{}.download", asset.name));
        let base = done_before;
        let mut on_bytes = |b: u64| {
            if last.elapsed() >= Duration::from_millis(250) {
                last = std::time::Instant::now();
                emit(
                    app,
                    JobUpdate {
                        id,
                        state: "preparing",
                        percent: Some(((base + b) as f64 / total as f64 * 100.0).min(100.0)),
                        ..Default::default()
                    },
                );
            }
        };
        // المصدر الأصلي، ثم النسخ الاحتياطية: أول ملف بالبصمة الصحيحة
        let mut failure = None;
        for url in std::iter::once(primary).chain(mirrors.iter().map(|m| m.to_string())) {
            match fetch(app, &url, &tmp, &mut on_bytes, cancel).await {
                Ok(false) => return Ok(None),
                Ok(true) => {}
                Err(e) => {
                    log::warn!("{} from {url}: {e:?}", asset.name);
                    failure = Some(e);
                    continue;
                }
            }
            let hash = sha256_async(&tmp).await?;
            if hash == asset.sha256 {
                failure = None;
                break;
            }
            let _ = std::fs::remove_file(&tmp);
            failure = Some(AppError::with_detail("aiChecksum", format!("{}: {hash}", asset.name)));
        }
        if let Some(e) = failure {
            return Err(e);
        }
        let dest = dir.join(asset.name);
        match asset.member {
            None => std::fs::rename(&tmp, &dest)?,
            Some(member) => {
                let out = tools::command(&tar())
                    .arg("-xf")
                    .arg(&tmp)
                    .arg("-C")
                    .arg(&dir)
                    .arg(member)
                    .output()
                    .await
                    .map_err(|e| AppError::with_detail("aiDownload", format!("tar: {e}")))?;
                if !out.status.success() {
                    return Err(AppError::with_detail(
                        "aiDownload",
                        String::from_utf8_lossy(&out.stderr).into_owned(),
                    ));
                }
                let _ = std::fs::remove_file(&dest);
                std::fs::rename(dir.join(member), &dest)?;
                if let Some(top) = member.split('/').next() {
                    let _ = std::fs::remove_dir_all(dir.join(top));
                }
                let _ = std::fs::remove_file(&tmp);
                std::fs::write(&lib_ok, asset.sha256)?;
            }
        }
        done_before += asset.size;
    }
    Ok(Some((lib, model)))
}

// ======================= النموذج والمعالجة =======================

const SR: u32 = 44_100;

/// إعدادات نموذج MDX-Net (من ملف إعدادات UVR الرسمي)
#[derive(Clone, Copy, Debug)]
pub struct MdxConfig {
    pub n_fft: usize,
    pub hop: usize,
    pub dim_f: usize,
    pub dim_t: usize,
    /// تعويض بسيط لمستوى الناتج يحدده مدرّب النموذج
    pub compensate: f32,
}

pub const VOC_FT: MdxConfig = MdxConfig {
    n_fft: 7680,
    hop: 1024,
    dim_f: 3072,
    dim_t: 256,
    compensate: 1.021,
};

/// STFT و iSTFT بنفس طريقة PyTorch (center=True، نافذة Hann دورية)
pub struct Spectral {
    cfg: MdxConfig,
    window: Vec<f32>,
    fwd: Arc<dyn Fft<f32>>,
    inv: Arc<dyn Fft<f32>>,
}

impl Spectral {
    pub fn new(cfg: MdxConfig) -> Self {
        let n = cfg.n_fft;
        let window = (0..n)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / n as f32).cos())
            .collect();
        let mut planner = FftPlanner::<f32>::new();
        Self {
            fwd: planner.plan_fft_forward(n),
            inv: planner.plan_fft_inverse(n),
            window,
            cfg,
        }
    }

    /// طول القطعة بالعينات
    pub fn chunk(&self) -> usize {
        self.cfg.hop * (self.cfg.dim_t - 1)
    }

    /// قناة واحدة (طولها chunk) ← [dim_f × dim_t] أعداد مركّبة
    pub fn stft(&self, x: &[f32]) -> Vec<Complex<f32>> {
        let (n, hop, dim_f, dim_t) = (self.cfg.n_fft, self.cfg.hop, self.cfg.dim_f, self.cfg.dim_t);
        let pad = n / 2;
        // حشو عاكس (reflect) مثل torch.stft(center=True)
        let len = x.len();
        let mut padded = Vec::with_capacity(len + 2 * pad);
        padded.extend((0..pad).map(|i| x[pad - i]));
        padded.extend_from_slice(x);
        padded.extend((0..pad).map(|i| x[len - 2 - i]));
        let mut out = vec![Complex::new(0.0, 0.0); dim_f * dim_t];
        let mut buf = vec![Complex::new(0.0, 0.0); n];
        for t in 0..dim_t {
            let s = t * hop;
            for i in 0..n {
                buf[i] = Complex::new(padded[s + i] * self.window[i], 0.0);
            }
            self.fwd.process(&mut buf);
            for f in 0..dim_f {
                out[f * dim_t + t] = buf[f];
            }
        }
        out
    }

    /// [dim_f × dim_t] ← قناة واحدة طولها chunk (الترددات فوق dim_f = صفر)
    pub fn istft(&self, spec: &[Complex<f32>]) -> Vec<f32> {
        let (n, hop, dim_f, dim_t) = (self.cfg.n_fft, self.cfg.hop, self.cfg.dim_f, self.cfg.dim_t);
        let total = n + hop * (dim_t - 1);
        let mut acc = vec![0f32; total];
        let mut wsum = vec![0f32; total];
        let mut buf = vec![Complex::new(0.0, 0.0); n];
        for t in 0..dim_t {
            buf.fill(Complex::new(0.0, 0.0));
            for f in 0..dim_f {
                buf[f] = spec[f * dim_t + t];
            }
            // تماثل مرافق: الطيف الكامل لإشارة حقيقية
            for f in 1..n / 2 {
                buf[n - f] = buf[f].conj();
            }
            buf[0].im = 0.0;
            self.inv.process(&mut buf);
            let s = t * hop;
            for i in 0..n {
                let w = self.window[i];
                acc[s + i] += buf[i].re / n as f32 * w;
                wsum[s + i] += w * w;
            }
        }
        let pad = n / 2;
        (0..self.chunk())
            .map(|i| {
                let w = wsum[i + pad];
                if w > 1e-8 { acc[i + pad] / w } else { 0.0 }
            })
            .collect()
    }
}

/// ما نريد الاحتفاظ به
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Keep {
    /// الصوت البشري فقط (= إزالة الموسيقى)
    Voice,
    /// الموسيقى فقط (= إزالة الصوت البشري)
    Music,
    /// الاثنان من مرور واحد للنموذج (R3-F21): فيديو بمسارين (الصوت ثم الموسيقى)، أو ملفّا صوت
    Both,
}

impl Keep {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "voice" => Some(Self::Voice),
            "music" => Some(Self::Music),
            "both" => Some(Self::Both),
            _ => None,
        }
    }
}

/// ملف الموسيقى بجانب `voice` حين يُطلب «الاثنان» (R3-F21): «x.wav» ← «x-music.wav»
pub fn music_companion(voice: &Path) -> PathBuf {
    let stem = voice.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = voice.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    voice.with_file_name(format!("{stem}-music{ext}"))
}

/// امتداد صوتي: الناتج صوت فقط (وإلا فالفيديو الأصلي بالصوت الجديد)
pub fn audio_ext(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    matches!(ext.as_str(), "wav" | "mp3" | "m4a" | "aac" | "flac" | "opus" | "ogg")
}

#[cfg(windows)]
fn no_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn no_window(_: &mut std::process::Command) {}

/// How the chunks are processed and how the stems are derived (studied in bench/separation)
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct SepOptions {
    /// Samples discarded at each edge of a chunk (the model sees them as context only)
    pub margin: usize,
    /// Samples shared by two successive chunks, cross-faded with a raised-cosine window (0 = hard joins)
    pub overlap: usize,
    /// Gain applied to the predicted voice
    pub compensate: f32,
    /// "subtract": music = mix - voice. "mask": Wiener-like soft mask M = |V|^2 / (|V|^2 + |X - V|^2),
    /// voice = M X and music = (1 - M) X in the STFT domain.
    pub derive: String,
}

impl Default for SepOptions {
    fn default() -> Self {
        Self::for_model(&VOICE)
    }
}

impl SepOptions {
    /// الإعدادات المعتمدة لنموذج: هامش نصف نافذة، وتعويض المستوى الذي حدده مدرّبه
    pub fn for_model(m: &SepModel) -> Self {
        Self {
            margin: m.cfg.n_fft / 2,
            overlap: 0,
            compensate: m.cfg.compensate,
            derive: "subtract".into(),
        }
    }
}

/// المعالجة الفعلية (متزامنة: تعمل في خيط منفصل). تكتب WAV ستيريو 44.1kHz.
#[allow(clippy::too_many_arguments)]
pub fn separate_blocking(
    ffmpeg: &Path,
    lib: &Path,
    m: &SepModel,
    model: &Path,
    input: &Path,
    start: Option<f64>,
    end: Option<f64>,
    keep: Keep,
    out_wav: &Path,
    progress: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<bool, AppError> {
    let both = music_companion(out_wav);
    let (voice, music) = match keep {
        Keep::Voice => (Some(out_wav), None),
        Keep::Music => (None, Some(out_wav)),
        Keep::Both => (Some(out_wav), Some(both.as_path())),
    };
    separate_stems(
        ffmpeg,
        lib,
        m,
        model,
        input,
        start,
        end,
        &SepOptions::for_model(m),
        voice,
        music,
        progress,
        cancel,
    )
}

fn wav_writer(ffmpeg: &Path, out: &Path) -> std::io::Result<std::process::Child> {
    let mut enc = std::process::Command::new(ffmpeg);
    enc.args([
        "-v",
        "error",
        "-y",
        "-f",
        "f32le",
        "-ar",
        &SR.to_string(),
        "-ac",
        "2",
        "-i",
        "-",
        "-c:a",
        "pcm_s16le",
    ]);
    enc.arg(out);
    enc.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    no_window(&mut enc);
    enc.spawn()
}

/// Separates the voice (and/or the music) in one pass of the model. Each output is optional.
#[allow(clippy::too_many_arguments)]
pub fn separate_stems(
    ffmpeg: &Path,
    lib: &Path,
    m: &SepModel,
    model: &Path,
    input: &Path,
    start: Option<f64>,
    end: Option<f64>,
    opts: &SepOptions,
    out_voice: Option<&Path>,
    out_music: Option<&Path>,
    progress: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<bool, AppError> {
    let ort_ok = ORT_READY.get_or_init(|| {
        // rc.13: تحميل المكتبة يفشل هنا، وcommit يعيد false فقط إن سبقته إعدادات أخرى (لا يحدث هنا)
        ort::init_from(lib)
            .map(|b| {
                b.with_name("khama").commit();
            })
            .map_err(|e| e.to_string())
    });
    if let Err(e) = ort_ok {
        return Err(AppError::with_detail("aiLoad", e.clone()));
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let load_err = |e: &dyn std::fmt::Display| AppError::with_detail("aiLoad", e.to_string());
    let mut session = ort::session::Session::builder()
        .map_err(|e| load_err(&e))?
        .with_intra_threads(threads)
        .map_err(|e| load_err(&e))?
        .commit_from_file(model)
        .map_err(|e| load_err(&e))?;

    let sp = Spectral::new(m.cfg);
    let cfg = &sp.cfg;
    let chunk = sp.chunk();
    // margin: context on each side; overlap: cross-faded part of the kept region
    let margin = opts.margin.min(chunk / 2 - 1024);
    let kept = chunk - 2 * margin;
    let overlap = opts.overlap.min(kept / 2);
    let step = kept - overlap;
    let mask = opts.derive == "mask";
    // raised-cosine fade-in over the overlap; the fade-out is 1 - fade-in, so the weights always sum to 1
    let fade: Vec<f32> = (0..overlap)
        .map(|i| (std::f32::consts::FRAC_PI_2 * (i as f32 + 0.5) / overlap as f32).sin().powi(2))
        .collect();

    // فك الصوت: ستيريو 44.1kHz أرقام عشرية
    let mut dec = std::process::Command::new(ffmpeg);
    dec.args(["-v", "error", "-nostdin"]);
    if let Some(s) = start {
        dec.args(["-ss", &format!("{s:.3}")]);
    }
    if let Some(e) = end {
        dec.args(["-to", &format!("{e:.3}")]);
    }
    dec.arg("-i").arg(input);
    dec.args(["-map", "0:a:0", "-ac", "2", "-ar", &SR.to_string(), "-f", "f32le", "-"]);
    dec.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    no_window(&mut dec);
    let mut dec = dec.spawn()?;
    // stderr يُقرأ من أوله في خيط: ملف تالف يجعل ffmpeg يكتب خطأً لكل حزمة، فإن امتلأ الأنبوب
    // توقّف ffmpeg عن الكتابة في stdout ونحن ننتظره، فيعلق الفصل وطابور التحويل كله
    let dec_err = drain_stderr(&mut dec);

    let mut encs: Vec<(bool, std::process::Child)> = Vec::new();
    if let Some(p) = out_voice {
        encs.push((false, wav_writer(ffmpeg, p)?));
    }
    if let Some(p) = out_music {
        encs.push((true, wav_writer(ffmpeg, p)?));
    }
    let enc_errs: Vec<_> = encs.iter_mut().map(|(_, c)| drain_stderr(c)).collect();

    let result = (|| -> Result<bool, AppError> {
        let mut src = dec.stdout.take().expect("piped");
        let mut sinks: Vec<(bool, std::process::ChildStdin)> = encs.iter_mut().map(|(m, c)| (*m, c.stdin.take().expect("piped"))).collect();
        // نبدأ بصمت بطول الهامش، كما في طريقة MDX الأصلية
        let mut left: Vec<f32> = vec![0.0; margin];
        let mut right: Vec<f32> = vec![0.0; margin];
        let mut eof = false;
        let mut read_total: u64 = 0;
        let mut written: u64 = 0;
        let mut raw = vec![0u8; 8 * 16384];
        let mut carry: Vec<u8> = Vec::new();
        let plane = cfg.dim_f * cfg.dim_t;
        // end of the previous kept region, waiting to be cross-faded: [voice L, voice R, mix L, mix R]
        let mut tail: Vec<[f32; 4]> = Vec::new();

        let emit = |sinks: &mut Vec<(bool, std::process::ChildStdin)>, frames: &[[f32; 4]]| -> std::io::Result<()> {
            for (is_music, sink) in sinks.iter_mut() {
                let mut bytes = Vec::with_capacity(frames.len() * 8);
                for f in frames {
                    let (a, b) = if *is_music { (f[2] - f[0], f[3] - f[1]) } else { (f[0], f[1]) };
                    bytes.extend_from_slice(&a.to_le_bytes());
                    bytes.extend_from_slice(&b.to_le_bytes());
                }
                sink.write_all(&bytes)?;
            }
            Ok(())
        };

        loop {
            // املأ المخزن حتى طول قطعة كاملة
            while !eof && left.len() < chunk {
                let n = src.read(&mut raw)?;
                if n == 0 {
                    eof = true;
                    break;
                }
                carry.extend_from_slice(&raw[..n]);
                let frames = carry.len() / 8;
                for k in 0..frames {
                    let b = &carry[k * 8..k * 8 + 8];
                    left.push(f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
                    right.push(f32::from_le_bytes([b[4], b[5], b[6], b[7]]));
                }
                read_total += frames as u64;
                carry.drain(..frames * 8);
            }
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            let remaining = read_total.saturating_sub(written);
            if remaining == 0 {
                break;
            }
            left.resize(left.len().max(chunk), 0.0);
            right.resize(right.len().max(chunk), 0.0);

            // ---- الطيف ← النموذج ← الموجة ----
            let sl = sp.stft(&left[..chunk]);
            let sr = sp.stft(&right[..chunk]);
            let mut input = vec![0f32; 4 * plane];
            for i in 0..plane {
                input[i] = sl[i].re;
                input[plane + i] = sl[i].im;
                input[2 * plane + i] = sr[i].re;
                input[3 * plane + i] = sr[i].im;
            }
            let tensor = ort::value::Tensor::from_array(([1usize, 4, cfg.dim_f, cfg.dim_t], input))
                .map_err(|e| AppError::with_detail("aiRun", e.to_string()))?;
            let outputs = session
                .run(ort::inputs![tensor])
                .map_err(|e| AppError::with_detail("aiRun", e.to_string()))?;
            let (_, pred) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| AppError::with_detail("aiRun", e.to_string()))?;
            let g = opts.compensate;
            let voice_of = |re: usize, im: usize, mix: &[Complex<f32>]| -> Vec<f32> {
                let v: Vec<Complex<f32>> = (0..plane)
                    .map(|i| Complex::new(pred[re * plane + i], pred[im * plane + i]) * g)
                    .collect();
                if !mask {
                    return sp.istft(&v);
                }
                // Wiener-like soft mask applied to the mixture
                let m: Vec<Complex<f32>> = (0..plane)
                    .map(|i| {
                        let pv = v[i].norm_sqr();
                        let pm = (mix[i] - v[i]).norm_sqr();
                        mix[i] * (pv / (pv + pm + 1e-10))
                    })
                    .collect();
                sp.istft(&m)
            };
            let mut vl = voice_of(0, 1, &sl);
            let mut vr = voice_of(2, 3, &sr);
            if m.predicts_other {
                // the model gave the other part: voice = mix - prediction
                for i in 0..chunk.min(vl.len()) {
                    vl[i] = left[i] - vl[i];
                    vr[i] = right[i] - vr[i];
                }
            }

            // the kept region of this chunk, in output order
            let region: Vec<[f32; 4]> = (margin..margin + kept).map(|i| [vl[i], vr[i], left[i], right[i]]).collect();
            // cross-fade its head with the previous tail (the mixture is the same in both chunks)
            let mut out: Vec<[f32; 4]> = Vec::with_capacity(step);
            for (i, f) in region.iter().enumerate().take(step) {
                if i < tail.len() {
                    let (w, p) = (fade[i], tail[i]);
                    out.push([p[0] * (1.0 - w) + f[0] * w, p[1] * (1.0 - w) + f[1] * w, f[2], f[3]]);
                } else {
                    out.push(*f);
                }
            }
            tail = region[step..].to_vec();
            let take = (out.len() as u64).min(remaining) as usize;
            emit(&mut sinks, &out[..take])?;
            written += take as u64;
            progress.store(written, Ordering::Relaxed);

            // القطعة التالية تبدأ بعد step عينة (مع الهامش من السياق قبلها)
            left.drain(..step.min(left.len()));
            right.drain(..step.min(right.len()));
            if eof && written >= read_total {
                break;
            }
        }
        drop(sinks);
        Ok(true)
    })();

    let finish = |c: &mut std::process::Child, err: Option<std::thread::JoinHandle<String>>| {
        let ok = c.wait().map(|s| s.success()).unwrap_or(false);
        (ok, err.and_then(|h| h.join().ok()).unwrap_or_default())
    };
    match result {
        Ok(true) => {
            let (dok, derr) = finish(&mut dec, dec_err);
            if !dok {
                return Err(AppError::with_detail("noAudioStream", tail(&derr, 6)));
            }
            for ((_, c), e) in encs.iter_mut().zip(enc_errs) {
                let (eok, eerr) = finish(c, e);
                if !eok {
                    return Err(AppError::with_detail("encodeFailed", tail(&eerr, 6)));
                }
            }
            Ok(true)
        }
        other => {
            let _ = dec.kill();
            let _ = dec.wait();
            for (_, c) in encs.iter_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            for p in [out_voice, out_music].into_iter().flatten() {
                let _ = std::fs::remove_file(p);
            }
            other
        }
    }
}

/// يقرأ stderr في خيط حتى ينتهي، ويحتفظ بآخر 32 KB فقط
fn drain_stderr(c: &mut std::process::Child) -> Option<std::thread::JoinHandle<String>> {
    let mut e = c.stderr.take()?;
    Some(std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = e.read(&mut chunk) {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > 64 * 1024 {
                let cut = buf.len() - 32 * 1024;
                buf.drain(..cut);
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }))
}

/// أمر ffmpeg للناتج النهائي بعد الفصل. `wav` ناتج النموذج، وفي «الاثنان» موسيقاه في music_companion(wav).
/// - امتداد صوتي: صوت فقط بتلك الصيغة (و«الاثنان»: ملفان من أمر واحد، الموسيقى في music_companion(output))
/// - وإلا: الفيديو الأصلي + الصوت الجديد (و«الاثنان»: مساران، الحوار أولًا ثم الموسيقى)
pub(crate) fn final_args(
    input: &Path,
    wav: &Path,
    output: &Path,
    start: Option<f64>,
    end: Option<f64>,
    keep: Keep,
) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = Vec::new();
    let mut push = |v: &[&str]| a.extend(v.iter().map(std::ffi::OsString::from));
    push(&["-hide_banner", "-nostdin", "-y", "-v", "error"]);
    let ext = output.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let music = music_companion(wav);
    let both = keep == Keep::Both;
    if audio_ext(output) {
        let codec: &[&str] = match ext.as_str() {
            "mp3" => &["-c:a", "libmp3lame", "-b:a", "320k"],
            "m4a" | "aac" => &["-c:a", "aac", "-b:a", "320k"],
            "flac" => &["-c:a", "flac"],
            "opus" | "ogg" => &["-c:a", "libopus", "-b:a", "192k"],
            _ => &["-c:a", "pcm_s16le"],
        };
        push(&["-i"]);
        a.push(wav.into());
        if both {
            a.extend(["-i".into(), music.into_os_string()]);
            a.extend(["-map", "0:a:0"].map(Into::into));
            a.extend(codec.iter().map(Into::into));
            a.push(output.into());
            a.extend(["-map", "1:a:0"].map(Into::into));
            a.extend(codec.iter().map(Into::into));
            a.push(music_companion(output).into_os_string());
        } else {
            a.extend(codec.iter().map(Into::into));
            a.push(output.into());
        }
        return a;
    }
    let trimmed = start.is_some() || end.is_some();
    if let Some(s) = start {
        a.extend(["-ss".into(), format!("{s:.3}").into()]);
    }
    if let Some(e) = end {
        a.extend(["-to".into(), format!("{e:.3}").into()]);
    }
    a.extend(["-i".into(), input.into(), "-i".into(), wav.into()]);
    if both {
        a.extend(["-i".into(), music.into_os_string()]);
    }
    let mut push = |v: &[&str]| a.extend(v.iter().map(std::ffi::OsString::from));
    push(&["-map", "0:v:0", "-map", "1:a:0"]);
    if both {
        // مساران في الفيديو نفسه: الحوار أولًا (الافتراضي) ثم الموسيقى، باسميهما في برنامج المونتاج.
        // MP4 يكتب title في «name» وMOV في «title»، وبعض البرامج تعرض handler_name: نكتب الاثنين
        push(&["-map", "2:a:0"]);
        push(&["-metadata:s:a:0", "title=Voice", "-metadata:s:a:0", "handler_name=Voice"]);
        push(&["-metadata:s:a:1", "title=Music", "-metadata:s:a:1", "handler_name=Music"]);
    }
    if trimmed {
        // القص الدقيق يحتاج إعادة ترميز الصورة حتى تتطابق مع الصوت المقصوص
        push(&["-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p"]);
    } else {
        push(&["-c:v", "copy"]);
    }
    if ext == "mov" {
        push(&["-c:a", "pcm_s16le"]);
    } else if ext == "webm" || ext == "mkv" {
        push(&["-c:a", "libopus", "-b:a", "192k"]);
    } else {
        push(&["-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"]);
    }
    // 48kHz = المعدل القياسي في برامج المونتاج
    push(&["-ar", "48000", "-shortest"]);
    a.push(output.into());
    a
}

/// يفصل الصوت ثم يكتب الناتج النهائي (final_args):
/// - إن كان امتداد الناتج صوتيًا: صوت فقط بتلك الصيغة
/// - وإلا: الفيديو الأصلي + الصوت الجديد
#[allow(clippy::too_many_arguments)]
pub async fn process_file(
    app: &AppHandle,
    id: u64,
    tools: &Tools,
    input: &Path,
    output: &Path,
    m: &'static SepModel,
    keep: Keep,
    start: Option<f64>,
    end: Option<f64>,
    duration: Option<f64>,
    work: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<bool, AppError> {
    let Some((lib, model)) = ensure_assets(app, m, id, cancel).await? else {
        return Ok(false);
    };
    emit(
        app,
        JobUpdate {
            id,
            state: "separating",
            percent: Some(0.0),
            ..Default::default()
        },
    );
    std::fs::create_dir_all(work)?;
    let wav = work.join("stem.wav");

    let progress = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (ffmpeg, input_p, wav_p, p2, s2) = (
        tools.ffmpeg.clone(),
        input.to_path_buf(),
        wav.clone(),
        progress.clone(),
        stop.clone(),
    );
    let mut handle = tauri::async_runtime::spawn_blocking(move || {
        separate_blocking(&ffmpeg, &lib, m, &model, &input_p, start, end, keep, &wav_p, &p2, &s2)
    });
    let span = end.or(duration).map(|e| e - start.unwrap_or(0.0)).filter(|s| *s > 0.0);
    let total = span.map(|s| s * SR as f64);
    let began = std::time::Instant::now();
    let ok = loop {
        tokio::select! {
            r = &mut handle => break r.map_err(|e| AppError::with_detail("aiRun", e.to_string()))??,
            _ = tokio::time::sleep(Duration::from_millis(400)) => {
                if let Some(t) = total {
                    let percent = (progress.load(Ordering::Relaxed) as f64 / t * 100.0).min(100.0);
                    emit(app, JobUpdate {
                        id,
                        state: "separating",
                        percent: Some(percent),
                        // الوقت الباقي من السرعة الفعلية لا من «بقدر طول الصوت» (U-41)
                        eta: separation_eta(began.elapsed().as_secs_f64(), percent),
                        ..Default::default()
                    });
                }
            }
            _ = crate::download::canceled(cancel) => {
                stop.store(true, Ordering::Relaxed);
                let _ = (&mut handle).await;
                return Ok(false);
            }
        }
    };
    if !ok {
        return Ok(false);
    }

    // ---- الناتج النهائي ----
    emit(
        app,
        JobUpdate {
            id,
            state: "processing",
            ..Default::default()
        },
    );
    let mut cmd = tools::command(&tools.ffmpeg);
    cmd.args(final_args(input, &wav, output, start, end, keep));
    let out = cmd.output().await?;
    let _ = std::fs::remove_file(&wav);
    let _ = std::fs::remove_file(music_companion(&wav));
    if !out.status.success() {
        return Err(AppError::with_detail(
            "encodeFailed",
            tail(&String::from_utf8_lossy(&out.stderr), 10),
        ));
    }
    Ok(true)
}

// ======================= اختبارات =======================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separation_eta_from_real_speed() {
        // 25% في 60 ثانية ← 180 ثانية باقية
        assert_eq!(separation_eta(60.0, 25.0), Some(180.0));
        assert_eq!(separation_eta(2.0, 50.0), None, "أول 3 ثوانٍ");
        assert_eq!(separation_eta(30.0, 1.0), None, "قبل 2%");
        assert_eq!(separation_eta(30.0, 100.0), None);
    }

    /// STFT ثم iSTFT يجب أن يعيد الإشارة نفسها (للترددات تحت dim_f)
    #[test]
    fn stft_roundtrip() {
        let sp = Spectral::new(VOC_FT);
        let n = sp.chunk();
        let x: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                0.5 * (2.0 * std::f32::consts::PI * 440.0 * t).sin() + 0.2 * (2.0 * std::f32::consts::PI * 3000.0 * t).sin()
            })
            .collect();
        let y = sp.istft(&sp.stft(&x));
        let err: f32 = x
            .iter()
            .zip(&y)
            .skip(4000)
            .take(n - 8000)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(err < 1e-3, "max error {err}");
    }

    /// اختبار حقيقي بالنموذج (يدوي):
    /// KHAMA_AI=<مجلد فيه onnxruntime و UVR-MDX-NET-Voc_FT.onnx> KHAMA_VOICE=<wav كلام> KHAMA_MUSIC=<wav موسيقى>
    #[test]
    #[ignore]
    fn separates_voice_from_music() {
        let ai = PathBuf::from(std::env::var("KHAMA_AI").unwrap());
        let ffmpeg = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffmpeg/bin")
            .join(format!("ffmpeg{}", tools::EXE));
        let voice = PathBuf::from(std::env::var("KHAMA_VOICE").unwrap());
        let music = PathBuf::from(std::env::var("KHAMA_MUSIC").unwrap());
        let tmp = std::env::temp_dir().join("khama-sep");
        std::fs::create_dir_all(&tmp).unwrap();
        let mix = tmp.join("mix.wav");
        let st = std::process::Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-i"])
            .arg(&voice)
            .arg("-i")
            .arg(&music)
            .args(["-filter_complex", "[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a];[1:a]aformat=sample_rates=44100:channel_layouts=stereo[b];[a][b]amix=inputs=2:duration=first:normalize=0", "-c:a", "pcm_s16le"])
            .arg(&mix)
            .status()
            .unwrap();
        assert!(st.success());
        let lib = ai.join(if cfg!(windows) {
            "onnxruntime.dll"
        } else if cfg!(target_os = "macos") {
            "libonnxruntime.dylib"
        } else {
            "libonnxruntime.so"
        });
        let model = ai.join(VOICE.asset.name);
        let p = AtomicU64::new(0);
        let c = AtomicBool::new(false);
        for (keep, name) in [(Keep::Voice, "voice.wav"), (Keep::Music, "music.wav")] {
            let t0 = std::time::Instant::now();
            assert!(separate_blocking(&ffmpeg, &lib, &VOICE, &model, &mix, None, None, keep, &tmp.join(name), &p, &c).unwrap());
            println!("{name}: {:.1}s", t0.elapsed().as_secs_f64());
        }
        // نقارن: الناتج الصوتي يجب أن يشبه الكلام الأصلي أكثر بكثير من الخليط
        let read = |p: &Path| -> Vec<f32> {
            let o = std::process::Command::new(&ffmpeg)
                .args(["-v", "error", "-i"])
                .arg(p)
                .args(["-ac", "1", "-ar", "44100", "-f", "f32le", "-"])
                .output()
                .unwrap();
            o.stdout.chunks(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
        };
        let reference = read(&voice);
        let snr = |est: &[f32]| -> f64 {
            let n = reference.len().min(est.len());
            let (mut s, mut e) = (0f64, 0f64);
            for i in 0..n {
                s += (reference[i] as f64).powi(2);
                e += ((reference[i] - est[i]) as f64).powi(2);
            }
            10.0 * (s / e.max(1e-12)).log10()
        };
        let mix_snr = snr(&read(&mix));
        let voice_snr = snr(&read(&tmp.join("voice.wav")));
        println!("SNR vs clean voice — mix: {mix_snr:.1} dB, separated: {voice_snr:.1} dB");
        assert!(voice_snr > mix_snr + 6.0, "separation did not improve the voice");
    }

    fn strs(a: &[std::ffi::OsString]) -> Vec<String> {
        a.iter().map(|x| x.to_string_lossy().into_owned()).collect()
    }

    /// «الاثنان» (R3-F21): الصوت ملفان من أمر واحد، والفيديو مساران بالترتيب والاسمين
    #[test]
    fn both_writes_two_files_or_two_tracks() {
        assert_eq!(
            music_companion(Path::new("w/x [no music].mp3")),
            Path::new("w/x [no music]-music.mp3")
        );
        assert_eq!(Keep::parse("both"), Some(Keep::Both));

        let a = strs(&final_args(
            Path::new("in.mp3"),
            Path::new("stem.wav"),
            Path::new("x.mp3"),
            None,
            None,
            Keep::Both,
        ));
        let at = |v: &str| a.iter().position(|x| x == v).unwrap();
        assert_eq!(a.iter().filter(|x| *x == "-i").count(), 2);
        assert!(a.contains(&"stem-music.wav".to_string()));
        assert!(at("0:a:0") < at("x.mp3") && at("x.mp3") < at("1:a:0"));
        assert_eq!(a.last().unwrap(), "x-music.mp3");
        assert_eq!(a.iter().filter(|x| *x == "libmp3lame").count(), 2, "كل ملف بترميزه");

        let v = strs(&final_args(
            Path::new("in.mp4"),
            Path::new("stem.wav"),
            Path::new("x.mp4"),
            None,
            None,
            Keep::Both,
        ));
        let maps: Vec<&String> = v
            .iter()
            .zip(v.iter().skip(1))
            .filter(|(k, _)| *k == "-map")
            .map(|(_, m)| m)
            .collect();
        assert_eq!(maps, ["0:v:0", "1:a:0", "2:a:0"]);
        assert!(
            ["title=Voice", "handler_name=Voice", "title=Music", "handler_name=Music"]
                .iter()
                .all(|t| v.contains(&t.to_string()))
        );
        assert_eq!(v.last().unwrap(), "x.mp4");

        // صوت واحد كما كان
        let one = strs(&final_args(
            Path::new("in.mp4"),
            Path::new("stem.wav"),
            Path::new("x.mp4"),
            None,
            None,
            Keep::Voice,
        ));
        assert_eq!(one.iter().filter(|x| *x == "-i").count(), 2);
        assert!(!one.iter().any(|x| x.contains("title=")));
    }

    /// اختبار حقيقي (يدوي) لـ«الاثنان»: مرور واحد للنموذج بدل مرورين، ثم أوامر الناتج كما يبنيها الكود
    /// KHAMA_AI=<مجلد onnxruntime والنموذج> KHAMA_SONG=<أغنية> KHAMA_VIDEO=<فيديو بكلام وموسيقى>
    #[test]
    #[ignore]
    fn both_real_one_pass() {
        let ai = PathBuf::from(std::env::var("KHAMA_AI").unwrap());
        let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/ffmpeg/bin");
        let ffmpeg = bin.join(format!("ffmpeg{}", tools::EXE));
        let ffprobe = bin.join(format!("ffprobe{}", tools::EXE));
        let song = PathBuf::from(std::env::var("KHAMA_SONG").unwrap());
        let video = PathBuf::from(std::env::var("KHAMA_VIDEO").unwrap());
        let lib = ai.join(if cfg!(windows) {
            "onnxruntime.dll"
        } else if cfg!(target_os = "macos") {
            "libonnxruntime.dylib"
        } else {
            "libonnxruntime.so"
        });
        let model = ai.join(VOICE.asset.name);
        let tmp = std::env::temp_dir().join("khama-both");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let (p, c) = (AtomicU64::new(0), AtomicBool::new(false));
        let (s, e) = (Some(30.0), Some(90.0));
        let run = |keep: Keep, out: &Path| {
            let t0 = std::time::Instant::now();
            assert!(separate_blocking(&ffmpeg, &lib, &VOICE, &model, &song, s, e, keep, out, &p, &c).unwrap());
            t0.elapsed().as_secs_f64()
        };
        let tv = run(Keep::Voice, &tmp.join("v.wav"));
        let tm = run(Keep::Music, &tmp.join("m.wav"));
        let tb = run(Keep::Both, &tmp.join("b.wav"));
        println!("60s of song: voice {tv:.1}s + music {tm:.1}s = {:.1}s, both {tb:.1}s", tv + tm);
        let read = |p: &Path| -> Vec<f32> {
            let o = std::process::Command::new(&ffmpeg)
                .args(["-v", "error", "-i"])
                .arg(p)
                .args(["-ac", "1", "-f", "f32le", "-"])
                .output()
                .unwrap();
            o.stdout.chunks(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
        };
        let diff = |x: &[f32], y: &[f32]| x.iter().zip(y).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        let dv = diff(&read(&tmp.join("v.wav")), &read(&tmp.join("b.wav")));
        let dm = diff(&read(&tmp.join("m.wav")), &read(&music_companion(&tmp.join("b.wav"))));
        println!("max diff vs separate passes: voice {dv:.5}, music {dm:.5}");
        assert!(dv < 1e-3 && dm < 1e-3, "one pass gives the same two stems");
        assert!(tb < (tv + tm) * 0.75, "one pass is clearly faster than two");

        let probe = |f: &Path| -> String {
            let o = std::process::Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_type,codec_name,channels:stream_tags=title,name,handler_name:format=duration",
                    "-of",
                    "compact",
                ])
                .arg(f)
                .output()
                .unwrap();
            String::from_utf8_lossy(&o.stdout).into_owned()
        };
        let ffrun = |a: Vec<std::ffi::OsString>| {
            let o = std::process::Command::new(&ffmpeg).args(a).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        };
        // صوت: ملفان mp3 من الأمر نفسه
        let out = tmp.join("song [no music].mp3");
        ffrun(final_args(&song, &tmp.join("b.wav"), &out, s, e, Keep::Both));
        println!("{}\n{}", probe(&out), probe(&music_companion(&out)));
        assert!(probe(&music_companion(&out)).contains("codec_name=mp3"));

        // فيديو: مساران، كاملًا ثم مقصوصًا (يعيد ترميز الصورة)
        for (vs, ve, name) in [(None, None, "full"), (Some(5.0), Some(20.0), "trim")] {
            let wav = tmp.join(format!("{name}.wav"));
            let t0 = std::time::Instant::now();
            assert!(separate_blocking(&ffmpeg, &lib, &VOICE, &model, &video, vs, ve, Keep::Both, &wav, &p, &c).unwrap());
            let out = tmp.join(format!("{name} [voice + music].mp4"));
            ffrun(final_args(&video, &wav, &out, vs, ve, Keep::Both));
            let info = probe(&out);
            println!("{name} ({:.1}s):\n{info}", t0.elapsed().as_secs_f64());
            assert_eq!(info.matches("codec_type=audio").count(), 2);
            assert!(info.contains("=Voice") && info.contains("=Music"));
        }
        // MOV للمونتاج: PCM ومساران باسميهما
        let out = tmp.join("full [voice + music].mov");
        ffrun(final_args(&video, &tmp.join("full.wav"), &out, None, None, Keep::Both));
        let info = probe(&out);
        println!("mov:\n{info}");
        assert_eq!(info.matches("codec_name=pcm_s16le").count(), 2);
        assert!(info.contains("=Voice") && info.contains("=Music"));
    }
}
