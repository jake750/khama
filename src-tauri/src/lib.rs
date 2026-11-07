//! نقطة دخول التطبيق: نسجّل الإضافات والحالة المشتركة والأوامر التي تستدعيها الواجهة.

mod convert;
mod download;
mod errors;
mod separate;
mod settings;
mod tools;

use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(download::Jobs::default())
        .manage(convert::ConvertQueue::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(settings::SettingsState(Mutex::new(settings::load(&handle))));
            download::clean_stale_jobs(&handle);
            convert::spawn_watcher(handle.clone());
            // في الخلفية: جهّز نسخة yt-dlp القابلة للتحديث
            tauri::async_runtime::spawn(async move {
                if let Err(e) = tools::ensure_managed_ytdlp(&handle).await {
                    eprintln!("ensure_managed_ytdlp: {e:?}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
