//! نقطة دخول التطبيق: نسجّل الإضافات والحالة المشتركة والأوامر التي تستدعيها الواجهة.

// نسخة الهاتف تستعمل جزءًا من محرّك الكمبيوتر فقط (لا ffprobe ولا إزالة موسيقى بعد)
#![cfg_attr(mobile, allow(dead_code, unused_mut))]

#[cfg(desktop)]
mod background;
mod convert;
mod download;
mod errors;
mod history;
#[cfg(mobile)]
mod mobile;
mod playlist;
mod separate;
mod settings;
mod srt;
mod tools;

use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(download::Jobs::default())
        .manage(download::DownloadQueue::default())
        .manage(history::HistoryState::default())
        .manage(convert::ConvertQueue::default());
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_drag::init())
        // نسخة واحدة فقط: فتح خامة مرة ثانية يُظهر النافذة الموجودة (المخفية في شريط المهام مثلًا)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| background::show_main(app)))
        .on_window_event(background::on_window_event);
    #[cfg(mobile)]
    let builder = builder.plugin(mobile::init());

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(settings::SettingsState(Mutex::new(settings::load(&handle))));
            download::clean_stale_jobs(&handle);
            #[cfg(desktop)]
            {
                convert::spawn_watcher(handle.clone());
                background::setup_tray(&handle)?;
                background::spawn_clipboard_watcher(handle.clone());
            }
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
            download::save_thumbnail,
            history::get_history,
            history::add_history,
            history::remove_history,
            history::clear_history,
            background::quit_app,
            background::set_compact,
            convert::analyze_file,
            convert::hw_encoders,
            convert::start_convert,
            convert::import_files,
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
        download::save_thumbnail,
        history::get_history,
        history::add_history,
        history::remove_history,
        history::clear_history,
        convert::analyze_file,
        convert::hw_encoders,
        convert::start_convert,
        convert::import_files,
    ]
}
