//! كشف الصمت بعتبة تتكيّف مع الملف.
//!
//! عتبة ثابتة (-40 dB) لا تجد شيئًا في تسجيل صوتي فيه ضجيج غرفة، أو مُعلّى الصوت بعد التسجيل:
//! «الصمت» فيه حول -37 dB. لذلك نقيس مستوى كل 20 ms من الملف، ونأخذ مستوى الضجيج (أهدأ 10%)
//! ومستوى الكلام (أعلى 10%)، والعتبة بينهما أقرب إلى الضجيج.

use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

const RATE: usize = 16_000;
/// طول الإطار: 20 ms
const FRAME: usize = RATE / 50;
pub const FRAME_SECS: f64 = FRAME as f64 / RATE as f64;
const FLOOR_DB: f32 = -90.0;

/// مستوى (dB) كل إطار من 20 ms، وبداية أول إطار (ث)
pub struct Levels {
    pub start: f64,
    pub db: Vec<f32>,
}

fn frame_db(sum_sq: f64, n: usize) -> f32 {
    let ms = sum_sq / n as f64 / (32768.0 * 32768.0);
    ((10.0 * (ms + 1e-12).log10()) as f32).max(FLOOR_DB)
}

#[cfg(test)]
/// مستوى كل إطار من عيّنات 16 بت أحادية بتردد 16 kHz
pub fn levels_from_samples(samples: &[i16]) -> Vec<f32> {
    samples
        .as_chunks::<FRAME>()
        .0
        .iter()
        .map(|c| frame_db(c.iter().map(|&s| f64::from(s) * f64::from(s)).sum(), FRAME))
        .collect()
}

fn percentile(sorted: &[f32], q: f64) -> f32 {
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

/// العتبة التلقائية: فوق مستوى الضجيج بـ 30% من المسافة إلى الكلام (بين 4 و15 dB).
/// ملف بلا فرق واضح بين الهادئ والعالي (موسيقى متصلة، ضجيج فقط): لا صمت فيه.
pub fn auto_threshold(db: &[f32]) -> Option<f64> {
    if db.is_empty() {
        return None;
    }
    let mut s = db.to_vec();
    s.sort_by(f32::total_cmp);
    let (lo, hi) = (f64::from(percentile(&s, 0.10)), f64::from(percentile(&s, 0.90)));
    if hi - lo < 10.0 {
        return None;
    }
    Some(lo + ((hi - lo) * 0.3).clamp(4.0, 15.0))
}

/// فترات الصمت: إطارات متتالية تحت العتبة لا تقل مدتها عن `min` ثانية.
/// صمت في آخر الملف يُحسب أيضًا (silencedetect كان يُسقطه لأنه لا ينتهي).
pub fn silent_runs(lv: &Levels, threshold: f64, min: f64) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    let mut open: Option<usize> = None;
    let close = |out: &mut Vec<[f64; 2]>, a: usize, b: usize| {
        if (b - a) as f64 * FRAME_SECS + 1e-9 >= min {
            out.push([lv.start + a as f64 * FRAME_SECS, lv.start + b as f64 * FRAME_SECS]);
        }
    };
    for (i, &d) in lv.db.iter().enumerate() {
        if f64::from(d) < threshold {
            open.get_or_insert(i);
        } else if let Some(a) = open.take() {
            close(&mut out, a, i);
        }
    }
    if let Some(a) = open {
        close(&mut out, a, lv.db.len());
    }
    out
}

/// الصمت بالخيارات: عتبة المستخدم إن اختارها، وإلا التلقائية. يعيد العتبة المستعملة أيضًا
pub fn find_silences(lv: &Levels, db: Option<f64>, min: Option<f64>) -> (Vec<[f64; 2]>, Option<f64>) {
    let min = min.filter(|v| v.is_finite()).unwrap_or(0.6).clamp(0.1, 30.0);
    let thr = match db.filter(|v| v.is_finite()) {
        Some(v) => Some(v.clamp(-80.0, -10.0)),
        None => auto_threshold(&lv.db),
    };
    match thr {
        Some(t) => (silent_runs(lv, t, min), Some(t)),
        None => (Vec::new(), None),
    }
}

