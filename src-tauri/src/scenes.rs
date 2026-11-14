//! Shot-boundary detection written for Khama (replaces FFmpeg's fixed `gt(scene,0.3)`).
//!
//! Pipeline (all frames are first downscaled to 160×90 by FFmpeg):
//!   1. Features per frame: a quantised HSV colour histogram of the whole frame and of a 3×3 grid
//!      of blocks, plus the mean and standard deviation of the luma.
//!   2. Frame distance d(t) between consecutive frames:
//!         d(t) = α · D(H_t, H_{t-1}) + (1 − α) · mean_b D(H_t^b, H_{t-1}^b),   D(p, q) = ½ Σ |p_i − q_i| ∈ [0, 1]
//!   3. Hard cuts: d(t) is a local maximum and exceeds an adaptive threshold computed on a sliding window
//!      around t (the frames t−1..t+1 are excluded so the cut does not raise its own threshold):
//!         T(t) = max(τ_min, centre + k · spread)
//!      where (centre, spread) is either (mean, std) or the robust pair (median, 1.4826 · MAD).
//!      A camera flash (frame t differs from both neighbours, which resemble each other) is rejected.
//!   4. Gradual transitions (dissolves, fades) with an adaptive twin-comparison: a run of frames whose
//!      d(t) stays above a low threshold T_low(t) is accepted when the accumulated change between the
//!      first and last frame of the run, D(H_s, H_e), is large.
//!   5. Fades through black/white: runs of flat (monochrome) frames merge the fade-out and fade-in into one transition.
//!
//! The module has no dependency on Tauri: the app and the `khama-bench` evaluation binary run the same code.

use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

/// Size of the analysed frames (enough for colour statistics, ~40× cheaper than 1080p)
pub const W: usize = 160;
pub const H: usize = 90;
const GRID: usize = 3;
/// Hue × saturation × value bins for coloured pixels, plus value bins for grey pixels
const HB: usize = 8;
const SB: usize = 3;
const VB: usize = 3;
const GREY: usize = 6;
pub const BINS: usize = HB * SB * VB + GREY;
/// Luma thumbnail for the structural (pixel) signal: 32×18, each value the mean of a 5×5 block
const TW: usize = 32;
const TH: usize = 18;

/// Features of one frame
#[derive(Clone, Debug)]
pub struct Frame {
    /// Normalised histogram of the whole frame
    pub hist: Vec<f32>,
    /// Normalised histograms of the GRID×GRID blocks
    pub blocks: Vec<Vec<f32>>,
    /// Mean and standard deviation of the luma (0..255)
    pub luma_mean: f32,
    pub luma_std: f32,
    /// 32×18 luma thumbnail (0..255)
    pub thumb: Vec<f32>,
    /// Presentation time in seconds
    pub time: f64,
}

/// Linear split of a coordinate between two neighbouring bins (bin centres at i + ½)
#[inline]
fn split(x: f32, bins: usize) -> (usize, usize, f32) {
    let p = (x * bins as f32 - 0.5).clamp(0.0, (bins - 1) as f32);
    let i = p.floor() as usize;
    let f = p - i as f32;
    (i, (i + 1).min(bins - 1), f)
}

