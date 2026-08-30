//! AI 抠图模型下载 / 状态 / 删除（Tauri 桌面端）。
//! 移植自「抠图」项目 scripts/model-downloader.mjs：
//! - 断点续传（.part 文件 + Range 头）
//! - 连接失败重试（指数退避，12 次封顶，可重试状态码 408/429/5xx）
//! - md5 完整性校验（失败重下，3 轮）
//! 模型文件保存在应用配置目录 models/ 下，经 model:// 自定义协议供前端 fetch。

use once_cell::sync::OnceCell;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

const CONNECT_TIMEOUT_MS: u64 = 30_000;
const MAX_CONNECT_ATTEMPTS: u32 = 12;
const RETRYABLE_STATUS: &[u16] = &[408, 429, 500, 502, 503, 504];

static MODELS_DIR: OnceCell<PathBuf> = OnceCell::new();

#[derive(Default)]
struct InstallState {
    model_id: Option<String>,
    filename: Option<String>,
    state: String,
    bytes: u64,
    total: u64,
    error: Option<String>,
}

static INSTALL: Mutex<InstallState> = Mutex::new(InstallState {
    model_id: None,
    filename: None,
    state: String::new(),
    bytes: 0,
    total: 0,
    error: None,
});

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub model_id: String,
    pub state: String,
    pub bytes: u64,
    pub total: u64,
    pub error: Option<String>,
    pub installed: bool,
}

/// 初始化模型目录（应用配置目录/models），首次启动 setup 时调用
pub fn init_models_dir<R: tauri::Runtime>(app: &impl Manager<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败: {e}"))?
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败: {e}"))?;
    let _ = MODELS_DIR.set(dir.clone());
    Ok(dir)
}

pub fn models_dir() -> Option<&'static PathBuf> {
    MODELS_DIR.get()
}

/// 只允许纯文件名（拒绝路径穿越）
fn safe_model_filename(filename: &str) -> Result<String, String> {
    let name = Path::new(filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("非法的模型文件名".to_string());
    }
    Ok(name)
}

fn model_file(dir: &Path, filename: &str) -> PathBuf {
    dir.join(filename)
}

fn model_part_file(dir: &Path, filename: &str) -> PathBuf {
    dir.join(format!("{filename}.part"))
}

fn installed(dir: &Path, filename: &str) -> bool {
    model_file(dir, filename).exists()
}

fn set_install_state(model_id: &str, filename: &str, state: &str, error: Option<String>) {
    let mut guard = INSTALL.lock().unwrap();
    guard.model_id = Some(model_id.to_string());
    guard.filename = Some(filename.to_string());
    guard.state = state.to_string();
    guard.error = error;
}

fn status_for(model_id: &str, filename: &str) -> ModelStatus {
    let dir = models_dir().cloned().unwrap_or_default();
    let guard = INSTALL.lock().unwrap();
    let active = guard.model_id.as_deref() == Some(model_id);
    ModelStatus {
        model_id: model_id.to_string(),
        state: if active { guard.state.clone() } else { "idle".to_string() },
        bytes: if active { guard.bytes } else { 0 },
        total: if active { guard.total } else { 0 },
        error: if active { guard.error.clone() } else { None },
        installed: installed(&dir, filename),
    }
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

/// 连接并跟随重定向；可重试状态码 / 连接失败自动重试（指数退避）
async fn connect_with_retry(url: &str, headers: Vec<(String, String)>) -> Result<reqwest::Response, String> {
    let mut last_error: Option<String> = None;
    for attempt in 1..=MAX_CONNECT_ATTEMPTS {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_millis(CONNECT_TIMEOUT_MS))
            .build()
            .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
        let mut req = client.get(url);
        for (name, value) in &headers {
            req = req.header(name, value);
        }
        match req.send().await {
            Ok(response) => {
                if RETRYABLE_STATUS.contains(&response.status().as_u16()) {
                    last_error = Some(format!("HTTP {}", response.status().as_u16()));
                    eprintln!("[model-download] 收到可重试状态 HTTP {}，第 {attempt}/{MAX_CONNECT_ATTEMPTS} 次", response.status().as_u16());
                } else {
                    return Ok(response);
                }
            }
            Err(error) => {
                last_error = Some(error.to_string());
                eprintln!("[model-download] 第 {attempt}/{MAX_CONNECT_ATTEMPTS} 次连接失败：{error}");
            }
        }
        if attempt < MAX_CONNECT_ATTEMPTS {
            sleep_ms(1000 * u64::from(attempt.min(8)));
        }
    }
    Err(last_error.unwrap_or_else(|| "无法连接下载源".to_string()))
}

