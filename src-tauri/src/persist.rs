//! حفظ ملفات الإعدادات والسجل بأمان:
//! - الكتابة الذرّية: نكتب إلى ملف مؤقت ثم نعيد تسميته، فانقطاع الكهرباء أو إغلاق التطبيق
//!   أثناء الحفظ لا يترك ملفًا نصف مكتوب.
//! - الملف التالف لا يُستبدل بصمت: نحتفظ بنسخة منه (.corrupt) قبل الرجوع للقيم الافتراضية.

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::de::DeserializeOwned;

/// يكتب `data` إلى `path` كاملًا أو لا يكتب شيئًا.
pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    write_atomic_opts(path, data, false)
}

/// مثل write_atomic لكن الملف يقرؤه صاحبه فقط (T-32: الكوكيز). على Unix/Android صلاحيات 600؛
/// على Windows مجلد إعدادات التطبيق (AppData) خاص بالمستخدم أصلًا.
pub fn write_atomic_private(path: &Path, data: &[u8]) -> io::Result<()> {
    write_atomic_opts(path, data, true)
}

fn write_atomic_opts(path: &Path, data: &[u8], private: bool) -> io::Result<()> {
    let tmp = sibling(path, "tmp");
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        #[cfg(not(unix))]
        let _ = private;
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    // على Windows وUnix تستبدل rename الملف الموجود في خطوة واحدة
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// نتيجة قراءة ملف JSON
#[derive(Debug, PartialEq)]
pub enum Loaded<T> {
    /// الملف غير موجود (أول تشغيل)
    Missing,
    Ok(T),
    /// الملف موجود لكنه تالف؛ نُقل إلى المسار المرفق
    Corrupt(PathBuf),
}

/// يقرأ JSON من `path`. إن كان تالفًا يُنقل جانبًا حتى لا يمحوه الحفظ التالي.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Loaded<T> {
    let text = match read_retrying(path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Loaded::Missing,
        Err(_) => return quarantine(path),
    };
    match serde_json::from_str(&text) {
        Ok(v) => Loaded::Ok(v),
        Err(_) => quarantine(path),
    }
}

/// قفل مؤقت (مضاد فيروسات أو مزامنة سحابية تفتح الملف على Windows) ليس تلفًا (RD15):
/// نعيد المحاولة قليلًا قبل أن نعدّه تالفًا وننقله جانبًا. نص غير UTF-8 تالف فورًا.
fn read_retrying(path: &Path) -> io::Result<String> {
    let mut last = None;
    for wait in [0u64, 50, 150, 400] {
        if wait > 0 {
            std::thread::sleep(std::time::Duration::from_millis(wait));
        }
        match fs::read_to_string(path) {
            Ok(t) => return Ok(t),
            Err(e) if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::InvalidData) => return Err(e),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("read failed")))
}

impl<T: Default> Loaded<T> {
    /// القيمة أو الافتراضي، مع تسجيل التلف في سجل الأخطاء
    pub fn or_default_logged(self, what: &str) -> T {
        match self {
            Loaded::Ok(v) => v,
            Loaded::Missing => T::default(),
            Loaded::Corrupt(backup) => {
                log::error!("khama: {what} تالف، حُفظت نسخة في {}", backup.display());
                T::default()
            }
        }
    }
}

fn quarantine<T>(path: &Path) -> Loaded<T> {
    let backup = sibling(path, "corrupt");
    let _ = fs::rename(path, &backup);
    Loaded::Corrupt(backup)
}

fn sibling(path: &Path, ext: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".");
    name.push(ext);
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("khama-persist-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_atomic_replaces_existing_and_leaves_no_tmp() {
        let d = temp_dir("write");
        let p = d.join("settings.json");
        fs::write(&p, "old").unwrap();
        write_atomic(&p, b"new").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        assert!(!d.join("settings.json.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn private_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let d = temp_dir("private");
        let p = d.join("cookies.txt");
        write_atomic_private(&p, b"x").unwrap();
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn read_json_missing_ok_and_corrupt() {
        let d = temp_dir("read");
        let p = d.join("h.json");
        assert_eq!(read_json::<Vec<u32>>(&p), Loaded::Missing);

        fs::write(&p, "[1,2]").unwrap();
        assert_eq!(read_json::<Vec<u32>>(&p), Loaded::Ok(vec![1, 2]));

        fs::write(&p, "[1,2").unwrap();
        let backup = d.join("h.json.corrupt");
        assert_eq!(read_json::<Vec<u32>>(&p), Loaded::Corrupt(backup.clone()));
        assert!(!p.exists(), "التالف نُقل جانبًا");
        assert_eq!(fs::read_to_string(backup).unwrap(), "[1,2");
    }
}
