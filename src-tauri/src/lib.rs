mod commands;
pub mod cutout;
pub mod models;
mod server;

use include_dir::{include_dir, Dir};
use once_cell::sync::OnceCell;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

/// 内嵌 WebGAL 引擎模板：让单独一个 exe（便携版）无需外部 templates 目录即可运行。
/// 首次启动时解压到资源目录（exe 所在目录）；NSIS 安装版由安装器放置的同名目录优先，此处幂等跳过。
static EMBEDDED_TEMPLATE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/templates/webgal");

/// 鉴赏室页面模板：随二进制内嵌，启动时补写到模板目录（老安装 / 老模板升级时缺失）。
static APPRECIATION_HTML: &str = include_str!("../../src/gameExtra/appreciation.html");

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
    if !target.join("index.html").exists() {
        std::fs::create_dir_all(&target).map_err(|e| format!("创建模板目录失败: {e}"))?;
        extract_dir(&EMBEDDED_TEMPLATE, &target).map_err(|e| format!("解压内嵌模板失败: {e}"))?;
        if !target.join("index.html").exists() {
            return Err("内嵌模板解压后校验失败".to_string());
        }
    }
    ensure_appreciation_file(&target);
    Ok(target)
}

/// 鉴赏室页面随模板一起分发：内嵌副本存在时补写到模板目录，老安装 / 老模板升级后缺失也会补齐。
fn ensure_appreciation_file(target: &std::path::Path) {
    let dest = target.join("appreciation.html");
    if dest.exists() {
        return;
    }
    if let Err(error) = std::fs::write(&dest, APPRECIATION_HTML) {
        eprintln!("[novelforge] 警告: 写入鉴赏室页面失败: {error}");
    }
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
        .register_uri_scheme_protocol("model", |_ctx, request| {
            // model://localhost/<模型文件名> → 应用配置目录 models/ 下的文件
            let path = request.uri().path().trim_start_matches('/');
            let filename = Path::new(path).file_name().and_then(|s| s.to_str()).unwrap_or_default();
            if filename.is_empty() {
                return tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
            }
            match models::read_model_file(filename) {
                Some(bytes) => tauri::http::Response::builder()
                    .header("Content-Type", "application/octet-stream")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })
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
            models::model_download_start,
            models::model_download_status,
            models::model_remove,
        ])
        .setup(|app| {
            if let Ok(dir) = app.path().app_config_dir() {
                let _ = std::fs::create_dir_all(&dir);
            }
            if let Err(error) = models::init_models_dir(app) {
                eprintln!("[novelforge] 警告: {error}");
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