/// 下载一个文件到 part（断点续传；连接中断自动续传）
async fn download_to_part(dir: &Path, filename: &str, url: &str) -> Result<(), String> {
    let part = model_part_file(dir, filename);
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let offset = if part.exists() { fs::metadata(&part).map(|m| m.len()).unwrap_or(0) } else { 0 };
        if offset > 0 && attempt == 1 {
            println!("[model-download] 检测到未完成下载 {} MB，将断点续传…", offset / 1048576);
        }
        let headers = if offset > 0 { vec![("Range".to_string(), format!("bytes={offset}-"))] } else { Vec::new() };
        let response = connect_with_retry(url, headers).await?;
        let status = response.status().as_u16();
        if status == 200 {
            if offset > 0 {
                println!("[model-download] 下载源不支持断点续传，将从头重新下载…");
                let _ = fs::remove_file(&part);
            }
        } else if status != 206 {
            return Err(format!("下载失败：HTTP {status}"));
        }
        let total = offset + response.content_length().unwrap_or(0);
        let mut file = OpenOptions::new().create(true).append(true).open(&part)
            .map_err(|e| format!("打开下载文件失败: {e}"))?;
        let mut stream = response.bytes_stream();
        use futures_util::StreamExt;
        let mut downloaded = offset;
        let mut failed = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    file.write_all(&bytes).map_err(|e| format!("写入下载文件失败: {e}"))?;
                    downloaded += bytes.len() as u64;
                    let mut guard = INSTALL.lock().unwrap();
                    guard.bytes = downloaded;
                    guard.total = total;
                }
                Err(error) => {
                    failed = true;
                    eprintln!("[model-download] 读取中断：{error}");
                    break;
                }
            }
        }
        let _ = file.flush();
        if !failed {
            println!("[model-download] 第 {attempt} 轮完成，累计 {} MB", downloaded / 1048576);
            return Ok(());
        }
        eprintln!("[model-download] 连接中断（第 {attempt} 次），{} 秒后续传…", attempt.min(8));
        sleep_ms(1000 * u64::from(attempt.min(8)));
    }
}

/// RFC 1321 MD5（内联实现，避免额外依赖；下载完整性校验用）
fn md5_hex(data: &[u8]) -> String {
    const SHIFTS: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let mut k = [0u32; 64];
    for (i, item) in k.iter_mut().enumerate() {
        *item = ((1u64 << 32) as f64 * ((i as f64) + 1.0).sin().abs()) as u32;
    }
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let mut a0: u32 = 0x6745_2301;
    let mut b0: u32 = 0xefcd_ab89;
    let mut c0: u32 = 0x98ba_dcfe;
    let mut d0: u32 = 0x1032_5476;

    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, word) in m.iter_mut().enumerate() {
            *word = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | ((!b) & d), i),
                1 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(k[i])
                    .wrapping_add(m[g])
                    .rotate_left(SHIFTS[i]),
            );
            a = tmp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = String::with_capacity(32);
    for word in [a0, b0, c0, d0] {
        // RFC 1321：输出按每个字的低字节在前（little-endian 字节序）
        out.push_str(&format!(
            "{:02x}{:02x}{:02x}{:02x}",
            word & 0xff,
            (word >> 8) & 0xff,
            (word >> 16) & 0xff,
            (word >> 24) & 0xff
        ));
    }
    out
}

fn file_md5(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取模型文件失败: {e}"))?;
    Ok(md5_hex(&bytes))
}

