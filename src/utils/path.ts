/**
 * 跨平台路径工具函数
 * 统一处理 Windows 和 Unix 风格的路径
 */

/**
 * 标准化路径分隔符为正斜杠
 * Windows: C:\path\to\file -> C:/path/to/file
 * Unix: /path/to/file -> /path/to/file
 */
export function normalizePath(path: string): string {
  let p = path;
  // 去掉 Windows 扩展长度路径前缀 \\?\（Tauri 的 current_exe 会返回带此前缀的路径）
  if (p.startsWith("\\\\?\\")) {
    p = p.slice(4);
  }
  return p.replace(/\\/g, "/");
}

/**
 * 获取路径的基本名称（文件名或目录名）
 * C:/path/to/file.txt -> file.txt
 * /path/to/dir -> dir
 */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * 获取路径的目录部分
 * C:/path/to/file.txt -> C:/path/to
 * /path/to/file.txt -> /path/to
 */
export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash > 0 ? normalized.substring(0, lastSlash) : normalized;
}

/**
 * 连接路径片段，确保使用正斜杠
 */
export function joinPath(...segments: string[]): string {
  const first = segments[0] ?? "";
  const isAbsolute = /^[\\/]/.test(first);
  const rest = segments
    .map(s => s.replace(/^[\\/]+|[\\/]+$/g, ""))
    .filter(Boolean)
    .join("/");
  return isAbsolute ? `/${rest}` : rest;
}

/**
 * 清理路径，移除多余的斜杠和空格
 */
export function cleanPath(path: string): string {
  return normalizePath(path)
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

/**
 * 安全的文件名（移除非法字符）
 */
export function safeFilename(name: string, maxLength = 60): string {
  return name
    .replace(/[\\/:*?"<>|\s]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, maxLength);
}

/**
 * 获取文件扩展名
 * file.txt -> .txt
 * file.tar.gz -> .gz
 */
export function extname(path: string): string {
  const base = basename(path);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex > 0 ? base.substring(dotIndex) : "";
}

/**
 * 获取不带扩展名的文件名
 * file.txt -> file
 * path/to/file.txt -> file
 */
export function basenameWithoutExt(path: string): string {
  const base = basename(path);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex > 0 ? base.substring(0, dotIndex) : base;
}
