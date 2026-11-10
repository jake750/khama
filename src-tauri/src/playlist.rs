//! قوائم التشغيل: نقرأ عناصر القائمة (دون تنزيل) لتختار الواجهة منها ما يُنزَّل.
//!
//! - يوتيوب وساوندكلاود وأغلب المواقع: yt-dlp مع --flat-playlist (سريع: لا يفتح كل عنصر).
//! - سبوتيفاي: أغانيه محمية ولا تُنزَّل منه، فنقرأ أسماء الأغاني من صفحة المشغّل المضمَّن
//!   (open.spotify.com/embed/...) ونبحث عن كل أغنية في YouTube Music عند التنزيل
//!   (قسم "الأغاني" يعطي النسخة الأصلية، لا فيديو كليب أو أداءً حيًا).
//!   نجلب الصفحة بـ yt-dlp نفسه (--dump-pages) حتى يعمل الشيء نفسه على الكمبيوتر والهاتف
//!   دون مكتبة اتصال إضافية.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

use crate::errors::AppError;

/// عنصر في القائمة: url هو ما يُعطى لـ yt-dlp عند التنزيل
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub url: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

/// بحث في أغاني YouTube Music. التنزيل يأخذ أول نتيجة (--playlist-items 1)
pub const MUSIC_SEARCH: &str = "https://music.youtube.com/search?q=";

/// "Ashe - Stop!" → "Ashe+-+Stop%21" (ترميز النص داخل الرابط)
fn query_encode(q: &str) -> String {
    let mut out = String::new();
    for b in q.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn music_search_url(query: &str) -> String {
    format!("{MUSIC_SEARCH}{}#songs", query_encode(query))
}

// ======================= yt-dlp =======================

/// "https://soundcloud.com/forss/city-ports" → "city ports" (ساوندكلاود لا يعطي العناوين مع --flat-playlist)
fn title_from_url(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let slug = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let t = slug.replace(['-', '_'], " ");
    let t = t.trim();
    if t.is_empty() { url.to_string() } else { t.to_string() }
}

fn str_field(e: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| e[*k].as_str().filter(|s| !s.trim().is_empty()))
        .map(|s| s.trim().to_string())
}

/// عناصر قائمة من مخرجات `yt-dlp -J --flat-playlist`
pub fn entries_from_ytdlp(j: &Value) -> Vec<Entry> {
    let Some(list) = j["entries"].as_array() else { return vec![] };
    list.iter()
        .filter(|e| !e.is_null())
        // قائمة داخل قائمة (مثل تبويبات قناة) لا تُنزَّل كملف واحد
        .filter(|e| {
            e["_type"].as_str() != Some("playlist")
                && !e["ie_key"].as_str().is_some_and(|k| k.ends_with("Tab") || k.contains("Playlist"))
        })
        .filter_map(|e| {
            let url = str_field(e, &["url", "webpage_url", "original_url"])
                .filter(|u| u.starts_with("http://") || u.starts_with("https://"))?;
            let title = str_field(e, &["title", "track"]).unwrap_or_else(|| title_from_url(&url));
            // أصغر صورة مصغّرة تكفي للقائمة
            let thumbnail = e["thumbnails"]
                .as_array()
                .and_then(|t| t.first())
                .and_then(|t| t["url"].as_str())
                .or(e["thumbnail"].as_str())
                .map(String::from);
            Some(Entry {
                uploader: str_field(e, &["uploader", "channel", "artist"]),
                duration: e["duration"].as_f64().filter(|d| *d > 0.0),
                thumbnail,
                title,
                url,
            })
        })
        .collect()
}

// ======================= سبوتيفاي =======================

