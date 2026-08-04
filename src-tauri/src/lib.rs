mod commands;
mod cutout;
mod server;

use once_cell::sync::OnceCell;
use std::sync::Mutex;
use tauri::Manager;

pub struct PreviewServer {
    pub running: Mutex<Option<server::ServerHandle>>,
}

static PREVIEW: OnceCell<PreviewServer> = OnceCell::new();

pub fn preview() -> &'static PreviewServer {
    PREVIEW.get_or_init(|| PreviewServer {
        running: Mutex::new(None),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::http_request,
            commands::read_text_file,
            commands::write_text_file,
            commands::read_file_base64,
            commands::write_file_base64,
            commands::list_dir,
            commands::mkdir_all,
            commands::copy_file,
            commands::copy_dir_all,
            commands::remove_path,
            commands::path_exists,
            commands::app_config_dir,
            commands::read_config,
            commands::write_config,
            commands::resource_dir,
            commands::start_preview_server,
            commands::stop_preview_server,
            commands::open_in_explorer,
            commands::open_url,
            commands::get_default_output_dir,
            commands::cutout_image,
            commands::has_transparency,
            commands::build_zip,
        ])
        .setup(|app| {
            if let Ok(dir) = app.path().app_config_dir() {
                let _ = std::fs::create_dir_all(&dir);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