/// Soft (trilinear) binning: each pixel spreads a total weight of 1 over the neighbouring bins, so a gradual
/// change of colour moves the histogram gradually instead of making whole pixels jump between bins.
/// Hue is circular; dark or unsaturated pixels fall progressively into grey bins (hue is meaningless there).
#[inline]
fn soft_bins(r: u8, g: u8, b: u8, out: &mut [(usize, f32); 10]) -> usize {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let v = max;
    let c = max - min;
    let s = if max > 0.0 { c / max } else { 0.0 };
    let colour = (((s - 0.10) / 0.16).clamp(0.0, 1.0)).min(((v - 0.08) / 0.08).clamp(0.0, 1.0));
    let mut n = 0;
    if colour < 1.0 {
        let (g0, g1, f) = split(v, GREY);
        let w = 1.0 - colour;
        out[n] = (HB * SB * VB + g0, w * (1.0 - f));
        out[n + 1] = (HB * SB * VB + g1, w * f);
        n += 2;
    }
    if colour > 0.0 {
        let h = if c == 0.0 {
            0.0
        } else if max == r {
            ((g - b) / c).rem_euclid(6.0)
        } else if max == g {
            (b - r) / c + 2.0
        } else {
            (r - g) / c + 4.0
        } / 6.0;
        // circular hue
        let ph = h * HB as f32 - 0.5;
        let hf = ph - ph.floor();
        let h0 = (ph.floor() as i32).rem_euclid(HB as i32) as usize;
        let h1 = (h0 + 1) % HB;
        let (s0, s1, sf) = split(((s - 0.10) / 0.90).clamp(0.0, 1.0), SB);
        let (v0, v1, vf) = split(((v - 0.08) / 0.92).clamp(0.0, 1.0), VB);
        for (hi, hw) in [(h0, 1.0 - hf), (h1, hf)] {
            for (si, sw) in [(s0, 1.0 - sf), (s1, sf)] {
                for (vi, vw) in [(v0, 1.0 - vf), (v1, vf)] {
                    out[n] = ((hi * SB + si) * VB + vi, colour * hw * sw * vw);
                    n += 1;
                }
            }
        }
    }
    n
}

/// Features of an RGB24 frame of W×H pixels
pub fn features(rgb: &[u8], time: f64) -> Frame {
    debug_assert_eq!(rgb.len(), W * H * 3);
    let mut hist = vec![0f32; BINS];
    let mut blocks = vec![vec![0f32; BINS]; GRID * GRID];
    let mut counts = [0f32; GRID * GRID];
    let (mut sum, mut sum2) = (0f64, 0f64);
    let mut bins = [(0usize, 0f32); 10];
    let mut thumb = vec![0f32; TW * TH];
    for y in 0..H {
        let by = y * GRID / H;
        for x in 0..W {
            let i = (y * W + x) * 3;
            let (r, g, b) = (rgb[i], rgb[i + 1], rgb[i + 2]);
            let blk = by * GRID + x * GRID / W;
            let m = soft_bins(r, g, b, &mut bins);
            for &(k, w) in &bins[..m] {
                hist[k] += w;
                blocks[blk][k] += w;
            }
            counts[blk] += 1.0;
            let l = 0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64;
            thumb[(y * TH / H) * TW + x * TW / W] += l as f32;
            sum += l;
            sum2 += l * l;
        }
    }
    let n = (W * H) as f32;
    hist.iter_mut().for_each(|v| *v /= n);
    for (b, c) in blocks.iter_mut().zip(counts) {
        b.iter_mut().for_each(|v| *v /= c.max(1.0));
    }
    let mean = sum / (W * H) as f64;
    let var = (sum2 / (W * H) as f64 - mean * mean).max(0.0);
    let per = ((W / TW) * (H / TH)) as f32;
    thumb.iter_mut().for_each(|v| *v /= per);
    Frame {
        hist,
        blocks,
        luma_mean: mean as f32,
        luma_std: var.sqrt() as f32,
        thumb,
        time,
    }
}

/// D(p, q) = ½ Σ|p − q| (= 1 − histogram intersection), in [0, 1]
pub fn hist_dist(p: &[f32], q: &[f32]) -> f32 {
    0.5 * p.iter().zip(q).map(|(a, b)| (a - b).abs()).sum::<f32>()
}

/// Mean absolute luma difference of two thumbnails, in [0, 1]: sees cuts between shots with the same colours
pub fn pix_dist(a: &Frame, b: &Frame) -> f32 {
    a.thumb.iter().zip(&b.thumb).map(|(x, y)| (x - y).abs()).sum::<f32>() / (a.thumb.len() as f32 * 255.0)
}

