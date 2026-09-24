use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chardetng::EncodingDetector;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::{preview, server};

const API_SECRET_SERVICE: &str = "com.novelforge.app.api";
const HTTP_BODY_LIMIT: usize = 64 * 1024 * 1024;
/// 流式增量合并节流：每累计 8KB 或每 200ms 才发一次 IPC 事件，避免小 chunk 刷爆事件通道
const STREAM_EMIT_BYTES: usize = 8 * 1024;
const STREAM_EMIT_INTERVAL: Duration = Duration::from_millis(200);
/// read_file_header 允许读取的最大头部字节数：无论调用方传多大都不读取整文件
const READ_FILE_HEADER_LIMIT: usize = 64 * 1024;
static ATOMIC_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// #1292 路径白名单：所有直接操作调用方传入路径的命令入口必须先经 resolve_safe_path
/// 归一化（canonicalize 消解 .. 与符号链接逃逸 + 允许根 starts_with 校验）。
/// 允许根 = 当前工作目录 / 系统临时目录 / 用户家目录 / 前端登记的用户自选目录
/// （项目输出目录、对话框选中的小说/素材/保存路径——选目录/文件行为本身经系统对话框
/// 或项目切换确认，用户已明示授权）。此处拦截 UNC/设备路径、NUL、file: scheme 与
/// 系统敏感目录；破坏性操作另经 guard_against_wipe 拒绝盘符根/允许根自身。
/// 去掉 Windows verbatim 前缀再做语法检查：`canonicalize()` 产出（及前端回传）的
/// `\\?\D:\...` 否则会被下行的 UNC 检查误杀，形成"自己产出、自己拒绝"的互斥。
/// 真正的 UNC（`\\host\...`、`\\?\UNC\...`）仍拒绝。
fn strip_verbatim_prefix(raw: &str) -> Result<String, String> {
    for prefix in [r"\\?\", "//?/", r"\??\", "/??/"] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            if rest.len() >= 4 && rest[..4].eq_ignore_ascii_case("UNC\\") {
                return Err("不支持 UNC 路径，已拒绝".to_string());
            }
            return Ok(rest.to_string());
        }
    }
    Ok(raw.to_string())
}

fn reject_unsafe_path_syntax(raw: &str) -> Result<String, String> {
    let deverbatim = strip_verbatim_prefix(raw.trim())?;
    let trimmed = deverbatim.trim();
    if trimmed.is_empty() {
        return Err("路径为空，已拒绝".to_string());
    }
    if trimmed.contains('\0') {
        return Err("路径包含非法字符，已拒绝".to_string());
    }
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") || trimmed.starts_with(r"\??\") {
        return Err("不支持 UNC/设备路径，已拒绝".to_string());
    }
    if trimmed.to_ascii_lowercase().starts_with("file:") {
        return Err("不支持 file: 路径，已拒绝".to_string());
    }
    Ok(trimmed.to_string())
}

/// 返给前端的路径去掉 verbatim 前缀：前端会把 entry.path 原样传回做下一次调用，
/// 带 `\\?\` 的会被语法检查当 UNC 拒绝（与 strip_verbatim_prefix 双保险）。
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    strip_verbatim_prefix(&s).unwrap_or(s)
}

fn allowed_file_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    roots.push(std::env::temp_dir());
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        if !home.trim().is_empty() {
            roots.push(PathBuf::from(home));
        }
    }
    roots
}

fn canonical_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = allowed_file_roots()
        .into_iter()
        .map(|r| r.canonicalize().unwrap_or(r))
        .collect();
    // 用户自选目录（项目输出目录、对话框路径）：进程内登记，重启后由前端重新登记
    if let Ok(blessed) = blessed_dirs().lock() {
        roots.extend(blessed.iter().cloned());
    }
    roots
}

/// 用户自选目录登记表（#1292 缺的另一半）：桌面应用的核心工作就是读写用户任意位置的
/// 工程目录，仅靠工作目录/临时目录/家目录三根会把 D 盘等位置的正常项目全部拒绝。
/// 登记 = 用户明示授权（切换项目、系统对话框选文件/选目录），与匿名调用方传参有本质区别。
fn blessed_dirs() -> &'static std::sync::Mutex<std::collections::HashSet<PathBuf>> {
    static BLESSED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    BLESSED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// 登记用户自选目录（前端在切换项目/对话框选中后调用）。目录本身可不存在；
/// 拒绝系统敏感目录与盘符根/文件系统根（防止一次登记放行整盘）。
#[tauri::command]
pub fn bless_project_dir(path: String) -> Result<(), String> {
    let clean = reject_unsafe_path_syntax(&path)?;
    let mut buf = PathBuf::from(&clean);
    if buf.is_relative() {
        let cwd = std::env::current_dir().map_err(|_| "无法解析相对路径".to_string())?;
        buf = cwd.join(buf);
    }
    let canon = canonicalize_with_missing_tail(&buf)?;
    if is_sensitive_system_path(&canon) {
        return Err("系统敏感目录不可登记，已拒绝".to_string());
    }
    if canon.parent().is_none() {
        return Err("不可登记文件系统根目录".to_string());
    }
    // 盘符根（如 D:\）不予登记：项目必须放在文件夹里（也避免一次登记放行整盘）
    if canon.parent().map(|p| p.parent().is_none()).unwrap_or(false) {
        return Err("不可登记盘符根目录，请把项目放在文件夹内".to_string());
    }
    if let Ok(mut blessed) = blessed_dirs().lock() {
        blessed.insert(canon);
        return Ok(());
    }
    Err("目录登记失败".to_string())
}

/// 最近已存在祖先 canonicalize 后拼回剩余部分（写新文件时目标本身尚不存在）。
fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf, String> {
    if let Ok(hit) = path.canonicalize() {
        return Ok(hit);
    }
    let mut remainder: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path;
    loop {
        match cursor.canonicalize() {
            Ok(hit) => {
                let mut out = hit;
                for comp in remainder.iter().rev() {
                    out.push(comp);
                }
                return Ok(out);
            }
            Err(_) => match cursor.parent() {
                Some(parent) => {
                    if let Some(name) = cursor.file_name() {
                        remainder.push(name.to_os_string());
                    }
                    cursor = parent;
                }
                None => return Err("路径无效，无法解析".to_string()),
            },
        }
    }
}

/// #1416：家目录下高危凭据目录（全平台生效）：此前仅 Windows 分支拦截 .ssh，
/// Linux/macOS 下 ~/.ssh 等可被任意读写。canonicalize 后的绝对路径按组件比较，
/// 相似名前缀（如 .ssh-backup）不会误伤。
const CREDENTIAL_HOME_REL_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube", ".config/gcloud"];

/// 纯函数（可单测）：canon 是否落在 home 下的凭据目录内。
fn path_within_home_credential_dir(canon: &Path, home: &Path) -> bool {
    CREDENTIAL_HOME_REL_DIRS.iter().any(|rel| {
        let dir = home.join(rel);
        *canon == dir || canon.starts_with(&dir)
    })
}

fn is_sensitive_system_path(canon: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        if let Ok(windir) = std::env::var("SystemRoot").or_else(|_| std::env::var("windir")) {
            let sys = PathBuf::from(&windir);
            let canon_sys = sys.canonicalize().unwrap_or(sys);
            if *canon == canon_sys || canon.starts_with(&canon_sys) {
                return true;
            }
        }
    }
    // #1416：凭据目录检查移出 Windows cfg，全平台生效
    // （家目录整体仍放行用户工程，仅直属凭据目录除外）
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        if !home.trim().is_empty() {
            let home_path = PathBuf::from(&home);
            // 家目录本身可能是符号链接（如 macOS /Users）：canonicalize 后再比一次，避免拼写绕过
            let canon_home = home_path.canonicalize().unwrap_or(home_path.clone());
            if path_within_home_credential_dir(canon, &home_path)
                || path_within_home_credential_dir(canon, &canon_home)
            {
                return true;
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if *canon == Path::new("/") {
            return true;
        }
    }
    false
}

fn resolve_safe_path(raw: &str) -> Result<PathBuf, String> {
    let clean = reject_unsafe_path_syntax(raw)?;
    let mut path = PathBuf::from(&clean);
    if path.is_relative() {
        let cwd = std::env::current_dir().map_err(|_| "无法解析相对路径".to_string())?;
        path = cwd.join(path);
    }
    let canon = canonicalize_with_missing_tail(&path)?;
    if !canonical_roots().iter().any(|r| canon.starts_with(r)) {
        return Err("路径不在允许目录内（仅允许工作目录/临时目录/用户家目录），已拒绝".to_string());
    }
    if is_sensitive_system_path(&canon) {
        return Err("系统敏感目录不可操作，已拒绝".to_string());
    }
    Ok(canon)
}

/// 破坏性操作（删除/替换/清理）不得指向盘符根、文件系统根或允许根自身。
fn guard_against_wipe(canon: &Path) -> Result<(), String> {
    if canon.parent().is_none() {
        return Err("拒绝操作文件系统根目录".to_string());
    }
    for root in canonical_roots() {
        if *canon == root {
            return Err("拒绝操作目录根自身，请指定其子路径".to_string());
        }
    }
    Ok(())
}

