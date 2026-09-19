//! AI 抠图模型下载 / 状态 / 删除（Tauri 桌面端）。
//! 移植自「抠图」项目 scripts/model-downloader.mjs：
//! - 断点续传（.part 文件 + Range 头）
//! - 连接失败重试（指数退避，12 次封顶，可重试状态码 408/429/5xx）
//! - md5 完整性校验（失败重下，3 轮）
//! 模型文件保存在程序目录（resource_dir）models/ 下，经 model:// 自定义协议供前端 fetch。

use once_cell::sync::OnceCell;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const CONNECT_TIMEOUT_MS: u64 = 30_000;
const MAX_CONNECT_ATTEMPTS: u32 = 12;
const RETRYABLE_STATUS: &[u16] = &[408, 429, 500, 502, 503, 504];
/// 外层「断流后续传」的最大轮数：无上限重试会无限占用网络并让 stop/删除永远等不到结果
const MAX_RESUME_ATTEMPTS: u32 = 20;
/// 单个文件下载的总时长上限（含所有续传轮次）
const MAX_DOWNLOAD_DURATION: Duration = Duration::from_secs(30 * 60);

static MODELS_DIR: OnceCell<PathBuf> = OnceCell::new();

#[derive(Default)]
struct InstallState {
    model_id: Option<String>,
    filename: Option<String>,
    state: String,
    bytes: u64,
    total: u64,
    error: Option<String>,
    /// 当前下载任务的取消标志：model_remove / 开始另一个模型下载时置位，
    /// 下载循环检查到后立即返回，避免删除后仍继续写盘
    cancel: Option<Arc<AtomicBool>>,
}

