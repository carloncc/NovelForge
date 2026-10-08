use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tiny_http::{Header, Server};

pub struct ServerHandle {
    /// 持有 Arc<Server> 防止监听 socket 被提前 drop
    #[allow(dead_code)]
    server: Arc<Server>,
    stop_flag: Arc<AtomicUsize>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
    port: u16,
    /// 已校验的预览根（canonical）：#1329 回滚重启旧实例用
    root: PathBuf,
}

/// #1294：每请求 thread::spawn 无上限 → 请求洪水打爆线程；并发处理数封顶，超限回 503。
const MAX_PREVIEW_REQUEST_THREADS: usize = 64;
static ACTIVE_PREVIEW_REQUESTS: AtomicUsize = AtomicUsize::new(0);

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.port
    }
    /// #1329 回滚用：旧实例的已校验根
    pub fn preview_root(&self) -> &Path {
        &self.root
    }
    pub fn stop(&self) {
        self.stop_flag.store(1, Ordering::Relaxed);
        if let Ok(mut guard) = self.thread.lock() {
            if let Some(t) = guard.take() {
                // join 可能被慢客户端（响应写阻塞）拖住：最多等 5 秒，
                // 超时则放弃 join 并 detach（线程已收到停止标志，处理完当前请求后会自行退出）。
                // 若无限等待，UI 侧的 stop_preview_server 命令会一起卡住。
                let deadline = Instant::now() + Duration::from_secs(5);
                while !t.is_finished() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(50));
                }
                if t.is_finished() {
                    let _ = t.join();
                } else {
                    eprintln!("[novelforge] 预览服务器线程 5 秒内未退出，已放弃等待（后台 detach）");
                }
            }
        }
    }
}

/// #1294 + #1329：先校验根再绑定端口。旧顺序（先绑定、后 canonicalize）有两个坏处：
/// 目录无效时调用方已付出绑定代价，且 commands 侧“先停旧实例”后才发现根无效；
/// 现在目录无效直接返回，旧预览不受影响。
pub fn start(root: &str) -> Result<ServerHandle, String> {
    let canon = validate_preview_root(root)?;
    let server = Server::http("127.0.0.1:17892")
        .map_err(|e| format!("启动预览服务器失败（端口 17892 被占用？）: {e}"))?;
    start_with_server(canon.to_string_lossy().as_ref(), server)
}

/// 预览根校验：必须存在、是目录、且含 index.html（即已生成的项目输出目录）。
/// 把 Documents 等任意目录变成 http 分享的口子在此堵住。
pub fn validate_preview_root(root: &str) -> Result<PathBuf, String> {
    let canon = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("目录无效: {e}"))?;
    if !canon.is_dir() {
        return Err("预览根不是有效目录".to_string());
    }
    if !canon.join("index.html").is_file() {
        return Err("目录不是有效的预览输出（缺少 index.html），已拒绝分享".to_string());
    }
    Ok(canon)
}