/// #1293 SSRF 防护：http_request 是通用 API 通道（无 models 那样的固定主机白名单），
/// 故做私网/特殊地址拦截。唯一例外：回环地址上的 Ollama 默认端口 11434
/// （应用内建“本地模型”通道，baseUrl 写死 http://localhost:11434/v1；其它回环端口一律拒绝）。
/// 重定向已全局禁用（Policy::none），此处只需卡直接请求目标。
const OLLAMA_LOCAL_PORT: u16 = 11434;

fn parse_numeric_ip(host: &str) -> Option<std::net::IpAddr> {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return Some(ip);
    }
    // 十进制整数（2130706433 == 127.0.0.1）与 0x 十六进制混淆写法同样归一化为 IP 再判定
    let h = host.trim().trim_end_matches('.');
    if !h.is_empty() && h.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(n) = h.parse::<u32>() {
            return Some(std::net::IpAddr::V4(std::net::Ipv4Addr::from(n)));
        }
    }
    for prefix in ["0x", "0X"] {
        if let Some(hex) = h.strip_prefix(prefix) {
            if !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                if let Ok(n) = u32::from_str_radix(hex, 16) {
                    return Some(std::net::IpAddr::V4(std::net::Ipv4Addr::from(n)));
                }
            }
        }
    }
    None
}

fn ipv4_blocked(octets: &[u8; 4]) -> bool {
    let [a, b, ..] = *octets;
    a == 0 // 0.0.0.0/8（含 0.0.0.0）
        || a == 10 // 10.0.0.0/8
        || (a == 172 && (16..=31).contains(&b)) // 172.16.0.0/12
        || (a == 192 && b == 168) // 192.168.0.0/16
        || (a == 169 && b == 254) // 169.254.0.0/16（含云元数据 169.254.169.254）
        || (a == 127) // 回环（端口例外由调用方先行处理；直接命中此处即拦）
        || a >= 224 // 组播/保留/广播
        || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64.0.0/10
        || (a == 192 && b == 0) // 192.0.0.0/24（含 TEST-NET-1）
        || (a == 198 && (18..=19).contains(&b)) // 基准测试网
        || (a == 203 && b == 0) // TEST-NET-3
}

/// #1411：用户显式放行时才允许的“自用局域网”范围（RFC1918）。
/// CGNAT/文档网段/组播/未指定/云元数据即使放行也不解禁，见 ssrf_reject_reason。
fn is_user_lan_ipv4(octets: &[u8; 4]) -> bool {
    let [a, b, ..] = *octets;
    a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168)
}

