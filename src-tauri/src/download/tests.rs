use super::*;

fn req(kind: &str, fmt: &str, q: &str, editor: bool) -> DownloadRequest {
    DownloadRequest {
        url: "https://example.com".into(),
        kind: kind.into(),
        video_format: fmt.into(),
        audio_format: fmt.into(),
        quality: q.into(),
        editor_ready: editor,
        start: None,
        end: None,
        stems: None,
        clips: vec![],
        join_clips: false,
        subdir: None,
        ..Default::default()
    }
}

#[test]
fn templates() {
    assert_eq!(output_template("{title}", false, 0, "2026-11-10"), "%(title).120B");
    assert_eq!(
        output_template("ref_{n} {site}", true, 7, "2026-11-10"),
        "%(extractor_key)s/ref_007 %(extractor_key)s"
    );
    // نص بلا متغيرات: يُضاف العنوان بعده، والرموز الممنوعة تُستبدل
    assert_eq!(output_template("a/b 100%", false, 0, "x"), "a_b 100%% %(title).120B");
    assert_eq!(output_template("", false, 0, "x"), "%(title).120B");
    assert_eq!(
        output_template("{today}_{title}", false, 0, "2026-11-10"),
        "2026-11-10_%(title).120B"
    );
}

#[test]
fn dates() {
    assert_eq!(civil_date(0), "1970-01-01");
    assert_eq!(civil_date(20_402), "2025-11-10");
    assert_eq!(civil_date(11_016), "2000-02-29");
}

#[test]
fn subtitle_languages() {
    let j: Value = serde_json::from_str(r#"{
            "language": "fr",
            "subtitles": {"en": [{"name": "English"}], "live_chat": []},
            "automatic_captions": {"fr-orig": [{"name": "French (Original)"}], "fr": [{"name": "French"}], "en": [{"name": "English"}], "ar": [{"name": "Arabic"}], "de": [{"name": "German"}]}
        }"#).unwrap();
    let codes: Vec<(String, bool)> = sub_langs(&j).into_iter().map(|s| (s.code, s.auto)).collect();
    assert_eq!(codes, vec![("en".into(), false), ("ar".into(), true), ("fr".into(), true)]);
}

#[test]
fn timeline() {
    let clips = vec![
        (PathBuf::from("C:/v/a b.mp4"), (0.0, 2.0)),
        (PathBuf::from("C:/v/c&d.mp4"), (5.0, 6.0)),
    ];
    let x = timeline_xml(&clips, &[2.0, 1.0], 29.97, 1920, 1080);
    assert!(x.contains("<timebase>30</timebase><ntsc>TRUE</ntsc>"));
    assert!(x.contains("<pathurl>file://localhost/C:/v/a%20b.mp4</pathurl>"));
    assert!(x.contains("c&amp;d.mp4"));
    assert!(x.contains("<start>60</start><end>90</end>"));
}

#[test]
fn info_file_text() {
    let j: Value = serde_json::from_str(
        r#"{"title":"T","webpage_url":"https://x","uploader":"U","upload_date":"20141110","extractor_key":"Youtube","license":"NA"}"#,
    )
    .unwrap();
    let t = info_text(&j, &[(1.0, 2.5)], "2026-11-15");
    assert!(t.contains("Source: https://x\n"));
    assert!(t.contains("Published: 2014-11-10\n"));
    assert!(!t.contains("License"));
    assert!(t.contains("Section: 0:00:01.000 - 0:00:02.500"));
}

#[test]
fn multiple_clips() {
    let mut r = req("video", "mp4", "1080", true);
    assert!(clips(&r).is_empty());
    r.start = Some(5.0);
    r.end = Some(9.0);
    assert_eq!(clips(&r), vec![(5.0, 9.0)]);
    // المقاطع تتقدّم على start/end، وتُرتّب، والخاطئ منها يُهمل
    r.clips = vec![[60.0, 70.0], [10.0, 20.0], [30.0, 25.0], [f64::NAN, 3.0]];
    assert_eq!(clips(&r), vec![(10.0, 20.0), (60.0, 70.0)]);
}

#[test]
fn joined_names() {
    let p = Path::new("C:/x/My Video [00m10s - 00m20s].mp4");
    assert_eq!(joined_name(p, 3), "My Video [3 clips].mp4");
    assert_eq!(joined_name(Path::new("/a/plain.mp3"), 2), "plain [2 clips].mp3");
    assert_eq!(concat_line(Path::new(r"C:\a\it's.mp4")), "file 'C:/a/it'\\''s.mp4'\n");
}