/// Detector parameters (defaults chosen by the evaluation in bench/scenes)
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Params {
    /// Weight of the global histogram vs. the block histograms
    pub alpha: f32,
    /// Half-width of the sliding window, in frames
    pub window: usize,
    /// Cut threshold: centre + k · spread
    pub k: f32,
    /// Absolute floor of the cut threshold
    pub min_score: f32,
    /// Robust statistics (median and MAD) instead of mean and standard deviation
    pub robust: bool,
    /// Reject camera flashes (1-3 frames that differ, between frames that resemble each other)
    pub flash: bool,
    /// Second cut signal: luma thumbnail difference with its own adaptive threshold (jump cuts with the same colours)
    pub pixel: bool,
    pub k_pix: f32,
    pub min_pix: f32,
    /// Minimum distance between two boundaries, in frames
    pub min_gap: usize,
    /// Detect gradual transitions (dissolves and fades)
    pub gradual: bool,
    /// Low threshold for gradual transitions: centre + k_low · spread, at least low_floor
    pub k_low: f32,
    pub low_floor: f32,
    /// Accumulated change needed between the first and last frame of a gradual transition
    pub grad_min: f32,
    /// Minimum length of a gradual transition, in frames
    pub grad_len: usize,
    /// Luma standard deviation under which a frame counts as flat (black/white)
    pub flat_std: f32,
}

