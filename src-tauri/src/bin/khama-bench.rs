//! khama-bench: runs Khama's own processing code on test material, for the evaluation scripts in bench/.
//!
//!   khama-bench scenes <video> [--params '<json>'] [--grid <file.json>] [--dump <d.csv>]
//!       Decodes the video once, then runs the shot-boundary detector with one parameter set
//!       (or every set of a JSON array in --grid). Prints JSON to stdout.
//!
//!   khama-bench separate <audio> [--voice v.wav] [--music m.wav] [--opts '<json>'] [--ai <dir>]
//!       Runs the voice/music separation (one model pass) with the given SepOptions. Prints JSON timings.
//!       --ai: folder with onnxruntime and UVR-MDX-NET-Voc_FT.onnx (default: the app's own data folder).
//!
//!   khama-bench topics <video> <subs.srt|vtt> [--opts '<ConvertOptions json>']
//!       Splits the subtitles into topics and detects the silences, as the "topics" preset does.
//!       Prints JSON {topics, silences}.
//!
//! FFmpeg: --ffmpeg <path>, else $KHAMA_FFMPEG, else src-tauri/binaries/ffmpeg/bin.

use std::{path::PathBuf, process::Command, sync::atomic::AtomicBool, time::Instant};

use khama_lib::scenes::{self, Params};
use serde_json::json;

fn ffmpeg(args: &mut Vec<String>) -> PathBuf {
    if let Some(i) = args.iter().position(|a| a == "--ffmpeg") {
        let p = PathBuf::from(args.remove(i + 1));
        args.remove(i);
        return p;
    }
    if let Ok(p) = std::env::var("KHAMA_FFMPEG") {
        return p.into();
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries/ffmpeg/bin")
        .join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })
}

fn take(args: &mut Vec<String>, key: &str) -> Option<String> {
    let i = args.iter().position(|a| a == key)?;
    let v = args.remove(i + 1);
    args.remove(i);
    Some(v)
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let ff = ffmpeg(&mut args);
    match args.first().map(String::as_str) {
        Some("scenes") => scenes_cmd(ff, args.split_off(1)),
        Some("separate") => separate_cmd(ff, args.split_off(1)),
        Some("topics") => topics_cmd(ff, args.split_off(1)),
        _ => {
            eprintln!("usage: khama-bench scenes <video> [--params json] [--grid file.json] [--dump d.csv]");
            eprintln!("       khama-bench topics <video> <subs> [--opts json]");
            eprintln!("       khama-bench separate <audio> [--voice v.wav] [--music m.wav] [--opts json] [--ai dir]");
            std::process::exit(2);
        }
    }
}

fn scenes_cmd(ff: PathBuf, mut args: Vec<String>) {
    let params: Vec<Params> = if let Some(g) = take(&mut args, "--grid") {
        serde_json::from_str(&std::fs::read_to_string(g).expect("grid file")).expect("grid json")
    } else if let Some(p) = take(&mut args, "--params") {
        vec![serde_json::from_str(&p).expect("params json")]
    } else {
        vec![Params::default()]
    };
    let dump = take(&mut args, "--dump");
    let input = PathBuf::from(args.first().expect("video path"));

    let t0 = Instant::now();
    let cancel = AtomicBool::new(false);
    let a = scenes::analyze_blocking(Command::new(&ff), &input, None, None, |_| {}, &cancel)
        .expect("ffmpeg")
        .expect("not cancelled");
    let decode_s = t0.elapsed().as_secs_f64();

    if let Some(path) = dump {
        let p = &params[0];
        let d = scenes::distances(&a.frames, p.alpha);
        let mut csv = String::from("frame,time,d,luma_mean,luma_std\n");
        for (i, f) in a.frames.iter().enumerate() {
            csv.push_str(&format!("{i},{:.4},{:.5},{:.2},{:.2}\n", f.time, d[i], f.luma_mean, f.luma_std));
        }
        std::fs::write(path, csv).expect("write dump");
    }

    let mut results = Vec::new();
    for p in &params {
        let t1 = Instant::now();
        let b = scenes::detect(&a.frames, p);
        results.push(json!({ "params": p, "boundaries": b, "detect_ms": t1.elapsed().as_secs_f64() * 1000.0 }));
    }
    let out = json!({ "frames": a.frames.len(), "decode_s": decode_s, "results": results });
    println!("{out}");
}

fn separate_cmd(ff: PathBuf, mut args: Vec<String>) {
    use khama_lib::separate::{self, SepOptions};
    use std::sync::atomic::AtomicU64;
    let opts: SepOptions = take(&mut args, "--opts")
        .map(|j| serde_json::from_str(&j).expect("opts json"))
        .unwrap_or_default();
    let voice = take(&mut args, "--voice").map(PathBuf::from);
    let music = take(&mut args, "--music").map(PathBuf::from);
    let ai = take(&mut args, "--ai").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var("LOCALAPPDATA").expect("LOCALAPPDATA"))
            .join("com.jake750.khama")
            .join("ai")
    });
    let input = PathBuf::from(args.first().expect("audio path"));
    let lib = ai.join(if cfg!(windows) {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else {
        "libonnxruntime.so"
    });
    let model = ai.join("UVR-MDX-NET-Voc_FT.onnx");
    let progress = AtomicU64::new(0);
    let cancel = AtomicBool::new(false);
    let t0 = Instant::now();
    let ok = separate::separate_stems(
        &ff,
        &lib,
        &model,
        &input,
        None,
        None,
        &opts,
        voice.as_deref(),
        music.as_deref(),
        &progress,
        &cancel,
    )
    .unwrap_or_else(|e| panic!("separation failed: {e:?}"));
    let secs = t0.elapsed().as_secs_f64();
    let audio = progress.load(std::sync::atomic::Ordering::Relaxed) as f64 / 44_100.0;
    println!(
        "{}",
        json!({ "ok": ok, "seconds": secs, "audio_seconds": audio, "rtf": secs / audio.max(1e-9), "opts": opts })
    );
}

fn topics_cmd(ff: PathBuf, mut args: Vec<String>) {
    use khama_lib::topics_bench::*;
    let o: ConvertOptions = take(&mut args, "--opts")
        .map(|j| serde_json::from_str(&j).expect("opts json"))
        .unwrap_or_default();
    let video = args.first().expect("video path").clone();
    let subs = args.get(1).expect("subtitle path");
    let raw = String::from_utf8_lossy(&std::fs::read(subs).expect("read subs")).into_owned();
    let t0 = Instant::now();
    let cues = clean_cues(parse_subs(&raw));
    let topics = topics_from(&cues, &SegParams::default());
    let seg_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let out = Command::new(&ff)
        .args(detect_args("detect_silence", &video, &o))
        .output()
        .expect("ffmpeg");
    let silences = parse_markers("detect_silence", &String::from_utf8_lossy(&out.stderr));
    println!(
        "{}",
        json!({ "cues": cues.len(), "segment_ms": seg_ms, "topics": topics, "silences": silences })
    );
}
