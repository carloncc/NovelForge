//! AI 抠图模型下载 / 状态 / 删除（Tauri 桌面端）。
//! 移植自「抠图」项目 scripts/model-downloader.mjs：
//! - 断点续传（.part 文件 + Range 头）
//! - 连接失败重试（指数退避，12 次封顶，可重试状态码 408/429/5xx）
//! - md5 完整性校验（失败重下，3 轮）
//! 模型文件保存在**用户可写目录**（app_data_dir/models，回退 app_config_dir）下，
//! 经 model:// 自定义协议供前端 fetch；resource_dir/models 只作为旧版本迁移来源与只读查找路径。
//! #1130：AppImage/deb/macOS .app 等安装形态下 resource_dir 只读，模型目录必须落在可写位置，
//! 否则下载必然以「Permission denied」失败；不可写时通过 ModelStatus.writable 明确告知前端。

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

/// #1128：下载来源白名单——前端只应传 rembg 官方 release，重定向目标（GitHub CDN）同样在列，
/// 避免 webview 内任意脚本把该命令当 SSRF/任意落盘通道用
const ALLOWED_DOWNLOAD_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
/// github.com 上只放行 rembg release 的下载路径（其余路径一律拒绝）
const REMBG_RELEASE_PATH_PREFIX: &str = "/danielgatis/rembg/releases/download/";
/// 表外文件（未来新增模型）的统一大小上限：与前端 sizeMB 上限对齐（300MB）+10% 余量
const MAX_UNKNOWN_MODEL_BYTES: u64 = 330 * 1024 * 1024;
/// 可信模型的最小体积：小于此值必然不是模型（截断/占位文件）
const MIN_MODEL_BYTES: u64 = 1024 * 1024;

/// 内置模型登记表：文件名 → (期望大小 MB, 官方 md5)。
/// 与前端 src/core/cutout/models.ts 保持一致；新增模型时两边都要改（#1128c：md5 不再由调用方说了算）。
const KNOWN_MODELS: &[(&str, u64, &str)] = &[
    ("isnet-anime.onnx", 168, "6f184e756bb3bd901c8849220a83e38e"),
    ("isnet-general-use.onnx", 170, "fc16ebd8b0c10d971d3513d564d01e29"),
    ("BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx", 214, "4fab47adc4ff364be1713e97b7e66334"),
    ("u2netp.onnx", 5, "8e83ca70e441ab06c318d82300c84806"),
];

static MODELS_DIR: OnceCell<PathBuf> = OnceCell::new();
/// 只读内置模型目录（resource_dir/models）：旧版本模型所在地，仅用于迁移与查找兜底
static BUNDLED_MODELS_DIR: OnceCell<Option<PathBuf>> = OnceCell::new();
/// 当前模型目录是否可写：false 时下载必然失败，前端据此给出「改用便携版/手动放置」提示
static MODELS_DIR_WRITABLE: AtomicBool = AtomicBool::new(false);

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
    /// 安装判定依据（#1129）：missing / ok / corrupt，corrupt 时 installed=false 且带 integrityReason
    pub integrity: String,
    pub integrity_reason: Option<String>,
    /// 当前实际使用的模型目录（#1130：不再是 resource_dir，UI 直接显示这个值）
    pub dir: Option<String>,
    /// 目录是否可写：false 表示下载必然失败，需提示用户改用便携版/手动放置
    pub writable: bool,
}

/// 模型文件完整性判定结果
#[derive(Clone, Copy, PartialEq, Debug)]
enum Integrity {
    Ok,
    Missing,
    Corrupt,
}

impl Integrity {
    fn as_str(self) -> &'static str {
        match self {
            Integrity::Ok => "ok",
            Integrity::Missing => "missing",
            Integrity::Corrupt => "corrupt",
        }
    }
}

struct IntegrityReport {
    kind: Integrity,
    reason: Option<String>,
}

fn corrupt(reason: impl Into<String>) -> IntegrityReport {
    IntegrityReport { kind: Integrity::Corrupt, reason: Some(reason.into()) }
}