async fn download_model(dir: &Path, filename: &str, url: &str, md5: &str) -> Result<(), String> {
    let destination = model_file(dir, filename);
    let part = model_part_file(dir, filename);
    for round in 1..=3u32 {
        download_to_part(dir, filename, url).await?;
        println!("[model-download] 第 {round} 轮下载完成，正在校验完整性…");
        let digest = file_md5(&part)?;
        if md5.is_empty() || digest == md5 {
            fs::rename(&part, &destination).map_err(|e| format!("模型文件落位失败: {e}"))?;
            println!("[model-download] {}，模型已就位", if md5.is_empty() { "完整性校验跳过（md5 未设置）" } else { "md5 校验通过" });
            return Ok(());
        }
        eprintln!("[model-download] 第 {round} 轮下载校验失败（md5={digest}，期望 {md5}），将重新下载。");
        let _ = fs::remove_file(&part);
    }
    Err("多次下载均未通过 md5 校验，请检查网络或设置镜像下载源".to_string())
}

#[tauri::command]
pub async fn model_download_start(
    app: tauri::AppHandle,
    model_id: String,
    filename: String,
    url: String,
    md5: String,
) -> Result<ModelStatus, String> {
    let dir = init_models_dir(&app)?;
    let safe = safe_model_filename(&filename)?;
    if installed(&dir, &safe) {
        set_install_state(&model_id, &safe, "done", None);
        return Ok(status_for(&model_id, &safe));
    }
    {
        let guard = INSTALL.lock().unwrap();
        if guard.state == "downloading" && guard.model_id.as_deref() == Some(model_id.as_str()) {
            return Ok(status_for(&model_id, &safe));
        }
    }
    set_install_state(&model_id, &safe, "downloading", None);
    let spawn_dir = dir.clone();
    let spawn_safe = safe.clone();
    let spawn_url = url.clone();
    let spawn_md5 = md5.clone();
    let spawn_model_id = model_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = download_model(&spawn_dir, &spawn_safe, &spawn_url, &spawn_md5).await;
        let mut guard = INSTALL.lock().unwrap();
        match result {
            Ok(()) => {
                guard.state = "done".to_string();
                guard.error = None;
                println!("[model-download] 模型 {spawn_model_id} 安装完成");
            }
            Err(error) => {
                guard.state = "error".to_string();
                guard.error = Some(error.clone());
                eprintln!("[model-download] 模型 {spawn_model_id} 安装失败：{error}");
            }
        }
    });
    Ok(status_for(&model_id, &safe))
}

#[tauri::command]
pub async fn model_download_status(model_id: String, filename: String) -> Result<ModelStatus, String> {
    let safe = safe_model_filename(&filename)?;
    Ok(status_for(&model_id, &safe))
}

#[tauri::command]
pub async fn model_remove(model_id: String, filename: String) -> Result<(), String> {
    let safe = safe_model_filename(&filename)?;
    if let Some(dir) = models_dir() {
        let _ = fs::remove_file(model_file(dir, &safe));
        let _ = fs::remove_file(model_part_file(dir, &safe));
    }
    let mut guard = INSTALL.lock().unwrap();
    if guard.model_id.as_deref() == Some(model_id.as_str()) {
        guard.model_id = None;
        guard.filename = None;
        guard.state = String::new();
        guard.bytes = 0;
        guard.total = 0;
        guard.error = None;
    }
    Ok(())
}

/// 供 model:// 自定义协议读取模型文件（返回文件字节；失败返回 None）
pub fn read_model_file(filename: &str) -> Option<Vec<u8>> {
    let dir = models_dir()?;
    let safe = safe_model_filename(filename).ok()?;
    let path = model_file(dir, &safe);
    if !path.is_file() {
        return None;
    }
    fs::read(path).ok()
}

#[cfg(test)]
mod tests {
    use super::md5_hex;

    #[test]
    fn md5_known_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            md5_hex(b"The quick brown fox jumps over the lazy dog"),
            "9e107d9d372bb6826bd81d3542a419d6"
        );
        // 跨多个 512-bit 分块
        let multi_block = "1234567890".repeat(8);
        assert_eq!(
            md5_hex(multi_block.as_bytes()),
            "57edf4a22be3c955ac49da2e2107b67a"
        );
    }
}
