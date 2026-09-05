import { tauri } from "../utils/tauri";
import { cleanPath, safeFilename } from "../utils/path";

export function cacheDirFor(cacheRoot: string, section: string): string {
  return cleanPath(`${cacheRoot}/${section}`);
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp"];

/**
 * 缓存命中：优先精确文件名；否则按 basename 匹配常见图片扩展名（.png/.jpg/.jpeg/.webp）。
 * 原因：图像 API 可能返回 jpeg/webp（task.fileName 固定 .png），若只查 .png 会导致
 * 已生成的 .jpg 图无法命中缓存，每次重跑都重新生成（用户报告「每次都要重新生成」）。
 */
export async function cacheHit(dir: string, fileName: string): Promise<string | null> {
  const path = `${dir}/${fileName}`;
  try {
    if (await tauri.pathExists(path)) return path;
  } catch {
    /* ignore */
  }
  const base = fileName.replace(/\.(png|jpg|jpeg|webp)$/i, "");
  for (const ext of IMAGE_EXTS) {
    const candidate = `${dir}/${base}.${ext}`;
    if (candidate === path) continue;
    try {
      if (await tauri.pathExists(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function jsonKey(kind: string, key: string): string {
  return `${kind}_${safeFilename(key, 100)}.json`;
}

export function slugify(s: string): string {
  return safeFilename(s, 60);
}

/** 短标题哈希（缓存文件名用，非加密） */
export function titleHash(title: string): string {
  let h = 5381;
  for (const ch of title) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return h.toString(36);
}

/** 剧本缓存键后半段（标题哈希＋正文全文指纹＋文风）。
 * 正文必须取全文哈希：旧实现只取前 8000 字，超长章后半改动检测不到、误命中旧剧本。 */
export function scriptCacheRest(title: string, text: string, styleFrag: string): string {
  return `${titleHash(title)}_t${titleHash(text || "")}${styleFrag}`;
}

/** 剧本缓存文件名：与管线 scriptWorker 的 cacheFile 公式唯一对应，供管线内外复用 */
export function scriptCacheFileName(
  cacheDir: string,
  demo: boolean,
  chapterIndex: number,
  title: string,
  text: string,
  styleFrag: string,
): string {
  return `${cacheDir}/${demo ? "script_demo" : "script"}_ch${chapterIndex + 1}_${scriptCacheRest(title, text, styleFrag)}.json`;
}