/// 初始化模型目录（用户可写位置），首次启动 setup 时调用；后续调用直接复用已选定的目录。
pub fn init_models_dir<R: tauri::Runtime>(app: &impl Manager<R>) -> Result<PathBuf, String> {
    if let Some(dir) = MODELS_DIR.get() {
        return Ok(dir.clone());
    }
    // 内置（只读）目录：旧版本模型放在这里，仅作为迁移来源与查找兜底
    let bundled = app.path().resource_dir().ok().map(|d| d.join("models"));
    let _ = BUNDLED_MODELS_DIR.set(bundled.clone());

    // #1130：优先用户可写目录。app_data_dir（Linux ~/.local/share、Windows %APPDATA%）→
    // app_config_dir（同为用户目录）→ resource_dir（只读兜底，UI 会提示不可写）。
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        candidates.push(dir.join("models"));
    }
    if let Ok(dir) = app.path().app_config_dir() {
        let config_models = dir.join("models");
        if !candidates.contains(&config_models) {
            candidates.push(config_models);
        }
    }
    if let Some(dir) = bundled.clone() {
        if !candidates.contains(&dir) {
            candidates.push(dir);
        }
    }

    let mut failures: Vec<String> = Vec::new();
    let last = candidates.len().saturating_sub(1);
    for (index, candidate) in candidates.iter().enumerate() {
        let is_last = index == last;
        match inspect_models_dir(candidate) {
            Ok(true) => return Ok(select_models_dir(candidate.clone(), true, &candidates)),
            Ok(false) if is_last => {
                // 全部候选都不可写：退回只读目录，至少状态查询与「手动放置模型」仍可用
                return Ok(select_models_dir(candidate.clone(), false, &candidates));
            }
            Ok(false) => failures.push(format!("{}：不可写", candidate.display())),
            Err(message) => failures.push(format!("{}：{message}", candidate.display())),
        }
    }
    Err(format!("无法准备模型目录（{}）", failures.join("；")))
}

fn select_models_dir(dir: PathBuf, writable: bool, sources: &[PathBuf]) -> PathBuf {
    migrate_legacy_models(&dir, sources, writable);
    MODELS_DIR_WRITABLE.store(writable, Ordering::Relaxed);
    let _ = MODELS_DIR.set(dir.clone());
    if !writable {
        eprintln!(
            "[novelforge] 警告: 模型目录不可写（{}）：AI 抠图模型将无法下载，请改用便携版/绿色版，或手动下载模型放入该目录",
            dir.display()
        );
    }
    MODELS_DIR.get().cloned().unwrap_or(dir)
}

/// 创建目录并真的写一次探测文件确认可写（resource_dir 下 create_dir_all 可能"成功"但写入必失败）。
/// 返回 Ok(true)=可写，Ok(false)=目录存在但不可写，Err=目录无法创建。
fn inspect_models_dir(dir: &Path) -> Result<bool, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    if !dir.is_dir() {
        return Err("路径不是目录".to_string());
    }
    let probe = dir.join(".novelforge-write-test");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

