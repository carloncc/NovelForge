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
    let file_len = match file.metadata() {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => {
            respond_error(request, 404, b"not found");
            return;
        }
    };

    let base = mime_guess::from_path(&candidate)
        .first_or_octet_stream()
        .to_string();
    // 文本类响应必须带 UTF-8 charset，否则浏览器 XHR/fetch 会按默认编码（本地为 GBK）解码，
    // 导致 WebGAL 剧本乱码 → 场景解析失败 → 背景/立绘不显示。场景 txt 均为 UTF-8。
    let ctype = if base.starts_with("text/") && !base.to_lowercase().contains("charset") {
        format!("{base}; charset=utf-8")
    } else {
        base
    };

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
    let mut headers = Vec::with_capacity(4);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()) {
        headers.push(h);
    }
    if let Ok(h) = Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..]) {
        headers.push(h);
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
    use super::{parse_range, safe_file_path, start_with_server};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpStream;
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
}
