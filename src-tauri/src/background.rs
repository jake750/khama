//! العمل في الخلفية (الكمبيوتر فقط):
//! - أيقونة في شريط المهام (System tray) بقائمة: إظهار خامة / خروج
//! - زر الإغلاق يُخفي النافذة بدل إنهاء التطبيق، فتكمل التنزيلات (إن فعّل المستخدم ذلك)
//! - مراقبة الحافظة: أي رابط يُنسخ يُقترح تنزيله
//! - الوضع المصغّر: نافذة صغيرة تبقى فوق البرامج الأخرى

use crate::errors::LockExt;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Size, Window, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

use crate::settings::SettingsState;


/// هل أخبرنا المستخدم مرة أن خامة ما زالت تعمل في الخلفية؟
static TOLD_HIDDEN: AtomicBool = AtomicBool::new(false);
/// إشعار «رابط منسوخ» مرة واحدة في كل تشغيل، لا مع كل رابط (U-82)
static TOLD_CLIP: AtomicBool = AtomicBool::new(false);
/// رابط khama:// وصل قبل أن تجهز الواجهة (فتح التطبيق من المتصفح)
static PENDING_LINK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn is_ar(app: &AppHandle) -> bool {
    app.state::<SettingsState>().0.lock_ok().language == "ar"
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let ar = is_ar(app);
    let show = MenuItem::with_id(app, "show", if ar { "إظهار خامة" } else { "Show Khama" }, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", if ar { "خروج" } else { "Quit" }, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Khama")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        if !app.state::<SettingsState>().0.lock_ok().close_to_tray {
            // عمليات جارية: نسأل بدل أن نقطعها بصمت (U-27، U-44)
            if !app.state::<crate::download::Jobs>().cancels.lock_ok().is_empty() {
                api.prevent_close();
                let _ = app.emit("close-requested", ());
            }
            return;
        }
        api.prevent_close();
        let _ = window.hide();
        if !TOLD_HIDDEN.swap(true, Ordering::Relaxed) {
            let ar = is_ar(app);
            let _ = app
                .notification()
                .builder()
                .title("Khama")
                .body(if ar {
                    "خامة ما زالت تعمل في الخلفية. افتحها من أيقونتها في شريط المهام."
                } else {
                    "Khama keeps running in the background. Open it from its tray icon."
                })
                .show();
        }
    }
}

/// أول رابط http(s) في نص منسوخ
pub fn first_url(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| matches!(c, '"' | '\'' | '<' | '>' | '(' | ')')))
        .find(|w| (w.starts_with("https://") || w.starts_with("http://")) && w.len() > 10)
        .map(String::from)
}

/// هل مراقبة الحافظة مفعّلة؟ نسخة من الإعداد لا تحتاج قفل الإعدادات كل ثانية (T-24)
static CLIP_ON: AtomicBool = AtomicBool::new(false);
static CLIP_THREAD: std::sync::OnceLock<std::thread::Thread> = std::sync::OnceLock::new();

/// تستدعيها قراءة الإعدادات وحفظها. إطفاء المراقبة يوقف الخيط تمامًا (park) حتى تُفعَّل من جديد
pub fn set_clipboard_watch(on: bool) {
    CLIP_ON.store(on, Ordering::Relaxed);
    if on && let Some(t) = CLIP_THREAD.get() {
        t.unpark();
    }
}

/// رقم يتغيّر مع كل نسخ في Windows: لا نقرأ محتوى الحافظة إلا إن تغيّر،
/// فلا تمرّ كلمة سر منسوخة على خامة كل ثانية (T-24). في الأنظمة الأخرى None = اقرأ دائمًا.
fn clipboard_seq() -> Option<u32> {
    #[cfg(windows)]
    {
        // SAFETY: دالة بلا وسائط ولا حالة، تُرجع عدّادًا فقط
        Some(unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() })
    }
    #[cfg(not(windows))]
    None
}

/// أطول نص نفحصه: الرابط المنسوخ قصير، والنص الطويل لا نمسح فيه عن روابط
const CLIP_MAX: usize = 4096;

