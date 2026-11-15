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
    let tmp = sibling(path, "tmp");
    {
        let mut f = fs::File::create(&tmp)?;
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
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Loaded::Missing,
        Err(_) => return quarantine(path),
    };
    match serde_json::from_str(&text) {
        Ok(v) => Loaded::Ok(v),
        Err(_) => quarantine(path),
    }
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