fn ssrf_reject_reason(url: &reqwest::Url, allow_lan: bool) -> Option<String> {
    let host = url
        .host_str()
        .unwrap_or_default()
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(|c| c == ']' || c == '.')
        .to_ascii_lowercase();
    if host.is_empty() {
        return Some("缺少主机名，已拒绝".to_string());
    }
    if let Some(ip) = parse_numeric_ip(&host) {
        match ip {
            std::net::IpAddr::V4(v) => {
                // 未指定/组播/保留/广播：即使显式放行也不解禁
                if v.is_unspecified() || v.is_multicast() || v.octets()[0] >= 224 {
                    return Some(format!("特殊地址 {host} 已拒绝（SSRF 防护）"));
                }
                // 云元数据与链路本地（含 169.254.169.254）：即使显式放行也不解禁
                if v.octets()[0] == 169 && v.octets()[1] == 254 {
                    return Some(format!("内网/特殊地址 {host} 已拒绝（SSRF 防护）"));
                }
                if v.is_loopback() {
                    if url.port_or_known_default() == Some(OLLAMA_LOCAL_PORT) {
                        return None;
                    }
                    // #1411：显式放行后，本机其它端口（LM Studio 1234/llama.cpp 8080/vLLM 8000 等）允许
                    if allow_lan {
                        return None;
                    }
                    return Some("回环地址仅放行本地模型端口 11434，已拒绝".to_string());
                }
                // #1411：RFC1918 自用局域网在显式放行后允许；其余特殊段（CGNAT/文档网段等）一律拒绝
                if is_user_lan_ipv4(&v.octets()) {
                    if allow_lan {
                        return None;
                    }
                    return Some(format!("内网/特殊地址 {host} 已拒绝（SSRF 防护）"));
                }
                if ipv4_blocked(&v.octets()) {
                    return Some(format!("内网/特殊地址 {host} 已拒绝（SSRF 防护）"));
                }
                return None;
            }
            std::net::IpAddr::V6(v) => {
                // 未指定/组播：即使显式放行也不解禁
                if v.is_unspecified() || v.is_multicast() {
                    return Some(format!("特殊地址 {host} 已拒绝（SSRF 防护）"));
                }
                if v.is_loopback() {
                    if url.port_or_known_default() == Some(OLLAMA_LOCAL_PORT) {
                        return None;
                    }
                    if allow_lan {
                        return None;
                    }
                    return Some("回环地址仅放行本地模型端口 11434，已拒绝".to_string());
                }
                let seg = v.segments();
                // ULA fc00::/7 与链路本地 fe80::/10：显式放行后允许（局域网 IPv6 自建网关）
                if (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80 {
                    if allow_lan {
                        return None;
                    }
                    return Some(format!("内网地址 {host} 已拒绝（SSRF 防护）"));
                }
                return None;
            }
        }
    }
    if host == "localhost" || host.ends_with(".localhost") {
        if url.port_or_known_default() == Some(OLLAMA_LOCAL_PORT) {
            return None;
        }
        if allow_lan {
            return None;
        }
        return Some("回环主机仅放行本地模型端口 11434，已拒绝".to_string());
    }
    // 云元数据主机名：即使显式放行也不解禁
    if host == "metadata.google.internal" || host == "instance-data" {
        return Some(format!("内网主机名 {host} 已拒绝（SSRF 防护）"));
    }
    if host.ends_with(".local") || host.ends_with(".internal") || host.ends_with(".lan") {
        if allow_lan {
            return None;
        }
        return Some(format!("内网主机名 {host} 已拒绝（SSRF 防护）"));
    }
    if !host.contains('.') && !host.contains(':') {
        if allow_lan {
            return None;
        }
        return Some(format!("单标签主机名 {host} 疑似内网，已拒绝（SSRF 防护）"));
    }
    None
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestArgs {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub body_base64: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// #1411：用户显式放行局域网/本机其它端口（前端 ApiConfig.allowLan 透传，默认关闭）。
    /// 缺省 false = 旧口径（回环仅 11434、私网/内网名全部拒绝），安全底线不变。
    #[serde(default)]
    pub allow_lan: bool,
    /// 剧本 SSE 流式（仅前端流式路径传 true）：边收边把增量经 nf-http-stream 事件发给前端
    ///（心跳日志显示「已生成 N 字」），返回值仍是完整响应体（契约不变）。
    /// 缺省 false = 老调用方行为完全不变（extract/translate/图像/TTS/视觉等仍整包等待）。
    #[serde(default)]
    pub stream: bool,
}

fn default_timeout() -> u64 {
    120
}

fn http_target(args: &HttpRequestArgs) -> Result<reqwest::Url, String> {
    let target = reqwest::Url::parse(&args.url).map_err(|_| "无效的 HTTP 地址".to_string())?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("仅支持 HTTP/HTTPS 地址".to_string());
    }
    // #1293：scheme 校验之外再拦截私网/回环（Ollama 11434 除外）/特殊地址与内网主机名
    // #1411：用户显式放行（allowLan，默认关闭）后，自用局域网/回环其它端口/内网名允许，
    // 高危目标（未指定/组播/云元数据等）仍拒绝
    if let Some(reason) = ssrf_reject_reason(&target, args.allow_lan) {
        return Err(reason);
    }
    let encoded_size = args.body.as_ref().map_or(0, String::len)
        + args.body_base64.as_ref().map_or(0, String::len);
    if encoded_size > HTTP_BODY_LIMIT * 2 {
        return Err("请求体超过 64MB 上限，已拒绝".to_string());
    }
    Ok(target)
}

async fn limited_response_bytes(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > HTTP_BODY_LIMIT as u64)
    {
        return Err("响应超过 64MB 上限，已拒绝".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?
    {
        if bytes.len() + chunk.len() > HTTP_BODY_LIMIT {
            return Err("响应超过 64MB 上限，已拒绝".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn http_request(
    app: tauri::AppHandle,
    args: HttpRequestArgs,
    request_id: Option<u64>,
) -> Result<Value, String> {
    // #784：支持取消的在途请求。无 request_id（旧调用方/一次性请求）时直接在当前任务执行；
    // 有 request_id 时把请求放进独立任务，注册 abort 句柄，前端「停止」可中断在途请求
    //（否则点停止后最长仍会跑完 600s 并继续计费）。
    // 流式（args.stream）同样沿用它：任务被 abort 时读取随 future 一起停止。
    if request_id.is_none() {
        return do_http_request(&app, args, None).await;
    }
    let id = request_id.unwrap();
    let handle = tauri::async_runtime::spawn(async move { do_http_request(&app, args, Some(id)).await });
    {
        let abort = handle.inner().abort_handle();
        if let Ok(mut registry) = http_aborts().lock() {
            registry.insert(id, Box::new(move || abort.abort()));
        }
    }
    let result = handle.await.map_err(|e| format!("请求被取消或任务失败: {e}"))?;
    if let Ok(mut registry) = http_aborts().lock() {
        registry.remove(&id);
    }
    result
}

/// 取消在途 HTTP 请求（#784）：应前端「停止」的调用；返回是否命中在途请求
#[tauri::command]
pub fn cancel_http_request(request_id: u64) -> Result<bool, String> {
    let cancel = http_aborts()
        .lock()
        .map_err(|_| "锁获取失败".to_string())?
        .remove(&request_id);
    match cancel {
        Some(cancel) => {
            cancel();
            Ok(true)
        }
        None => Ok(false),
    }
}

type HttpAbortFn = Box<dyn Fn() + Send + Sync>;

fn http_aborts() -> &'static std::sync::Mutex<HashMap<u64, HttpAbortFn>> {
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<HashMap<u64, HttpAbortFn>>> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

async fn do_http_request(
    app: &tauri::AppHandle,
    args: HttpRequestArgs,
    request_id: Option<u64>,
) -> Result<Value, String> {
    let target = http_target(&args)?;
    let client = reqwest::Client::builder()
        // 上限与前端 requestTimeoutSecs 对齐（1800s）：32K 输出在 30 tok/s 后端上要约 1090s，
        // 旧上限 600s 会把「慢但在出字」的大请求掐掉，掐掉后拆小重跑更慢更贵
        .timeout(Duration::from_secs(args.timeout_secs.clamp(1, 1800)))
        // 连接超时独立封顶 30s：建连/TLS 阶段卡住时不再烧完整次超时（如 300s）才报错，
        // 慢响应仍享有完整总超时；与 models.rs 的 CONNECT_TIMEOUT_MS 口径一致
        .connect_timeout(Duration::from_secs(30))
        // 禁止跟随重定向：否则 302/307 可跳到内网/元数据地址完成 SSRF 绕过，
        // 且与 Web 代理（redirect:"manual"）策略不一致
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?;

    let method = reqwest::Method::from_bytes(args.method.to_uppercase().as_bytes())
        .map_err(|_| "不支持的 HTTP 方法".to_string())?;

    let mut req = client.request(method, target);
    for (k, v) in &args.headers {
        // host/cookie/content-length 由客户端管理：与 Web 代理的禁止头列表保持一致，
        // 防止渲染层借 Tauri 侧携带 Cookie 请求任意站点
        let lower = k.to_lowercase();
        if lower != "host" && lower != "cookie" && lower != "content-length" {
            req = req.header(k, v);
        }
    }
    if let Some(body_base64) = &args.body_base64 {
        let body = B64.decode(body_base64).map_err(|_| "HTTP binary request body is not valid Base64".to_string())?;
        if body.len() > HTTP_BODY_LIMIT {
            return Err("HTTP request body exceeds the 64MB limit".to_string());
        }
        req = req.body(body);
    } else if let Some(body) = &args.body {
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
    // 流式（仅剧本路径传 stream=true）：边收边 emit 增量给前端，返回值仍是完整响应体；
    // 其余调用方保持原有限流整包读取，行为完全不变。
    let bytes = if args.stream {
        let app = app.clone();
        let id = request_id.unwrap_or(0);
        read_streaming_bytes(resp, move |chunk| emit_stream_chunk(&app, id, chunk)).await?
    } else {
        limited_response_bytes(resp).await?
    };

    Ok(serde_json::json!({
        "status": status,
        "contentType": content_type,
        "bodyBase64": B64.encode(bytes),
    }))
}

/// 流式读取响应体（仅 args.stream=true 走此路径）：边累积完整字节，边把增量交给 on_chunk。
/// 返回值与 limited_response_bytes 完全一致（同样受 64MB 上限约束、同样的错误文案）；
/// 任务被 abort 时整个 future 被丢弃，读取随之停止（取消语义由 http_request 的 AbortHandle 提供）。
async fn read_streaming_bytes(
    mut response: reqwest::Response,
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    if response
        .content_length()
        .is_some_and(|size| size > HTTP_BODY_LIMIT as u64)
    {
        return Err("响应超过 64MB 上限，已拒绝".to_string());
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut pending: Vec<u8> = Vec::new();
    let mut last_emit = Instant::now();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取响应失败: {e}"))?;
        if bytes.len() + chunk.len() > HTTP_BODY_LIMIT {
            return Err("响应超过 64MB 上限，已拒绝".to_string());
        }
        bytes.extend_from_slice(&chunk);
        pending.extend_from_slice(&chunk);
        // 合并节流：够 8KB 或距上次已 200ms 才发一次；结束时残留必定 flush，增量不丢
        if pending.len() >= STREAM_EMIT_BYTES || last_emit.elapsed() >= STREAM_EMIT_INTERVAL {
            on_chunk(&pending);
            pending.clear();
            last_emit = Instant::now();
        }
    }
    if !pending.is_empty() {
        on_chunk(&pending);
    }
    Ok(bytes)
}

/// 把一段流式增量发给前端（base64 承载任意字节，前端按 requestId 过滤自己的流）。
/// 事件发送失败不影响请求本身：返回值仍是完整响应体，前端解析不受影响。
fn emit_stream_chunk(app: &tauri::AppHandle, request_id: u64, data: &[u8]) {
    let payload = serde_json::json!({
        "requestId": request_id,
        "dataBase64": B64.encode(data),
    });
    if let Err(error) = app.emit("nf-http-stream", payload) {
        eprintln!("[novelforge] 流式事件发送失败: {error}");
    }
}

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<Value, String> {
    // 文件读 + 编码探测是阻塞 IO/CPU，放阻塞线程池执行，避免卡住主线程（IPC 命令默认在主线程执行）
    let safe = resolve_safe_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let data = std::fs::read(&safe).map_err(|e| format!("读取失败: {e}"))?;

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
    })
    .await
    .map_err(|e| format!("读取任务执行失败: {e}"))?
}

/// 原子写文件：写同目录临时文件后 rename 覆盖目标。
/// 中断/崩溃时目标文件要么是旧完整内容、要么是新的完整内容，不会留下半截损坏数据
/// （assets.json / project_state.json / visual-bible.json 等被半截写入会导致下次解析失败）。
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = atomic_write_temp_path(path);
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换文件失败: {e}")
    })
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    // #1413：原子写（建目录+写临时+rename）是阻塞 IO（autosave 高频调用，MB 级快照），放阻塞线程池
    let safe = resolve_safe_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || atomic_write(&safe, content.as_bytes()))
        .await
        .map_err(|e| format!("写入任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    // 图片/音频等文件读取 + base64 编码是阻塞操作，放阻塞线程池（大素材读几十 MB）
    let safe = resolve_safe_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let data = std::fs::read(&safe).map_err(|e| format!("读取失败: {e}"))?;
        Ok(B64.encode(&data))
    })
    .await
    .map_err(|e| format!("读取任务执行失败: {e}"))?
}

/// 读取文件头部最多 max_bytes 字节（不超过 64KB 常量上限）。
fn read_file_header_bytes(path: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let limit = max_bytes.min(READ_FILE_HEADER_LIMIT);
    let mut file = std::fs::File::open(path).map_err(|e| format!("读取失败: {e}"))?;
    let mut buffer = vec![0u8; limit];
    let mut read = 0usize;
    // read 允许短读：循环直到填满 limit 或到达文件末尾
    while read < limit {
        match file.read(&mut buffer[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("读取失败: {error}")),
        }
    }
    buffer.truncate(read);
    Ok(buffer)
}

/// 只读取文件头部最多 max_bytes 字节（B85）：前端识别图片尺寸只需文件头，
/// 旧实现调用 read_file_base64 会把几十 MB 的整张图读入内存再 base64 编码，纯为解析 4 字节宽高。
/// max_bytes 由调用方给出并被强制封顶 64KB。
#[tauri::command]
pub async fn read_file_header(path: String, max_bytes: usize) -> Result<Value, String> {
    // 头部读取同样是阻塞 IO，放阻塞线程池执行，避免卡住主线程（与 read_file_base64 一致）
    let safe = resolve_safe_path(&path)?;
    let safe_str = safe.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let bytes = read_file_header_bytes(&safe_str, max_bytes)?;
        Ok(serde_json::json!({ "base64": B64.encode(&bytes) }))
    })
    .await
    .map_err(|e| format!("读取任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn write_file_base64(path: String, data_b64: String) -> Result<(), String> {
    // base64 解码 + 落盘是阻塞操作（大图可能几十 MB），放阻塞线程池
    let safe = resolve_safe_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let bytes = B64.decode(&data_b64).map_err(|e| format!("base64 解码失败: {e}"))?;
        atomic_write(&safe, &bytes)
    })
    .await
    .map_err(|e| format!("写入任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Value, String> {
    // #1413：目录遍历+元数据是阻塞 IO（生成期高频扫素材目录），放阻塞线程池
    let p = resolve_safe_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
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
                // #1292 回归：entry.path() 继承 read_dir 入参的 canonical 前缀（`\\?\D:\...`），
                // 原样返回会导致前端下一次调用被当 UNC 拒绝；去前缀后再返回。
                "path": display_path(&entry.path()),
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
    })
    .await
    .map_err(|e| format!("读取任务执行失败: {e}"))?
}