/// 历史版本把模型放在 resource_dir/models 或应用配置目录 models/：
/// 新目录里缺哪个文件就从旧目录补哪个（跨盘失败退化为复制失败，只告警不阻断）。
fn migrate_legacy_models(target: &Path, sources: &[PathBuf], writable: bool) {
    if !writable {
        return;
    }
    for source in sources {
        if source == target || !source.is_dir() {
            continue;
        }
        let entries: Vec<_> = match fs::read_dir(source) {
            Ok(it) => it.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
            Err(_) => continue,
        };
        for entry in entries {
            let Some(name) = entry.file_name() else { continue };
            let Some(name_str) = name.to_str() else { continue };
            // 只迁移合法模型文件名（跳过 .part / 探测文件等）
            if safe_model_filename(name_str).is_err() {
                continue;
            }
            let destination = target.join(&name);
            if destination.exists() {
                continue;
            }
            if fs::copy(&entry, &destination).is_ok() {
                println!("[novelforge] 已把旧模型 {} 迁移到 {}", entry.display(), destination.display());
                // 迁移成功后清掉旧副本，避免同一模型占两份磁盘（只读目录删除失败则保留）
                let _ = fs::remove_file(&entry);
            } else {
                eprintln!("[novelforge] 警告: 旧模型迁移失败，已保留原文件 {}", entry.display());
            }
        }
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
    model_integrity(dir, filename).kind == Integrity::Ok
}

/// #1129：不再「文件存在即已安装」——损坏/截断/被替换/占位文件会被判 corrupt，
/// 避免 UI 显示「已安装」而运行期 onnxruntime 加载失败后降级色度键、错误难定位。
/// 只做便宜的大小 + 文件头校验（md5 校验在下载落位时已完成；状态查询里算 md5 代价过高）。
fn model_integrity(dir: &Path, filename: &str) -> IntegrityReport {
    let path = model_file(dir, filename);
    let Ok(metadata) = fs::metadata(&path) else {
        return IntegrityReport { kind: Integrity::Missing, reason: None };
    };
    if !metadata.is_file() {
        return corrupt("模型路径不是文件");
    }
    let size = metadata.len();
    if size < MIN_MODEL_BYTES {
        return corrupt(format!("文件过小（{} KB），疑似截断或占位文件", size / 1024));
    }
    if let Some((size_mb, _)) = known_model(filename) {
        let expected = size_mb.saturating_mul(1024 * 1024);
        // 允许 10% 误差（前端 sizeMB 为约数）；明显偏小即判不完整
        if size.saturating_mul(10) < expected.saturating_mul(9) {
            return corrupt(format!(
                "文件不完整（{:.0} MB，期望约 {} MB）",
                size as f64 / 1048576.0,
                size_mb
            ));
        }
    }
    let mut head = [0u8; 16];
    match read_file_head(&path, &mut head) {
        Ok(filled) => {
            let bytes = &head[..filled];
            if bytes.is_empty() || bytes.iter().all(|b| *b == 0) {
                return corrupt("文件头全零，疑似损坏或占位文件");
            }
            if looks_like_text(bytes) {
                return corrupt("文件内容像文本/网页而不是模型（可能是错误页被当成模型保存）");
            }
            // ONNX 是 protobuf 序列化的 ModelProto：首字段 ir_version（varint，tag = 0x08）
            if filename.ends_with(".onnx") && bytes[0] != 0x08 {
                return corrupt(format!(
                    "文件头不是有效的 ONNX 模型（首字节 0x{:02x}）",
                    bytes[0]
                ));
            }
        }
        Err(error) => return corrupt(format!("读取文件头失败: {error}")),
    }
    IntegrityReport { kind: Integrity::Ok, reason: None }
}

fn read_file_head(path: &Path, buffer: &mut [u8]) -> Result<usize, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(filled)
}

/// 文本/HTML 探测：全为可打印 ASCII 或空白 → 不可能是模型二进制
fn looks_like_text(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| {
        *b == b'\n' || *b == b'\r' || *b == b'\t' || (0x20..=0x7e).contains(b)
    })
}

fn known_model(filename: &str) -> Option<(u64, &'static str)> {
    KNOWN_MODELS
        .iter()
        .find(|(name, _, _)| *name == filename)
        .map(|(_, size_mb, md5)| (*size_mb, *md5))
}

/// #1128b：单文件下载大小上限。登记表内按「期望大小 ×1.2 + 32MB」留余量，表外统一 330MB
fn max_bytes_for(filename: &str) -> u64 {
    match known_model(filename) {
        Some((size_mb, _)) => {
            size_mb
                .saturating_mul(1024 * 1024)
                .saturating_mul(12)
                / 10
                + 32 * 1024 * 1024
        }
        None => MAX_UNKNOWN_MODEL_BYTES,
    }
}

/// #1128a：下载地址白名单——仅 HTTPS，主机必须在允许列表内；
/// github.com 还要求路径以 rembg 官方 release 前缀开头（其他主机是 GitHub CDN 重定向目标）
fn validate_download_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("下载地址无效: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("下载地址必须使用 HTTPS（模型仅允许从 rembg 官方 release 下载）".to_string());
    }
    let host = parsed.host_str().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
    if !ALLOWED_DOWNLOAD_HOSTS.contains(&host.as_str()) {
        return Err(format!(
            "下载主机 {host} 不在允许列表内（仅允许 GitHub 官方 release/CDN 域名）"
        ));
    }
    if host == "github.com" && !parsed.path().starts_with(REMBG_RELEASE_PATH_PREFIX) {
        return Err(format!(
            "github.com 仅允许下载 rembg 官方 release（路径需以 {REMBG_RELEASE_PATH_PREFIX} 开头）"
        ));
    }
    Ok(parsed)
}

/// 重定向目标同样要过白名单（GitHub release 会 302 到 CDN，不能一刀切禁跟随）
fn download_host_allowed(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
    ALLOWED_DOWNLOAD_HOSTS.contains(&host.as_str())
}

