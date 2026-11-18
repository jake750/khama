use super::*;

fn video(w: u32, h: u32) -> MediaInfo {
    MediaInfo {
        path: "in.mp4".into(),
        name: "in.mp4".into(),
        size: 1,
        duration: Some(60.0),
        container: "mov,mp4".into(),
        bitrate: None,
        video: Some(VideoInfo {
            codec: "h264".into(),
            profile: None,
            width: w,
            height: h,
            fps: Some(30.0),
            vfr: false,
            pix_fmt: "yuv420p".into(),
            bit_depth: 8,
            hdr: false,
            interlaced: false,
        }),
        audio: vec![AudioInfo {
            codec: "aac".into(),
            channels: 2,
            sample_rate: 48000,
        }],
        subtitles: 0,
        thumbnail: None,
        issues: vec![],
    }
}

fn joined(plan: &Plan) -> String {
    plan.args.join(" ")
}

#[test]
fn vertical_crop_dims() {
    let o = ConvertOptions {
        aspect: Some("9:16".into()),
        ..Default::default()
    };
    assert_eq!(output_dims(1920, 1080, &o, Some(1080)), (608, 1080));
    let o = ConvertOptions {
        aspect: Some("9:16".into()),
        size: Some(1080),
        ..Default::default()
    };
    assert_eq!(output_dims(1920, 1080, &o, None), (1080, 1920));
}

#[test]
fn prores_plan() {
    let p = preset("prores_hq").unwrap();
    let plan = build_plan(&p, &ConvertOptions::default(), &[video(1920, 1080)], &[], Path::new("o.mov"), None).unwrap();
    let s = joined(&plan);
    assert!(s.contains("-c:v prores_ks -profile:v 3"));
    assert!(s.contains("-c:a pcm_s16le"));
    assert!(s.contains("format=yuv422p10le"));
    assert_eq!(plan.duration, 60.0);
}

#[test]
fn trim_and_speed() {
    let p = preset("edit_h264").unwrap();
    let o = ConvertOptions {
        start: Some(10.0),
        end: Some(30.0),
        speed: Some(2.0),
        ..Default::default()
    };
    let plan = build_plan(&p, &o, &[video(1920, 1080)], &[], Path::new("o.mp4"), None).unwrap();
    let s = joined(&plan);
    assert!(s.contains("-ss 10.000 -to 30.000 -i in.mp4"));
    assert!(s.contains("setpts=PTS/2.0000"));
    assert!(s.contains("atempo=2"));
    assert_eq!(plan.duration, 10.0);
}

#[test]
fn hw_encoder_used_when_available() {
    let p = preset("edit_h264").unwrap();
    let o = ConvertOptions {
        hw: true,
        ..Default::default()
    };
    let plan = build_plan(&p, &o, &[video(1920, 1080)], &["h264_qsv".into()], Path::new("o.mp4"), None).unwrap();
    assert!(joined(&plan).contains("-c:v h264_qsv"));
}

#[test]
fn audio_only_rejects_video_preset() {
    let mut m = video(1, 1);
    m.video = None;
    let p = preset("prores_422").unwrap();
    assert!(build_plan(&p, &ConvertOptions::default(), &[m], &[], Path::new("o"), None).is_err());
}

#[test]
fn atempo_ranges() {
    // حاصل ضرب السرعات = المطلوب، وكل واحدة ضمن 0.5–2
    for want in [4.0, 0.25, 3.0, 0.3, 1.5] {
        let chain = atempo_chain(want);
        let prod: f64 = chain.iter().map(|a| a[7..].parse::<f64>().unwrap()).product();
        assert!((prod - want).abs() < 1e-3, "{want}: {chain:?}");
        assert!(chain.iter().all(|a| (0.5..=2.0).contains(&a[7..].parse::<f64>().unwrap())));
    }
    assert!(atempo_chain(1.0).is_empty());
}

#[test]
fn markers() {
    let log = "[blackdetect @ 0x1] black_start:0 black_end:1.52 black_duration:1.52\n\
                   [silencedetect @ 0x2] silence_start: 3.5\n[silencedetect @ 0x2] silence_end: 4.75 | silence_duration: 1.25\n\
                   [Parsed_showinfo_2 @ 0x3] n:   0 pts:  12345 pts_time:4.115   duration:1";
    assert_eq!(parse_markers("detect_black", log), vec![[0.0, 1.52]]);
    assert_eq!(parse_markers("detect_silence", log), vec![[3.5, 4.75]]);
    assert_eq!(parse_markers("detect_scenes", log), vec![[4.115, 4.115]]);
}