static INSTALL: Mutex<InstallState> = Mutex::new(InstallState {
    model_id: None,
    filename: None,
    state: String::new(),
    bytes: 0,
    total: 0,
    error: None,
    cancel: None,
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

/// 初始化模型目录（程序目录/models），首次启动 setup 时调用
pub fn init_models_dir<R: tauri::Runtime>(app: &impl Manager<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("获取程序目录失败: {e}"))?
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败: {e}"))?;
    migrate_old_models_dir(app, &dir);
    let _ = MODELS_DIR.set(dir.clone());
    Ok(dir)
}

/// 历史版本把模型放在应用配置目录（%APPDATA%）models/。新目录为空时把旧文件搬过去，
/// 避免老用户已安装的模型失效（跨盘移动失败则退化为复制后删除）。
fn migrate_old_models_dir<R: tauri::Runtime>(app: &impl Manager<R>, new_dir: &Path) {
    let empty = fs::read_dir(new_dir)
        .map(|mut it| it.next().is_none())
        .unwrap_or(true);
    if !empty {
        return;
    }
    let Ok(old_dir) = app.path().app_config_dir().map(|d| d.join("models")) else {
        return;
    };
    if !old_dir.is_dir() {
        return;
    }
    let entries: Vec<_> = match fs::read_dir(&old_dir) {
        Ok(it) => it.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
        Err(_) => return,
    };
    if entries.is_empty() {
        return;
    }
    let mut copied = Vec::new();
    for entry in &entries {
        let Some(name) = entry.file_name() else { continue };
        if fs::copy(entry, new_dir.join(&name)).is_ok() {
            copied.push(entry.clone());
        }
    }
    if copied.len() == entries.len() {
        let _ = fs::remove_dir_all(&old_dir);
        println!("[novelforge] 已把旧模型目录迁移到: {}", new_dir.display());
    } else {
        eprintln!("[novelforge] 警告: 旧模型迁移不完整，请手动处理 {}", old_dir.display());
    }
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
    let mut guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
    guard.model_id = Some(model_id.to_string());
    guard.filename = Some(filename.to_string());
    guard.state = state.to_string();
    guard.error = error;
}

fn status_for(model_id: &str, filename: &str) -> ModelStatus {
    let dir = models_dir().cloned().unwrap_or_default();
    let guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
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

/// 下载一个文件到 part（断点续传；连接中断自动续传，但轮数与总时长有上限且可取消）
async fn download_to_part(
    dir: &Path,
    filename: &str,
    url: &str,
    model_id: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let part = model_part_file(dir, filename);
    let started = Instant::now();
    let mut attempt: u32 = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("下载已取消".to_string());
        }
        attempt += 1;
        if attempt > MAX_RESUME_ATTEMPTS {
            return Err(format!(
                "下载多次中断（{MAX_RESUME_ATTEMPTS} 次）仍未完成，请检查网络后重试"
            ));
        }
        if started.elapsed() > MAX_DOWNLOAD_DURATION {
            return Err("下载超时（超过 30 分钟），请检查网络后重试".to_string());
        }
        let mut offset = if part.exists() { fs::metadata(&part).map(|m| m.len()).unwrap_or(0) } else { 0 };
        if offset > 0 && attempt == 1 {
            println!("[model-download] 检测到未完成下载 {} MB，将断点续传…", offset / 1048576);
        }
        let headers = if offset > 0 { vec![("Range".to_string(), format!("bytes={offset}-"))] } else { Vec::new() };
        let response = connect_with_retry(url, headers).await?;
        if cancel.load(Ordering::Relaxed) {
            return Err("下载已取消".to_string());
        }
        let status = response.status().as_u16();
        if status == 200 {
            if offset > 0 {
                println!("[model-download] 下载源不支持断点续传，将从头重新下载…");
                let _ = fs::remove_file(&part);
            }
            // B121：200 表示返回完整文件，offset 必须清零，否则 total/downloaded 会把旧偏移
            // 算进去（进度虚高），且 append 写入会在旧数据后叠加造成文件损坏
            offset = 0;
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
            if cancel.load(Ordering::Relaxed) {
                return Err("下载已取消".to_string());
            }
            match chunk {
                Ok(bytes) => {
                    file.write_all(&bytes).map_err(|e| format!("写入下载文件失败: {e}"))?;
                    downloaded += bytes.len() as u64;
                    // 仅当全局状态槽仍属于本模型时才回写进度：并发的另一个模型下载接管状态后，
                    // 旧任务的进度会污染新模型的 UI（B116 跨模型污染）
                    let mut guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
                    if guard.model_id.as_deref() == Some(model_id) {
                        guard.bytes = downloaded;
                        guard.total = total;
                    }
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

/// RFC 1321 MD5 增量实现（内联，避免额外依赖；下载完整性校验用）。
/// B123：模型文件可达数百 MB，不能再一次性读入内存，必须以 update 分块喂入。
struct Md5 {
    state: [u32; 4],
    k: [u32; 64],
    buffer: [u8; 64],
    buffered: usize,
    length: u64,
}

impl Md5 {
    fn new() -> Self {
        let mut k = [0u32; 64];
        for (i, item) in k.iter_mut().enumerate() {
            *item = ((1u64 << 32) as f64 * ((i as f64) + 1.0).sin().abs()) as u32;
        }
        Md5 {
            state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
            k,
            buffer: [0u8; 64],
            buffered: 0,
            length: 0,
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        self.length = self.length.wrapping_add(data.len() as u64);
        if self.buffered > 0 {
            let take = (64 - self.buffered).min(data.len());
            self.buffer[self.buffered..self.buffered + take].copy_from_slice(&data[..take]);
            self.buffered += take;
            data = &data[take..];
            if self.buffered == 64 {
                let block = self.buffer;
                self.process(&block);
                self.buffered = 0;
            }
        }
        while data.len() >= 64 {
            let (block, rest) = data.split_at(64);
            self.process(block);
            data = rest;
        }
        if !data.is_empty() {
            self.buffer[..data.len()].copy_from_slice(data);
            self.buffered = data.len();
        }
    }

    fn process(&mut self, chunk: &[u8]) {
        const SHIFTS: [u32; 64] = [
            7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
            5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
            4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
            6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
        ];
        let mut m = [0u32; 16];
        for (i, word) in m.iter_mut().enumerate() {
            *word = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) = (self.state[0], self.state[1], self.state[2], self.state[3]);
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
                    .wrapping_add(self.k[i])
                    .wrapping_add(m[g])
                    .rotate_left(SHIFTS[i]),
            );
            a = tmp;
        }
        self.state[0] = self.state[0].wrapping_add(a);
        self.state[1] = self.state[1].wrapping_add(b);
        self.state[2] = self.state[2].wrapping_add(c);
        self.state[3] = self.state[3].wrapping_add(d);
    }

    fn finalize_hex(mut self) -> String {
        let bit_len = self.length.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buffered != 56 {
            self.update(&[0]);
        }
        self.update(&bit_len.to_le_bytes());
        let mut out = String::with_capacity(32);
        for word in self.state {
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
}

/// 一次性便捷封装（仅测试用；生产路径走 file_md5 流式分块）
#[cfg(test)]
fn md5_hex(data: &[u8]) -> String {
    let mut hasher = Md5::new();
    hasher.update(data);
    hasher.finalize_hex()
}

/// B123：流式计算文件 MD5，按 64KB 分块读取，峰值内存与文件大小无关
fn file_md5(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读取模型文件失败: {e}"))?;
    let mut hasher = Md5::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取模型文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize_hex())
}

async fn download_model(
    dir: &Path,
    filename: &str,
    url: &str,
    md5: &str,
    model_id: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let destination = model_file(dir, filename);
    let part = model_part_file(dir, filename);
    for round in 1..=3u32 {
        download_to_part(dir, filename, url, model_id, cancel).await?;
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
    // 「检查是否已在下载 + 标记下载中」必须放在同一持锁临界区：
    // 否则两个并发调用都能通过检查，对同一模型启动两次下载（双倍流量/互相覆盖 .part）
    let cancel = Arc::new(AtomicBool::new(false));
    let same_download_active = {
        let mut guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
        if guard.state == "downloading" && guard.model_id.as_deref() == Some(model_id.as_str()) {
            true
        } else {
            // 下载槽被新模型接管前，取消仍在进行的旧下载，避免其继续占带宽/写进度
            if let Some(old) = guard.cancel.take() {
                old.store(true, Ordering::Relaxed);
            }
            guard.model_id = Some(model_id.clone());
            guard.filename = Some(safe.clone());
            guard.state = "downloading".to_string();
            guard.bytes = 0;
            guard.total = 0;
            guard.error = None;
            guard.cancel = Some(cancel.clone());
            false
        }
    };
    if same_download_active {
        return Ok(status_for(&model_id, &safe));
    }
    let spawn_dir = dir.clone();
    let spawn_safe = safe.clone();
    let spawn_url = url.clone();
    let spawn_md5 = md5.clone();
    let spawn_model_id = model_id.clone();
    let spawn_cancel = cancel.clone();
    tauri::async_runtime::spawn(async move {
        let result = download_model(
            &spawn_dir,
            &spawn_safe,
            &spawn_url,
            &spawn_md5,
            &spawn_model_id,
            &spawn_cancel,
        )
        .await;
        let mut guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
        // 仅当状态槽仍属于本次下载时才回写结果：期间可能已开始另一个模型的下载，
        // 旧任务的结果会覆盖新模型的 state/error（B116 跨模型污染）
        if guard.model_id.as_deref() != Some(spawn_model_id.as_str()) {
            return;
        }
        guard.cancel = None;
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
    let wait_model_id = model_id.clone();
    // 等待取消 + 删除文件是阻塞操作，放阻塞线程池，不占用 async 运行时
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if let Some(dir) = models_dir() {
            // 先尝试取消正在进行的下载：否则删除 .part 后下载线程会继续 append 写回（B124）。
            // 仅当下载槽属于当前要删除的模型时才取消，避免误杀另一个模型的下载
            {
                let guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
                if guard.model_id.as_deref() == Some(wait_model_id.as_str()) {
                    if let Some(flag) = guard.cancel.as_ref() {
                        flag.store(true, Ordering::Relaxed);
                    }
                }
            }
            // 给下载线程最多 3 秒退出（每个 chunk 都会检查取消标志）；超时则放弃等待直接删，
            // 由文件占用错误如实反馈（Windows 删被占用文件会失败）
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let downloading = {
                    let guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
                    guard.state == "downloading"
                        && guard.model_id.as_deref() == Some(wait_model_id.as_str())
                };
                if !downloading || Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // B124：删除失败必须返回错误，静默忽略会让用户以为模型已删除但实际仍在
            let model = model_file(dir, &safe);
            if model.exists() {
                fs::remove_file(&model).map_err(|e| format!("删除模型文件失败: {e}"))?;
            }
            let part = model_part_file(dir, &safe);
            if part.exists() {
                fs::remove_file(&part).map_err(|e| format!("删除未完成下载文件失败: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("删除任务执行失败: {e}"))??;

    let mut guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
    if guard.model_id.as_deref() == Some(model_id.as_str()) {
        guard.model_id = None;
        guard.filename = None;
        guard.state = String::new();
        guard.bytes = 0;
        guard.total = 0;
        guard.error = None;
        guard.cancel = None;
    }
    Ok(())
}

/// 供 model:// 自定义协议读取模型文件（返回文件字节；失败返回 None）。
/// B123：自定义协议要求一次性返回完整 body，无法流式；模型文件通常几十 MB，
/// 这里维持全量读入（协议层无 Range 支持）。若将来引入超大模型，需改用分块协议。
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
    use super::{md5_hex, Md5};

    #[test]
    fn md5_streaming_matches_one_shot() {
        // B123：分块 update（非 64 字节对齐）必须与一次性计算得到相同摘要
        let data = "The quick brown fox jumps over the lazy dog".repeat(10);
        let expected = md5_hex(data.as_bytes());
        let mut hasher = Md5::new();
        for chunk in data.as_bytes().chunks(7) {
            hasher.update(chunk);
        }
        assert_eq!(hasher.finalize_hex(), expected);
    }

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