fn request_header_value(request: &tiny_http::Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

/// #1294 DNS rebinding 防护：Host 必须指向本机预览端口。
/// 无 Host 头（HTTP/1.0 兼容/测试直连）时放行——重绑攻击必然携带攻击者 Host。
fn preview_host_allowed(host: Option<&str>, port: u16) -> bool {
    let Some(raw) = host else {
        return true;
    };
    let h = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    // 拆 host:port（IPv6 形如 [::1]:port）
    let (name, req_port) = if let Some(stripped) = h.strip_prefix('[') {
        let Some(end) = stripped.find(']') else {
            return false;
        };
        let name = &stripped[..end];
        let rest = &stripped[end + 1..];
        let req_port = rest.strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
        (name.to_string(), req_port)
    } else if let Some((name, port_str)) = h.rsplit_once(':') {
        // 127.0.0.1:17892 / localhost:17892；无端口时整体即主机名
        match port_str.parse::<u16>() {
            Ok(p) => (name.to_string(), Some(p)),
            Err(_) => (h.clone(), None),
        }
    } else {
        (h.clone(), None)
    };
    if name != "127.0.0.1" && name != "localhost" && name != "::1" {
        return false;
    }
    // 带端口时必须与本实例端口一致（测试直连常省略端口，此时放行）
    if let Some(p) = req_port {
        return p == port;
    }
    true
}

/// 跨站读防护：请求携带 Origin/Referer 时必须同源（本机预览端口），否则 403。
/// 预览 iframe 内的同源子资源天然满足；攻击者页面 fetch 会带上 evil Origin 而被拦。
/// 缺失时放行（顶层导航/无 Referer 的首跳不受影响）。
fn preview_origin_allowed(value: Option<&str>, port: u16) -> bool {
    let Some(raw) = value else {
        return true;
    };
    let v = raw.trim().to_ascii_lowercase();
    // 归一化成 "scheme://authority"：Origin 不带路径，Referer 带（"http://127.0.0.1:17892/index.html"）
    let origin = v.split(['/', '?', '#']).take(3).collect::<Vec<_>>().join("/");
    // #1518：应用自身页面必须放行。预览页把游戏放进 iframe，浏览器默认会带上
    // Referer=http://tauri.localhost/（Tauri webview）或 http://localhost:5173/（dev server），
    // 两者都不在下面的白名单里 → 应用自己的预览 iframe 被 403 打不开（控制台只有 forbidden）。
    // 放行这几个来源不削弱 DNS rebinding / 跨站读防护：外部站点不可能持有这些 origin。
    if matches!(
        origin.as_str(),
        "http://tauri.localhost" | "tauri://localhost" | "http://localhost:5173" | "http://127.0.0.1:5173"
    ) {
        return true;
    }
    // #1475：原实现用 starts_with("http://127.0.0.1:{port}") 做前缀比对，
    // 端口 ≤6553 时 "http://127.0.0.1:50001" 会被误判为同源（17892 这类 5 位端口碰巧躲过）。
    // 这里改为解析出 scheme/host/port 后精确比对。
    for authority in ["127.0.0.1", "localhost", "[::1]"] {
        let prefix = format!("http://{authority}");
        let Some(rest) = origin.strip_prefix(&prefix) else {
            continue;
        };
        // origin 必须是 host:port，且端口与本实例一致（split 至少产出一段，unwrap_or 仅兜底）
        let auth = rest.split(['/', '?', '#']).next().unwrap_or("");
        return match auth.strip_prefix(':') {
            Some(p) => p.parse::<u16>() == Ok(port),
            None => false,
        };
    }
    false
}

/// #1294：.novel2vn 工程目录（含原文与成本）与点文件一律不对外提供。
fn is_preview_blocked(root: &Path, candidate: &Path) -> bool {
    // #1474：原实现只拦「叶子是点文件」与「路径组件等于 .novel2vn」，于是子目录里的点目录
    // （如 <root>/.cache/x.json、.bak/secret）能被同机任意进程 GET 出来，与本函数承诺的
    // 「点文件一律不对外」不符。现在按相对路径的**任一组件**以 '.' 开头即拦截。
    if let Ok(rel) = candidate.strip_prefix(root) {
        if rel.components().any(|c| {
            c.as_os_str()
                .to_str()
                .is_some_and(|name| name.starts_with('.'))
        }) {
            return true;
        }
    }
    // 落在 root 之外（或 strip 失败）时退回叶子检查，保持原有兜底语义
    candidate
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

/// 在已绑定的 Server 上启动预览服务（测试用 127.0.0.1:0 拿临时端口，避免与开发环境端口冲突）
fn start_with_server(root: &str, server: Server) -> Result<ServerHandle, String> {
    let root = validate_preview_root(root)?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|addr| addr.port())
        .unwrap_or(17892);
    let server = Arc::new(server);
    let stop_flag = Arc::new(AtomicUsize::new(0));

    let srv = server.clone();
    let flag = stop_flag.clone();
    let r = Arc::new(root.clone());
    let thread = thread::spawn(move || {
        while flag.load(Ordering::Relaxed) == 0 {
            match srv.recv_timeout(Duration::from_millis(200)) {
                Ok(Some(request)) => {
                    // #1294 并发封顶：超限直接 503，不再无上限 thread::spawn
                    if ACTIVE_PREVIEW_REQUESTS.load(Ordering::Relaxed) >= MAX_PREVIEW_REQUEST_THREADS {
                        let response = tiny_http::Response::from_data(b"busy".to_vec())
                            .with_status_code(503);
                        let _ = request.respond(response);
                        continue;
                    }
                    ACTIVE_PREVIEW_REQUESTS.fetch_add(1, Ordering::Relaxed);
                    // 每请求独立线程：浏览器会并发加载页面/音频/图片资源，串行处理时
                    // 单个慢响应（大文件传输/慢客户端）会阻塞后续所有请求，预览"卡住"。
                    let r = r.clone();
                    thread::spawn(move || {
                        handle_request(&r, request, port);
                        ACTIVE_PREVIEW_REQUESTS.fetch_sub(1, Ordering::Relaxed);
                    });
                }
                Ok(None) => continue,
                Err(_) => break,
            }
        }
    });

    Ok(ServerHandle {
        server,
        stop_flag,
        thread: Mutex::new(Some(thread)),
        port,
        root,
    })
}

fn handle_request(root: &Path, request: tiny_http::Request, port: u16) {
    // #1446：per-instance token 已删除（从未被校验），不再做 token 鉴权。
    // 生效防线为 127.0.0.1 绑定 + Host/DNS-rebinding 校验；缺失 Host/Origin/Referer 时放行
    //（HTTP/1.0 兼容/顶层导航首跳），同机非浏览器客户端可直连属本地预览设计使然，不在此收紧。
    // #1294：Host/Origin/Referer 校验（DNS rebinding 与跨站读防护）
    if !preview_host_allowed(request_header_value(&request, "Host").as_deref(), port)
        || !preview_origin_allowed(request_header_value(&request, "Origin").as_deref(), port)
        || !preview_origin_allowed(request_header_value(&request, "Referer").as_deref(), port)
    {
        let response =
            tiny_http::Response::from_data(b"forbidden".to_vec()).with_status_code(403);
        let _ = request.respond(response);
        return;
    }
    let url = request.url().to_string();
    let range_header: Option<String> = request
        .headers()
        .iter()
        // 头部字段名大小写不敏感（HTTP 规范）：有的客户端发 "range:"，只认 "Range" 会让
        // 分片请求退化成整文件响应（视频拖拽/断点续传失效）。
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("Range"))
        .map(|h| h.value.as_str().to_string());
    let if_none_match: Option<String> = request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case("If-None-Match"))
        .map(|h| h.value.as_str().to_string());
    let path_part = url.split('?').next().unwrap_or("/");
    let decoded = percent_decode(path_part);
    let rel = if decoded == "/" {
        "index.html".to_string()
    } else {
        decoded.trim_start_matches('/').to_string()
    };

    let respond_error = |request: tiny_http::Request, status: u16, body: &[u8]| {
        let mut response = tiny_http::Response::from_data(body.to_vec()).with_status_code(status);
        if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], &b"text/plain"[..]) {
            response = response.with_header(h);
        }
        let _ = request.respond(response);
    };

    let Some(candidate) = safe_file_path(root, Path::new(&rel)) else {
        respond_error(request, 404, b"404 not found");
        return;
    };
    // #1294：.novel2vn 工程目录与点文件不对外
    if is_preview_blocked(root, &candidate) {
        respond_error(request, 404, b"not found");
        return;
    };
    let mut file = match std::fs::File::open(&candidate) {
        Ok(f) => f,
        Err(_) => {
            respond_error(request, 404, b"not found");
            return;
        }
    };
    let metadata = file.metadata().ok();
    let file_len = match &metadata {
        Some(meta) if meta.is_file() => meta.len(),
        _ => {
            respond_error(request, 404, b"not found");
            return;
        }
    };
    // 重新组装后 html/js/剧本固定文件名不能命中文档缓存（#1112）：Cache-Control 见 cache_control_for；
    // no-cache 资源用 ETag 重新校验，未变更时返回 304 而不是整包重下（大图/大音频省流量）。
    let modified_secs = metadata
        .and_then(|meta| meta.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    let etag = modified_secs.map(|secs| format!("\"{:x}-{:x}\"", file_len, secs));

    // 文本类响应必须带 UTF-8 charset，否则浏览器 XHR/fetch 会按默认编码（本地为 GBK）解码，
    // 导致 WebGAL 剧本乱码 → 场景解析失败 → 背景/立绘不显示。场景 txt 均为 UTF-8。
    let ctype = content_type_for(&candidate);
    let cache_control = cache_control_for(&candidate);

    if range_header.is_none() {
        if let (Some(tag), Some(inm)) = (etag.as_deref(), if_none_match.as_deref()) {
            if inm.split(',').any(|candidate| candidate.trim() == tag) {
                let mut response = tiny_http::Response::empty(304);
                if let Ok(h) = Header::from_bytes(&b"Cache-Control"[..], cache_control.as_bytes()) {
                    response = response.with_header(h);
                }
                if let Ok(h) = Header::from_bytes(&b"ETag"[..], tag.as_bytes()) {
                    response = response.with_header(h);
                }
                let _ = request.respond(response);
                return;
            }
        }
    }

    // Range 断点续播：大 vocal mp3 / video mp4 快进 seek 必需，否则浏览器只能从头播。
    // 单区间 bytes=start-end / bytes=start- / bytes=-suffix。
    let mut status = 200u16;
    let mut content_range: Option<String> = None;
    let mut start = 0u64;
    let mut length = file_len;
    if let Some(range_value) = range_header.as_deref() {
        if let Some((s, e)) = parse_range(range_value, file_len) {
            let e = e.min(file_len.saturating_sub(1));
            if s <= e {
                status = 206;
                start = s;
                length = e - s + 1;
                content_range = Some(format!("bytes {}-{}/{}", s, e, file_len));
            }
        }
    }
    if start > 0 && file.seek(SeekFrom::Start(start)).is_err() {
        respond_error(request, 500, b"seek error");
        return;
    }

    // 流式拷贝：不再 read_to_end 整文件，Range 请求也只定位区间后按长度 take，
    // 大音频/视频响应内存占用从 O(文件大小) 降到 O(1)（无需再 limit 单响应大小）
    let reader: Box<dyn Read + Send> = Box::new(file.take(length));
    let mut headers = Vec::with_capacity(8);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()) {
        headers.push(h);
    }
    if let Ok(h) = Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..]) {
        headers.push(h);
    }
    if let Ok(h) = Header::from_bytes(&b"Cache-Control"[..], cache_control.as_bytes()) {
        headers.push(h);
    }
    if let Some(tag) = etag.as_deref() {
        if let Ok(h) = Header::from_bytes(&b"ETag"[..], tag.as_bytes()) {
            headers.push(h);
        }
    }
    if let Some(secs) = modified_secs {
        if let Ok(h) = Header::from_bytes(&b"Last-Modified"[..], http_date(secs).as_bytes()) {
            headers.push(h);
        }
    }
    // 声明断点续播能力，浏览器音频/视频标签才会发 Range 快进
    if let Ok(h) = Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]) {
        headers.push(h);
    }
    if let Some(cr) = content_range {
        if let Ok(h) = Header::from_bytes(&b"Content-Range"[..], cr.as_bytes()) {
            headers.push(h);
        }
    }
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(status),
        headers,
        reader,
        Some(length as usize),
        None,
    );
    let _ = request.respond(response);
}

