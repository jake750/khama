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

const MODEL: Asset = Asset {
    url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx",
    sha256: "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111",
    size: 66_762_490,
    member: None,
    name: "UVR-MDX-NET-Voc_FT.onnx",
};

/// نسخ احتياطية للنموذج نفسه (T-39): المصدر الأصلي مستودع طرف ثالث قد يُحذف. كل نسخة تُفحص
/// بالبصمة نفسها فوق (Hugging Face يعلن البصمة في X-Linked-ETag، وطابقت عند الإضافة 2026-11-17)،
/// فنسخة معدّلة تُرفض كما يُرفض الأصل.
const MODEL_MIRRORS: &[&str] = &[
    "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/UVR-MDX-NET-Voc_FT.onnx",
    "https://huggingface.co/AI4future/RVC/resolve/main/UVR-MDX-NET-Voc_FT.onnx",
];

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

fn ai_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| AppError::with_detail("dataDir", e.to_string()))?
        .join("ai"))
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
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

fn tar() -> PathBuf {
    if cfg!(windows) {
        // tar الخاص بـ Windows (bsdtar) يفك ملفات zip أيضًا
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        return Path::new(&sys).join("System32").join("tar.exe");
    }
    PathBuf::from("tar")
}

/// ينزّل ملفًا مع إرسال التقدّم (نقيس حجم الملف الجزئي) وإمكانية الإلغاء
async fn fetch(
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
async fn model_intact(model: &Path) -> bool {
    use crate::errors::LockExt;
    static CHECKED: std::sync::Mutex<Option<(u64, std::time::SystemTime)>> = std::sync::Mutex::new(None);
    let Ok(meta) = std::fs::metadata(model) else {
        return false;
    };
    if meta.len() != MODEL.size {
        return false;
    }
    let stamp = (meta.len(), meta.modified().unwrap_or(std::time::UNIX_EPOCH));
    if *CHECKED.lock_ok() == Some(stamp) {
        return true;
    }
    let path = model.to_path_buf();
    let hash = tauri::async_runtime::spawn_blocking(move || sha256_file(&path)).await;
    let ok = matches!(hash, Ok(Ok(h)) if h == MODEL.sha256);
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
pub fn ai_ready(app: AppHandle) -> bool {
    let Ok(dir) = ai_dir(&app) else { return false };
    let model_ok = std::fs::metadata(dir.join(MODEL.name)).is_ok_and(|m| m.len() == MODEL.size);
    #[cfg(not(target_os = "android"))]
    let lib_ok = RUNTIME.is_some_and(|r| dir.join(r.name).exists());
    #[cfg(target_os = "android")]
    let lib_ok = true;
    model_ok && lib_ok
}

pub async fn ensure_assets(app: &AppHandle, id: u64, cancel: &mut watch::Receiver<bool>) -> Result<Option<(PathBuf, PathBuf)>, AppError> {
    let _guard = SETUP.lock().await;
    let dir = ai_dir(app)?;
    std::fs::create_dir_all(&dir)?;
    let model = dir.join(MODEL.name);

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
    let need_model = !model_intact(&model).await;
    if !need_lib && !need_model {
        return Ok(Some((lib, model)));
    }

    let total = (if need_lib { runtime.size } else { 0 }) + (if need_model { MODEL.size } else { 0 });
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

    for (asset, needed) in [(&runtime, need_lib), (&MODEL, need_model)] {
        if !needed {
            continue;
        }
        let primary = if asset.url.starts_with("http") {
            asset.url.to_string()
        } else {
            format!("{ORT_BASE}{}", asset.url)
        };
        let mirrors: &[&str] = if asset.name == MODEL.name { MODEL_MIRRORS } else { &[] };
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
            let hash = sha256_file(&tmp)?;
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

/// إعدادات نموذج UVR-MDX-NET-Voc_FT (من ملف إعدادات UVR الرسمي)
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
}

impl Keep {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "voice" => Some(Self::Voice),
            "music" => Some(Self::Music),
            _ => None,
        }
    }
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
        Self {
            margin: VOC_FT.n_fft / 2,
            overlap: 0,
            compensate: VOC_FT.compensate,
            derive: "subtract".into(),
        }
    }
}

