//! المحوّل (Encoder): يحوّل ملفات على جهاز المستخدم باستخدام FFmpeg المضمّن.
//!
//! الفكرة: المستخدم يختار "وش يبي يسوي بالملف" (Preset)، لا الكودك.
//! كل Preset يعرف حاويته وكودكاته وإعداداته، والخيارات الإضافية
//! (قص، تغيير المقاس، LUT، ترجمة محروقة، علامة مائية، توحيد الصوت...)
//! تُركّب كسلسلة فلاتر واحدة.
//!
//! التحويلات تمرّ بطابور بمسارين (R3-F22): الثقيل (ترميز فيديو، فصل، تفريغ) واحد في كل مرة
//! (FFmpeg يستهلك كل أنوية المعالج أصلًا)، والخفيف (نسخ، صوت، إطار، كشف) يعمل بجانبه.
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
mod preview;
pub use preview::*;
mod run;
pub use run::*;
mod topics;
pub use topics::*;
mod denoise;
pub mod silence;
pub mod words;
pub use silence::SilenceLevels;
#[cfg(test)]
mod tests;
#[cfg(desktop)]
mod watcher;
#[cfg(desktop)]
pub use watcher::*;

// ======================= الحالة =======================

/// طابور التحويل بمسارين (R3-F22): الثقيل واحد في كل مرة وتحت الحد المشترك مع التنزيلات (T-41)،
/// والخفيف حتى LIGHT_JOBS بجانبه، فلا ينتظر نسخ أو استخراج صوت لثوانٍ خلف ترميز ProRes لساعة
pub struct ConvertQueue {
    pub heavy: Arc<Semaphore>,
    pub light: Arc<Semaphore>,
}

/// تحويلات خفيفة تعمل معًا بجانب الثقيل
pub const LIGHT_JOBS: usize = 2;

impl Default for ConvertQueue {
    fn default() -> Self {
        Self {
            heavy: Arc::new(Semaphore::new(1)),
            light: Arc::new(Semaphore::new(LIGHT_JOBS)),
        }
    }
}

impl ConvertQueue {
    /// المسار الذي ينتظر فيه تحويل بهذه الصيغة
    pub fn lane(&self, p: &Preset) -> Arc<Semaphore> {
        if is_light(p) { self.light.clone() } else { self.heavy.clone() }
    }
}

/// خفيف: لا يرمّز صورة ولا يشغّل نموذجًا. نسخ بلا ترميز، صوت، إطار واحد، كشف (المشاهد والسواد والصمت).
/// تحليل المواضيع ليس منها: يفرّغ الكلام بـ whisper
pub fn is_light(p: &Preset) -> bool {
    match p.kind {
        PKind::Copy | PKind::Audio | PKind::Frame => true,
        PKind::Detect => p.id != "topics",
        PKind::Video | PKind::Gif | PKind::Sequence | PKind::Stems => false,
    }
}

/// مشفّرات كرت الشاشة المتاحة فعلًا على هذا الجهاز (تُفحص مرة واحدة)
static HW: OnceCell<Vec<String>> = OnceCell::const_new();