#[test]
fn sections() {
    let mut r = req("video", "mp4", "1080", true);
    assert_eq!(section(&r), None);
    r.start = Some(75.5);
    r.end = Some(130.0);
    assert_eq!(section(&r), Some((75.5, 130.0)));
    assert_eq!(ts(75.5), "0:01:15.500");
    assert_eq!(ts_name(3725.0), "1h02m05s");
    r.end = Some(10.0); // نهاية قبل البداية
    assert_eq!(section(&r), None);
}

#[test]
fn video_1080_editor_ready_prefers_h264() {
    let a = format_args(&req("video", "mp4", "1080", true));
    let i = a.iter().position(|x| x == "-S").unwrap();
    assert_eq!(a[i + 1], "res:1080,vcodec:h264,acodec:aac");
    assert!(a.contains(&"mp4".to_string()));
}

#[test]
fn video_best_without_editor_ready() {
    let a = format_args(&req("video", "mp4", "best", false));
    let i = a.iter().position(|x| x == "-S").unwrap();
    assert_eq!(a[i + 1], "res");
}

#[test]
fn audio_wav() {
    let a = format_args(&req("audio", "wav", "best", true));
    assert!(a.windows(2).any(|w| w[0] == "--audio-format" && w[1] == "wav"));
    let a = format_args(&req("audio", "original", "best", true));
    assert!(a.windows(2).any(|w| w[0] == "--audio-format" && w[1] == "best"), "بلا تحويل (U-95)");
}

#[test]
fn parses_progress_line() {
    let p = parse_dl_line("downloading|1024|2048|NA|5000.5|3|avc1.4D400C|none|NA|NA").unwrap();
    assert_eq!(p.stage, "video");
    assert_eq!(p.percent, Some(50.0));
    assert_eq!(p.speed, Some(5000.5));
    assert!(!p.finished);
}

#[test]
fn parses_fragment_progress() {
    let p = parse_dl_line("downloading|1024|NA|NA|NA|NA|none|mp4a.40.2|5|20").unwrap();
    assert_eq!(p.stage, "audio");
    assert_eq!(p.percent, Some(25.0));
}

#[test]
fn rejects_non_http_url() {
    assert!(validate_url("ftp://x").is_err());
    assert!(validate_url("  https://youtu.be/x ").is_ok());
}

