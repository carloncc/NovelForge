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
}

impl ServerHandle {
    pub fn port(&self) -> u16 {
        self.port
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

pub fn start(root: &str) -> Result<ServerHandle, String> {
    let server = Server::http("127.0.0.1:17892")
        .map_err(|e| format!("启动预览服务器失败（端口 17892 被占用？）: {e}"))?;
    start_with_server(root, server)
}

/// 在已绑定的 Server 上启动预览服务（测试用 127.0.0.1:0 拿临时端口，避免与开发环境端口冲突）
fn start_with_server(root: &str, server: Server) -> Result<ServerHandle, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("目录无效: {e}"))?;
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
                    // 每请求独立线程：浏览器会并发加载页面/音频/图片资源，串行处理时
                    // 单个慢响应（大文件传输/慢客户端）会阻塞后续所有请求，预览"卡住"。
                    let r = r.clone();
                    thread::spawn(move || handle_request(&r, request));
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
    })
}

fn handle_request(root: &Path, request: tiny_http::Request) {
    let url = request.url().to_string();
    let range_header: Option<String> = request
        .headers()
        .iter()
        .find(|h| h.field.as_str() == "Range")
        .map(|h| h.value.as_str().to_string());
    let if_none_match: Option<String> = request
        .headers()
        .iter()
        .find(|h| h.field.as_str() == "If-None-Match")
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
    use super::{cache_control_for, content_type_for, http_date, parse_range, safe_file_path, start_with_server};
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

    /// B113 集成回归：Range 请求应返回 206 + 正确 Content-Range + 精确区间字节
    #[test]
    fn range_request_returns_partial_content() {
        let root = std::env::temp_dir().join(format!("novelforge-preview-range-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let payload: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        fs::write(root.join("data.bin"), &payload).unwrap();

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
}
