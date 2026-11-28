//! حفظ نتائج التحليل (R3-F19): التفريغ (الجمل وأوقات الكلمات) والصمت يُحفظان في مجلد ذاكرة التطبيق
//! بمفتاح بصمة الملف، فتحليل الملف نفسه مرة ثانية لا يعيد whisper (نحو 0.7 من زمن الصوت على
//! المعالج: 40 دقيقة لمحاضرة ساعة) ولا قياس الصمت.
//!
//! البصمة: حجم الملف ووقت تعديله وSHA-256 لأول ميغابايت وآخره، فتُقرأ في أجزاء من الثانية حتى لملف
//! بعشرات الغيغابايتات. أي تعديل في الملف يغيّر الحجم أو الوقت فيتغيّر المفتاح. كل مدخل يحمل رقم
//! الإصدار والبصمة والخيارات التي حُسب بها، ويُحذف إن لم تطابق أو تلف، ولا يفشل التحليل بسبب
//! الذاكرة أبدًا (أسوأ الحالات: يُعاد الحساب). الحجم محدود: الأقدم استعمالًا يُحذف أولًا.

use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

/// يتغيّر حين تتغيّر صيغة ما يُحفظ: المدخلات القديمة تُتجاهل وتُحذف
const VERSION: u32 = 1;
/// يكفي نحو 100 ساعة من الكلام المفرَّغ (ساعة ≈ 600 KB)
pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 500;
/// ما يُقرأ من أول الملف وآخره للبصمة
const SAMPLE: u64 = 1024 * 1024;

/// بصمة الملف: الحجم، ووقت التعديل، وSHA-256 لأول ميغابايت وآخره
pub fn fingerprint(path: &Path) -> std::io::Result<String> {
    let meta = std::fs::metadata(path)?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    h.update(size.to_le_bytes());
    h.update(mtime.to_le_bytes());
    let mut buf = vec![0u8; SAMPLE.min(size) as usize];
    f.read_exact(&mut buf)?;
    h.update(&buf);
    if size > SAMPLE {
        let tail = SAMPLE.min(size - SAMPLE);
        f.seek(SeekFrom::Start(size - tail))?;
        let mut buf = vec![0u8; tail as usize];
        f.read_exact(&mut buf)?;
        h.update(&buf);
    }
    Ok(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Deserialize)]
struct Entry<T> {
    v: u32,
    kind: String,
    fingerprint: String,
    params: String,
    data: T,
}

/// مجلد الذاكرة وحدوده
#[derive(Debug, Clone)]
pub struct Cache {
    dir: PathBuf,
    max_bytes: u64,
    max_entries: usize,
}