/// رابط سبوتيفاي → رابط المشغّل المضمَّن الذي فيه قائمة الأغاني
/// (playlist / album / track، مع أو بدون /intl-xx/ و ?si=...)
pub fn spotify_embed_url(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://").or_else(|| url.trim().strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/')?;
    if !matches!(host, "open.spotify.com" | "play.spotify.com") {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    let segs: Vec<&str> = path
        .split('/')
        .filter(|s| !s.is_empty() && *s != "embed" && !s.starts_with("intl-"))
        .collect();
    match segs.as_slice() {
        [kind @ ("playlist" | "album" | "track"), id, ..] if id.chars().all(|c| c.is_ascii_alphanumeric()) => {
            Some(format!("https://open.spotify.com/embed/{kind}/{id}"))
        }
        _ => None,
    }
}

/// الصفحة من مخرجات `yt-dlp --dump-pages`: سطر base64 بعد "Dumping request to"
pub fn page_from_dump(stdout: &str) -> Option<String> {
    let mut lines = stdout.lines();
    lines.find(|l| l.contains("Dumping request to"))?;
    let b64 = lines.next()?.trim();
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub struct SpotifyList {
    pub title: String,
    pub owner: Option<String>,
    pub thumbnail: Option<String>,
    pub entries: Vec<Entry>,
}

fn search_entry(title: &str, artists: Option<&str>, duration_ms: Option<f64>) -> Entry {
    let query = match artists {
        Some(a) if !a.is_empty() => format!("{a} {title}"),
        _ => title.to_string(),
    };
    Entry {
        url: music_search_url(&query),
        title: title.to_string(),
        uploader: artists.map(String::from).filter(|a| !a.is_empty()),
        duration: duration_ms.map(|ms| ms / 1000.0).filter(|d| *d > 0.0),
        thumbnail: None,
    }
}

/// يقرأ قائمة الأغاني من صفحة المشغّل المضمَّن (JSON داخل __NEXT_DATA__)
pub fn parse_spotify_page(html: &str) -> Result<SpotifyList, AppError> {
    const START: &str = r#"<script id="__NEXT_DATA__" type="application/json">"#;
    let fail = || AppError::new("spotifyFailed");
    let from = html.find(START).ok_or_else(fail)? + START.len();
    let len = html[from..].find("</script>").ok_or_else(fail)?;
    let j: Value = serde_json::from_str(&html[from..from + len]).map_err(|_| fail())?;
    let e = &j["props"]["pageProps"]["state"]["data"]["entity"];
    if e.is_null() {
        return Err(fail());
    }
    let title = str_field(e, &["name", "title"]).unwrap_or_else(|| "Spotify".into());
    let owner = str_field(e, &["subtitle"]);
    let thumbnail = e["coverArt"]["sources"]
        .as_array()
        .and_then(|s| s.iter().rev().find_map(|x| x["url"].as_str()))
        .map(String::from);

    let mut entries: Vec<Entry> = e["trackList"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|t| {
                    let name = str_field(t, &["title", "name"])?;
                    Some(search_entry(&name, str_field(t, &["subtitle"]).as_deref(), t["duration"].as_f64()))
                })
                .collect()
        })
        .unwrap_or_default();

    // رابط أغنية واحدة: لا قائمة، الأغنية نفسها هي الكيان
    if entries.is_empty() && e["type"].as_str() == Some("track") {
        let artists = e["artists"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
            .filter(|a| !a.is_empty())
            .or_else(|| owner.clone());
        let ms = e["duration"].as_f64().or(e["duration"]["totalMilliseconds"].as_f64());
        entries.push(search_entry(&title, artists.as_deref(), ms));
    }
    if entries.is_empty() {
        return Err(AppError::new("playlistEmpty"));
    }
    Ok(SpotifyList { title, owner, thumbnail, entries })
}

// ======================= اسم مجلد القائمة =======================

/// اسم القائمة → اسم مجلد صالح على كل الأنظمة (أو None إن لم يبقَ منه شيء)
pub fn folder_name(name: &str) -> Option<String> {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned: String = cleaned.chars().take(100).collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

// ======================= اختبارات =======================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spotify_urls() {
        assert_eq!(
            spotify_embed_url("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc").as_deref(),
            Some("https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M")
        );
        assert_eq!(
            spotify_embed_url("https://open.spotify.com/intl-ar/album/4aawyAB9vmqN3uQ7FjRGTy").as_deref(),
            Some("https://open.spotify.com/embed/album/4aawyAB9vmqN3uQ7FjRGTy")
        );
        assert!(spotify_embed_url("https://open.spotify.com/artist/abc").is_none());
        assert!(spotify_embed_url("https://www.youtube.com/playlist?list=x").is_none());
        assert!(spotify_embed_url("https://open.spotify.com/track/../../x").is_none());
    }

    #[test]
    fn ytdlp_entries() {
        let j = json!({ "_type": "playlist", "entries": [
            { "url": "https://www.youtube.com/watch?v=a", "title": "A", "duration": 61.0, "channel": "Ch",
              "thumbnails": [{ "url": "https://i/s.jpg" }, { "url": "https://i/l.jpg" }] },
            { "url": "https://soundcloud.com/forss/city-ports", "ie_key": "Soundcloud" },
            { "url": "https://www.youtube.com/@x/shorts", "ie_key": "YoutubeTab", "title": "Shorts" },
            null,
            { "url": "not-a-link", "title": "bad" }
        ]});
        let e = entries_from_ytdlp(&j);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].title, "A");
        assert_eq!(e[0].uploader.as_deref(), Some("Ch"));
        assert_eq!(e[0].thumbnail.as_deref(), Some("https://i/s.jpg"));
        assert_eq!(e[1].title, "city ports");
    }

    #[test]
    fn spotify_page() {
        let data = json!({ "props": { "pageProps": { "state": { "data": { "entity": {
            "type": "playlist", "name": "Hits", "subtitle": "Spotify",
            "coverArt": { "sources": [{ "url": "https://c/1.jpg" }] },
            "trackList": [
                { "title": "Song", "subtitle": "Artist, Other", "duration": 198840 },
                { "title": "" }
            ]
        }}}}}});
        let html = format!(r#"<html><script id="__NEXT_DATA__" type="application/json">{data}</script></html>"#);
        let l = parse_spotify_page(&html).unwrap();
        assert_eq!(l.title, "Hits");
        assert_eq!(l.entries.len(), 1);
        assert_eq!(l.entries[0].url, "https://music.youtube.com/search?q=Artist%2C+Other+Song#songs");
        assert_eq!(music_search_url("عمرو"), "https://music.youtube.com/search?q=%D8%B9%D9%85%D8%B1%D9%88#songs");
        assert_eq!(l.entries[0].duration, Some(198.84));
        assert!(parse_spotify_page("<html></html>").is_err());
    }

    #[test]
    fn dump_and_folder() {
        let b64 = base64::engine::general_purpose::STANDARD.encode("<html>hi</html>");
        let out = format!("[generic] x: Downloading webpage\n[generic] Dumping request to https://x\n{b64}\n");
        assert_eq!(page_from_dump(&out).as_deref(), Some("<html>hi</html>"));
        assert_eq!(folder_name("  My: Mix / 2024?. ").as_deref(), Some("My Mix 2024"));
        assert_eq!(folder_name("..."), None);
    }
}
