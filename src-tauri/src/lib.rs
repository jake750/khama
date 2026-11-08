//! نقطة دخول التطبيق: نسجّل الإضافات والحالة المشتركة والأوامر التي تستدعيها الواجهة.

// نسخة الهاتف تستعمل جزءًا من محرّك الكمبيوتر فقط (لا ffprobe ولا إزالة موسيقى بعد)
#![cfg_attr(mobile, allow(dead_code, unused_mut))]

#[cfg(desktop)]
mod convert;
mod download;
mod errors;
#[cfg(mobile)]
mod mobile;
#[cfg(desktop)]
mod separate;
mod settings;
mod tools;

use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(download::Jobs::default());
    #[cfg(desktop)]
    let builder = builder
        .manage(convert::ConvertQueue::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    #[cfg(mobile)]
    let builder = builder.plugin(mobile::init());

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(settings::SettingsState(Mutex::new(settings::load(&handle))));
            download::clean_stale_jobs(&handle);
            #[cfg(desktop)]
            convert::spawn_watcher(handle.clone());
            // في الخلفية: جهّز yt-dlp (نسخة قابلة للتحديث على الكمبيوتر، أو فكّ الأدوات على الهاتف)
            tauri::async_runtime::spawn(async move {
                if let Err(e) = tools::ensure_managed_ytdlp(&handle).await {
                    eprintln!("ensure_managed_ytdlp: {e:?}");
                }
            });
            Ok(())
        })
        .invoke_handler(handlers())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            settings::default_output_dir,
            settings::has_saved_cookies,
            settings::save_cookies,
            settings::delete_cookies,
            tools::tools_info,
            tools::update_ytdlp,
            download::probe,
            download::start_download,
            download::cancel_download,
            download::reveal_file,
            download::open_output_dir,
            convert::analyze_file,
            convert::hw_encoders,
            convert::start_convert,
    ]
}

#[cfg(mobile)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        settings::get_settings,
        settings::save_settings,
        settings::default_output_dir,
        settings::has_saved_cookies,
        settings::save_cookies,
        settings::delete_cookies,
        tools::tools_info,
        tools::update_ytdlp,
        download::probe,
        download::start_download,
        download::cancel_download,
        download::reveal_file,
        download::open_output_dir,
    ]
}