impl Cache {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_limits(dir, MAX_BYTES, MAX_ENTRIES)
    }

    pub fn with_limits(dir: PathBuf, max_bytes: u64, max_entries: usize) -> Self {
        Cache {
            dir,
            max_bytes,
            max_entries,
        }
    }

    /// مجلد «analysis» في ذاكرة التطبيق (Windows: %LOCALAPPDATA%\com.jake750.khama\analysis)
    pub fn for_app(app: &tauri::AppHandle) -> Option<Self> {
        use tauri::Manager;
        app.path().app_cache_dir().ok().map(|d| Self::new(d.join("analysis")))
    }

    fn path(&self, kind: &str, fingerprint: &str, params: &str) -> PathBuf {
        let mut h = Sha256::new();
        for part in [kind, fingerprint, params] {
            h.update(part.as_bytes());
            h.update([0]);
        }
        let key = hex(&h.finalize());
        self.dir.join(format!("{kind}-{}.json", &key[..32]))
    }

    /// المحفوظ لهذا الملف بهذه الخيارات، أو لا شيء. مدخل قديم الإصدار أو تالف أو لا يطابق يُحذف
    pub fn get<T: DeserializeOwned>(&self, kind: &str, fingerprint: &str, params: &str) -> Option<T> {
        let p = self.path(kind, fingerprint, params);
        let bytes = std::fs::read(&p).ok()?;
        match serde_json::from_slice::<Entry<T>>(&bytes) {
            Ok(e) if e.v == VERSION && e.kind == kind && e.fingerprint == fingerprint && e.params == params => {
                // آخر استعمال = وقت التعديل: الحذف عند امتلاء الذاكرة يبدأ بما لم يُستعمل منذ زمن
                if let Ok(f) = std::fs::File::options().append(true).open(&p) {
                    let _ = f.set_modified(SystemTime::now());
                }
                Some(e.data)
            }
            _ => {
                log::info!("analysis cache: dropping stale entry {}", p.display());
                let _ = std::fs::remove_file(&p);
                None
            }
        }
    }

    /// يحفظ النتيجة (كتابة ذرّية)، ثم يُبقي الذاكرة تحت حدّيها. خطأ هنا يُسجَّل ولا يوقف شيئًا
    pub fn put<T: Serialize>(&self, kind: &str, fingerprint: &str, params: &str, data: &T) {
        let entry = Entry {
            v: VERSION,
            kind: kind.to_string(),
            fingerprint: fingerprint.to_string(),
            params: params.to_string(),
            data,
        };
        let result = std::fs::create_dir_all(&self.dir).and_then(|_| {
            let json = serde_json::to_vec(&entry).map_err(std::io::Error::other)?;
            crate::persist::write_atomic(&self.path(kind, fingerprint, params), &json)
        });
        match result {
            Ok(()) => self.prune(),
            Err(e) => log::warn!("analysis cache: {e}"),
        }
    }

    /// الأحدث استعمالًا يبقى ما دام المجموع تحت الحدّين، والباقي يُحذف
    pub fn prune(&self) {
        let Ok(dir) = std::fs::read_dir(&self.dir) else { return };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = dir
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((m.modified().unwrap_or(UNIX_EPOCH), m.len(), e.path()))
            })
            .collect();
        files.sort_by(|a, b| b.0.cmp(&a.0));
        let mut total = 0u64;
        for (i, (_, len, path)) in files.iter().enumerate() {
            total += len;
            if i >= self.max_entries || total > self.max_bytes {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("khama-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn fingerprint_changes_with_the_file() {
        let d = temp_dir("fp");
        let a = d.join("a.bin");
        // أكبر من ميغابايتين: الوسط لا يُقرأ، والأول والآخر يُقرآن
        let mut data = vec![7u8; 3 * 1024 * 1024];
        std::fs::write(&a, &data).unwrap();
        let fp1 = fingerprint(&a).unwrap();
        assert_eq!(fp1, fingerprint(&a).unwrap());
        assert_eq!(fp1.len(), 64);
        let t = std::fs::metadata(&a).unwrap().modified().unwrap();
        // تغيير آخر بايت مع إرجاع وقت التعديل: البصمة تتغيّر
        *data.last_mut().unwrap() = 8;
        std::fs::write(&a, &data).unwrap();
        std::fs::File::options().append(true).open(&a).unwrap().set_modified(t).unwrap();
        assert_ne!(fp1, fingerprint(&a).unwrap());
        // ملف صغير جدًا وملف فارغ
        std::fs::write(d.join("s"), b"abc").unwrap();
        std::fs::write(d.join("e"), b"").unwrap();
        assert_ne!(fingerprint(&d.join("s")).unwrap(), fingerprint(&d.join("e")).unwrap());
        assert!(fingerprint(&d.join("missing")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn round_trip_and_mismatches() {
        let d = temp_dir("rt");
        let c = Cache::new(d.clone());
        let data = (vec![[1.0, 2.0]], "نص".to_string());
        c.put("silences", "fp", "a", &data);
        assert_eq!(c.get::<(Vec<[f64; 2]>, String)>("silences", "fp", "a"), Some(data.clone()));
        // خيارات أو بصمة أو نوع آخر: لا شيء
        assert_eq!(c.get::<(Vec<[f64; 2]>, String)>("silences", "fp", "b"), None);
        assert_eq!(c.get::<(Vec<[f64; 2]>, String)>("silences", "fp2", "a"), None);
        assert_eq!(c.get::<(Vec<[f64; 2]>, String)>("speech", "fp", "a"), None);
        // صيغة أخرى (إصدار قديم أو بيانات بشكل آخر) تُحذف
        let p = c.path("silences", "fp", "a");
        assert_eq!(c.get::<Vec<String>>("silences", "fp", "a"), None);
        assert!(!p.exists());
        c.put("silences", "fp", "a", &data);
        let old = String::from_utf8(std::fs::read(&p).unwrap()).unwrap().replace("\"v\":1", "\"v\":0");
        std::fs::write(&p, old).unwrap();
        assert_eq!(c.get::<(Vec<[f64; 2]>, String)>("silences", "fp", "a"), None);
        assert!(!p.exists());
        // ملف تالف
        std::fs::write(&p, b"{not json").unwrap();
        assert_eq!(c.get::<(Vec<[f64; 2]>, String)>("silences", "fp", "a"), None);
        assert!(!p.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn prune_keeps_the_most_recently_used() {
        let d = temp_dir("prune");
        let c = Cache::with_limits(d.clone(), 10_000, 100);
        let now = SystemTime::now();
        for i in 0..5u64 {
            c.put("speech", &format!("f{i}"), "", &vec![i; 10]);
            let f = std::fs::File::options()
                .append(true)
                .open(c.path("speech", &format!("f{i}"), ""))
                .unwrap();
            f.set_modified(now - std::time::Duration::from_secs(100 - i * 10)).unwrap();
        }
        // استعمال الأقدم يجعله أحدث
        assert!(c.get::<Vec<u64>>("speech", "f0", "").is_some());
        Cache::with_limits(d.clone(), 10_000, 3).prune();
        let kept: Vec<bool> = (0..5).map(|i| c.path("speech", &format!("f{i}"), "").exists()).collect();
        assert_eq!(kept, vec![true, false, false, true, true]);
        // حد الحجم: مدخل أكبر من الحد كله لا يبقى
        let small = Cache::with_limits(d.clone(), 50, 100);
        small.put("speech", "big", "", &vec![0u64; 100]);
        assert!(!small.path("speech", "big", "").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
