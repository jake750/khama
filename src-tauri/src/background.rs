//! العمل في الخلفية (الكمبيوتر فقط):
//! - أيقونة في شريط المهام (System tray) بقائمة: إظهار خامة / خروج
//! - زر الإغلاق يُخفي النافذة بدل إنهاء التطبيق، فتكمل التنزيلات (إن فعّل المستخدم ذلك)
//! - مراقبة الحافظة: أي رابط يُنسخ يُقترح تنزيله
//! - الوضع المصغّر: نافذة صغيرة تبقى فوق البرامج الأخرى

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

fn is_ar(app: &AppHandle) -> bool {
    app.state::<SettingsState>().0.lock().unwrap().language == "ar"
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
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
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
        if !app.state::<SettingsState>().0.lock().unwrap().close_to_tray {
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

/// يقرأ الحافظة كل ثانية (إن فعّل المستخدم المراقبة) ويخبر الواجهة بأي رابط جديد
pub fn spawn_clipboard_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<String> = None;
        let mut primed = false;
        loop {
            std::thread::sleep(Duration::from_millis(1000));
            let enabled = app.state::<SettingsState>().0.lock().unwrap().watch_clipboard;
            if !enabled {
                primed = false;
                continue;
            }
            let url = app.clipboard().read_text().ok().and_then(|t| first_url(&t));
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
            let focused = app
                .get_webview_window("main")
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false);
            if !focused {
                let ar = is_ar(&app);
                let _ = app
                    .notification()
                    .builder()
                    .title(if ar { "رابط منسوخ" } else { "Link copied" })
                    .body(format!("{}\n{url}", if ar { "افتح خامة لتنزيله:" } else { "Open Khama to download it:" }))
                    .show();
            }
        }
    });
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
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
        assert_eq!(first_url("look: https://youtu.be/abc123 nice"), Some("https://youtu.be/abc123".into()));
        assert_eq!(first_url("\"https://x.com/a/status/1\""), Some("https://x.com/a/status/1".into()));
        assert_eq!(first_url("no link here"), None);
    }
}