#[tauri::command]
pub fn mkdir_all(path: String) -> Result<(), String> {
    let safe = resolve_safe_path(&path)?;
    std::fs::create_dir_all(&safe).map_err(|e| format!("创建目录失败: {e}"))
}

#[tauri::command]
pub async fn copy_file(src: String, dst: String) -> Result<(), String> {
    // #1413：文件复制是阻塞 IO（视频导入可达数百 MB），放阻塞线程池（与 copy_dir_all 对齐）
    let safe_src = resolve_safe_path(&src)?;
    let safe_dst = resolve_safe_path(&dst)?;
    if safe_src == safe_dst {
        return Err("源与目标相同，已拒绝".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if let Some(parent) = safe_dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        std::fs::copy(&safe_src, &safe_dst).map_err(|e| format!("复制失败: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("复制任务执行失败: {e}"))?
}

fn atomic_write_temp_path(path: &std::path::Path) -> PathBuf {
    let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("bin");
    let sequence = ATOMIC_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    path.with_extension(format!("{extension}.{}.{}.tmp", std::process::id(), sequence))
}

#[tauri::command]
pub async fn replace_path(src: String, dst: String) -> Result<(), String> {
    // #1413：改名/备份/清理是阻塞 IO，放阻塞线程池
    let source = resolve_safe_path(&src)?;
    let destination = resolve_safe_path(&dst)?;
    guard_against_wipe(&destination)?;
    let src_display = src.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let backup = PathBuf::from(format!("{}.replace-backup", destination.to_string_lossy()));
        if !source.exists() {
            return Err(format!("替换失败：源路径不存在 {src_display}"));
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
    })
    .await
    .map_err(|e| format!("替换任务执行失败: {e}"))?
}

/// 原子写临时文件名：`<name>.<pid>.<seq>.tmp`（与本文件 atomic_write_temp_path 同构）
fn is_atomic_tmp_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tmp") else {
        return false;
    };
    let mut parts = stem.rsplitn(3, '.');
    let seq = parts.next();
    let pid = parts.next();
    let rest = parts.next();
    match (rest, pid, seq) {
        (Some(rest), Some(pid), Some(seq)) => {
            !rest.is_empty()
                && !pid.is_empty()
                && !seq.is_empty()
                && pid.chars().all(|c| c.is_ascii_digit())
                && seq.chars().all(|c| c.is_ascii_digit())
        }
        _ => false,
    }
}

/// 递归清理崩溃残留（#783）：删除本程序产生的 .tmp，恢复/清理 .replace-backup。
/// - `.replace-backup`：原路径缺失说明替换在「已备份、未发布」处中断 → 恢复备份；
///   原路径存在说明发布已完成、只是备份没清掉 → 删除备份（以新内容为准）。
fn cleanup_stale_dir(dir: &Path, depth: usize, removed: &mut u64, restored: &mut u64) {
    if depth == 0 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // 不跟随符号链接：只处理真实目录/文件
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            cleanup_stale_dir(&path, depth - 1, removed, restored);
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(target) = name.strip_suffix(".replace-backup") {
            let original = path.with_file_name(target);
            if original.exists() {
                if std::fs::remove_file(&path).is_ok() {
                    *removed += 1;
                }
            } else if std::fs::rename(&path, &original).is_ok() {
                *restored += 1;
            }
            continue;
        }
        if is_atomic_tmp_name(&name) && std::fs::remove_file(&path).is_ok() {
            *removed += 1;
        }
    }
}

