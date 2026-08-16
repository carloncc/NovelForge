mod commands;
pub mod cutout;
mod server;

use include_dir::{include_dir, Dir};
use once_cell::sync::OnceCell;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

/// 内嵌 WebGAL 引擎模板：让单独一个 exe（便携版）无需外部 templates 目录即可运行。
/// 首次启动时解压到资源目录（exe 所在目录）；NSIS 安装版由安装器放置的同名目录优先，此处幂等跳过。
static EMBEDDED_TEMPLATE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/templates/webgal");

pub struct PreviewServer {
    pub running: Mutex<Option<server::ServerHandle>>,
}

static PREVIEW: OnceCell<PreviewServer> = OnceCell::new();

pub fn preview() -> &'static PreviewServer {
    PREVIEW.get_or_init(|| PreviewServer {
        running: Mutex::new(None),
    })
}

/// 确保资源目录下存在可用的 WebGAL 模板（幂等）。返回最终模板目录或错误信息。
pub fn ensure_embedded_template(app: &tauri::App) -> Result<std::path::PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("获取资源目录失败: {e}"))?;
    let target = resource_dir.join("templates").join("webgal");
    if target.join("index.html").exists() {
        return Ok(target);
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("创建模板目录失败: {e}"))?;
    extract_dir(&EMBEDDED_TEMPLATE, &target).map_err(|e| format!("解压内嵌模板失败: {e}"))?;
    if !target.join("index.html").exists() {
        return Err("内嵌模板解压后校验失败".to_string());
    }
    Ok(target)
}

fn extract_dir(dir: &Dir<'_>, root: &Path) -> std::io::Result<()> {
    for file in dir.files() {
        let path = root.join(file.path());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, file.contents())?;
    }
    for sub in dir.dirs() {
        extract_dir(sub, root)?;
    }
    Ok(())
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
            commands::replace_path,
            commands::copy_dir_all,
            commands::remove_path,
            commands::path_exists,
            commands::app_config_dir,
            commands::read_config,
            commands::write_config,
            commands::read_api_secrets,
            commands::write_api_secrets,
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
            match ensure_embedded_template(app) {
                Ok(template_dir) => {
                    eprintln!("[novelforge] WebGAL 模板就绪: {}", template_dir.display());
                }
                Err(error) => {
                    eprintln!("[novelforge] 警告: {error}");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