impl Default for Params {
    // Tuned on the dev half of the synthetic set (bench/scenes/evaluate.py, results/scenes_grid_dev.csv).
    fn default() -> Self {
        Self {
            alpha: 0.0,
            window: 18,
            k: 5.0,
            min_score: 0.22,
            robust: true,
            flash: true,
            pixel: true,
            k_pix: 4.0,
            min_pix: 0.04,
            min_gap: 6,
            gradual: true,
            k_low: 1.5,
            low_floor: 0.05,
            grad_min: 0.25,
            grad_len: 4,
            flat_std: 6.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Cut,
    Gradual,
}

/// A detected boundary: frames start..=end are the transition; `end` is the first frame of the new shot
#[derive(Clone, Debug, serde::Serialize)]
pub struct Boundary {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
    pub score: f32,
    /// Time of the first frame of the new shot
    pub time: f64,
    /// Time of the first frame of the transition (= time for a cut)
    pub start_time: f64,
}

impl Boundary {
    /// The [start, end] marker shown in the app: one instant for a cut, the span of a gradual transition
    pub fn marker(&self) -> [f64; 2] {
        match self.kind {
            Kind::Cut => [self.time, self.time],
            Kind::Gradual => [self.start_time, self.time],
        }
    }
}

/// Consecutive-frame distances; d[0] = 0
pub fn distances(frames: &[Frame], alpha: f32) -> Vec<f32> {
    let mut d = vec![0f32; frames.len()];
    for t in 1..frames.len() {
        d[t] = pair_dist(&frames[t - 1], &frames[t], alpha);
    }
    d
}

fn pair_dist(a: &Frame, b: &Frame, alpha: f32) -> f32 {
    let g = hist_dist(&a.hist, &b.hist);
    if alpha >= 1.0 {
        return g;
    }
    let l = a.blocks.iter().zip(&b.blocks).map(|(p, q)| hist_dist(p, q)).sum::<f32>() / a.blocks.len() as f32;
    alpha * g + (1.0 - alpha) * l
}

/// (centre, spread) of d over the window around t, without t−1..t+1.
/// `causal` = only the frames before t (used for gradual transitions, which must not raise their own threshold).
fn window_stats(d: &[f32], t: usize, half: usize, robust: bool, causal: bool, buf: &mut Vec<f32>) -> (f32, f32) {
    buf.clear();
    let lo = t.saturating_sub(if causal { 2 * half } else { half }).max(1);
    let hi = if causal { t.saturating_sub(2) } else { (t + half).min(d.len() - 1) };
    for (i, v) in d.iter().enumerate().take(hi + 1).skip(lo) {
        if i + 1 < t || i > t + 1 {
            buf.push(*v);
        }
    }
    if buf.is_empty() {
        return (0.0, 0.0);
    }
    if robust {
        buf.sort_by(|a, b| a.total_cmp(b));
        let med = buf[buf.len() / 2];
        for v in buf.iter_mut() {
            *v = (*v - med).abs();
        }
        buf.sort_by(|a, b| a.total_cmp(b));
        (med, 1.4826 * buf[buf.len() / 2])
    } else {
        let n = buf.len() as f32;
        let m = buf.iter().sum::<f32>() / n;
        let var = buf.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / n;
        (m, var.sqrt())
    }
}

/// Runs the whole detector on the features of a sequence
pub fn detect(frames: &[Frame], p: &Params) -> Vec<Boundary> {
    let n = frames.len();
    if n < 3 {
        return Vec::new();
    }
    let d = distances(frames, p.alpha);
    let mut buf = Vec::with_capacity(2 * p.window + 1);
    let stats: Vec<(f32, f32)> = (0..n).map(|t| window_stats(&d, t, p.window, p.robust, false, &mut buf)).collect();
    let flat: Vec<bool> = frames.iter().map(|f| f.luma_std < p.flat_std).collect();
    // structural signal
    let mut e = vec![0f32; n];
    for t in 1..n {
        e[t] = pix_dist(&frames[t - 1], &frames[t]);
    }
    let stats_e: Vec<(f32, f32)> = if p.pixel {
        (0..n).map(|t| window_stats(&e, t, p.window, p.robust, false, &mut buf)).collect()
    } else {
        Vec::new()
    };
    let local_max = |x: &[f32], t: usize| {
        let lo = t.saturating_sub(2).max(1);
        let hi = (t + 2).min(n - 1);
        !(lo..=hi).any(|i| x[i] > x[t])
    };
    let comb =
        |a: usize, b: usize| pair_dist(&frames[a], &frames[b], p.alpha).max(if p.pixel { pix_dist(&frames[a], &frames[b]) } else { 0.0 });

    // ---- 1. hard cuts: a spike of the colour signal OR of the structural signal ----
    let mut cuts: Vec<Boundary> = Vec::new();
    for t in 1..n {
        let (c, s) = stats[t];
        let by_hist = d[t] >= p.min_score.max(c + p.k * s) && local_max(&d, t);
        let by_pix = p.pixel && {
            let (ce, se) = stats_e[t];
            e[t] >= p.min_pix.max(ce + p.k_pix * se) && local_max(&e, t)
        };
        if !by_hist && !by_pix {
            continue;
        }
        let spike = if p.pixel { comb(t - 1, t) } else { d[t] };
        if p.flash {
            // start of a flash: frame t differs, but what follows resembles what came before
            let after = (1..=3)
                .filter(|j| t + j < n)
                .map(|j| comb(t - 1, t + j))
                .fold(f32::INFINITY, f32::min);
            // end of a flash: frame t resembles the frames before the flash began
            let before = (1..=3).filter(|j| t > *j).map(|j| comb(t - 1 - j, t)).fold(f32::INFINITY, f32::min);
            if after < 0.35 * spike || before < 0.35 * spike {
                continue;
            }
        }
        // cuts to or from a flat frame belong to a fade, not to a cut
        if flat[t] && flat[t - 1] {
            continue;
        }
        let score = if by_hist { d[t] } else { e[t] };
        cuts.push(Boundary {
            kind: Kind::Cut,
            start: t - 1,
            end: t,
            score,
            time: frames[t].time,
            start_time: frames[t].time,
        });
    }

    // ---- 2. gradual transitions (twin comparison) ----
    let mut grads: Vec<Boundary> = Vec::new();
    if p.gradual {
        let is_cut = |t: usize| cuts.iter().any(|c| c.end == t);
        let past: Vec<(f32, f32)> = (0..n).map(|t| window_stats(&d, t, p.window, p.robust, true, &mut buf)).collect();
        let mut t = 1;
        while t < n {
            // the low threshold comes from the frames before the run and stays fixed during it
            let low = p.low_floor.max(past[t].0 + p.k_low * past[t].1);
            if is_cut(t) || d[t] < low {
                t += 1;
                continue;
            }
            let s = t - 1;
            let mut e = t;
            // allow one quiet frame inside the transition
            while e + 1 < n && !is_cut(e + 1) && (d[e + 1] >= low || (e + 2 < n && d[e + 2] >= low && !is_cut(e + 2))) {
                e += 1;
            }
            let len = e - s;
            let acc = pair_dist(&frames[s], &frames[e], p.alpha);
            let through_flat = (s..=e).any(|i| flat[i]);
            if len >= p.grad_len && (acc >= p.grad_min || through_flat) {
                grads.push(Boundary {
                    kind: Kind::Gradual,
                    start: s,
                    end: e,
                    score: acc,
                    time: frames[e].time,
                    start_time: frames[s].time,
                });
            }
            t = e + 1;
        }
        // a fade-out and a fade-in separated only by flat frames are one transition
        let mut merged: Vec<Boundary> = Vec::new();
        for g in grads {
            if let Some(prev) = merged.last_mut() {
                if g.start <= prev.end + 1 || (prev.end + 1..g.start).all(|i| flat[i]) {
                    prev.end = g.end;
                    prev.time = g.time;
                    prev.score = prev.score.max(g.score);
                    continue;
                }
            }
            merged.push(g);
        }
        // a fade from black at the very start, or to black at the very end, is not a boundary between shots
        grads = merged
            .into_iter()
            .filter(|g| !(flat[..=g.start].iter().all(|f| *f) || flat[g.end..].iter().all(|f| *f)))
            .collect();
    }

    // ---- 3. merge, keep the strongest within min_gap ----
    let mut all: Vec<Boundary> = cuts.into_iter().chain(grads).collect();
    all.sort_by_key(|b| b.start);
    let mut out: Vec<Boundary> = Vec::new();
    for b in all {
        if let Some(prev) = out.last_mut() {
            if b.start <= prev.end + p.min_gap {
                // a cut inside a gradual run: keep the gradual span; otherwise keep the stronger one
                if prev.kind == Kind::Gradual || b.kind == Kind::Gradual {
                    prev.start = prev.start.min(b.start);
                    prev.end = prev.end.max(b.end);
                    prev.time = frames[prev.end].time;
                    prev.start_time = frames[prev.start].time;
                    prev.kind = Kind::Gradual;
                    prev.score = prev.score.max(b.score);
                } else if b.score > prev.score {
                    *prev = b;
                }
                continue;
            }
        }
        out.push(b);
    }
    out
}

// ======================= decoding with FFmpeg =======================

/// Result of analysing a file
pub struct Analysis {
    pub frames: Vec<Frame>,
}

/// Decodes the first video stream at W×H and computes the features of every frame.
/// `progress` receives the time (s) of the last analysed frame. Returns None when cancelled.
pub fn analyze_blocking(
    mut cmd: Command,
    input: &Path,
    start: Option<f64>,
    end: Option<f64>,
    mut progress: impl FnMut(f64),
    cancel: &AtomicBool,
) -> std::io::Result<Option<Analysis>> {
    cmd.args(["-hide_banner", "-nostdin", "-v", "info"]);
    if let Some(s) = start.filter(|v| *v > 0.0) {
        cmd.args(["-ss", &format!("{s:.3}")]);
    }
    if let Some(e) = end {
        cmd.args(["-to", &format!("{e:.3}")]);
    }
    cmd.arg("-copyts").arg("-i").arg(input);
    cmd.args([
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-vf",
        &format!("scale={W}:{H}:flags=area,format=rgb24,showinfo"),
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
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

    // showinfo writes one line per frame with its pts_time (in decoding order = order of the raw frames)
    let times: Arc<Mutex<Vec<f64>>> = Arc::default();
    let log: Arc<Mutex<String>> = Arc::default();
    let (t2, l2) = (times.clone(), log.clone());
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(err).lines().map_while(Result::ok) {
            if line.contains("Parsed_showinfo") {
                if let Some(t) = field(&line, "pts_time:") {
                    t2.lock().unwrap().push(t);
                }
            } else {
                let mut l = l2.lock().unwrap();
                l.push_str(&line);
                l.push('\n');
            }
        }
    });

    let size = W * H * 3;
    let mut buf = vec![0u8; size];
    let mut frames = Vec::new();
    let mut canceled = false;
    loop {
        if cancel.load(Ordering::Relaxed) {
            canceled = true;
            break;
        }
        if let Err(e) = out.read_exact(&mut buf) {
            if e.kind() == std::io::ErrorKind::UnexpectedEof {
                break;
            }
            return Err(e);
        }
        // the showinfo line may arrive slightly after the frame: fill the time in later
        frames.push(features(&buf, f64::NAN));
        if frames.len() % 25 == 0 {
            if let Some(t) = times.lock().unwrap().last() {
                progress(*t);
            }
        }
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
    let times = times.lock().unwrap();
    for (i, f) in frames.iter_mut().enumerate() {
        f.time = times.get(i).copied().unwrap_or(f64::NAN);
    }
    // missing times (should not happen): extrapolate from the previous frame
    for i in 0..frames.len() {
        if frames[i].time.is_nan() {
            frames[i].time = if i > 0 {
                frames[i - 1].time + 1.0 / 30.0
            } else {
                start.unwrap_or(0.0)
            };
        }
    }
    Ok(Some(Analysis { frames }))
}

/// Runs the analysis in a worker thread from async code (the app): `progress` gets the analysed time in seconds.
/// Returns None if the user cancelled.
pub async fn detect_file(
    tools: &crate::tools::Tools,
    input: &Path,
    start: Option<f64>,
    end: Option<f64>,
    params: Params,
    mut progress: impl FnMut(f64),
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<Option<Vec<Boundary>>, crate::errors::AppError> {
    use std::sync::atomic::AtomicU64;
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.envs(tools.env.iter().map(|(k, v)| (k, v)));
    let done = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (d2, s2, input) = (done.clone(), stop.clone(), input.to_path_buf());
    let mut handle = tauri::async_runtime::spawn_blocking(move || {
        analyze_blocking(cmd, &input, start, end, |t| d2.store(t.to_bits(), Ordering::Relaxed), &s2)
            .map(|a| a.map(|a| detect(&a.frames, &params)))
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

fn field(line: &str, key: &str) -> Option<f64> {
    let i = line.find(key)? + key.len();
    let rest = line[i..].trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e'))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

// ======================= tests =======================

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic frame: solid colour with a moving square, plus a little noise
    fn frame(rgb: [u8; 3], square: [u8; 3], pos: usize, seed: u32, time: f64) -> Frame {
        let mut img = vec![0u8; W * H * 3];
        let mut s = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
        // the square bounces between the edges (no wrap-around: a jump across the frame is not motion)
        let m = pos % (2 * (W - 30));
        let x0 = if m < W - 30 { m } else { 2 * (W - 30) - m };
        for y in 0..H {
            for x in 0..W {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                let noise = (s % 9) as i16 - 4;
                let c = if x >= x0 && x < x0 + 30 && (30..60).contains(&y) {
                    square
                } else {
                    rgb
                };
                let i = (y * W + x) * 3;
                for k in 0..3 {
                    img[i + k] = (c[k] as i16 + noise).clamp(0, 255) as u8;
                }
            }
        }
        features(&img, time)
    }

    fn blend(a: &[u8; 3], b: &[u8; 3], w: f32) -> [u8; 3] {
        [0, 1, 2].map(|k| (a[k] as f32 * (1.0 - w) + b[k] as f32 * w).round() as u8)
    }

    const A: [u8; 3] = [200, 40, 40];
    const B: [u8; 3] = [30, 90, 200];
    const C: [u8; 3] = [40, 170, 60];
    const SQ: [u8; 3] = [240, 230, 80];

    #[test]
    fn identical_histograms_have_zero_distance() {
        let f = frame(A, SQ, 0, 1, 0.0);
        assert_eq!(hist_dist(&f.hist, &f.hist), 0.0);
        let g = frame(B, SQ, 0, 1, 0.0);
        assert!(hist_dist(&f.hist, &g.hist) > 0.8);
    }

    #[test]
    fn finds_a_hard_cut_and_ignores_motion() {
        let mut v = Vec::new();
        for t in 0..60 {
            v.push(frame(A, SQ, t * 3, t as u32, t as f64 / 25.0));
        }
        for t in 60..120 {
            v.push(frame(B, SQ, t * 3, t as u32, t as f64 / 25.0));
        }
        let b = detect(&v, &Params::default());
        assert_eq!(b.len(), 1, "{b:?}");
        assert_eq!(b[0].kind, Kind::Cut);
        assert_eq!(b[0].end, 60);
    }

    /// A horizontal gradient (left dark, right bright, or reversed): same colours, different layout
    fn gradient(reverse: bool, seed: u32, time: f64) -> Frame {
        let mut img = vec![0u8; W * H * 3];
        let mut s = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
        for y in 0..H {
            for x in 0..W {
                s ^= s << 13;
                s ^= s >> 17;
                s ^= s << 5;
                let v = (x * 255 / (W - 1)) as i16;
                let v = if reverse { 255 - v } else { v } + (s % 7) as i16 - 3;
                let i = (y * W + x) * 3;
                img[i..i + 3].copy_from_slice(&[v.clamp(0, 255) as u8, (v / 2).clamp(0, 255) as u8, 60]);
            }
        }
        features(&img, time)
    }

    #[test]
    fn finds_a_jump_cut_with_the_same_colours() {
        let mut v: Vec<Frame> = (0..50).map(|t| gradient(false, t, t as f64)).collect();
        v.extend((50..100).map(|t| gradient(true, t, t as f64)));
        assert!(hist_dist(&v[49].hist, &v[50].hist) < 0.1, "same global colours");
        let b = detect(&v, &Params::default());
        assert_eq!(b.len(), 1, "{b:?}");
        assert_eq!(b[0].end, 50);
    }

    #[test]
    fn rejects_a_two_frame_flash() {
        let mut v: Vec<Frame> = (0..80).map(|t| frame(A, SQ, t, t as u32, t as f64)).collect();
        v[40] = frame([250, 250, 250], [250, 250, 250], 0, 40, 40.0);
        v[41] = frame([235, 235, 235], [235, 235, 235], 0, 41, 41.0);
        assert!(detect(&v, &Params::default()).is_empty());
    }

    #[test]
    fn rejects_a_flash() {
        let mut v: Vec<Frame> = (0..80).map(|t| frame(A, SQ, t, t as u32, t as f64)).collect();
        v[40] = frame([250, 250, 250], [250, 250, 250], 0, 40, 40.0);
        assert!(detect(&v, &Params::default()).is_empty());
    }

    #[test]
    fn finds_a_dissolve_as_one_gradual_transition() {
        let mut v = Vec::new();
        for t in 0..50 {
            v.push(frame(A, SQ, t, t as u32, t as f64));
        }
        for i in 0..20 {
            let c = blend(&A, &C, (i + 1) as f32 / 21.0);
            v.push(frame(c, SQ, 50 + i, 50 + i as u32, (50 + i) as f64));
        }
        for t in 70..130 {
            v.push(frame(C, SQ, t, t as u32, t as f64));
        }
        let b = detect(&v, &Params::default());
        assert_eq!(b.len(), 1, "{b:?}");
        assert_eq!(b[0].kind, Kind::Gradual);
        assert!(b[0].start >= 45 && b[0].end <= 75, "{b:?}");
    }

    #[test]
    fn fade_through_black_is_one_transition() {
        let mut v = Vec::new();
        let black = [0u8; 3];
        let mut t = 0;
        for _ in 0..50 {
            v.push(frame(A, SQ, t, t as u32, t as f64));
            t += 1;
        }
        for i in 0..12 {
            let w = (i + 1) as f32 / 12.0;
            v.push(frame(blend(&A, &black, w), blend(&SQ, &black, w), t, t as u32, t as f64));
            t += 1;
        }
        for i in 0..12 {
            let w = (i + 1) as f32 / 12.0;
            v.push(frame(blend(&black, &B, w), blend(&black, &SQ, w), t, t as u32, t as f64));
            t += 1;
        }
        for _ in 0..50 {
            v.push(frame(B, SQ, t, t as u32, t as f64));
            t += 1;
        }
        let b = detect(&v, &Params::default());
        assert_eq!(b.len(), 1, "{b:?}");
        assert!(b[0].start >= 45 && b[0].end <= 80, "{b:?}");
    }
}