#[test]
fn loudnorm_json() {
    let err = "blah\n{\n\t\"input_i\" : \"-20.31\",\n\t\"input_tp\" : \"-3.10\",\n\t\"input_lra\" : \"6.20\",\n\t\"input_thresh\" : \"-30.62\",\n\t\"output_i\" : \"-14.1\",\n\t\"target_offset\" : \"0.12\"\n}\n";
    assert_eq!(
        parse_loudnorm(err).unwrap(),
        "measured_I=-20.31:measured_TP=-3.10:measured_LRA=6.20:measured_thresh=-30.62:offset=0.12"
    );
}

/// اختبار حقيقي لكل Preset مع FFmpeg المضمّن (بطيء؛ يعمل يدويًا فقط):
/// KHAMA_SAMPLE=<فيديو قصير> cargo test -- --ignored presets_real
mod real {
    use super::*;
    use std::process::Command as Std;

    fn bin(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/ffmpeg/bin")
            .join(format!("{name}{}", tools::EXE))
    }

    fn probe(path: &Path) -> MediaInfo {
        let o = Std::new(bin("ffprobe"))
            .args(["-v", "error", "-show_format", "-show_streams", "-of", "json"])
            .arg(path)
            .output()
            .unwrap();
        let j: Value = serde_json::from_slice(&o.stdout).unwrap();
        parse_probe(path, 1, &j)
    }

