//! نقطة دخول التطبيق: نسجّل الإضافات والحالة المشتركة والأوامر التي تستدعيها الواجهة.

#[cfg(desktop)]
mod background;
mod convert;
mod download;
mod errors;
mod history;
#[cfg(mobile)]
mod mobile;
mod persist;
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
        .plugin(tauri_plugin_os::init())
        // ملف سجلّ في مجلد سجلات التطبيق (Windows: %LOCALAPPDATA%\com.jake750.khama\logs)،
        // يُستبدل عند 2 ميغابايت ويبقى ملف سابق واحد
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                    file_name: None,
                }))
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stderr))
                .build(),
        )
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
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            background::show_main(app);
            // فتح رابط khama:// والتطبيق مفتوح: يصل كوسيط للنسخة الثانية
            for a in args.iter().filter(|a| a.starts_with("khama://")) {
                background::open_link(app, a);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .on_window_event(background::on_window_event);
    #[cfg(mobile)]
    let builder = builder.plugin(mobile::init());

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            let loaded = settings::load(&handle);
            app.state::<download::DownloadQueue>().set_limit(loaded.parallel_downloads.into());
            #[cfg(desktop)]
            background::set_clipboard_watch(loaded.watch_clipboard);
            app.manage(settings::SettingsState(Mutex::new(loaded)));
            download::clean_stale_jobs(&handle);
            #[cfg(desktop)]
            {
                convert::spawn_watcher(handle.clone());
                background::setup_tray(&handle)?;
                background::spawn_clipboard_watcher(handle.clone());
                // روابط khama:// (T-101): التسجيل في النظام يكتبه المثبّت، ونكرّره هنا لنسخ التطوير وAppImage
                use tauri_plugin_deep_link::DeepLinkExt;
                #[cfg(any(windows, target_os = "linux"))]
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("deep link register: {e}");
                }
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for u in urls {
                        background::open_link(&handle, u.as_str());
                    }
                }
                let h = handle.clone();
                app.deep_link().on_open_url(move |e| {
                    for u in e.urls() {
                        background::open_link(&h, u.as_str());
                    }
                });
            }
            // في الخلفية: جهّز yt-dlp (نسخة قابلة للتحديث على الكمبيوتر، أو فكّ الأدوات على الهاتف)
            tauri::async_runtime::spawn(async move {
                if let Err(e) = tools::ensure_managed_ytdlp(&handle).await {
                    log::error!("ensure_managed_ytdlp: {e:?}");
                }
            });
            Ok(())
        })
        .invoke_handler(handlers())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// قائمة الأوامر مرة واحدة: المشتركة بين الكمبيوتر والهاتف، وبعدها أوامر خاصة بالمنصة.
macro_rules! handlers_with {
    ($($m:ident :: $f:ident),* $(,)?) => {
        tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            settings::default_output_dir,
            settings::has_saved_cookies,
            settings::save_cookies,
            settings::delete_cookies,
            settings::counter_next,
            settings::reset_counter,
            tools::tools_info,
            tools::update_ytdlp,
            download::probe,
            download::start_download,
            download::cancel_download,
            download::remember_job,
            download::list_jobs,
            download::new_job_id,
            download::reveal_file,
            download::open_file,
            download::open_output_dir,
            download::save_thumbnail,
            download::free_space,
            history::get_history,
            history::remove_history,
            history::clear_history,
            history::get_scheduled,
            history::save_scheduled,
            convert::analyze_file,
            convert::hw_encoders,
            convert::start_convert,
            convert::import_files,
            $($m::$f),*
        ]
    };
}

#[cfg(desktop)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    handlers_with![
        background::quit_app,
        background::set_compact,
        background::hide_main,
        background::take_deep_link
    ]
}

#[cfg(mobile)]
fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    handlers_with![]
}