/// #1128c：md5 以 Rust 内置表为准——登记表内的文件忽略调用方传值（仅做一致性校验），
/// 表外文件必须提供 32 位十六进制 md5，避免「校验值也可被调用方指定」
fn resolve_download_md5(filename: &str, provided: &str) -> Result<String, String> {
    let provided = provided.trim().to_ascii_lowercase();
    match known_model(filename) {
        Some((_, expected)) => {
            if !provided.is_empty() && provided != expected {
                return Err(format!(
                    "模型 {filename} 的校验值与内置登记表不一致，已拒绝下载"
                ));
            }
            Ok(expected.to_string())
        }
        None => {
            if provided.len() != 32 || !provided.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err("未登记的模型必须提供 32 位 MD5 校验值".to_string());
            }
            Ok(provided)
        }
    }
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
    let integrity = model_integrity(&dir, filename);
    let guard = INSTALL.lock().unwrap_or_else(|e| e.into_inner());
    let active = guard.model_id.as_deref() == Some(model_id);
    ModelStatus {
        model_id: model_id.to_string(),
        state: if active { guard.state.clone() } else { "idle".to_string() },
        bytes: if active { guard.bytes } else { 0 },
        total: if active { guard.total } else { 0 },
        error: if active { guard.error.clone() } else { None },
        installed: integrity.kind == Integrity::Ok,
        integrity: integrity.kind.as_str().to_string(),
        integrity_reason: integrity.reason,
        dir: models_dir().map(|d| d.display().to_string()),
        writable: MODELS_DIR_WRITABLE.load(Ordering::Relaxed),
    }
}


/// #1349：async 内禁用 std::thread::sleep——退避等待改用可取消的异步睡眠，
/// 每 100ms 检查一次取消标志；返回 true 表示等待期间被取消。
async fn sleep_cancellable(ms: u64, cancel: &AtomicBool) -> bool {
    let mut waited = 0u64;
    while waited < ms {
        if cancel.load(Ordering::Relaxed) {
            return true;
        }
        let step = (ms - waited).min(100);
        tokio::time::sleep(Duration::from_millis(step)).await;
        waited += step;
    }
    cancel.load(Ordering::Relaxed)
}

/// 连接并跟随重定向；可重试状态码 / 连接失败自动重试（指数退避）
/// #1349：新增 cancel 参数——连接重试全程（12 次 × 退避）均可被取消，
/// 退避等待不再 std::thread::sleep 占死 tokio worker。
async fn connect_with_retry(
    url: &str,
    headers: Vec<(String, String)>,
    cancel: &AtomicBool,
) -> Result<reqwest::Response, String> {
    let mut last_error: Option<String> = None;
    for attempt in 1..=MAX_CONNECT_ATTEMPTS {
        if cancel.load(Ordering::Relaxed) {
            return Err("下载已取消".to_string());
        }
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_millis(CONNECT_TIMEOUT_MS))
            // #1128a：重定向目标也要过白名单，避免下载源 302 到内网/任意主机
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() > 5 || !download_host_allowed(attempt.url()) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
        let mut req = client.get(url);
        for (name, value) in &headers {
            req = req.header(name, value);
        }
        match req.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                if RETRYABLE_STATUS.contains(&status) {
                    last_error = Some(format!("HTTP {status}"));
                    eprintln!("[model-download] 收到可重试状态 HTTP {status}，第 {attempt}/{MAX_CONNECT_ATTEMPTS} 次");
                } else if (300..400).contains(&status) {
                    // 重定向策略只放行白名单主机：走到这里说明跳到了未授权地址
                    return Err("下载地址被重定向到未授权的地址（仅允许 GitHub 官方域名），已拒绝".to_string());
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
            if sleep_cancellable(1000 * u64::from(attempt.min(8)), cancel).await {
                return Err("下载已取消".to_string());
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "无法连接下载源".to_string()))
}

