use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chardetng::EncodingDetector;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;

use crate::{preview, server};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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
pub fn replace_path(src: String, dst: String) -> Result<(), String> {
    let source = PathBuf::from(&src);
    let destination = PathBuf::from(&dst);
    let backup = PathBuf::from(format!("{dst}.replace-backup"));
    if !source.exists() {
        return Err(format!("替换失败：源路径不存在 {src}"));
    }
    if backup.exists() {
        if backup.is_dir() {
            std::fs::remove_dir_all(&backup)
        } else {
            std::fs::remove_file(&backup)
        }
        .map_err(|e| format!("清理替换备份失败: {e}"))?;
    }
    let had_destination = destination.exists();
    if had_destination {
        std::fs::rename(&destination, &backup).map_err(|e| format!("创建替换备份失败: {e}"))?;
    }
    if let Err(error) = std::fs::rename(&source, &destination) {
        if had_destination {
            if let Err(rollback_error) = std::fs::rename(&backup, &destination) {
                return Err(format!(
                    "发布替换路径失败: {error}; 回滚原路径也失败: {rollback_error}"
                ));
            }
        }
        return Err(format!("发布替换路径失败: {error}"));
    }
    if had_destination {
        let cleanup = if backup.is_dir() {
            std::fs::remove_dir_all(&backup)
        } else {
            std::fs::remove_file(&backup)
        };
        if let Err(error) = cleanup {
            eprintln!("清理替换备份失败（发布已成功）: {error}");
        }
    }
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
    // Windows 下 Tauri 可能返回 \\?\ 扩展长度路径前缀，去掉它避免前端拼接路径时解析失败
    let s = dir.to_string_lossy();
    let s = s.strip_prefix("\\\\?\\").unwrap_or(&s).to_string();
    Ok(s.replace("\\", "/"))
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoutResult {
    pub data_b64: String,
    /// 抠图方式：ai（isnet-anime 分割）/ chroma（色度键）
    pub method: String,
}

/// 抠图：优先 AI 分割（isnet-anime，首次自动下载模型约 40MB），
/// 模型不可用/下载失败/推理失败时自动回退到改进版色度键抠图。
#[tauri::command]
pub async fn cutout_image(
    app: tauri::AppHandle,
    data_b64: String,
    threshold: f32,
) -> Result<CutoutResult, String> {
    let app2 = app.clone();
    let data = data_b64.clone();
    let ai = tauri::async_runtime::spawn_blocking(move || {
        let model = crate::matte::ensure_model(&app2).ok()?;
        crate::matte::ai_cutout(&data, &model)
            .ok()
            .map(|b| (b, "ai".to_string()))
    })
    .await
    .map_err(|e| format!("AI 抠图线程异常: {e}"))?;
    if let Some((data_b64, method)) = ai {
        return Ok(CutoutResult { data_b64, method });
    }
    let data_b64 = crate::cutout::cutout(&data_b64, threshold)?;
    Ok(CutoutResult {
        data_b64,
        method: "chroma".to_string(),
    })
}

#[tauri::command]
pub fn has_transparency(data_b64: String) -> Result<bool, String> {
    crate::cutout::has_transparency(&data_b64)
}

#[tauri::command]
pub fn build_zip(
    source_dir: String,
    zip_path: String,
    exclude: Vec<String>,
) -> Result<serde_json::Value, String> {
    let src = std::path::PathBuf::from(&source_dir);
    if !src.is_dir() {
        return Err("源目录不存在".to_string());
    }
    if let Some(parent) = std::path::Path::new(&zip_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let file = std::fs::File::create(&zip_path).map_err(|e| format!("创建 zip 失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    fn is_excluded(path: &std::path::Path, exclude: &[String]) -> bool {
        path.components().any(|c| {
            if let std::path::Component::Normal(n) = c {
                let s = n.to_string_lossy();
                exclude.iter().any(|e| s == e.as_str() || s.ends_with(e.as_str()))
            } else {
                false
            }
        })
    }

    let mut file_count = 0u64;
    let mut total_size = 0u64;

    fn walk(
        dir: &std::path::Path,
        prefix: &str,
        writer: &mut zip::ZipWriter<std::io::BufWriter<std::fs::File>>,
        options: zip::write::SimpleFileOptions,
        exclude: &[String],
        file_count: &mut u64,
        total_size: &mut u64,
    ) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))? {
            let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
            let path = entry.path();
            if is_excluded(&path, exclude) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let zip_name = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if path.is_dir() {
                writer
                    .add_directory(zip_name.clone(), options)
                    .map_err(|e| format!("写入目录失败: {e}"))?;
                walk(&path, &zip_name, writer, options, exclude, file_count, total_size)?;
            } else {
                let data = std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))?;
                writer
                    .start_file(zip_name, options)
                    .map_err(|e| format!("写入文件失败: {e}"))?;
                writer
                    .write_all(&data)
                    .map_err(|e| format!("写入数据失败: {e}"))?;
                *file_count += 1;
                *total_size += data.len() as u64;
            }
        }
        Ok(())
    }

    walk(&src, "", &mut writer, options, &exclude, &mut file_count, &mut total_size)?;
    writer.finish().map_err(|e| format!("zip 收尾失败: {e}"))?;

    Ok(serde_json::json!({ "fileCount": file_count, "sizeBytes": total_size }))
}

#[cfg(test)]
mod zip_tests {
    use super::build_zip;
    use std::io::Write;

    #[test]
    fn zip_excludes_and_keeps_utf8_names() {
        let dir = std::env::temp_dir().join("novelforge_zip_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".novel2vn")).unwrap();
        std::fs::create_dir_all(dir.join("game")).unwrap();
        std::fs::write(dir.join("game/中文名.txt"), "hello").unwrap();
        std::fs::write(dir.join(".novel2vn/cache.json"), "secret").unwrap();
        std::fs::write(dir.join("index.html"), "<html/>").unwrap();

        let zip_path = dir.join("out.zip");
        let res = build_zip(
            dir.to_string_lossy().to_string(),
            zip_path.to_string_lossy().to_string(),
            vec![".novel2vn".to_string()],
        );
        assert!(res.is_ok(), "build_zip 失败: {:?}", res.err());

        let f = std::fs::File::open(&zip_path).unwrap();
        let mut reader = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..reader.len())
            .map(|i| reader.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n.contains("中文名")), "中文文件名丢失: {names:?}");
        assert!(names.iter().any(|n| n == "index.html"), "根文件丢失: {names:?}");
        assert!(!names.iter().any(|n| n.contains(".novel2vn")), "排除目录被打包: {names:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