    #[test]
    #[ignore]
    fn presets_real() {
        let sample = PathBuf::from(std::env::var("KHAMA_SAMPLE").expect("KHAMA_SAMPLE"));
        let out = std::env::temp_dir().join("khama-presets");
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();
        // ملفات مساعدة: علامة مائية، LUT، ترجمة عربية
        Std::new(bin("ffmpeg"))
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red@0.8:s=400x200,format=rgba",
                "-frames:v",
                "1",
            ])
            .arg(out.join("wm.png"))
            .status()
            .unwrap();
        let mut cube = String::from("LUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    cube.push_str(&format!("{} {} {}\n", r as f64 * 0.9, g as f64, b as f64 * 0.8));
                }
            }
        }
        std::fs::write(out.join("lut.cube"), cube).unwrap();
        std::fs::write(out.join("sub.srt"), "1\n00:00:01,000 --> 00:00:04,000\nمرحبا بالعالم — Hello\n").unwrap();

        let info = probe(&sample);
        let hw: Vec<String> = std::env::var("KHAMA_HW")
            .map(|v| v.split(',').map(String::from).collect())
            .unwrap_or_default();
        let o = |f: &dyn Fn(&mut ConvertOptions)| {
            let mut x = ConvertOptions {
                start: Some(1.0),
                end: Some(6.0),
                ..Default::default()
            };
            f(&mut x);
            x
        };
        let cases: Vec<(&str, ConvertOptions)> = vec![
            ("edit_h264", o(&|_| {})),
            ("edit_h264", o(&|x| x.hw = true)),
            ("prores_proxy", o(&|_| {})),
            ("prores_hq", o(&|_| {})),
            ("prores_4444", o(&|_| {})),
            ("dnxhr_sq", o(&|_| {})),
            ("dnxhr_hqx", o(&|_| {})),
            ("proxy", o(&|_| {})),
            ("youtube", o(&|x| x.loudness = Some(-14.0))),
            ("vertical", o(&|x| x.aspect = Some("9:16".into()))),
            ("whatsapp", o(&|x| x.watermark = Some(out.join("wm.png").to_string_lossy().into()))),
            ("h265", o(&|x| x.fps = Some("25".into()))),
            ("h265", o(&|x| x.hw = true)),
            ("av1", o(&|x| x.size = Some(480))),
            ("webm", o(&|x| x.size = Some(480))),
            ("gif", o(&|_| {})),
            ("wav", o(&|_| {})),
            ("mp3", o(&|x| x.speed = Some(1.5))),
            ("aac", o(&|_| {})),
            ("flac", o(&|_| {})),
            ("opus", o(&|_| {})),
            ("rewrap_mov", o(&|_| {})),
            ("rewrap_mkv", o(&|x| x.split_at = vec![3.0, 4.5])),
            ("frame_png", o(&|_| {})),
            (
                "edit_h264",
                o(&|x| {
                    x.lut = Some("lut.cube".into());
                    x.subtitles = Some("sub.srt".into());
                    x.timecode = true;
                    x.denoise = true;
                    x.rotate = Some("90".into());
                    x.speed = Some(0.5);
                }),
            ),
            ("edit_h264", o(&|x| x.mute = true)),
        ];
        let mut failures = Vec::new();
        for (i, (id, opts)) in cases.iter().enumerate() {
            let p = preset(id).unwrap();
            let target = if opts.split_at.is_empty() {
                out.join(format!("{i:02}_{id}.{}", p.ext))
            } else {
                out.join(format!("{i:02}_{id}_%03d.{}", p.ext))
            };
            let plan = build_plan(&p, opts, std::slice::from_ref(&info), &hw, &target, None).unwrap();
            let mut args = plan.args.clone();
            if let Some(t) = opts.loudness {
                // مرور القياس مختصر هنا: نستخدم loudnorm بمرور واحد
                let i = args.iter().position(|a| a == "anull").unwrap_or(0);
                if i > 0 {
                    args[i] = format!("loudnorm=I={t}");
                }
            }
            let t0 = Instant::now();
            let r = Std::new(bin("ffmpeg")).args(&args).current_dir(&out).output().unwrap();
            let ok = r.status.success();
            let what = if opts.split_at.is_empty() {
                let m = probe(&target);
                format!(
                    "{:?} {:?} dur={:?}",
                    m.video.as_ref().map(|v| format!(
                        "{} {}x{} {:?}fps {}",
                        v.codec,
                        v.width,
                        v.height,
                        v.fps.map(|f| (f * 100.0).round() / 100.0),
                        v.pix_fmt
                    )),
                    m.audio.first().map(|a| a.codec.clone()),
                    m.duration.map(|d| (d * 100.0).round() / 100.0)
                )
            } else {
                format!(
                    "{} parts",
                    std::fs::read_dir(&out)
                        .unwrap()
                        .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with(&format!("{i:02}_")))
                        .count()
                )
            };
            println!(
                "{} {i:02} {id:<14} {:>5.1}s  {what}",
                if ok { "OK  " } else { "FAIL" },
                t0.elapsed().as_secs_f64()
            );
            if !ok {
                println!(
                    "     args: {}\n     {}",
                    args.join(" "),
                    tail(&String::from_utf8_lossy(&r.stderr), 6).replace('\n', "\n     ")
                );
                failures.push(*id);
            }
        }
        assert!(failures.is_empty(), "failed: {failures:?}");
    }

    /// تقييم الصيغ للتقرير (A-30 A-31): الحجم الحقيقي، وSSIM مقابل الأصل، والزمن.
    /// KHAMA_EVAL_DIR=<مجلد ملفات> KHAMA_EVAL_OUT=<ملف jsonl> [KHAMA_REPEAT=3] cargo test --release -- --ignored presets_eval
    /// ثم: KHAMA_EVAL_OUT=<الملف نفسه> npx vitest run src/estimate.eval.test.ts
    #[test]
    #[ignore]
    fn presets_eval() {
        use std::io::Write;
        let dir = PathBuf::from(std::env::var("KHAMA_EVAL_DIR").expect("KHAMA_EVAL_DIR"));
        let out_file = std::env::var("KHAMA_EVAL_OUT").expect("KHAMA_EVAL_OUT");
        let repeat: usize = std::env::var("KHAMA_REPEAT").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
        let tmp = std::env::temp_dir().join("khama-eval");
        std::fs::create_dir_all(&tmp).unwrap();
        let mut log = std::fs::File::create(&out_file).unwrap();
        let cases = [
            ("edit_h264", "high"),
            ("edit_h264", "balanced"),
            ("edit_h264", "small"),
            ("youtube", "balanced"),
            ("whatsapp", "balanced"),
            ("h265", "balanced"),
            ("av1", "balanced"),
            ("webm", "balanced"),
            ("prores_proxy", "balanced"),
            ("prores_422", "balanced"),
            ("dnxhr_sq", "balanced"),
            ("proxy", "balanced"),
        ];
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        for file in files {
            let info = probe(&file);
            if info.video.is_none() {
                continue;
            }
            for (id, quality) in cases {
                let Some(p) = preset(id) else { continue };
                let opts = ConvertOptions {
                    quality: quality.into(),
                    ..Default::default()
                };
                let target = tmp.join(format!("out.{}", p.ext));
                let plan = build_plan(&p, &opts, std::slice::from_ref(&info), &[], &target, None).unwrap();
                let mut secs = Vec::new();
                for _ in 0..repeat {
                    let t0 = Instant::now();
                    let r = Std::new(bin("ffmpeg")).args(&plan.args).output().unwrap();
                    assert!(r.status.success(), "{id} {}", tail(&String::from_utf8_lossy(&r.stderr), 4));
                    secs.push(t0.elapsed().as_secs_f64());
                }
                let bytes = std::fs::metadata(&target).unwrap().len();
                // SSIM مقابل الأصل بعد إعادة القياس إلى أبعاده (الصيغ التي تقص الصورة تُستثنى)
                let v = info.video.as_ref().unwrap();
                let r = Std::new(bin("ffmpeg"))
                    .args(["-hide_banner", "-i"])
                    .arg(&target)
                    .arg("-i")
                    .arg(&file)
                    .args([
                        "-lavfi",
                        &format!(
                            "[0:v]scale={}:{}:flags=bicubic,format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim",
                            v.width, v.height
                        ),
                        "-f",
                        "null",
                        "-",
                    ])
                    .output()
                    .unwrap();
                let err = String::from_utf8_lossy(&r.stderr);
                let ssim = err
                    .split("All:")
                    .nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse::<f64>().ok());
                let line = serde_json::json!({
                    "file": file.file_name().unwrap().to_string_lossy(),
                    "preset": id,
                    "quality": quality,
                    "media": info,
                    "bytes": bytes,
                    "secs": secs,
                    "ssim": ssim,
                });
                writeln!(log, "{line}").unwrap();
                println!("{id:<13} {quality:<8} {:>8} KB  ssim={ssim:?}  {secs:.1?}s", bytes / 1024);
            }
        }
    }
}

