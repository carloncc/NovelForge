use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

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
                let _ = t.join();
            }
        }
    }
}

pub fn start(root: &str) -> Result<ServerHandle, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("目录无效: {e}"))?;
    let server = Arc::new(
        Server::http("127.0.0.1:17892")
            .map_err(|e| format!("启动预览服务器失败（端口 17892 被占用？）: {e}"))?,
    );
    let port = 17892;
    let stop_flag = Arc::new(AtomicUsize::new(0));

    let srv = server.clone();
    let flag = stop_flag.clone();
    let r = root.clone();
    let thread = thread::spawn(move || {
        while flag.load(Ordering::Relaxed) == 0 {
            match srv.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(Some(request)) => {
                    handle_request(&r, request);
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

    let candidate = safe_file_path(root, Path::new(&rel));

    let body: Vec<u8>;
    let ctype: String;
    let mut status: u16 = 200;
    let mut content_range: Option<String> = None;

    if let Some(candidate) = candidate {
        match std::fs::File::open(&candidate) {
            Ok(mut f) => {
                let mut buf = Vec::new();
                if f.read_to_end(&mut buf).is_ok() {
                    let base = mime_guess::from_path(&candidate)
                        .first_or_octet_stream()
                        .to_string();
                    // 文本类响应必须带 UTF-8 charset，否则浏览器 XHR/fetch 会按默认编码（本地为 GBK）解码，
                    // 导致 WebGAL 剧本乱码 → 场景解析失败 → 背景/立绘不显示。场景 txt 均为 UTF-8。
                    if base.starts_with("text/") && !base.to_lowercase().contains("charset") {
                        ctype = format!("{base}; charset=utf-8");
                    } else {
                        ctype = base;
                    }
                    // Range 断点续播：大 vocalmp3 / video mp4 快进 seek 必需，否则浏览器只能从头播，
                    // “快进不断音频”的体感会被放大。单区间 bytes=start-end / bytes=start- / bytes=-suffix。
                    if let Some(range_value) = range_header.as_deref() {
                        if let Some((start, end)) = parse_range(range_value, buf.len() as u64) {
                            let end = end.min(buf.len() as u64 - 1);
                            if start <= end && (end as usize) < buf.len() {
                                content_range = Some(format!("bytes {}-{}/{}", start, end, buf.len()));
                                body = buf[start as usize..=end as usize].to_vec();
                                status = 206;
                            } else {
                                body = buf;
                            }
                        } else {
                            body = buf;
                        }
                    } else {
                        body = buf;
                    }
                } else {
                    body = b"read error".to_vec();
                    ctype = "text/plain".to_string();
                }
            }
            Err(_) => {
                body = b"not found".to_vec();
                ctype = "text/plain".to_string();
            }
        }
    } else {
        body = b"404 not found".to_vec();
        ctype = "text/plain".to_string();
    }

    let mut response = tiny_http::Response::from_data(body);
    response = response.with_status_code(status);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], ctype.as_bytes()) {
        response = response.with_header(h);
    }
    if let Ok(h) = Header::from_bytes(&b"X-Content-Type-Options"[..], &b"nosniff"[..]) {
        response = response.with_header(h);
    }
    // 声明断点续播能力，浏览器音频/视频标签才会发 Range 快进
    if let Ok(h) = Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]) {
        response = response.with_header(h);
    }
    if let Some(cr) = content_range {
        if let Ok(h) = Header::from_bytes(&b"Content-Range"[..], cr.as_bytes()) {
            response = response.with_header(h);
        }
    }
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
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
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
    use super::{parse_range, safe_file_path};
    use std::fs;

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
}