/// 启动清理入口：扫描项目目录并清理崩溃残留（非递归到符号链接之外，深度默认 6）
#[tauri::command]
pub async fn cleanup_stale_files(root: String, max_depth: Option<usize>) -> Result<Value, String> {
    // #1413：启动时递归扫整个输出目录是阻塞 IO（App.vue 启动即调），放阻塞线程池
    let path = resolve_safe_path(&root)?;
    guard_against_wipe(&path)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        if !path.is_dir() {
            return Ok(serde_json::json!({ "removed": 0, "restored": 0 }));
        }
        let mut removed = 0u64;
        let mut restored = 0u64;
        cleanup_stale_dir(&path, max_depth.unwrap_or(6).clamp(1, 16), &mut removed, &mut restored);
        Ok(serde_json::json!({ "removed": removed, "restored": restored }))
    })
    .await
    .map_err(|e| format!("清理任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn copy_dir_all(src: String, dst: String) -> Result<(), String> {    // 递归复制目录是磁盘密集阻塞操作，放阻塞线程池
    let safe_src = resolve_safe_path(&src)?;
    let safe_dst = resolve_safe_path(&dst)?;
    if safe_src == safe_dst {
        return Err("源与目标相同，已拒绝".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        copy_dir_recursive(&safe_src, &safe_dst)
    })
    .await
    .map_err(|e| format!("复制任务执行失败: {e}"))?
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    // 用 symlink_metadata 绝不跟随链接：链接可能指回父目录造成无限递归/磁盘写满,
    // 也可能把导出目录外的文件（用户私密目录）复制进发布包，直接跳过
    let meta = std::fs::symlink_metadata(src).map_err(|e| format!("读取文件属性失败: {e}"))?;
    if meta.file_type().is_symlink() {
        eprintln!("[novelforge] 跳过符号链接: {}", src.display());
        return Ok(());
    }
    if meta.file_type().is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
        for entry in std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))? {
            let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
            let s = entry.path();
            let d = dst.join(entry.file_name());
            copy_dir_recursive(&s, &d)?;
        }
    } else if meta.file_type().is_file() {
        std::fs::copy(src, dst).map_err(|e| format!("复制失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_path(path: String) -> Result<(), String> {
    let p = resolve_safe_path(&path)?;
    guard_against_wipe(&p)?;
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
    // 非法路径按不存在处理（不向调用方泄露拒绝原因细节）
    resolve_safe_path(&path).map(|p| p.exists()).unwrap_or(false)
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
    atomic_write(&file, content.as_bytes())
}

fn validate_secret_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err("无效的凭据标识".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn read_api_secrets(ids: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut secrets = HashMap::new();
    for id in ids {
        validate_secret_id(&id)?;
        let entry = keyring::Entry::new(API_SECRET_SERVICE, &id)
            .map_err(|e| format!("创建系统凭据项失败（{id}）：{e}"))?;
        match entry.get_password() {
            Ok(secret) => {
                secrets.insert(id, secret);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("读取系统凭据失败（{id}）：{e}")),
        }
    }
    Ok(secrets)
}

#[tauri::command]
pub fn write_api_secrets(secrets: HashMap<String, String>) -> Result<(), String> {
    // #1441：先校验全部 id，再快照旧值，最后逐条应用；中途失败尽力回滚已处理条目，
    // 杜绝“前几条已删/已写、后几条失败直接返回”的半表状态（“密钥已删但配置组仍在”不可恢复）。
    // 空串仍表示删除（config.ts removeConfig/removePreset 的显式删除依赖此语义）；
    // “无密钥≠删除”由前端只提交非空值保证（configMigration.nonEmptySecrets），迁移路径不再送空串。
    for id in secrets.keys() {
        validate_secret_id(id)?;
    }
    enum Previous {
        Missing,
        Present(String),
    }
    let mut previous: Vec<(String, Previous)> = Vec::with_capacity(secrets.len());
    for id in secrets.keys() {
        let prev = match keyring::Entry::new(API_SECRET_SERVICE, id) {
            Err(_) => Previous::Missing,
            Ok(entry) => match entry.get_password() {
                Ok(secret) => Previous::Present(secret),
                // 旧值读不出（未解锁/损坏）时按缺失记：回滚即删除本次写入，不残留不可追溯的值
                Err(_) => Previous::Missing,
            },
        };
        previous.push((id.clone(), prev));
    }
    let ordered: Vec<(String, String)> = secrets.into_iter().collect();
    let mut applied = 0usize;
    let mut first_error: Option<String> = None;
    for (id, secret) in &ordered {
        let result = (|| -> Result<(), String> {
            let entry = keyring::Entry::new(API_SECRET_SERVICE, id)
                .map_err(|e| format!("创建系统凭据项失败（{id}）：{e}"))?;
            if secret.is_empty() {
                match entry.delete_credential() {
                    Ok(()) => Ok(()),
                    Err(keyring::Error::NoEntry) => Ok(()),
                    Err(e) => Err(format!("删除系统凭据失败（{id}）：{e}")),
                }
            } else {
                entry
                    .set_password(secret)
                    .map_err(|e| format!("写入系统凭据失败（{id}）：{e}"))?;
                Ok(())
            }
        })();
        if let Err(error) = result {
            first_error = Some(error);
            break;
        }
        applied += 1;
    }
    if let Some(error) = first_error {
        let mut rollback_errors = Vec::new();
        for (id, _) in ordered.iter().take(applied) {
            let prev = previous.iter().find(|(p, _)| p == id).map(|(_, p)| p);
            let result = (|| -> Result<(), String> {
                let entry = keyring::Entry::new(API_SECRET_SERVICE, id)
                    .map_err(|e| format!("创建系统凭据项失败（{id}）：{e}"))?;
                match prev {
                    Some(Previous::Present(old)) => entry
                        .set_password(old)
                        .map_err(|e| format!("回滚写入失败（{id}）：{e}")),
                    _ => match entry.delete_credential() {
                        Ok(()) => Ok(()),
                        Err(keyring::Error::NoEntry) => Ok(()),
                        Err(e) => Err(format!("回滚删除失败（{id}）：{e}")),
                    },
                }
            })();
            if let Err(e) = result {
                rollback_errors.push(e);
            }
        }
        if rollback_errors.is_empty() {
            return Err(format!("{error}（已回滚 {applied} 条）"));
        }
        return Err(format!(
            "{error}（回滚 {applied} 条时又失败：{}）",
            rollback_errors.join("；")
        ));
    }
    Ok(())
}

/// #1329 + #1379：async + spawn_blocking（ServerHandle::stop 最多 join 5 秒，
/// 不再占用主线程冻结 UI）；先校验新根再动旧实例（目录无效时旧预览保持可用）；
/// 新实例绑定失败时尽力用旧根重启旧实例回滚。
#[tauri::command]
pub async fn start_preview_server(root: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start_preview_server_blocking(&root))
        .await
        .map_err(|e| format!("预览启动任务失败: {e}"))?
}

fn start_preview_server_blocking(root: &str) -> Result<Value, String> {
    // 校验期不持有锁、不碰旧实例：失败直接返回，旧预览保持可用（#1329 主路径）
    if let Err(error) = server::validate_preview_root(root) {
        return Err(error);
    }
    // 先释放旧实例再绑定端口（#782）：旧实现先 start 后 stop，连点「启动/刷新」时
    // 第二次绑定会在旧实例释放前失败，报「端口 17892 被占用」。
    // take 出来的 handle 在 stop 后仍保留 root，可供绑定失败时回滚重启。
    let old = {
        let mut guard = preview()
            .running
            .lock()
            .map_err(|_| "锁获取失败".to_string())?;
        guard.take()
    };
    if let Some(ref handle) = old {
        handle.stop();
    }
    match server::start(root) {
        Ok(handle) => {
            let port = handle.port();
            let url = format!("http://127.0.0.1:{port}/index.html");
            preview()
                .running
                .lock()
                .map_err(|_| "锁获取失败".to_string())?
                .replace(handle);
            // #1446：不再生成/回传装饰性 token（从未被校验，前端亦直接丢弃）。
            // 生效的防线是 loopback 绑定 + Host/DNS-rebinding 校验，见 server.rs handle_request 注释。
            Ok(serde_json::json!({ "url": url, "port": port }))
        }
        Err(error) => {
            // 端口被外部进程占用时旧实例已被停掉：尽力用旧根重启恢复，
            // 恢复也失败则如实返回双重错误，前端据此提示用户手动重试
            if let Some(old_handle) = old {
                let old_root = old_handle.preview_root().to_string_lossy().to_string();
                match server::start(&old_root) {
                    Ok(restored) => {
                        if let Ok(mut guard) = preview().running.lock() {
                            *guard = Some(restored);
                        }
                        return Err(format!("{error}（已恢复旧预览）"));
                    }
                    Err(restore_error) => {
                        return Err(format!("{error}（旧预览恢复失败：{restore_error}）"));
                    }
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn stop_preview_server() -> Result<(), String> {
    // #1379：stop 的 5 秒 join 等待放阻塞线程池，不冻结主线程/UI
    tauri::async_runtime::spawn_blocking(|| {
        let old = preview()
            .running
            .lock()
            .map_err(|_| "锁获取失败".to_string())?
            .take();
        if let Some(handle) = old {
            handle.stop();
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("预览停止任务失败: {e}"))?
}

/// #1330：Linux 打开命令的参数表（纯函数，可单测）：gio 必须带 `open` 子命令，
/// 直接 `gio <path>` 会报 Unknown command（退出码非零）；xdg-open/nautilus 直接接路径。
/// 仅 Linux 运行时与单测使用（Windows/macOS 分支用不到，避免 unused 警告）。
#[cfg(any(target_os = "linux", test))]
fn linux_open_args(cmd: &str, target: &str) -> Vec<String> {
    if cmd == "gio" {
        vec!["open".to_string(), target.to_string()]
    } else {
        vec![target.to_string()]
    }
}

/// #1330：候选命令全部失败时的错误文案（带已尝试列表，方便用户定位缺哪个工具）。
#[cfg(any(target_os = "linux", test))]
fn linux_open_failed(what: &str, attempted: &[String]) -> String {
    format!("{what}失败，已尝试：{}（均不可用或返回失败）", attempted.join("、"))
}

/// #1330：运行单个打开命令，按退出码判定（spawn 成功≠打开成功：
/// xdg-open 存在但无默认浏览器/headless 时退出码非零，必须判 status().success()）。
#[cfg(target_os = "linux")]
fn try_linux_open(cmd: &str, target: &str) -> bool {
    std::process::Command::new(cmd)
        .args(linux_open_args(cmd, target))
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let safe = resolve_safe_path(&path)?;
    let p = safe;
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
        // #1330：按退出码判定 + gio 带 open 子命令；未经 Linux 真机验证（见回写）。
        let dir_str = dir.to_string_lossy().to_string();
        let mut attempted = Vec::new();
        for cmd in ["xdg-open", "gio", "nautilus"] {
            attempted.push(if cmd == "gio" { "gio open".to_string() } else { cmd.to_string() });
            if try_linux_open(cmd, &dir_str) {
                return Ok(());
            }
        }
        return Err(linux_open_failed("打开文件管理器", &attempted));
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
    // 只允许 http/https：旧实现把任意字符串交给 explorer/open，可借系统关联启动本地程序、
    // 访问 file:// 或 UNC（\\host\share）触发 NTLM 外泄
    let trimmed = url.trim();
    let lower = trimmed.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("仅支持打开 http/https 链接".to_string());
    }
    if trimmed.contains('\\') || trimmed.contains('\n') || trimmed.contains('\r') {
        return Err("链接包含非法字符".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(trimmed).spawn().map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(trimmed).spawn().map_err(|e| format!("打开失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        // #1330：同 open_in_explorer（gio open + 退出码判定）；未经 Linux 真机验证（见回写）。
        let mut attempted = Vec::new();
        for cmd in ["xdg-open", "gio"] {
            attempted.push(if cmd == "gio" { "gio open".to_string() } else { cmd.to_string() });
            if try_linux_open(cmd, trimmed) {
                return Ok(());
            }
        }
        return Err(linux_open_failed("打开链接", &attempted));
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
    // 纯代码色度键：立绘/物品背景多为纯色（提示词强制 solid background），色度键即可干净抠出。
    // 抠图是 CPU 密集 + 大内存操作（解码/洪水填充/PNG 编码），必须放阻塞线程池：
    // 直接内联在 async 里会占满 async 运行时线程，拖慢其他命令（如下载状态轮询）。
    let input = data_b64.clone();
    let chroma = tauri::async_runtime::spawn_blocking(move || {
        crate::cutout::cutout_with_stats(&input, threshold)
    })
    .await
    .map_err(|e| format!("抠图任务执行失败: {e}"))?;
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
pub async fn has_transparency(data_b64: String) -> Result<bool, String> {
    // #1413：base64 解码+整图解码+全像素扫描是 CPU 密集（每张候选图都调），放阻塞线程池
    tauri::async_runtime::spawn_blocking(move || crate::cutout::has_transparency(&data_b64))
        .await
        .map_err(|e| format!("透明检测任务执行失败: {e}"))?
}

#[tauri::command]
pub async fn build_zip(
    source_dir: String,
    zip_path: String,
    exclude: Vec<String>,
) -> Result<serde_json::Value, String> {
    // ZIP 压缩是 CPU + 磁盘密集阻塞操作，放阻塞线程池执行
    let safe_src = resolve_safe_path(&source_dir)?;
    let safe_zip = resolve_safe_path(&zip_path)?;
    if safe_src == safe_zip {
        return Err("源目录与目标 zip 相同，已拒绝".to_string());
    }
    let safe_src = safe_src.to_string_lossy().to_string();
    let safe_zip = safe_zip.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        build_zip_sync(&safe_src, &safe_zip, &exclude)
    })
    .await
    .map_err(|e| format!("压缩任务执行失败: {e}"))?
}

fn build_zip_sync(
    source_dir: &str,
    zip_path: &str,
    exclude: &[String],
) -> Result<serde_json::Value, String> {
    let src = std::path::PathBuf::from(source_dir);
    if !src.is_dir() {
        return Err("源目录不存在".to_string());
    }
    if let Some(parent) = std::path::Path::new(zip_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let result = write_zip_contents(&src, zip_path, exclude);
    if result.is_err() {
        // 失败时删除目标 zip：半成品（缺文件/未收尾）会被用户当成完整发布包上传
        let _ = std::fs::remove_file(zip_path);
    }
    result
}

fn write_zip_contents(
    src: &Path,
    zip_path: &str,
    exclude: &[String],
) -> Result<serde_json::Value, String> {
    let file = std::fs::File::create(zip_path).map_err(|e| format!("创建 zip 失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        // #1440：启用 ZIP64。项目内单文件 ≥4GiB（如导入的长视频）否则必失败
        // 「Large file option has not been set」且半成品 zip 被删除；对小文件行为一致。
        .large_file(true);

    // 排除项按「路径组件」精确匹配：把 "game/vocal" 这类写法归一化为组件序列，
    // 旧实现 s.ends_with(e) 会把 "not.novel2vn"、"xnode_modules" 等相似名误伤
    let patterns: Vec<Vec<String>> = exclude
        .iter()
        .map(|e| {
            e.split(['/', '\\'])
                .filter(|s| !s.is_empty() && *s != ".")
                .map(str::to_string)
                .collect()
        })
        .filter(|p: &Vec<String>| !p.is_empty())
        .collect();

    fn is_excluded(rel: &[String], patterns: &[Vec<String>]) -> bool {
        patterns.iter().any(|pat| {
            if pat.len() == 1 {
                rel.iter().any(|c| c == &pat[0])
            } else {
                rel.windows(pat.len()).any(|w| w == pat.as_slice())
            }
        })
    }

    let mut file_count = 0u64;
    let mut total_size = 0u64;

    // #1116 纵深防御：目标 zip 自身不得进包（用户把 zip 存在项目目录内时，
    // 前端虽已拦截，Rust 侧仍需跳过正在写入的半成品；文件名按 canonical 路径比对）
    let target_canon = std::fs::canonicalize(zip_path).ok();

    fn walk(
        dir: &std::path::Path,
        rel: &mut Vec<String>,
        writer: &mut zip::ZipWriter<std::io::BufWriter<std::fs::File>>,
        options: zip::write::SimpleFileOptions,
        patterns: &[Vec<String>],
        file_count: &mut u64,
        total_size: &mut u64,
        target_canon: &Option<std::path::PathBuf>,
    ) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))? {
            let entry = entry.map_err(|e| format!("读取条目失败: {e}"))?;
            let path = entry.path();
            // 不跟随符号链接（file_type 取自目录项本身）：链接可能指回父目录导致无限递归，
            // 或把导出目录外的文件打包进发布物
            let file_type = entry.file_type().map_err(|e| format!("读取条目类型失败: {e}"))?;
            if file_type.is_symlink() {
                eprintln!("[novelforge] 跳过符号链接: {}", path.display());
                continue;
            }
            rel.push(entry.file_name().to_string_lossy().to_string());
            if is_excluded(rel, patterns) {
                rel.pop();
                continue;
            }
            if file_type.is_dir() {
                let zip_name = rel.join("/");
                writer
                    .add_directory(zip_name, options)
                    .map_err(|e| format!("写入目录失败: {e}"))?;
                walk(&path, rel, writer, options, patterns, file_count, total_size, target_canon)?;
            } else {
                let zip_name = rel.join("/");
                if let Some(target) = target_canon {
                    // 目标 zip 自身：跳过（尤其当用户把它存在源目录内时）
                    if std::fs::canonicalize(&path).ok().as_ref() == Some(target) {
                        eprintln!("[novelforge] 跳过打包目标自身: {}", path.display());
                        rel.pop();
                        continue;
                    }
                }
                // 流式写入：io::copy 分块拷贝，大视频/配音不再整块读进内存
                let mut reader = std::fs::File::open(&path).map_err(|e| format!("读取文件失败: {e}"))?;
                let size = reader.metadata().map(|m| m.len()).unwrap_or(0);
                writer
                    .start_file(zip_name, options)
                    .map_err(|e| format!("写入文件失败: {e}"))?;
                std::io::copy(&mut reader, writer).map_err(|e| format!("写入数据失败: {e}"))?;
                *file_count += 1;
                *total_size += size;
            }
            rel.pop();
        }
        Ok(())
    }

    let mut rel = Vec::new();
    walk(src, &mut rel, &mut writer, options, &patterns, &mut file_count, &mut total_size, &target_canon)?;
    writer.finish().map_err(|e| format!("zip 收尾失败: {e}"))?;

    Ok(serde_json::json!({ "fileCount": file_count, "sizeBytes": total_size }))
}

#[cfg(test)]
mod atomic_write_tests {
    use super::{atomic_write, atomic_write_temp_path, bless_project_dir, cancel_http_request, cleanup_stale_dir, cleanup_stale_files, copy_file, display_path, guard_against_wipe, has_transparency, http_aborts, http_target, is_atomic_tmp_name, linux_open_args, linux_open_failed, list_dir, path_exists, path_within_home_credential_dir, reject_unsafe_path_syntax, replace_path, resolve_safe_path, ssrf_reject_reason, strip_verbatim_prefix, validate_secret_id, write_api_secrets, write_text_file, HttpRequestArgs};
    use std::path::Path;
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use image::ImageEncoder as _;
    use std::collections::HashMap;

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

    #[test]
    fn atomic_write_uses_unique_temporary_paths() {
        let path = std::env::temp_dir().join("novelforge_atomic_unique.json");
        assert_ne!(atomic_write_temp_path(&path), atomic_write_temp_path(&path));
    }

    #[test]
    fn atomic_tmp_name_matches_only_own_pattern() {
        assert!(is_atomic_tmp_name("assets.json.1234.5.tmp"));
        assert!(is_atomic_tmp_name("project_state.json.99.0.tmp"));
        assert!(!is_atomic_tmp_name("assets.json.tmp"));
        assert!(!is_atomic_tmp_name("notes.tmp"));
        assert!(!is_atomic_tmp_name("assets.json.abc.5.tmp"));
        assert!(!is_atomic_tmp_name("assets.json.1234.5.bak"));
    }

    #[test]
    fn cleanup_removes_tmp_and_restores_backup() {
        let dir = std::env::temp_dir().join("novelforge_cleanup_stale_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("cache")).unwrap();
        // 崩溃残留：临时文件
        std::fs::write(dir.join("cache").join("assets.json.1234.5.tmp"), b"partial").unwrap();
        // 崩溃残留：替换中断（原路径缺失）→ 应恢复
        std::fs::write(dir.join("orphan.bin.replace-backup"), b"old").unwrap();
        // 替换已完成、备份未清 → 应删除备份
        std::fs::write(dir.join("game.txt"), b"new").unwrap();
        std::fs::write(dir.join("game.txt.replace-backup"), b"old").unwrap();

        let mut removed = 0u64;
        let mut restored = 0u64;
        cleanup_stale_dir(&dir, 6, &mut removed, &mut restored);

        assert_eq!(removed, 2, "应删除 1 个 .tmp 与 1 个已完成替换的备份");
        assert_eq!(restored, 1, "应恢复 1 个中断替换的备份");
        assert!(!dir.join("cache").join("assets.json.1234.5.tmp").exists());
        assert_eq!(std::fs::read_to_string(dir.join("game.txt")).unwrap(), "new");
        assert!(!dir.join("game.txt.replace-backup").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancel_http_request_hits_registered_request_only_once() {
        // #784：注册空操作（避免真实网络），取消应命中一次，再次取消应未命中
        http_aborts().lock().unwrap().insert(424242, Box::new(|| {}));
        assert!(cancel_http_request(424242).unwrap(), "首次取消应命中在途请求");
        assert!(!cancel_http_request(424242).unwrap(), "重复取消不应再次命中");
    }

    #[test]
    fn credential_dirs_are_sensitive_on_all_platforms() {
        // #1416：纯函数单测（不碰环境变量，避免并行测试竞态）
        let home = Path::new("/home/testuser");
        for rel in [".ssh", ".aws", ".gnupg", ".kube", ".config/gcloud"] {
            let dir = home.join(rel);
            assert!(path_within_home_credential_dir(&dir, home), "{rel} 应敏感");
            assert!(
                path_within_home_credential_dir(&dir.join("id_rsa"), home),
                "{rel} 下文件应敏感"
            );
        }
        assert!(!path_within_home_credential_dir(&home.join("projects/a.txt"), home));
        assert!(
            !path_within_home_credential_dir(&home.join(".ssh-backup/key"), home),
            "相似名前缀不得误伤"
        );
    }

    #[test]
    fn secret_ids_reject_unsafe_values() {        assert!(validate_secret_id("llm-config_1").is_ok());
        assert!(validate_secret_id("").is_err());
        assert!(validate_secret_id("../credential").is_err());
        assert!(validate_secret_id(&"x".repeat(129)).is_err());
    }

    #[test]
    fn linux_open_args_use_gio_open_subcommand() {
        // #1330：分支逻辑单测（平台无关的纯函数部分；真机 spawn/退出码需 Linux 验证）
        assert_eq!(
            linux_open_args("gio", "https://example.com"),
            vec!["open".to_string(), "https://example.com".to_string()]
        );
        assert_eq!(
            linux_open_args("xdg-open", "https://example.com"),
            vec!["https://example.com".to_string()]
        );
        assert_eq!(linux_open_args("nautilus", "/tmp/x"), vec!["/tmp/x".to_string()]);
        let msg = linux_open_failed("打开链接", &["xdg-open".to_string(), "gio open".to_string()]);
        assert!(msg.contains("xdg-open") && msg.contains("gio open"), "{msg}");
    }

    #[test]
    fn write_api_secrets_validates_all_ids_before_applying() {
        // #1441：全量校验前置——非法 id 直接 Err，且发生在任何凭据库读写之前（无副作用，CI 可执行）
        let mut secrets = HashMap::new();
        secrets.insert("valid-id-1".to_string(), "secret".to_string());
        secrets.insert("../evil".to_string(), "x".to_string());
        assert!(write_api_secrets(secrets).is_err());
    }

    #[test]
    fn http_targets_reject_non_http_protocols() {
        let args = HttpRequestArgs {
            method: "GET".to_string(),
            url: "file:///etc/passwd".to_string(),
            headers: HashMap::new(),
            body: None,
            body_base64: None,
            timeout_secs: 120,
            allow_lan: false,
            stream: false,
        };
        assert!(http_target(&args).is_err());
    }

    #[test]
    fn path_syntax_rejects_unc_nul_and_file_scheme() {
        // #1292：UNC/设备路径、NUL、file: scheme 在入口即拒绝
        assert!(reject_unsafe_path_syntax(r"\\host\share\a.txt").is_err());
        assert!(reject_unsafe_path_syntax("//host/share/a.txt").is_err());
        assert!(reject_unsafe_path_syntax("file:///etc/passwd").is_err());
        assert!(reject_unsafe_path_syntax("a\0b").is_err());
        assert!(reject_unsafe_path_syntax("   ").is_err());
        assert!(reject_unsafe_path_syntax("game/scene/ch1.txt").is_ok());
    }

    #[test]
    fn safe_path_accepts_inside_roots_and_blocks_escape() {
        // #1292：允许根内放行；UNC 拒绝；破坏性守卫拒绝允许根自身
        let dir = std::env::temp_dir().join("novelforge_safepath_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let inner = dir.join("sub").join("a.txt");
        std::fs::create_dir_all(inner.parent().unwrap()).unwrap();
        std::fs::write(&inner, b"hi").unwrap();
        assert!(resolve_safe_path(&inner.to_string_lossy()).is_ok());
        assert!(resolve_safe_path(r"\\host\share\a.txt").is_err());
        let tmp_root = std::env::temp_dir()
            .canonicalize()
            .unwrap_or_else(|_| std::env::temp_dir());
        assert!(guard_against_wipe(&tmp_root).is_err());
        assert!(guard_against_wipe(&inner).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blessed_dirs_open_user_project_outside_static_roots() {
        // #1292 回归：用户工程在静态三根（工作目录/临时目录/家目录）之外时（如 D 盘），
        // 未登记一律拒绝；经 bless_project_dir 登记后放行；盘符根与系统敏感目录拒绝登记。
        // 用一个"看起来在外面"的路径：Unix 取 / 下不存在的目录（canonicalize 经 / 拼回，
        // 不落任何静态根）；Windows 用不存在的盘符同理。
        #[cfg(not(target_os = "windows"))]
        let outside = "/novelforge-bless-test-xyz/project/file.txt";
        #[cfg(target_os = "windows")]
        let outside = "Z:/novelforge-bless-test-xyz/project/file.txt";
        assert!(resolve_safe_path(outside).is_err(), "未登记的外部目录应拒绝");

        // 登记一个真实存在的临时子目录：登记成功，且其内文件可解析
        let dir = std::env::temp_dir().join("novelforge_bless_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(bless_project_dir(dir.to_string_lossy().to_string()).is_ok());
        assert!(resolve_safe_path(&dir.join("a.txt").to_string_lossy()).is_ok());
        let _ = std::fs::remove_dir_all(&dir);

        // 盘符根 / 文件系统根不予登记（防止一次登记放行整盘）
        #[cfg(target_os = "windows")]
        assert!(bless_project_dir("C:\\".to_string()).is_err(), "盘符根不可登记");
        #[cfg(not(target_os = "windows"))]
        assert!(bless_project_dir("/".to_string()).is_err(), "文件系统根不可登记");
        // 系统敏感目录不予登记
        #[cfg(target_os = "windows")]
        if let Ok(windir) = std::env::var("SystemRoot") {
            assert!(bless_project_dir(windir).is_err(), "系统目录不可登记");
        }
    }

    #[test]
    fn verbatim_prefix_is_normalized_not_rejected_as_unc() {
        // #1292 回归：canonicalize 产出（及前端回传）的 `\\?\D:\...` 不得被当 UNC 拒绝，
        // 否则 list_dir 返回的 entry.path 下一次调用即死（自产自销式互斥）；真 UNC 仍拒绝。
        assert_eq!(
            strip_verbatim_prefix(r"\\?\D:\proj\a.txt").unwrap(),
            r"D:\proj\a.txt".to_string()
        );
        assert!(strip_verbatim_prefix(r"\\?\UNC\host\share").is_err());
        assert!(strip_verbatim_prefix(r"\\host\share").is_ok()); // 非 verbatim 走下行 UNC 检查
        assert!(resolve_safe_path(r"\\host\share\a.txt").is_err());
        // 去前缀展示函数：普通路径原样返回
        assert_eq!(
            display_path(std::path::Path::new(r"D:\proj\a.txt")),
            r"D:\proj\a.txt".to_string()
        );
    }

    #[test]
    fn ssrf_blocks_private_loopback_and_tricks() {
        // #1293：私网/回环（非 Ollama 端口）/十进制与十六进制混淆 IP/内网主机名一律拦截
        let blocked = [
            "http://10.0.0.5/v1",
            "http://192.168.1.10:8080/v1",
            "http://172.20.4.1/v1",
            "http://169.254.169.254/latest/meta-data",
            "http://0.0.0.0/v1",
            "http://127.0.0.1:8080/v1",
            "http://localhost:3000/v1",
            "http://[::1]/v1",
            "http://2130706433/v1",
            "http://0x7f000001/v1",
            "http://evil.internal/v1",
            "http://nas.local/v1",
            "http://intranet/v1",
        ];
        for url in blocked {
            let target = reqwest::Url::parse(url).unwrap();
            assert!(ssrf_reject_reason(&target, false).is_some(), "应拦截 SSRF 目标: {url}");
        }
        // 公网 API 与本地模型通道（回环 11434）放行
        for url in [
            "https://api.openai.com/v1",
            "http://localhost:11434/v1",
            "http://127.0.0.1:11434/v1",
        ] {
            let target = reqwest::Url::parse(url).unwrap();
            assert!(ssrf_reject_reason(&target, false).is_none(), "应放行合法目标: {url}");
        }
        // 入口级：http_target 同样拦截元数据地址
        let args = HttpRequestArgs {
            method: "GET".to_string(),
            url: "http://169.254.169.254/latest/meta-data".to_string(),
            headers: HashMap::new(),
            body: None,
            body_base64: None,
            timeout_secs: 120,
            allow_lan: false,
            stream: false,
        };
        assert!(http_target(&args).is_err());
    }

    #[test]
    fn ssrf_allow_lan_opens_loopback_and_private_only() {
        // #1411：默认关闭 = 旧口径（本机其它端口/私网/内网名全部拒绝）
        for url in [
            "http://127.0.0.1:8080/v1",
            "http://localhost:1234/v1",
            "http://192.168.1.10:8000/v1",
            "http://10.0.0.5/v1",
            "http://nas.local/v1",
            "http://intranet/v1",
        ] {
            let target = reqwest::Url::parse(url).unwrap();
            assert!(ssrf_reject_reason(&target, false).is_some(), "默认应拦截: {url}");
            assert!(ssrf_reject_reason(&target, true).is_none(), "显式放行后应允许: {url}");
        }
        // 公网与 Ollama 11434：无论开关都放行
        for url in ["https://api.openai.com/v1", "http://localhost:11434/v1"] {
            let target = reqwest::Url::parse(url).unwrap();
            assert!(ssrf_reject_reason(&target, false).is_none());
            assert!(ssrf_reject_reason(&target, true).is_none());
        }
        // 高危目标：即使显式放行也不解禁（未指定/组播/云元数据 IP 与主机名）
        for url in [
            "http://169.254.169.254/latest/meta-data",
            "http://0.0.0.0/v1",
            "http://224.0.0.1/v1",
            "http://metadata.google.internal/v1",
            "http://instance-data/v1",
        ] {
            let target = reqwest::Url::parse(url).unwrap();
            assert!(ssrf_reject_reason(&target, true).is_some(), "放行后仍应拦截: {url}");
        }
        // 入口级：allowLan 透传到 http_target（默认关闭仍拦截局域网）
        let lan_args = HttpRequestArgs {
            method: "GET".to_string(),
            url: "http://192.168.1.10:8000/v1/models".to_string(),
            headers: HashMap::new(),
            body: None,
            body_base64: None,
            timeout_secs: 20,
            allow_lan: true,
            stream: false,
        };
        assert!(http_target(&lan_args).is_ok());
        let default_args = HttpRequestArgs { allow_lan: false, ..lan_args };
        assert!(http_target(&default_args).is_err());
    }

    /// #1413：阻塞文件命令改为 async + spawn_blocking 后的接线回归
    /// （临时目录在允许根内，resolve_safe_path 放行）。
    #[tokio::test]
    async fn blocking_file_commands_roundtrip() {
        let dir = std::env::temp_dir().join("novelforge_blocking_cmds_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sub = dir.join("sub");
        let src = sub.join("a.txt");
        write_text_file(src.to_string_lossy().to_string(), "hello".to_string())
            .await
            .unwrap();
        assert!(path_exists(src.to_string_lossy().to_string()));
        let list = list_dir(sub.to_string_lossy().to_string()).await.unwrap();
        assert_eq!(list.as_array().map(|a| a.len()).unwrap_or(0), 1);
        let dst = dir.join("b.txt");
        copy_file(src.to_string_lossy().to_string(), dst.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "hello");
        // replace_path：目标已存在时走备份-发布-清理路径
        let src2 = dir.join("c.txt");
        std::fs::write(&src2, b"new").unwrap();
        replace_path(src2.to_string_lossy().to_string(), dst.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "new");
        // 1x1 不透明 PNG：透明检测应 Ok(false)
        let mut rgba = image::RgbaImage::new(1, 1);
        rgba.put_pixel(0, 0, image::Rgba([255, 0, 0, 255]));
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(rgba.as_raw(), 1, 1, image::ExtendedColorType::Rgba8)
            .unwrap();
        assert_eq!(has_transparency(B64.encode(&png)).await.unwrap(), false);
        // cleanup_stale_files：.tmp 删除、中断替换恢复
        std::fs::write(dir.join("x.json.1234.5.tmp"), b"partial").unwrap();
        std::fs::write(dir.join("orphan.bin.replace-backup"), b"old").unwrap();
        let report = cleanup_stale_files(dir.to_string_lossy().to_string(), Some(3))
            .await
            .unwrap();
        assert_eq!(report["removed"], serde_json::json!(1));
        assert_eq!(report["restored"], serde_json::json!(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod http_stream_tests {
    use super::{limited_response_bytes, read_streaming_bytes};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    /// 本地假服务：接受 2 个连接，按 chunked 编码分块返回 payload（块间 sleep 模拟流式到达）。
    /// 与 server.rs 的 TcpStream 测试同一写法（直接写原始 HTTP 响应）。
    fn spawn_chunked_server(chunks: Vec<Vec<u8>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for _ in 0..2 {
                let Ok((mut sock, _)) = listener.accept() else { break };
                // 读到请求头即停（测试只发 GET，无请求体）
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf);
                sock.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
                for chunk in &chunks {
                    sock.write_all(format!("{:x}\r\n", chunk.len()).as_bytes()).unwrap();
                    sock.write_all(chunk).unwrap();
                    sock.write_all(b"\r\n").unwrap();
                    sock.flush().unwrap();
                    std::thread::sleep(Duration::from_millis(20));
                }
                sock.write_all(b"0\r\n\r\n").unwrap();
                sock.flush().unwrap();
            }
        });
        format!("http://{addr}/stream")
    }

    async fn get(url: &str) -> reqwest::Response {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap()
    }

    /// 核心契约：流式读取累积的字节与整包读取完全一致（前端拿到的 bodyBase64 与旧路径相同），
    /// 且增量拼接后同样等于完整响应（剧本路径的进度计数据此可靠）。
    #[tokio::test]
    async fn streaming_read_matches_full_read() {
        let payload: Vec<u8> =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n".repeat(512);
        let chunks: Vec<Vec<u8>> = payload.chunks(4096).map(|c| c.to_vec()).collect();
        let url = spawn_chunked_server(chunks);

        let streamed = {
            let mut emitted: Vec<u8> = Vec::new();
            let mut emissions = 0usize;
            let bytes = read_streaming_bytes(get(&url).await, |chunk| {
                emitted.extend_from_slice(chunk);
                emissions += 1;
            })
            .await
            .unwrap();
            assert!(emissions >= 1, "流式读取至少要发一次增量");
            assert_eq!(emitted, bytes, "增量拼接必须与完整字节一致");
            bytes
        };

        let full = limited_response_bytes(get(&url).await).await.unwrap();
        assert_eq!(streamed, full, "流式与整包读取的字节必须完全一致");
        assert_eq!(full, payload, "响应体应与假服务发送的 payload 一致");
    }

    /// 小响应（单块 < 8KB）在流结束时也要 flush 一次，增量不能丢。
    #[tokio::test]
    async fn small_response_is_flushed_once() {
        let payload = b"data: [DONE]\n\n".to_vec();
        let url = spawn_chunked_server(vec![payload.clone()]);
        let mut emitted: Vec<u8> = Vec::new();
        let mut emissions = 0usize;
        let bytes = read_streaming_bytes(get(&url).await, |chunk| {
            emissions += 1;
            emitted.extend_from_slice(chunk);
        })
        .await
        .unwrap();
        assert_eq!(emissions, 1, "小响应应在结束时 flush 恰好一次");
        assert_eq!(emitted, payload);
        assert_eq!(bytes, payload);
    }
}

#[cfg(test)]
mod zip_tests {
    use super::build_zip_sync;

    fn read_zip_names(zip_path: &std::path::Path) -> Vec<String> {
        let f = std::fs::File::open(zip_path).unwrap();
        let mut reader = zip::ZipArchive::new(f).unwrap();
        (0..reader.len())
            .map(|i| reader.by_index(i).unwrap().name().to_string())
            .collect()
    }

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
        let res = build_zip_sync(
            &dir.to_string_lossy(),
            &zip_path.to_string_lossy(),
            &[".novel2vn".to_string()],
        );
        assert!(res.is_ok(), "build_zip 失败: {:?}", res.err());

        let names = read_zip_names(&zip_path);
        assert!(names.iter().any(|n| n.contains("中文名")), "中文文件名丢失: {names:?}");
        assert!(names.iter().any(|n| n == "index.html"), "根文件丢失: {names:?}");
        assert!(!names.iter().any(|n| n.contains(".novel2vn")), "排除目录被打包: {names:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_skips_itself_when_target_inside_source() {
        // #1116 纵深防御：目标 zip 在源目录内时，打包不得把正在写入的半成品打进包
        let dir = std::env::temp_dir().join("novelforge_zip_self_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();
        let target = dir.join("out.zip");
        let res = build_zip_sync(&dir.to_string_lossy(), &target.to_string_lossy(), &[]);
        assert!(res.is_ok(), "build_zip 失败: {:?}", res.err());
        let names = read_zip_names(&target);
        assert_eq!(names, vec!["a.txt".to_string()], "zip 不应包含自身: {names:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_exclude_matches_path_components_exactly() {
        // B126 回归：排除 ".novel2vn" 不能误伤 "not.novel2vn" / "xnode_modules" 这类相似名
        let dir = std::env::temp_dir().join("novelforge_zip_exclude_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".novel2vn")).unwrap();
        std::fs::create_dir_all(dir.join("not.novel2vn")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join(".novel2vn/cache.json"), "secret").unwrap();
        std::fs::write(dir.join("not.novel2vn/keep.txt"), "keep").unwrap();
        std::fs::write(dir.join("node_modules/keep.txt"), "keep").unwrap();
        std::fs::write(dir.join("index.html"), "<html/>").unwrap();

        let zip_path = dir.join("out.zip");
        let res = build_zip_sync(
            &dir.to_string_lossy(),
            &zip_path.to_string_lossy(),
            &[".novel2vn".to_string(), "node_modules".to_string()],
        );
        assert!(res.is_ok(), "build_zip 失败: {:?}", res.err());

        let names = read_zip_names(&zip_path);
        assert!(!names.iter().any(|n| n.starts_with(".novel2vn/")), "应排除 .novel2vn: {names:?}");
        assert!(!names.iter().any(|n| n.starts_with("node_modules/")), "应排除 node_modules: {names:?}");
        assert!(
            names.iter().any(|n| n.starts_with("not.novel2vn/")),
            "相似名目录被误伤: {names:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