/// المعالجة الفعلية (متزامنة: تعمل في خيط منفصل). تكتب WAV ستيريو 44.1kHz.
#[allow(clippy::too_many_arguments)]
pub fn separate_blocking(
    ffmpeg: &Path,
    lib: &Path,
    model: &Path,
    input: &Path,
    start: Option<f64>,
    end: Option<f64>,
    keep: Keep,
    out_wav: &Path,
    progress: &AtomicU64,
    cancel: &AtomicBool,
) -> Result<bool, AppError> {
    let (voice, music) = match keep {
        Keep::Voice => (Some(out_wav), None),
        Keep::Music => (None, Some(out_wav)),
    };
    separate_stems(
        ffmpeg,
        lib,
        model,
        input,
        start,
        end,
        &SepOptions::default(),
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
        ort::init_from(lib.to_string_lossy().to_string())
            .with_name("khama")
            .commit()
            .map(|_| ())
            .map_err(|e| e.to_string())
    });
    if let Err(e) = ort_ok {
        return Err(AppError::with_detail("aiLoad", e.clone()));
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut session = ort::session::Session::builder()
        .and_then(|b| b.with_intra_threads(threads))
        .and_then(|b| b.commit_from_file(model))
        .map_err(|e| AppError::with_detail("aiLoad", e.to_string()))?;

    let sp = Spectral::new(VOC_FT);
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

    let mut encs: Vec<(bool, std::process::Child)> = Vec::new();
    if let Some(p) = out_voice {
        encs.push((false, wav_writer(ffmpeg, p)?));
    }
    if let Some(p) = out_music {
        encs.push((true, wav_writer(ffmpeg, p)?));
    }

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
            let vl = voice_of(0, 1, &sl);
            let vr = voice_of(2, 3, &sr);

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

    let finish = |c: &mut std::process::Child| {
        let mut err = String::new();
        if let Some(mut e) = c.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        (c.wait().map(|s| s.success()).unwrap_or(false), err)
    };
    match result {
        Ok(true) => {
            let (dok, derr) = finish(&mut dec);
            if !dok {
                return Err(AppError::with_detail("noAudioStream", tail(&derr, 6)));
            }
            for (_, c) in encs.iter_mut() {
                let (eok, eerr) = finish(c);
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

/// يفصل الصوت ثم يكتب الناتج النهائي:
/// - إن كان امتداد الناتج صوتيًا: صوت فقط بتلك الصيغة
/// - وإلا: الفيديو الأصلي + الصوت الجديد
#[allow(clippy::too_many_arguments)]
pub async fn process_file(
    app: &AppHandle,
    id: u64,
    tools: &Tools,
    input: &Path,
    output: &Path,
    keep: Keep,
    start: Option<f64>,
    end: Option<f64>,
    duration: Option<f64>,
    work: &Path,
    cancel: &mut watch::Receiver<bool>,
) -> Result<bool, AppError> {
    let Some((lib, model)) = ensure_assets(app, id, cancel).await? else {
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
        separate_blocking(&ffmpeg, &lib, &model, &input_p, start, end, keep, &wav_p, &p2, &s2)
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
    let ext = output.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mut cmd = tools::command(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-v", "error"]);
    let audio_only = matches!(ext.as_str(), "wav" | "mp3" | "m4a" | "aac" | "flac" | "opus" | "ogg");
    if audio_only {
        cmd.arg("-i").arg(&wav);
        let codec: &[&str] = match ext.as_str() {
            "mp3" => &["-c:a", "libmp3lame", "-b:a", "320k"],
            "m4a" | "aac" => &["-c:a", "aac", "-b:a", "320k"],
            "flac" => &["-c:a", "flac"],
            "opus" | "ogg" => &["-c:a", "libopus", "-b:a", "192k"],
            _ => &["-c:a", "pcm_s16le"],
        };
        cmd.args(codec);
    } else {
        let trimmed = start.is_some() || end.is_some();
        if let Some(s) = start {
            cmd.args(["-ss", &format!("{s:.3}")]);
        }
        if let Some(e) = end {
            cmd.args(["-to", &format!("{e:.3}")]);
        }
        cmd.arg("-i").arg(input).arg("-i").arg(&wav);
        cmd.args(["-map", "0:v:0", "-map", "1:a:0"]);
        if trimmed {
            // القص الدقيق يحتاج إعادة ترميز الصورة حتى تتطابق مع الصوت المقصوص
            cmd.args(["-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p"]);
        } else {
            cmd.args(["-c:v", "copy"]);
        }
        if ext == "mov" {
            cmd.args(["-c:a", "pcm_s16le"]);
        } else if ext == "webm" || ext == "mkv" {
            cmd.args(["-c:a", "libopus", "-b:a", "192k"]);
        } else {
            cmd.args(["-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"]);
        }
        // 48kHz = المعدل القياسي في برامج المونتاج
        cmd.args(["-ar", "48000", "-shortest"]);
    }
    cmd.arg(output);
    let out = cmd.output().await?;
    let _ = std::fs::remove_file(&wav);
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
        let model = ai.join(MODEL.name);
        let p = AtomicU64::new(0);
        let c = AtomicBool::new(false);
        for (keep, name) in [(Keep::Voice, "voice.wav"), (Keep::Music, "music.wav")] {
            let t0 = std::time::Instant::now();
            assert!(separate_blocking(&ffmpeg, &lib, &model, &mix, None, None, keep, &tmp.join(name), &p, &c).unwrap());
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
}
