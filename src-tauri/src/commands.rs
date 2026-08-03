use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chardetng::EncodingDetector;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

use crate::{preview, server};

#[derive(Deserialize)]
pub struct HttpRequestArgs {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
}

fn default_timeout() -> u64 {
    120
}

#[tauri::command]
pub async fn http_request(
    args: HttpRequestArgs,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(args.timeout_secs.max(1)))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let method = reqwest::Method::from_bytes(args.method.to_uppercase().as_bytes())
        .map_err(|_| "不支持的 HTTP 方法".to_string())?;

    let mut req = client.request(method, &args.url);
    for (k, v) in &args.headers {
        if k.to_lowercase() != "host" {
            req = req.header(k, v);
        }
    }
    if let Some(body) = &args.body {
        if !body.is_empty() {
            req = req.body(body.clone());
        }
    }

    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(format!("响应超过 64MB 上限（实际 {}MB），已拒绝", bytes.len() / 1024 / 1024));
    }

    Ok(serde_json::json!({
        "status": status,
        "contentType": content_type,
        "bodyBase64": B64.encode(&bytes),
    }))
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    let data = std::fs::read(&p).map_err(|e| format!("读取失败: {e}"))?;

    if let Ok(text) = String::from_utf8(data.clone()) {
        return Ok(serde_json::json!({ "text": text, "encoding": "UTF-8" }));
    }

    let mut detector = EncodingDetector::new();
    detector.feed(&data, true);
    let enc = detector.guess(None, true);
    if enc.name() != "UTF-8" {
        let (text, _, _) = encoding_rs::Encoding::decode(enc, &data);
        return Ok(serde_json::json!({ "text": text, "encoding": enc.name() }));
    }

    let lossy = String::from_utf8_lossy(&data).to_string();
    Ok(serde_json::json!({ "text": lossy, "encoding": "unknown" }))
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败: {e}"))
}

#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    Ok(B64.encode(&data))
}

#[tauri::command]
pub fn write_file_base64(path: String, data_b64: String) -> Result<(), String> {
    let bytes = B64.decode(&data_b64).map_err(|e| format!("base64 解码失败: {e}"))?;
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&p, bytes).map_err(|e| format!("写入失败: {e}"))
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    let mut out = Vec::new();
    if !p.exists() {
        return Ok(Value::Array(out));
    }
    let entries = std::fs::read_dir(&p).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in entries.flatten() {
        let meta = entry.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta.map(|m| m.len()).unwrap_or(0);
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        out.push(serde_json::json!({
            "name": name,
            "path": entry.path().to_string_lossy().to_string(),
            "isDir": is_dir,
            "size": size,
        }));
    }
    out.sort_by(|a, b| {
        let ad = a["isDir"].as_bool().unwrap_or(false);
        let bd = b["isDir"].as_bool().unwrap_or(false);
        bd.cmp(&ad).then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(Value::Array(out))
}

#[tauri::command]
pub fn mkdir_all(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {e}"))
}

#[tauri::command]
pub fn copy_file(src: String, dst: String) -> Result<(), String> {
    let dp = PathBuf::from(&dst);
    if let Some(parent) = dp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::copy(&src, &dp).map_err(|e| format!("复制失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn copy_dir_all(src: String, dst: String) -> Result<(), String> {
    copy_dir_recursive(Path::new(&src), Path::new(&dst))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
        for entry in std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))? {
            let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
            let s = entry.path();
            let d = dst.join(entry.file_name());
            copy_dir_recursive(&s, &d)?;
        }
    } else if src.is_file() {
        std::fs::copy(src, dst).map_err(|e| format!("复制失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("删除目录失败: {e}"))
    } else if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("删除文件失败: {e}"))
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn app_config_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn resource_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("获取资源目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_config(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    let file = dir.join("config.json");
    if !file.exists() {
        return Ok("{}".to_string());
    }
    let mut s = String::new();
    std::fs::File::open(&file)
        .and_then(|mut f| f.read_to_string(&mut s))
        .map_err(|e| format!("读取配置失败: {e}"))?;
    Ok(s)
}

#[tauri::command]
pub fn write_config(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    let file = dir.join("config.json");
    std::fs::write(&file, content).map_err(|e| format!("写入配置失败: {e}"))
}

#[tauri::command]
pub fn start_preview_server(root: String) -> Result<Value, String> {
    let handle = server::start(&root)?;
    let port = handle.port();
    let running = &preview().running;
    let mut guard = running.lock().map_err(|_| "锁获取失败".to_string())?;
    if let Some(old) = guard.take() {
        old.stop();
    }
    *guard = Some(handle);
    Ok(serde_json::json!({
        "url": format!("http://127.0.0.1:{port}/index.html"),
        "port": port,
    }))
}

#[tauri::command]
pub fn stop_preview_server() -> Result<(), String> {
    let running = &preview().running;
    let mut guard = running.lock().map_err(|_| "锁获取失败".to_string())?;
    if let Some(old) = guard.take() {
        old.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let dir = if p.is_dir() { p } else { p.parent().map(|d| d.to_path_buf()).unwrap_or(p) };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&dir).spawn().map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&dir).spawn().map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        for cmd in ["xdg-open", "gio", "nautilus"] {
            if std::process::Command::new(cmd).arg(&dir).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("没有可用的文件管理器".to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        return Err("不支持当前平台".to_string());
    }
}

#[tauri::command]
pub fn get_default_output_dir() -> String {
    // 用户主目录下的 NovelForge/output（保证可写，避免安装目录无权限）
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if !home.is_empty() {
        return format!("{}{}NovelForge{}output", home, std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR);
    }
    std::env::current_dir()
        .map(|d| d.join("output").to_string_lossy().to_string())
        .unwrap_or_else(|_| "output".to_string())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(&url).spawn().map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        for cmd in ["xdg-open", "gio"] {
            if std::process::Command::new(cmd).arg(&url).spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("没有可用的浏览器打开方式".to_string());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        return Err("不支持当前平台".to_string());
    }
}

#[tauri::command]
pub fn cutout_image(data_b64: String, threshold: f32) -> Result<String, String> {
    crate::cutout::cutout(&data_b64, threshold)
}

#[tauri::command]
pub fn has_transparency(data_b64: String) -> Result<bool, String> {
    crate::cutout::has_transparency(&data_b64)
}