/// 下载一个文件到 part（断点续传；连接中断自动续传，但轮数、总时长与总字节数都有上限且可取消）
async fn download_to_part(
    dir: &Path,
    filename: &str,
    url: &str,
    model_id: &str,
    cancel: &AtomicBool,
    max_bytes: u64,
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
        let response = connect_with_retry(url, headers, cancel).await?;
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
        // #1128b：先看声明大小，超限直接拒绝（避免拉完才发现白花流量/占满磁盘）
        if total > max_bytes {
            return Err(format!(
                "模型文件超过大小上限（声明 {} MB，上限 {} MB），已拒绝下载",
                total / 1048576,
                max_bytes / 1048576
            ));
        }
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
                    downloaded += bytes.len() as u64;
                    // #1128b：真实写入量也要设上限（服务端可能不报 Content-Length）
                    if downloaded > max_bytes {
                        let _ = fs::remove_file(&part);
                        return Err(format!(
                            "模型文件超过大小上限（{} MB），下载已中止",
                            max_bytes / 1048576
                        ));
                    }
                    file.write_all(&bytes).map_err(|e| format!("写入下载文件失败: {e}"))?;
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
        // #1349：续传等待同样可取消、不再阻塞 tokio worker
        if sleep_cancellable(1000 * u64::from(attempt.min(8)), cancel).await {
            return Err("下载已取消".to_string());
        }
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
    max_bytes: u64,
) -> Result<(), String> {
    let destination = model_file(dir, filename);
    let part = model_part_file(dir, filename);
    for round in 1..=3u32 {
        download_to_part(dir, filename, url, model_id, cancel, max_bytes).await?;
        println!("[model-download] 第 {round} 轮下载完成，正在校验完整性…");
        // #1349：数百 MB 同步 MD5 挪出 async 运行时（spawn_blocking），避免占死 worker
        let part_owned = part.clone();
        let digest = tauri::async_runtime::spawn_blocking(move || file_md5(&part_owned))
            .await
            .map_err(|e| format!("校验任务失败: {e}"))??;
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
    // #1128：入口加固——URL 主机白名单（仅 HTTPS + GitHub/rembg release 路径）、
    // md5 以内置登记表为准、单文件大小上限，避免该命令被当成 SSRF/任意落盘通道
    let url = validate_download_url(&url)?.to_string();
    let md5 = resolve_download_md5(&safe, &md5)?;
    let max_bytes = max_bytes_for(&safe);
    if installed(&dir, &safe) {
        set_install_state(&model_id, &safe, "done", None);
        return Ok(status_for(&model_id, &safe));
    }
    if !MODELS_DIR_WRITABLE.load(Ordering::Relaxed) {
        return Err(format!(
            "模型目录不可写（{}）：请改用便携版/绿色版，或手动下载模型后放入该目录",
            dir.display()
        ));
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
            max_bytes,
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
/// #1130：先查用户可写目录，再回退只读内置目录（安装包自带模型 / 尚未迁移的场景）。
pub fn read_model_file(filename: &str) -> Option<Vec<u8>> {
    let safe = safe_model_filename(filename).ok()?;
    if let Some(dir) = models_dir() {
        let path = model_file(dir, &safe);
        if path.is_file() {
            return fs::read(path).ok();
        }
    }
    let bundled = BUNDLED_MODELS_DIR.get()?.as_ref()?;
    let path = model_file(bundled, &safe);
    if !path.is_file() {
        return None;
    }
    fs::read(path).ok()
}

#[cfg(test)]
mod tests {
    use super::{
        connect_with_retry, max_bytes_for, md5_hex, model_integrity, resolve_download_md5,
        sleep_cancellable, validate_download_url, Integrity, Md5, MAX_UNKNOWN_MODEL_BYTES,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    /// 每个测试独立的临时目录（避免并行测试互相踩）
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("novelforge-models-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_model(dir: &PathBuf, filename: &str, size: usize, first_byte: u8) -> PathBuf {
        let path = dir.join(filename);
        let mut bytes = vec![0u8; size];
        bytes[0] = first_byte;
        bytes[1] = 0x07;
        fs::write(&path, &bytes).unwrap();
        path
    }

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

    #[test]
    fn download_url_must_be_https_allowlisted_and_rembg_release() {
        // 官方 release 地址与 CDN 重定向目标都放行
        assert!(validate_download_url(
            "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
        )
        .is_ok());
        assert!(validate_download_url("https://objects.githubusercontent.com/github-production-release-asset/1/x?X-Amz=1").is_ok());

        for rejected in [
            // 非 HTTPS / 其他协议
            "http://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
            "ftp://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx",
            "file:///etc/passwd",
            // 白名单外主机（含内网/元数据地址）
            "https://evil.example.com/u2netp.onnx",
            "https://169.254.169.254/latest/meta-data",
            "https://raw.githubusercontent.com/danielgatis/rembg/main/u2netp.onnx",
            // 同主机但非 rembg release 路径
            "https://github.com/danielgatis/rembg/archive/refs/heads/main.zip",
            // 伪造成 github.com 子域（host 不是 github.com）
            "https://github.com.evil.example/u2netp.onnx",
        ] {
            assert!(validate_download_url(rejected).is_err(), "应拒绝下载地址: {rejected}");
        }
    }

    #[test]
    fn download_md5_comes_from_builtin_table_for_known_models() {
        // 登记表内的模型：调用方不传 / 传对 → 用内置值；传错 → 拒绝
        assert_eq!(
            resolve_download_md5("u2netp.onnx", "").unwrap(),
            "8e83ca70e441ab06c318d82300c84806"
        );
        assert_eq!(
            resolve_download_md5("u2netp.onnx", "8E83CA70E441AB06C318D82300C84806").unwrap(),
            "8e83ca70e441ab06c318d82300c84806"
        );
        assert!(resolve_download_md5("u2netp.onnx", "00000000000000000000000000000000").is_err());
        // 表外文件：必须给出 32 位十六进制校验值
        assert_eq!(
            resolve_download_md5("future-model.onnx", "0123456789abcdef0123456789abcdef").unwrap(),
            "0123456789abcdef0123456789abcdef"
        );
        assert!(resolve_download_md5("future-model.onnx", "").is_err());
        assert!(resolve_download_md5("future-model.onnx", "deadbeef").is_err());
        assert!(resolve_download_md5("future-model.onnx", "zz23456789abcdef0123456789abcdef").is_err());
    }

    #[test]
    fn download_size_limit_matches_registry() {
        // 登记表内：期望大小 ×1.2 + 32MB（5MB 的 u2netp 上限约 38MB）
        assert_eq!(max_bytes_for("u2netp.onnx"), 5 * 1024 * 1024 * 12 / 10 + 32 * 1024 * 1024);
        // 表外：统一 330MB
        assert_eq!(max_bytes_for("future-model.onnx"), MAX_UNKNOWN_MODEL_BYTES);
    }
    #[test]
    fn integrity_rejects_missing_truncated_and_broken_models() {

        let dir = temp_dir("integrity");
        // 缺失
        assert_eq!(model_integrity(&dir, "u2netp.onnx").kind, Integrity::Missing);

        // 截断（大小远小于登记值）
        write_model(&dir, "u2netp.onnx", 1024 * 1024, 0x08);
        let truncated = model_integrity(&dir, "u2netp.onnx");
        assert_eq!(truncated.kind, Integrity::Corrupt);
        assert!(truncated.reason.unwrap().contains("不完整"));

        // 占位文件（全零）
        write_model(&dir, "u2netp.onnx", 8 * 1024 * 1024, 0x00);
        assert_eq!(model_integrity(&dir, "u2netp.onnx").kind, Integrity::Corrupt);

        // 错误页被当成模型保存（文本/HTML）
        let html = dir.join("u2netp.onnx");
        let mut text = vec![b' '; 8 * 1024 * 1024];
        text[..15].copy_from_slice(b"<html><body>404");
        fs::write(&html, &text).unwrap();
        assert_eq!(model_integrity(&dir, "u2netp.onnx").kind, Integrity::Corrupt);

        // 大小达标但文件头不是 ONNX
        write_model(&dir, "u2netp.onnx", 6 * 1024 * 1024, 0x77);
        assert_eq!(model_integrity(&dir, "u2netp.onnx").kind, Integrity::Corrupt);

        // 正常（ONNX ModelProto 首字节 0x08）
        write_model(&dir, "u2netp.onnx", 6 * 1024 * 1024, 0x08);
        assert_eq!(model_integrity(&dir, "u2netp.onnx").kind, Integrity::Ok);

        let _ = fs::remove_dir_all(&dir);
    }

    /// #1349：预置取消标志时 connect 阶段立即退出（不发起 12 次重试、不睡退避）
    #[tokio::test]
    async fn connect_retry_observes_pre_set_cancel() {
        let cancel = AtomicBool::new(true);
        let started = Instant::now();
        let result =
            connect_with_retry("https://objects.githubusercontent.com/x", Vec::new(), &cancel)
                .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("取消"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "预取消应立即返回，不应进入重试等待"
        );
    }

    /// #1349：退避等待期间置位取消应提前返回 true；未取消时睡满返回 false
    #[tokio::test]
    async fn cancellable_sleep_wakes_on_cancel() {
        let cancel = AtomicBool::new(false);
        assert!(!sleep_cancellable(50, &cancel).await);
        let cancel = AtomicBool::new(true);
        assert!(sleep_cancellable(8000, &cancel).await);
        // 8 秒退避若不可取消会睡满；可取消时应在远小于 8 秒内返回
        let started = Instant::now();
        let cancel = AtomicBool::new(true);
        assert!(sleep_cancellable(8000, &cancel).await);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
