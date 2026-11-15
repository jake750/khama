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
    let t = info_text(&j, &[(1.0, 2.5)]);
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