/// يفكّ الصوت إلى PCM ويقيس كل إطار دون حفظ العيّنات. None = ألغاه المستخدم
pub fn levels_blocking(
    mut cmd: Command,
    input: &Path,
    start: Option<f64>,
    end: Option<f64>,
    mut progress: impl FnMut(f64),
    cancel: &AtomicBool,
) -> std::io::Result<Option<Levels>> {
    cmd.args(["-hide_banner", "-nostdin", "-v", "error"]);
    let t0 = start.filter(|v| *v > 0.0);
    if let Some(s) = t0 {
        cmd.args(["-ss", &format!("{s:.3}")]);
    }
    if let Some(e) = end {
        cmd.args(["-to", &format!("{e:.3}")]);
    }
    cmd.arg("-copyts").arg("-i").arg(input);
    cmd.args([
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-ac",
        "1",
        "-ar",
        &RATE.to_string(),
        "-f",
        "s16le",
        "pipe:1",
    ]);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn()?;
    let mut out = child.stdout.take().expect("piped");
    let err = child.stderr.take().expect("piped");
    let log: Arc<Mutex<String>> = Arc::default();
    let l2 = log.clone();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            let mut l = l2.lock().unwrap();
            if l.len() < 64 * 1024 {
                l.push_str(&line);
                l.push('\n');
            }
        }
    });

    let mut db = Vec::new();
    let mut buf = vec![0u8; FRAME * 2 * 50];
    let mut pending: Vec<u8> = Vec::with_capacity(buf.len() + FRAME * 2);
    let mut canceled = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            canceled = true;
            break;
        }
        let n = out.read(&mut buf)?;
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        let whole = pending.len() / (FRAME * 2) * (FRAME * 2);
        for f in pending[..whole].as_chunks::<{ FRAME * 2 }>().0 {
            let sum: f64 = f.as_chunks::<2>().0.iter().map(|b| f64::from(i16::from_le_bytes(*b)).powi(2)).sum();
            db.push(frame_db(sum, FRAME));
        }
        pending.drain(..whole);
        progress(t0.unwrap_or(0.0) + db.len() as f64 * FRAME_SECS);
    }
    if canceled {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(None);
    }
    drop(out);
    let status = child.wait()?;
    let _ = reader.join();
    if !status.success() {
        return Err(std::io::Error::other(crate::errors::tail(&log.lock().unwrap(), 8)));
    }
    Ok(Some(Levels {
        start: t0.unwrap_or(0.0),
        db,
    }))
}

/// من الكود غير المتزامن (التطبيق): `progress` تأخذ الزمن المحلَّل بالثواني
pub async fn levels_file(
    tools: &crate::tools::Tools,
    input: &Path,
    start: Option<f64>,
    end: Option<f64>,
    mut progress: impl FnMut(f64),
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Option<Levels>, crate::errors::AppError> {
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.envs(tools.env.iter().map(|(k, v)| (k, v)));
    let done = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (d2, s2, input) = (done.clone(), stop.clone(), PathBuf::from(input));
    let mut handle = tauri::async_runtime::spawn_blocking(move || {
        levels_blocking(cmd, &input, start, end, |t| d2.store(t.to_bits(), Ordering::Relaxed), &s2)
    });
    loop {
        tokio::select! {
            r = &mut handle => {
                let r = r.map_err(|e| crate::errors::AppError::with_detail("encodeFailed", e.to_string()))?;
                return r.map_err(|e| crate::errors::AppError::with_detail("encodeFailed", e.to_string()));
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                let t = f64::from_bits(done.load(Ordering::Relaxed));
                if t > 0.0 {
                    progress(t);
                }
            }
            _ = crate::download::canceled(cancel) => {
                stop.store(true, Ordering::Relaxed);
                let _ = (&mut handle).await;
                return Ok(None);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// تسجيل فيه ضجيج غرفة حول -37 dB وكلام حول -16 dB: -40 الثابتة لا تجد فيه صمتًا
    fn noisy(pattern: &[(f32, usize)]) -> Levels {
        Levels {
            start: 0.0,
            db: pattern.iter().flat_map(|&(d, n)| std::iter::repeat_n(d, n)).collect(),
        }
    }

    #[test]
    fn auto_finds_pauses_in_noisy_room() {
        // كلام 2 ث، وقفة 1 ث، كلام 2 ث، وقفة 0.3 ث (أقصر من الحد)، كلام 1 ث، وقفة 1.5 ث في الآخر
        let lv = noisy(&[(-16.0, 100), (-37.0, 50), (-17.0, 100), (-37.0, 15), (-16.0, 50), (-38.0, 75)]);
        assert!(silent_runs(&lv, -40.0, 0.6).is_empty());
        let (runs, thr) = find_silences(&lv, None, None);
        let thr = thr.unwrap();
        assert!(thr > -37.0 && thr < -20.0, "{thr}");
        assert_eq!(runs.len(), 2);
        assert!((runs[0][0] - 2.0).abs() < 1e-6 && (runs[0][1] - 3.0).abs() < 1e-6);
        // صمت آخر الملف يُحسب
        assert!((runs[1][0] - 6.3).abs() < 1e-6 && (runs[1][1] - 7.8).abs() < 1e-6);
    }

    #[test]
    fn manual_level_is_respected() {
        let lv = noisy(&[(-16.0, 100), (-37.0, 50), (-16.0, 100)]);
        assert!(find_silences(&lv, Some(-40.0), None).0.is_empty());
        assert_eq!(find_silences(&lv, Some(-30.0), None).0.len(), 1);
    }

    #[test]
    fn steady_audio_has_no_silence() {
        let lv = noisy(&[(-20.0, 200), (-24.0, 200)]);
        assert_eq!(find_silences(&lv, None, None), (vec![], None));
    }

    #[test]
    fn start_offset_and_levels() {
        let mut s = vec![0i16; FRAME * 40];
        s.extend(std::iter::repeat_n(8000i16, FRAME * 40));
        let db = levels_from_samples(&s);
        assert_eq!(db.len(), 80);
        assert_eq!(db[0], FLOOR_DB);
        let lv = Levels { start: 10.0, db };
        let (runs, _) = find_silences(&lv, None, Some(0.5));
        assert_eq!(runs, vec![[10.0, 10.8]]);
    }
}
