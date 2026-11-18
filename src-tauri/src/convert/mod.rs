//! المحوّل (Encoder): يحوّل ملفات على جهاز المستخدم باستخدام FFmpeg المضمّن.
//!
//! الفكرة: المستخدم يختار "وش يبي يسوي بالملف" (Preset)، لا الكودك.
//! كل Preset يعرف حاويته وكودكاته وإعداداته، والخيارات الإضافية
//! (قص، تغيير المقاس، LUT، ترجمة محروقة، علامة مائية، توحيد الصوت...)
//! تُركّب كسلسلة فلاتر واحدة.
//!
//! التحويلات تمرّ بطابور: واحدة في كل مرة (FFmpeg يستهلك كل أنوية المعالج أصلًا).
//! الناتج يُكتب باسم مؤقت مخفي في مجلد الحفظ، ثم يُعاد تسميته عند النجاح،
//! فلا يرى المستخدم ملفًا ناقصًا أبدًا.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::{OnceCell, Semaphore, watch};

use crate::{
    download::{self, JobUpdate, Jobs, RunOutcome, emit, fraction, num, run_streaming, unique_path},
    errors::{AppError, tail},
    separate,
    settings::{self, SettingsState},
    tools::{self, Tools},
};

mod info;
pub use info::*;
mod presets;
pub use presets::*;
mod request;
pub use request::*;
mod args;
pub use args::*;
mod detect;
pub use detect::*;
mod estimate;
pub use estimate::*;
mod run;
pub use run::*;
#[cfg(test)]
mod tests;
#[cfg(desktop)]
mod watcher;
#[cfg(desktop)]
pub use watcher::*;

// ======================= الحالة =======================

/// طابور التحويل: تحويل واحد في كل مرة
pub struct ConvertQueue(pub Arc<Semaphore>);

impl Default for ConvertQueue {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(1)))
    }
}

/// مشفّرات كرت الشاشة المتاحة فعلًا على هذا الجهاز (تُفحص مرة واحدة)
static HW: OnceCell<Vec<String>> = OnceCell::const_new();