/// MIME 推断（#1145）：mime_guess 2.0.5 把 `.m4a` 映射为 `audio/m4a`（非标准注册类型），
/// 配合 `X-Content-Type-Options: nosniff` 后浏览器会拒绝播放（Chrome/Firefox 认 `audio/mp4`）。
/// 这里对已知偏差做显式覆盖，并统一为文本类补 UTF-8 charset。
fn content_type_for(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "m4a" | "m4b" | "mp4a" => return "audio/mp4".to_string(),
        "opus" => return "audio/ogg".to_string(),
        "webmanifest" => return "application/manifest+json".to_string(),
        _ => {}
    }
    let base = mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string();
    if base.starts_with("text/") && !base.to_lowercase().contains("charset") {
        format!("{base}; charset=utf-8")
    } else {
        base
    }
}

/// 预览缓存策略（#1112）：剧本（game/scene/*.txt）、立绘/背景（固定文件名）、配音都是重新组装后会变的
/// 动态产物，但 URL 不变 → 浏览器可能沿用旧缓存。入口类（html/js/css/json/txt）强 no-store；
/// 其余静态资源 no-cache（每次带 ETag 重新校验，未变更 304），兼顾正确性与带宽。
fn cache_control_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" | "js" | "mjs" | "css" | "json" | "txt" | "webmanifest" => "no-store",
        _ => "no-cache, max-age=0, must-revalidate",
    }
}