#[test]
fn hw_cache_is_reused_only_for_the_same_key_and_age() {
    let cache = HwCache {
        key: "0.3.1|10|20".into(),
        at_ms: 1_000,
        encoders: vec!["h264_nvenc".into()],
    };
    assert_eq!(hw_cache_valid(&cache, "0.3.1|10|20", 2_000), Some(vec!["h264_nvenc".to_string()]));
    assert_eq!(hw_cache_valid(&cache, "0.3.2|10|20", 2_000), None, "إصدار جديد = فحص جديد");
    assert_eq!(hw_cache_valid(&cache, "0.3.1|10|20", 1_000 + HW_CACHE_TTL_MS), None, "انتهت المدة");
}

#[cfg(desktop)]
#[test]
fn watched_folder_converts_files_that_arrived_while_closed() {
    use super::watcher::arrived_while_closed;
    assert!(arrived_while_closed(2_000, Some(1_000)), "وصل بعد آخر فحص");
    assert!(!arrived_while_closed(500, Some(1_000)), "كان موجودًا");
    assert!(!arrived_while_closed(2_000, None), "مجلد أُضيف للتو: لا نلمس ما فيه");
}

#[test]
fn part_dir_is_removed_once_empty() {
    let out = std::env::temp_dir().join(format!("khama-parts-{}", std::process::id()));
    std::fs::create_dir_all(&out).unwrap();
    {
        let parts = super::run::PartDir::new(&out).unwrap();
        assert!(parts.0.is_dir());
        std::fs::write(parts.0.join("1-part.mp4"), b"x").unwrap();
        std::fs::rename(parts.0.join("1-part.mp4"), out.join("done.mp4")).unwrap();
    }
    assert!(!out.join(".khama-parts").exists());
    assert!(out.join("done.mp4").exists());
    let _ = std::fs::remove_dir_all(&out);
}

// أدوات صغيرة في بناء الأوامر بلا اختبار من قبل (T-15)
#[test]
fn small_command_helpers() {
    assert_eq!(
        (even(1919.4), even(0.2), even(721.0)),
        (1920, 2, 722),
        "الأبعاد زوجية دائمًا وليست صفرًا"
    );
    assert_eq!(parse_aspect("16:9").map(|a| (a * 1000.0).round()), Some(1778.0));
    assert_eq!((parse_aspect("0:9"), parse_aspect("wide")), (None, None));
    assert_eq!(
        (fps_expr("29.97"), fps_expr("23.976"), fps_expr("31")),
        (Some("30000/1001"), Some("24000/1001"), None)
    );
    assert_eq!(
        (sub_ext("a.ASS"), sub_ext("b.vtt"), sub_ext("c.srt"), sub_ext("d")),
        ("ass", "vtt", "srt", "srt")
    );
    assert_eq!(overlay_pos(None), overlay_pos(Some("br")), "الافتراضي أسفل الطرف");
    assert_eq!(overlay_pos(Some("c")), "x=(W-w)/2:y=(H-h)/2");
    let args = ["-c:v", "libx264", "-pix_fmt", "yuv420p"].map(String::from);
    assert_eq!(final_pix(&args).as_deref(), Some("yuv420p"));
    assert_eq!(final_pix(&args[..2]), None);
}

#[test]
fn editor_issues_flags_what_editors_cant_read() {
    let mp4 = "mov,mp4,m4a,3gp,3g2,mj2";
    assert_eq!(
        editor_issues("matroska,webm", "webm", ["opus"].into_iter()),
        vec!["editorAudio", "editorContainer"]
    );
    assert_eq!(editor_issues(mp4, "mp4", ["pcm_s16le"].into_iter()), vec!["pcmInMp4"]);
    assert!(editor_issues(mp4, "mov", ["pcm_s24le"].into_iter()).is_empty(), "PCM سليم في MOV");
    assert!(editor_issues(mp4, "mp4", ["aac"].into_iter()).is_empty());
}