/// يفحص الحافظة كل ثانية (إن فعّل المستخدم المراقبة) ويخبر الواجهة بأي رابط جديد
pub fn spawn_clipboard_watcher(app: AppHandle) {
    let handle = std::thread::spawn(move || {
        let mut last: Option<String> = None;
        let mut primed = false;
        let mut seq = None;
        loop {
            if !CLIP_ON.load(Ordering::Relaxed) {
                primed = false;
                std::thread::park();
                continue;
            }
            std::thread::sleep(Duration::from_millis(1000));
            let now = clipboard_seq();
            if primed && now.is_some() && now == seq {
                continue;
            }
            seq = now;
            let url = app
                .clipboard()
                .read_text()
                .ok()
                .filter(|t| t.len() <= CLIP_MAX)
                .and_then(|t| first_url(&t));
            // أول قراءة بعد التفعيل: ما في الحافظة قديم، لا نقترحه
            if !primed {
                primed = true;
                last = url;
                continue;
            }
            let Some(url) = url else { continue };
            if last.as_deref() == Some(url.as_str()) {
                continue;
            }
            last = Some(url.clone());
            let _ = app.emit("clipboard-url", &url);
            let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
            if !focused && !TOLD_CLIP.swap(true, Ordering::Relaxed) {
                let ar = is_ar(&app);
                let _ = app
                    .notification()
                    .builder()
                    .title(if ar { "رابط منسوخ" } else { "Link copied" })
                    .body(format!(
                        "{}\n{url}",
                        if ar {
                            "افتح خامة لتنزيله:"
                        } else {
                            "Open Khama to download it:"
                        }
                    ))
                    .show();
            }
        }
    });
    let _ = CLIP_THREAD.set(handle.thread().clone());
    // قد تكون المراقبة فُعّلت قبل أن يُسجَّل الخيط
    if CLIP_ON.load(Ordering::Relaxed) {
        handle.thread().unpark();
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// «أكمل في الخلفية»: نخفي النافذة، والأيقونة في شريط المهام تعيدها
#[tauri::command]
pub fn hide_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// رابط khama://download?url=<رابط مُرمَّز> ← الرابط نفسه، إن كان http(s) (T-101).
/// لا نبدأ تنزيلًا من رابط خارجي: نضعه في الحقل فقط، والمستخدم يختار ويضغط «تنزيل»
pub fn link_target(link: &str) -> Option<String> {
    let rest = link.strip_prefix("khama://")?;
    let (_, query) = rest.split_once('?')?;
    let raw = query.split('&').find_map(|kv| kv.strip_prefix("url="))?;
    let url = percent_decode(raw)?;
    (url.starts_with("https://") || url.starts_with("http://")).then_some(url)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
                out.push(u8::from_str_radix(h, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// رابط khama:// وصل: نُظهر النافذة ونرسله للواجهة، ونحفظه إن لم تجهز بعد
pub fn open_link(app: &AppHandle, link: &str) {
    let Some(url) = link_target(link) else { return };
    *PENDING_LINK.lock_ok() = Some(url.clone());
    show_main(app);
    let _ = app.emit("deep-link", url);
}

/// تسألها الواجهة عند فتحها: رابط khama:// فتح التطبيق
#[tauri::command]
pub fn take_deep_link() -> Option<String> {
    PENDING_LINK.lock_ok().take()
}

#[cfg(test)]
mod link_tests {
    use super::link_target;

    #[test]
    fn reads_the_url_and_rejects_others() {
        assert_eq!(
            link_target("khama://download?url=https%3A%2F%2Fyoutu.be%2Fabc%3Ft%3D5").as_deref(),
            Some("https://youtu.be/abc?t=5")
        );
        assert_eq!(link_target("khama://download?url=file%3A%2F%2F%2Fc%3A%2Fx"), None);
        assert_eq!(link_target("khama://download"), None);
        assert_eq!(link_target("https://x.com/?url=https://y"), None);
        assert_eq!(link_target("khama://download?url=%zz"), None);
    }
}

/// الوضع المصغّر: نافذة ضيقة فوق البرامج الأخرى (للعمل بجانب برنامج المونتاج)
#[tauri::command]
pub fn set_compact(app: AppHandle, compact: bool) -> Result<(), crate::errors::AppError> {
    let Some(w) = app.get_webview_window("main") else { return Ok(()) };
    let err = |e: tauri::Error| crate::errors::AppError::with_detail("window", e.to_string());
    // لا يتغيّر حجم نافذة مصغّرة أو مكبّرة: نعيدها لحالتها العادية أولًا
    let _ = w.unminimize();
    let _ = w.unmaximize();
    if compact {
        w.set_min_size(Some(Size::Logical(LogicalSize::new(360.0, 420.0)))).map_err(err)?;
        w.set_size(Size::Logical(LogicalSize::new(420.0, 640.0))).map_err(err)?;
        w.set_always_on_top(true).map_err(err)?;
    } else {
        w.set_always_on_top(false).map_err(err)?;
        w.set_size(Size::Logical(LogicalSize::new(1040.0, 760.0))).map_err(err)?;
        w.set_min_size(Some(Size::Logical(LogicalSize::new(760.0, 560.0)))).map_err(err)?;
        let _ = w.center();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::first_url;

    #[test]
    fn finds_urls() {
        assert_eq!(
            first_url("look: https://youtu.be/abc123 nice"),
            Some("https://youtu.be/abc123".into())
        );
        assert_eq!(first_url("\"https://x.com/a/status/1\""), Some("https://x.com/a/status/1".into()));
        assert_eq!(first_url("no link here"), None);
    }
}