#[test]
fn unique_names() {
    let dir = std::env::temp_dir().join(format!("khama-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.mp4"), b"x").unwrap();
    assert_eq!(unique_path(&dir, "a.mp4"), dir.join("a (1).mp4"));
    // الاسم محجوز: الطلب التالي يأخذ اسمًا آخر حتى قبل نقل الملف الحقيقي (T-47)
    assert_eq!(unique_path(&dir, "a.mp4"), dir.join("a (2).mp4"));
    assert_eq!(unique_dir(&dir, "a stills"), dir.join("a stills"));
    assert_eq!(unique_dir(&dir, "a stills"), dir.join("a stills (1)"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unique_names_under_concurrency() {
    let dir = std::env::temp_dir().join(format!("khama-race-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let handles: Vec<_> = (0..16)
        .map(|_| {
            let d = dir.clone();
            std::thread::spawn(move || unique_path(&d, "same.mp4"))
        })
        .collect();
    let names: std::collections::HashSet<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_eq!(names.len(), 16, "كل عملية أخذت اسمًا مختلفًا");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn validate_url_parses_the_whole_url() {
    assert!(validate_url(" https://youtu.be/abc ").is_ok());
    assert!(validate_url("http://example.com/a?b=c").is_ok());
    for bad in [
        "ftp://x.com/a",
        "https://",
        "https:// space.com",
        "javascript:alert(1)",
        "youtu.be/abc",
        "file:///C:/x",
    ] {
        assert!(validate_url(bad).is_err(), "{bad}");
    }
}

#[test]
fn produced_files_are_remembered() {
    let f = "C:/khama-test/produced-file.mp4";
    assert!(!was_produced(f));
    remember_output(f);
    assert!(was_produced(f));
}

/// معاينة جديدة من الشاشة توقف السابقة فورًا (T-42). أمر بطيء بدل yt-dlp: ping/sleep خمس ثوانٍ
#[test]
fn a_new_screen_probe_cancels_the_previous_one() {
    let slow = |prog: &str| Tools {
        ytdlp: PathBuf::from(prog),
        ytdlp_prefix: vec![],
        env: vec![],
        js_runtime: String::new(),
        ffmpeg: PathBuf::new(),
        ffprobe: PathBuf::new(),
        ffmpeg_dir: PathBuf::new(),
    };
    #[cfg(windows)]
    let (tools, long, short) = (slow("ping"), vec!["-n", "6", "127.0.0.1"], vec!["-n", "1", "127.0.0.1"]);
    #[cfg(unix)]
    let (tools, long, short) = (slow("sleep"), vec!["5"], vec!["0"]);
    tauri::async_runtime::block_on(async {
        let started = Instant::now();
        let first = run_probe(&tools, &long, true);
        let second = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            run_probe(&tools, &short, true).await
        };
        let (a, _) = tokio::join!(first, second);
        assert_eq!(a.unwrap_err().code, "canceled");
        assert!(started.elapsed() < Duration::from_secs(4), "الأولى توقفت قبل أن تنتهي وحدها");
    });
}

#[test]
fn meta_line_gives_title_and_thumbnail() {
    let (t, th) = parse_meta_line(r#"{"title": "عنوان", "thumbnail": "https://i.ytimg.com/a.jpg"}"#).unwrap();
    assert_eq!(t.as_deref(), Some("عنوان"));
    assert_eq!(th.as_deref(), Some("https://i.ytimg.com/a.jpg"));
    assert_eq!(
        parse_meta_line(r#"{"title": "x", "thumbnail": null}"#),
        Some((Some("x".into()), None))
    );
    assert_eq!(parse_meta_line("NA"), None);
    assert_eq!(parse_meta_line(r#"{"title": null}"#), None);
}

/// مدة الملف تُقارن بمدة الموقع أو المقطع المطلوب (R3-F2)
#[test]
fn short_downloads_are_incomplete() {
    assert_eq!(meta_duration(r#"{"title": "x", "duration": 212.5}"#), Some(212.5));
    assert_eq!(meta_duration(r#"{"title": "x", "duration": null}"#), None);
    assert_eq!(meta_duration("NA"), None);
    assert_eq!(expected_duration(Some(600.0), None), Some(600.0));
    assert_eq!(expected_duration(Some(600.0), Some((10.0, 20.0))), Some(10.0));
    // نهاية المقطع بعد آخر الفيديو: المتوقع حتى آخره فقط
    assert_eq!(expected_duration(Some(15.0), Some((10.0, 20.0))), Some(5.0));
    assert_eq!(expected_duration(None, Some((10.0, 20.0))), Some(10.0));
    assert_eq!(expected_duration(None, None), None);
    // ساعة ناقصة دقيقة: ناقص. ساعة ناقصة 30 ثانية (أقل من 1%): مقبول
    assert!(is_incomplete(3600.0, 3540.0));
    assert!(!is_incomplete(3600.0, 3570.0));
    // يوتيوب يقرّب المدة: 4.6 ثوانٍ لفيديو «5 ثوانٍ» ليس نقصًا، و3 ثوانٍ نقص
    assert!(!is_incomplete(5.0, 4.6));
    assert!(is_incomplete(5.0, 3.0));
    assert!(!is_incomplete(10.0, 12.0), "الأطول لا يُعدّ ناقصًا");
}

/// تنزيل HLS/DASH يتوقف عند جزء مفقود بدل أن يتخطّاه (R3-F2)
#[test]
fn missing_fragments_abort_the_download() {
    let tools = Tools {
        ytdlp: PathBuf::from("yt-dlp"),
        ytdlp_prefix: vec![],
        env: vec![],
        js_runtime: String::new(),
        ffmpeg: PathBuf::new(),
        ffprobe: PathBuf::new(),
        ffmpeg_dir: PathBuf::new(),
    };
    let o = JobOptions {
        template: "%(title)s".into(),
        rate_limit_kb: 0,
        max_name: 120,
    };
    let a = download_args(
        &tools,
        vec![],
        &req("video", "mp4", "best", false),
        &o,
        None,
        Path::new("out"),
        Path::new("work"),
    );
    assert!(a.iter().any(|x| x == "--abort-on-unavailable-fragments"));
    assert!(a.windows(2).any(|w| w[0] == "--fragment-retries" && w[1] == "15"));
    assert!(a.iter().any(|x| x.starts_with("before_dl:KHAMA_META") && x.contains("duration")));
}

/// ملف أقصر من مدة الموقع (R3-F2) بـ ffprobe الحقيقي: الأول خطأ ويُحذف، وإعادته بالمدة نفسها تُقبل
/// (المدة المعلنة هي الخاطئة). KHAMA_FFMPEG=<مجلد bin فيه ffmpeg وffprobe> cargo test -- --ignored check_length
#[test]
#[ignore]
fn check_length_with_real_ffprobe() {
    let bin = PathBuf::from(std::env::var("KHAMA_FFMPEG").expect("KHAMA_FFMPEG"));
    let tools = Tools {
        ytdlp: PathBuf::new(),
        ytdlp_prefix: vec![],
        env: vec![],
        js_runtime: String::new(),
        ffmpeg: bin.join(format!("ffmpeg{}", tools::EXE)),
        ffprobe: bin.join(format!("ffprobe{}", tools::EXE)),
        ffmpeg_dir: bin.clone(),
    };
    let dir = std::env::temp_dir().join(format!("khama-short-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let make = |name: &str, secs: &str| {
        let f = dir.join(name);
        let ok = std::process::Command::new(&tools.ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440", "-t", secs, "-c:a", "aac"])
            .arg(&f)
            .status()
            .unwrap();
        assert!(ok.success());
        f
    };
    tauri::async_runtime::block_on(async {
        let full = make("full.m4a", "60");
        assert!(check_length(&tools, &full, 60.0, &dir).await.is_ok());
        let short = make("short.m4a", "50");
        let e = check_length(&tools, &short, 60.0, &dir).await.unwrap_err();
        assert_eq!(e.code, "incomplete");
        assert!(!short.exists(), "الملف الناقص لا يبقى لتسلّمه الإعادة");
        let again = make("short.m4a", "50");
        assert!(check_length(&tools, &again, 60.0, &dir).await.is_ok(), "المدة نفسها مرتين: تُقبل");
    });
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn today_uses_the_local_offset() {
    // 2026-11-14 23:30 UTC
    let t = 1_794_699_000;
    assert_eq!(local_date(t, 0), "2026-11-14");
    assert_eq!(local_date(t, 60), "2026-11-15", "UTC+1 بعد منتصف الليل المحلي");
    assert_eq!(local_date(t, -300), "2026-11-14");
    assert_eq!(local_date(t, 99_999), "2026-11-14", "قيمة غير معقولة تُهمل");
}

#[test]
fn file_names_fit_under_the_windows_path_limit() {
    let short = Path::new("C:/Users/me/Downloads");
    assert_eq!(max_name_len(&[short]), 260 - 21 - 40);
    let deep = "C:/x/".repeat(40);
    assert_eq!(max_name_len(&[short, Path::new(&deep)]), 60, "لا يقل عن 60");
}

#[test]
fn history_entry_prefers_the_preview_title_then_ytdlp_then_the_file_name() {
    let file = Path::new("C:/out/My Video [1080p].mp4");
    let start = |title: &str| {
        Some(HistoryStart {
            title: title.into(),
            meta: "MP4 · 1080p".into(),
            thumbnail: None,
        })
    };
    let printed = (Some("من yt-dlp".to_string()), Some("https://i/t.jpg".to_string()));
    let e = history_entry("https://youtu.be/x", "video", start("من المعاينة"), printed.clone(), file, 5);
    assert_eq!((e.title.as_str(), e.meta.as_str(), e.date), ("من المعاينة", "MP4 · 1080p", 5));
    assert_eq!(e.thumbnail.as_deref(), Some("https://i/t.jpg"));
    let e = history_entry("https://youtu.be/x", "video", start("https://youtu.be/x"), printed, file, 5);
    assert_eq!(e.title, "من yt-dlp", "العنوان رابط: نأخذ ما طبعه yt-dlp");
    let e = history_entry("https://youtu.be/x", "audio", None, (None, None), file, 5);
    assert_eq!(e.title, "My Video [1080p]");
}

#[test]
fn printed_meta_is_kept_per_job_until_taken() {
    let up = |title: Option<&str>, thumb: Option<&str>| JobUpdate {
        id: 777,
        state: "downloading",
        title: title.map(String::from),
        thumbnail: thumb.map(String::from),
        ..Default::default()
    };
    remember_meta(&up(Some("أ"), None));
    remember_meta(&up(None, Some("t.jpg")));
    assert_eq!(take_meta(777), (Some("أ".into()), Some("t.jpg".into())));
    assert_eq!(take_meta(777), (None, None));
}

#[test]
fn heavy_work_limit_is_a_quarter_of_the_cores() {
    assert_eq!(heavy_limit(1), 1);
    assert_eq!(heavy_limit(4), 1);
    assert_eq!(heavy_limit(8), 2);
    assert_eq!(heavy_limit(32), 3);
}

#[test]
fn resume_dir_is_stable_per_request_and_not_shared() {
    let req = |url: &str| DownloadRequest {
        url: url.into(),
        ..Default::default()
    };
    let (a, b) = (resume_key(&req("https://x.com/1")), resume_key(&req("https://x.com/1")));
    assert_eq!(a, b, "الطلب نفسه = المجلد نفسه");
    assert_ne!(a, resume_key(&req("https://x.com/2")));
    assert!(is_resumable_dir(&a));
    assert!(!is_resumable_dir("ready") && !is_resumable_dir("12"));

    let root = std::env::temp_dir().join(format!("khama-resume-{}", std::process::id()));
    let r = req("https://x.com/resume-test");
    let work = root.join(resume_key(&r)).join("work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join("v.mp4.part"), b"half").unwrap();
    std::fs::create_dir_all(root.join(resume_key(&r)).join("conv")).unwrap();
    let (dir, key) = claim_job_dir(&root, 7, &r);
    assert!(dir.join("work/v.mp4.part").exists(), "الجزء المنزّل يبقى");
    assert!(!dir.join("conv").exists(), "المراحل اللاحقة تُعاد");
    let (other, none) = claim_job_dir(&root, 8, &r);
    assert_eq!((other, none), (root.join("8"), None), "طلب مطابق يعمل الآن: مجلد خاص");
    release_job_dir(key);
    let _ = std::fs::remove_dir_all(&root);
}

/// الإلغاء يقتل الأحفاد أيضًا (T-98): ping يعمل تحت cmd ويرث مخرجه، فلو قُتل cmd وحده
/// لبقي الأنبوب مفتوحًا حتى ينتهي ping بعد 30 ثانية
#[cfg(windows)]
#[test]
fn kill_tree_ends_grandchildren_through_the_job_object() {
    use tokio::io::AsyncReadExt;
    tauri::async_runtime::block_on(async {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.args(["/c", "ping -n 30 127.0.0.1"]).stdout(Stdio::piped());
        let mut child = spawn_tree(&mut cmd).unwrap();
        let mut out = child.stdout.take().unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = Instant::now();
        kill_tree(&mut child).await;
        let mut buf = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(10), out.read_to_end(&mut buf)).await;
        assert!(started.elapsed() < Duration::from_secs(5), "الأنبوب أُغلق: ping قُتل مع cmd");
    });
}

/// الترميز (T-94): FFmpeg على Windows يأخذ الوسائط UTF-16 من النظام ويطبع المسارات UTF-8،
/// وyt-dlp يطبع UTF-8 لأننا نضبط PYTHONUTF8=1، فـ from_utf8_lossy لا يفقد شيئًا من العناوين العربية.
/// يحتاج FFmpeg الحقيقي: KHAMA_FFMPEG=src-tauri/binaries/ffmpeg/bin/ffmpeg cargo test -- --ignored
#[test]
#[ignore]
fn ffmpeg_output_keeps_arabic_file_names() {
    let ffmpeg = PathBuf::from(std::env::var("KHAMA_FFMPEG").expect("KHAMA_FFMPEG"));
    let dir = std::env::temp_dir().join(format!("khama-utf8-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("مقطع تجربة — ١.wav");
    let made = std::process::Command::new(&ffmpeg)
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc", "-t", "0.1"])
        .arg(&file)
        .status()
        .unwrap();
    assert!(made.success());
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.arg("-hide_banner").arg("-i").arg(&file);
    // المرسل يبقى حيًّا: إسقاطه يُعدّ إلغاءً
    let (_keep, mut cancel) = tokio::sync::watch::channel(false);
    let out = tauri::async_runtime::block_on(run_streaming(cmd, &mut cancel, |_| {}));
    let Ok(RunOutcome::Exited { stderr, .. }) = out else {
        panic!("ffmpeg did not run: {:?}", out.err())
    };
    assert!(stderr.contains("مقطع تجربة — ١.wav"), "{stderr}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn spotify_song_picks_the_matching_result() {
    let hits = |v: &[(&str, &str, Option<f64>)]| {
        v.iter()
            .map(|(u, t, d)| SongHit {
                url: u.to_string(),
                title: t.to_string(),
                duration: *d,
            })
            .collect::<Vec<_>>()
    };
    let r = hits(&[
        ("live", "Hello (Live at the BBC)", None),
        ("studio", "Hello", None),
        ("other", "Hello Again", None),
    ]);
    assert_eq!(best_song(&r, Some("Hello"), None).as_deref(), Some("studio"), "العنوان نفسه");
    let r = hits(&[("a", "Song", Some(260.0)), ("b", "Song", Some(199.0))]);
    assert_eq!(best_song(&r, Some("Song"), Some(198.8)).as_deref(), Some("b"), "المدة الأقرب");
    let r = hits(&[("cover", "Song - Live", None), ("x", "Unrelated", None)]);
    assert_eq!(
        best_song(&r, Some("Song (Live)"), None).as_deref(),
        Some("cover"),
        "الحية مطلوبة فعلًا"
    );
    let r = hits(&[("first", "A", None), ("second", "B", None)]);
    assert_eq!(
        best_song(&r, Some("Zzz"), None).as_deref(),
        Some("first"),
        "لا تطابق: ترتيب YouTube Music"
    );
    assert_eq!(best_song(&[], Some("x"), None), None);
}

/// سبوتيفاي (T-45): نقرأ قائمة الأغاني من صفحة المشغّل المضمَّن، وأي تغيير في سبوتيفاي يكسرها
/// بصمت. هذا الاختبار يجلب قائمة رسمية حقيقية ويتحقق أن الأسماء والمدد ما زالت تُقرأ.
/// يعمل أسبوعيًا في .github/workflows/canary.yml، ومحليًا:
/// KHAMA_YTDLP=src-tauri/binaries/khama-yt-dlp-<triple> cargo test spotify_live -- --ignored
#[test]
#[ignore]
fn spotify_live_embed_page_still_parses() {
    let tools = Tools {
        ytdlp: PathBuf::from(std::env::var("KHAMA_YTDLP").expect("KHAMA_YTDLP")),
        ytdlp_prefix: vec![],
        env: vec![],
        js_runtime: String::new(),
        ffmpeg: PathBuf::new(),
        ffprobe: PathBuf::new(),
        ffmpeg_dir: PathBuf::new(),
    };
    // «Today's Top Hits» من حساب سبوتيفاي نفسه: لا تُحذف، وفيها 50 أغنية دائمًا
    let embed = crate::playlist::spotify_embed_url("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").unwrap();
    let info = tauri::async_runtime::block_on(probe_spotify(&tools, embed)).expect("spotify page");
    let entries = info.entries.expect("entries");
    assert!(entries.len() >= 10, "{} أغنية فقط", entries.len());
    assert!(
        entries
            .iter()
            .all(|e| !e.title.is_empty() && e.url.starts_with(crate::playlist::MUSIC_SEARCH))
    );
    assert!(
        entries.iter().filter(|e| e.duration.is_some()).count() >= entries.len() / 2,
        "المدد لم تعد تُقرأ"
    );
}

#[tokio::test]
async fn start_now_wakes_a_queued_job_even_if_pressed_first() {
    let jump = jump_signal(9_001);
    start_now(9_001);
    // notify_one يحفظ الإشارة: الانتظار بعدها ينتهي فورًا (U-11)
    tokio::time::timeout(Duration::from_secs(1), jump.notified()).await.expect("woken");
    forget_jump(9_001);
    start_now(9_001); // بعد النسيان: لا شيء ولا انهيار
}

/// أمر التنزيل الكامل: عنصر واحد من أي قائمة، المقطع بالوقت، والرابط بعد «--» دائمًا
#[test]
fn download_args_single_item_section_and_url_last() {
    let tools = Tools {
        ytdlp: PathBuf::from("yt-dlp"),
        ytdlp_prefix: vec![],
        env: vec![],
        js_runtime: String::new(),
        ffmpeg: PathBuf::new(),
        ffprobe: PathBuf::new(),
        ffmpeg_dir: PathBuf::new(),
    };
    let opts = JobOptions {
        template: "%(title)s".into(),
        rate_limit_kb: 500,
        max_name: 120,
    };
    let mut r = req("video", "mp4", "1080", true);
    r.url = "-https://example.com/watch?v=x".into();
    let a = download_args(
        &tools,
        vec!["--cookies".into(), "c.txt".into()],
        &r,
        &opts,
        Some((10.0, 20.0)),
        Path::new("out"),
        Path::new("work"),
    );
    let pos = |s: &str| a.iter().position(|x| x == s).unwrap_or_else(|| panic!("{s} missing"));
    assert_eq!(a[pos("--playlist-items") + 1], "1");
    assert_eq!(a[pos("-r") + 1], "500K");
    assert_eq!(a[pos("--cookies") + 1], "c.txt");
    assert!(a[pos("--download-sections") + 1].starts_with('*'));
    assert!(a.contains(&"--force-keyframes-at-cuts".to_string()));
    assert_eq!(a[a.len() - 2], "--");
    assert_eq!(a.last().unwrap(), &r.url);
}

/// إعادة المحاولة بعد فشل في منتصف المقاطع المنفصلة: المسلَّم يُعرف ولا يُكرَّر، والمحذوف يُعاد (RD20)
#[test]
fn delivered_clip_is_remembered_only_while_file_exists() {
    let root = std::env::temp_dir().join(format!("khama-delivered-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let clip = root.join("clip0");
    let out = root.join("out.mp4");
    assert_eq!(delivered_before(&clip), None);
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(&out, b"x").unwrap();
    mark_delivered(&clip, &out);
    assert_eq!(delivered_before(&clip), Some(out.clone()));
    std::fs::remove_file(&out).unwrap();
    assert_eq!(delivered_before(&clip), None, "المستخدم حذف الملف: يُنزَّل من جديد");
    let _ = std::fs::remove_dir_all(&root);
}

/// ملف روابط من Notepad («Unicode» = UTF-16 بـ BOM) أو بترميز Windows-1256 يُقرأ نصًا سليمًا (R2-5)
#[test]
fn links_file_in_utf16_and_cp1256() {
    let dir = std::env::temp_dir().join(format!("khama-links-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let text = "روابط: https://youtu.be/abc https://example.com/v";
    let mut utf16 = vec![0xFF, 0xFE];
    for u in text.encode_utf16() {
        utf16.extend(u.to_le_bytes());
    }
    let a = dir.join("u16.txt");
    std::fs::write(&a, &utf16).unwrap();
    assert_eq!(super::commands::read_links_file(a.to_string_lossy().into_owned()).unwrap(), text);
    let (cp, _, _) = encoding_rs::WINDOWS_1256.encode(text);
    let b = dir.join("cp1256.txt");
    std::fs::write(&b, &cp).unwrap();
    assert!(
        super::commands::read_links_file(b.to_string_lossy().into_owned())
            .unwrap()
            .contains("https://youtu.be/abc")
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// أجزاء HLS/DASH تُجلب معًا، إلا مع حد السرعة (R2-18)
#[test]
fn concurrent_fragments_only_without_rate_limit() {
    let tools = Tools {
        ytdlp: PathBuf::from("yt-dlp"),
        ytdlp_prefix: vec![],
        env: vec![],
        js_runtime: String::new(),
        ffmpeg: PathBuf::new(),
        ffprobe: PathBuf::new(),
        ffmpeg_dir: PathBuf::new(),
    };
    let r = req("video", "mp4", "best", false);
    let mut o = JobOptions {
        template: "%(title)s".into(),
        rate_limit_kb: 0,
        max_name: 120,
    };
    let a = download_args(&tools, vec![], &r, &o, None, Path::new("out"), Path::new("work"));
    assert!(a.windows(2).any(|w| w[0] == "--concurrent-fragments" && w[1] == "4"));
    o.rate_limit_kb = 500;
    let a = download_args(&tools, vec![], &r, &o, None, Path::new("out"), Path::new("work"));
    assert!(!a.iter().any(|x| x == "--concurrent-fragments"));
}
