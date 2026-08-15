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
/// 原子写文件：写同目录临时文件后 rename 覆盖目标。
/// 中断/崩溃时目标文件要么是旧完整内容、要么是新的完整内容，不会留下半截损坏数据
/// （assets.json / project_state.json / visual-bible.json 等被半截写入会导致下次解析失败）。
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = path.with_extension(format!("{}.tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("bin")));
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换文件失败: {e}")
    })
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    atomic_write(&PathBuf::from(&path), content.as_bytes())
}

#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
    Ok(B64.encode(&data))
}

#[tauri::command]
pub fn write_file_base64(path: String, data_b64: String) -> Result<(), String> {
    let bytes = B64.decode(&data_b64).map_err(|e| format!("base64 解码失败: {e}"))?;
    atomic_write(&PathBuf::from(&path), &bytes)
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
    /// 抠图方式：chroma（色度键）/ skip-dark（深色背景，保留原图）/ skip-overcut（疑似过激，保留原图）
    pub method: String,
}

/// 色度键输出中被置为全透明的像素占比达到该值，判定为“背景识别过激”。
/// 仅对非绿幕背景生效：绿幕背景 removed 偏高是“抠干净”的正常结果（背景占比常达 60-75%）。
/// 典型过激场景：AI 画了纯黑/纯深色背景，黑色前景到背景色距离≈0 被误抠，removed 异常偏高。
/// 命中时保留原图，避免把主体黑色部分切掉。
const CUTOUT_OVERCUT_THRESHOLD: f32 = 0.6;

/// 抠图：纯算法色度键（零依赖、零下载，纯色/绿幕背景即可干净抠出）。
/// 深色背景与疑似过激的结果一律保留原图——宁可有背景也不破坏主体，不下载任何分割模型。
#[tauri::command]
pub async fn cutout_image(
    data_b64: String,
    threshold: f32,
) -> Result<CutoutResult, String> {
    // 纯代码色度键：立绘/物品背景多为纯色（提示词强制 solid background），色度键即可干净抠出
    let chroma = crate::cutout::cutout_with_stats(&data_b64, threshold);
    match &chroma {
        Ok((_, removed, bg_is_green, dark_bg, _sweep_count)) => {
            // 绿幕背景：removed 高是成功（背景被干净抠掉）
            if *bg_is_green {
                return Ok(CutoutResult {
                    data_b64: chroma.as_ref().unwrap().0.clone(),
                    method: "chroma".to_string(),
                });
            }
            // 深色背景（黑/墨蓝等）：色度键原理上无法区分黑发/黑衣服/深色物品与深色背景，
            // 硬抠会把主体抠成半透明灰。保留原图，交回前端提示。
            if *dark_bg {
                eprintln!("[novelforge] 背景为深色，色度键无法区分主体，保留原图");
                return Ok(CutoutResult {
                    data_b64: data_b64.clone(),
                    method: "skip-dark".to_string(),
                });
            }
            if *removed < CUTOUT_OVERCUT_THRESHOLD {
                return Ok(CutoutResult {
                    data_b64: chroma.as_ref().unwrap().0.clone(),
                    method: "chroma".to_string(),
                });
            }
            // 非绿底疑似过激（黑色前景被误判为背景）：保留原图
            eprintln!(
                "[novelforge] 色度键疑似过激（非绿底 removed={:.1}%），保留原图",
                removed * 100.0
            );
            Ok(CutoutResult {
                data_b64: data_b64.clone(),
                method: "skip-overcut".to_string(),
            })
        }
        Err(msg) => Err(format!("色度键: {msg}")),
    }
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
mod atomic_write_tests {
    use super::atomic_write;
    use std::io::Write;

    #[test]
    fn atomic_write_overwrites_and_no_tmp_left() {
        let dir = std::env::temp_dir().join("novelforge_atomic_write_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("assets.json");

        atomic_write(&f, b"{\"v\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"v\":1}");

        // 覆盖已存在文件（Windows rename 语义）→ 应成功且内容更新
        atomic_write(&f, b"{\"v\":2,\"more\":\"data\"}").unwrap();
        assert_eq!(
            std::fs::read_to_string(&f).unwrap(),
            "{\"v\":2,\"more\":\"data\"}"
        );

        // 不应残留临时文件
        let leftovers = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".tmp")).count();
        assert_eq!(leftovers, 0, "原子写残留临时文件");

        let _ = std::fs::remove_dir_all(&dir);
    }
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