/// Unix 秒 → HTTP-date（RFC 7231 IMF-fixdate，固定 GMT，不依赖本地时区/系统 TZ 数据库）
fn http_date(unix_secs: u64) -> String {
    let days = (unix_secs / 86400) as i64;
    let secs_of_day = unix_secs % 86400;
    let (hour, minute, second) = (secs_of_day / 3600, (secs_of_day / 60) % 60, secs_of_day % 60);
    let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    // 1970-01-01 是周四；zeller 简化：日数偏移后取模
    let weekday = weekdays[((days % 7 + 7) % 7 + 4) as usize % 7];
    // 民用历法换算（Howard Hinnant civil_from_days）
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    format!(
        "{weekday}, {day:02} {} {year:04} {hour:02}:{minute:02}:{second:02} GMT",
        months[(month - 1) as usize]
    )
}

/// 解析 `bytes=start-end` 单区间；返回 (start, end inclusive)。非法返回 None。
fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let value = value.trim();
    let spec = value.strip_prefix("bytes=")?;
    let (start_str, end_str) = spec.split_once('-')?;
    if start_str.is_empty() {
        // bytes=-N：取尾部 N 字节
        let suffix: u64 = end_str.parse().ok()?;
        if suffix == 0 || total == 0 {
            return None;
        }
        let suffix = suffix.min(total);
        return Some((total - suffix, total - 1));
    }
    let start: u64 = start_str.parse().ok()?;
    if start >= total {
        return None;
    }
    if end_str.is_empty() {
        return Some((start, total - 1));
    }
    let end: u64 = end_str.parse().ok()?;
    Some((start, end))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // 必须先确认两个字节都是 ASCII 十六进制再切片：按字节切片落在多字节字符中间会 panic
            // （请求路径 `/%中` 的原始字节 `25 E4 B8 AD` 会直接打挂 preview 线程）
            let hi = bytes[i + 1];
            let lo = bytes[i + 2];
            if hi.is_ascii_hexdigit() && lo.is_ascii_hexdigit() {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn safe_file_path(root: &Path, relative: &Path) -> Option<PathBuf> {
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    let candidate = root.join(relative).canonicalize().ok()?;
    candidate
        .is_file()
        .then_some(candidate)
        .filter(|path| path.starts_with(root))
}

#[allow(dead_code)]
struct _MutexGuardGuard(Mutex<()>);

#[cfg(test)]
mod tests {
    use super::{cache_control_for, content_type_for, http_date, is_preview_blocked, parse_range, preview_host_allowed, percent_decode, preview_origin_allowed, safe_file_path, start_with_server, validate_preview_root};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn preview_path_stays_inside_root() {
        let root = std::env::temp_dir().join(format!("novelforge-preview-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("index.html"), "ok").unwrap();
        let canonical_root = root.canonicalize().unwrap();

        assert!(safe_file_path(&canonical_root, std::path::Path::new("index.html")).is_some());
        assert!(safe_file_path(&canonical_root, std::path::Path::new("../outside.txt")).is_none());

        fs::remove_dir_all(root).unwrap();
    }

    /// #1537：parse_range 自身**不**把 end 收敛到 total-1（bytes=0-999999 配 200 字节文件
/// 会得到 Some((0, 999999))），真正兜底的是 handle_request 里的 `e.min(file_len-1)`。
/// 也就是说「超范围 end 不会让 length 爆成 u64::MAX、不会预分配巨量内存」这条安全性，
/// 完全寄生在调用点那一行 clamp 上。这里把它连同 handle_request 的实际用法一起钉住，
/// 免得将来有人删掉 clamp 又以为 parse_range 自己会收敛。
#[test]
fn parse_range_over_range_end_is_clamped_by_caller() {
    // parse_range 本身不收敛：调用点必须自己夹
    assert_eq!(parse_range("bytes=0-999999", 200), Some((0, 999999)));
    // 复刻 handle_request:318-327 的那段逻辑
    let file_len = 200u64;
    let (s, e) = parse_range("bytes=0-999999", file_len).expect("应解析出区间");
    let e = e.min(file_len.saturating_sub(1));
    assert!(s <= e);
    let length = e - s + 1;
    assert_eq!(length, file_len, "超范围 end 必须被夹到整文件长度，不得溢出");
    // u64::MAX 作为 end 同样只能被夹到文件大小（否则 length 计算会回绕）
    let (s, e) = parse_range("bytes=0-18446744073709551615", file_len).expect("应解析出区间");
    let e = e.min(file_len.saturating_sub(1));
    assert_eq!(e - s + 1, file_len, "u64::MAX end 不得撑爆 length");
    // 后缀区间已自带收敛（suffix.min(total)），不依赖调用点
    assert_eq!(parse_range("bytes=-99999", 200), Some((0, 199)));
}

/// #1537：percent_decode 在 safe_file_path **之前**执行（handle_request:244 -> 259），
/// 所以 %2e%2e%2f 这类编码过的穿越序列必须先被解码、再由 components() 判成 ParentDir 拦掉。
/// 顺序若反过来（先按原始串判守卫、再解码），就成了绕过。
#[test]
fn percent_encoded_traversal_is_blocked() {
    // 解码确实还原出 ../
    assert_eq!(percent_decode("/%2e%2e%2f%2e%2e%2fetc/passwd"), "/../../etc/passwd");
    let rel = percent_decode("/%2e%2e%2f%2e%2e%2fetc/passwd");
    let rel = rel.trim_start_matches('/');
    // 再走 safe_file_path 的守卫：ParentDir 必须被拒
    assert!(
        Path::new(&rel)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir)),
        "编码过的穿越必须被 components() 判为非 Normal/CurDir",
    );
    // 反斜杠编码同样是 ParentDir（Windows 上 \\ 是分隔符）
    let rel2 = percent_decode("/%2e%2e%5c%2e%2e%5cboot.ini");
    assert_eq!(rel2.trim_start_matches('/'), "..\\..\\boot.ini");
    // 合法路径不得被误伤
    assert_eq!(percent_decode("/game/scene%2Fstart.txt"), "/game/scene/start.txt");
    // 非法/半截百分号按字面透传，不 panic（#1487 的多字节切分防护）
    assert_eq!(percent_decode("/%E4%B8%AD"), "/中");
    assert_eq!(percent_decode("/100%"), "/100%");
    assert_eq!(percent_decode("/%zz"), "/%zz");
    assert_eq!(percent_decode("/%2"), "/%2");
}
#[test]
fn parse_range_single_interval() {
        assert_eq!(parse_range("bytes=0-99", 200), Some((0, 99)));
        assert_eq!(parse_range("bytes=100-", 200), Some((100, 199)));
        assert_eq!(parse_range("bytes=-50", 200), Some((150, 199)));
        assert_eq!(parse_range("bytes=500-", 200), None);
        assert_eq!(parse_range("invalid", 200), None);
    }

    /// #1145：.m4a 必须返回浏览器认可的 audio/mp4（mime_guess 的 audio/m4a 在 nosniff 下会被拒播）
    #[test]
    fn content_type_overrides_browser_unfriendly_mimes() {
        assert_eq!(content_type_for(Path::new("bgm/theme.m4a")), "audio/mp4");
        assert_eq!(content_type_for(Path::new("vocal/line.M4A")), "audio/mp4");
        assert_eq!(content_type_for(Path::new("vocal/line.opus")), "audio/ogg");
        assert_eq!(
            content_type_for(Path::new("manifest.webmanifest")),
            "application/manifest+json"
        );
        // 文本类必须带 charset（剧本乱码回归）
        let txt = content_type_for(Path::new("game/scene/ch1.txt"));
        assert!(txt.starts_with("text/plain") && txt.contains("charset=utf-8"), "{txt}");
        assert_eq!(content_type_for(Path::new("game/background/bg.png")), "image/png");
    }

    /// #1112：入口文件强 no-store，其余静态资源 no-cache（配合 ETag 重新校验）
    #[test]
    fn cache_control_policy_for_preview_output() {
        assert_eq!(cache_control_for(Path::new("index.html")), "no-store");
        assert_eq!(cache_control_for(Path::new("assets/index-abc.js")), "no-store");
        assert_eq!(cache_control_for(Path::new("game/scene/ch1.txt")), "no-store");
        assert_eq!(cache_control_for(Path::new("manifest.json")), "no-store");
        assert!(cache_control_for(Path::new("game/figure/a.png")).starts_with("no-cache"));
        assert!(cache_control_for(Path::new("game/vocal/a.m4a")).starts_with("no-cache"));
    }

    #[test]
    fn http_date_formats_unix_epoch_fixed_gmt() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(1_700_000_000), "Tue, 14 Nov 2023 22:13:20 GMT");
    }

    /// #1537 集成回归：**真正打到 handle_request** 的超范围 Range。
    /// 上面那个单元测试只是复刻了 clamp 的算式；真正保证「删掉 clamp 也不会出事」的是这条：
    /// Range: bytes=0-18446744073709551615 打到 1000 字节文件，服务端必须回 206 +
    /// Content-Range: bytes 0-999/1000 + 恰好 1000 字节，而不是把 length 算成 u64::MAX。
    #[test]
    fn range_request_with_over_range_end_is_clamped_end_to_end() {
        let root = std::env::temp_dir().join(format!("novelforge-preview-range-clamp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let payload: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        fs::write(root.join("data.bin"), &payload).unwrap();
        fs::write(root.join("index.html"), "<html></html>").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let handle = start_with_server(root.to_str().unwrap(), server).unwrap();

        // (Range 头, 期望 Content-Range, 期望响应体起点, 期望响应体长度)
        for (range, want_cr, want_start, want_len) in [
            ("bytes=0-18446744073709551615", "bytes 0-999/1000", 0usize, 1000usize),
            ("bytes=0-999999", "bytes 0-999/1000", 0, 1000),
            ("bytes=900-999999", "bytes 900-999/1000", 900, 100),
        ] {
            let mut stream = TcpStream::connect(("127.0.0.1", handle.port())).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let req = format!("GET /data.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: {range}\r\nConnection: close\r\n\r\n");
            stream.write_all(req.as_bytes()).unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap();

            let head_end = response.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(response.len());
            let head = String::from_utf8_lossy(&response[..head_end]);
            assert!(head.starts_with("HTTP/1.1 206"), "{range} 应返回 206: {head}");
            assert!(head.contains(&format!("Content-Range: {want_cr}")), "{range} 的 Content-Range 应为 {want_cr}: {head}");
            let body = &response[head_end..];
            assert_eq!(body.len(), want_len, "{range} 的响应体长度应为 {want_len}，实际 {}", body.len());

            assert_eq!(body, &payload[want_start..want_start + want_len],
                "{range} 的响应体应是 payload[{want_start}..{}]", want_start + want_len);
        }

        handle.stop();
        let _ = fs::remove_dir_all(&root);
    }

    /// #1537 集成回归：编码过的穿越序列必须在解码之后被守卫拦下。
    /// handle_request:244 先 percent_decode、259 才 safe_file_path，顺序反了就成了绕过。
    #[test]
    fn percent_encoded_traversal_returns_404_end_to_end() {
        // root 外面放一个可读文件，若守卫失效就会被读到
        let base = std::env::temp_dir().join(format!("novelforge-preview-esc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        fs::write(base.join("secret.txt"), b"TOP-SECRET").unwrap();
        fs::write(root.join("index.html"), "<html></html>").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let handle = start_with_server(root.to_str().unwrap(), server).unwrap();

        for path in [
            "/%2e%2e/secret.txt",
            "/%2E%2E%2Fsecret.txt",
            "/..%2fsecret.txt",
            "/%2e%2e%5csecret.txt",
            "/../secret.txt",
        ] {
            let mut stream = TcpStream::connect(("127.0.0.1", handle.port())).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
            stream.write_all(req.as_bytes()).unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap();
            let text = String::from_utf8_lossy(&response);
            assert!(text.starts_with("HTTP/1.1 404"), "{path} 必须 404: {}", &text[..text.len().min(60)]);
            assert!(!text.contains("TOP-SECRET"), "{path} 泄漏了 root 外的文件内容");
        }

        handle.stop();
        let _ = fs::remove_dir_all(&base);
    }
    /// B113 集成回归：Range 请求应返回 206 + 正确 Content-Range + 精确区间字节
    #[test]
    fn range_request_returns_partial_content() {
        let root = std::env::temp_dir().join(format!("novelforge-preview-range-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let payload: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        fs::write(root.join("data.bin"), &payload).unwrap();
        // 预览根校验要求输出目录含 index.html（#1294）：测试根同样补齐
        fs::write(root.join("index.html"), "<html></html>").unwrap();

        // 用 127.0.0.1:0 绑定临时端口，避免占用固定预览端口导致测试互相干扰
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let handle = start_with_server(root.to_str().unwrap(), server).unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", handle.port())).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        stream
            .write_all(b"GET /data.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=10-19\r\nConnection: close\r\n\r\n")
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();

        let head_end = response.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4);
        let head = String::from_utf8_lossy(&response[..head_end.unwrap_or(response.len())]);
        assert!(head.starts_with("HTTP/1.1 206"), "Range 请求应返回 206: {head}");
        assert!(head.contains("Content-Range: bytes 10-19/1000"), "缺少 Content-Range: {head}");
        assert_eq!(&response[head_end.unwrap()..], &payload[10..20], "区间字节不匹配");

        handle.stop();
        let _ = fs::remove_dir_all(&root);
    }

    /// #1112/#1145 集成回归：.m4a 响应头必须可被浏览器直接播放（audio/mp4 + nosniff + no-cache + ETag），
    /// html 入口必须 no-store；带 If-None-Match 时应返回 304。
    #[test]
    fn static_response_headers_carry_mime_and_cache_policy() {
        let root = std::env::temp_dir().join(format!("novelforge-preview-headers-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("game/vocal")).unwrap();
        fs::write(root.join("index.html"), "<html></html>").unwrap();
        fs::write(root.join("game/vocal/bgm.m4a"), b"fake-m4a").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let handle = start_with_server(root.to_str().unwrap(), server).unwrap();

        let get = |path: &str, extra: &str| -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", handle.port())).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            stream
                .write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{extra}Connection: close\r\n\r\n").as_bytes())
                .unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap();
            String::from_utf8_lossy(&response).to_string()
        };

        let m4a = get("/game/vocal/bgm.m4a", "");
        assert!(m4a.starts_with("HTTP/1.1 200"), "m4a 应可访问: {m4a}");
        assert!(m4a.contains("Content-Type: audio/mp4"), "m4a MIME 应为 audio/mp4: {m4a}");
        assert!(m4a.contains("Cache-Control: no-cache"), "m4a 应 no-cache: {m4a}");
        assert!(m4a.contains("ETag: "), "m4a 应带 ETag: {m4a}");

        let html = get("/", "");
        assert!(html.contains("Cache-Control: no-store"), "html 应 no-store: {html}");

        let etag_line = m4a
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("etag:"))
            .map(|l| l.split_once(':').unwrap().1.trim().to_string())
            .expect("缺少 ETag");
        let revalidated = get("/game/vocal/bgm.m4a", &format!("If-None-Match: {etag_line}\r\n"));
        assert!(revalidated.starts_with("HTTP/1.1 304"), "ETag 命中应 304: {revalidated}");

        handle.stop();
        let _ = fs::remove_dir_all(&root);
    }

    /// #1294：预览根必须是含 index.html 的已生成输出目录；任意目录一律拒绝
    #[test]
    fn preview_root_requires_generated_output() {
        assert!(validate_preview_root("/definitely/not/here-novelforge").is_err());
        let dir = std::env::temp_dir().join(format!("novelforge-preview-root-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // 空目录（无 index.html）→ 拒绝分享
        assert!(validate_preview_root(dir.to_str().unwrap()).is_err());
        fs::write(dir.join("index.html"), "<html></html>").unwrap();
        assert!(validate_preview_root(dir.to_str().unwrap()).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    /// #1294：Host/Origin 校验——重绑与跨站读被拦，同源与无头直连放行
    #[test]
    fn preview_host_and_origin_checks() {
        assert!(preview_host_allowed(Some("127.0.0.1:17892"), 17892));
        assert!(preview_host_allowed(Some("127.0.0.1"), 17892));
        assert!(preview_host_allowed(Some("localhost:17892"), 17892));
        assert!(preview_host_allowed(None, 17892));
        assert!(!preview_host_allowed(Some("evil.com"), 17892));
        assert!(!preview_host_allowed(Some("127.0.0.1:9999"), 17892));
        assert!(!preview_host_allowed(Some("attacker.example:17892"), 17892));
        assert!(preview_origin_allowed(None, 17892));
        assert!(preview_origin_allowed(Some("http://127.0.0.1:17892/game/scene/1.txt"), 17892));
        assert!(preview_origin_allowed(Some("http://127.0.0.1:17892"), 17892));
        assert!(preview_origin_allowed(Some("http://localhost:17892/x"), 17892));
        assert!(!preview_origin_allowed(Some("http://evil.com/"), 17892));
        assert!(!preview_origin_allowed(Some("http://127.0.0.1:9999/x"), 17892));
        // #1475 回归：旧实现用 starts_with("http://127.0.0.1:{port}") 前缀比对，
        // 小端口部署下 "…:50001" 会被当成同源。改为精确 host:port 比对后必须拒绝。
        assert!(!preview_origin_allowed(Some("http://127.0.0.1:50001"), 5000));
        assert!(!preview_origin_allowed(Some("http://127.0.0.1:5000.evil.com"), 5000));
        assert!(preview_origin_allowed(Some("http://127.0.0.1:5000"), 5000));
    }

    /// #1294：.novel2vn 与点文件不对外
    #[test]
    fn preview_blocks_project_state_and_dotfiles() {
        let root = std::env::temp_dir().join(format!("novelforge-preview-block-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".novel2vn")).unwrap();
        fs::write(root.join("index.html"), "<html></html>").unwrap();
        fs::write(root.join(".novel2vn/project_state.json"), "secret").unwrap();
        fs::write(root.join(".hidden"), "secret").unwrap();
        let canon = root.canonicalize().unwrap();
        let secret = canon.join(".novel2vn/project_state.json").canonicalize().unwrap();
        assert!(is_preview_blocked(&canon, &secret));
        let hidden = canon.join(".hidden").canonicalize().unwrap();
        assert!(is_preview_blocked(&canon, &hidden));
        let index = canon.join("index.html").canonicalize().unwrap();
        assert!(!is_preview_blocked(&canon, &index));
        // #1474 回归：点目录不在叶子时也必须拦住（旧实现只查 file_name 与 .novel2vn）
        fs::create_dir_all(root.join("game/.cache")).unwrap();
        fs::write(root.join("game/.cache/token.json"), "secret").unwrap();
        let nested = canon.join("game/.cache/token.json").canonicalize().unwrap();
        assert!(
            is_preview_blocked(&canon, &nested),
            "子目录中的点目录必须一并拦截，否则同机任意进程可直接 GET 出来"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// #1294 集成：.novel2vn 经 HTTP 应 404，index.html 仍可访问
    #[test]
    fn preview_http_hides_project_state() {
        let root = std::env::temp_dir().join(format!("novelforge-preview-hide-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".novel2vn")).unwrap();
        fs::write(root.join("index.html"), "<html></html>").unwrap();
        fs::write(root.join(".novel2vn/project_state.json"), "secret").unwrap();

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let handle = start_with_server(root.to_str().unwrap(), server).unwrap();
        let get = |path: &str| -> String {
            let mut stream = TcpStream::connect(("127.0.0.1", handle.port())).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            stream
                .write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes())
                .unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap();
            String::from_utf8_lossy(&response).to_string()
        };
        assert!(get("/index.html").starts_with("HTTP/1.1 200"), "index.html 应可访问");
        assert!(get("/.novel2vn/project_state.json").starts_with("HTTP/1.1 404"), ".novel2vn 不得对外");

        handle.stop();
        let _ = fs::remove_dir_all(&root);
    }

    // #1446：per-instance token 已删除（生成了也从不校验，前端亦直接丢弃，纯装饰）。
    // 生效防线为 loopback 绑定 + Host/DNS-rebinding 校验；不再为已删除的 token 保留单测。
}
