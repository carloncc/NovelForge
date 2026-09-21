import { tauri } from "../utils/tauri";
import { cleanPath } from "../utils/path";

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

/** 短标题哈希（缓存文件名用，非加密） */
export function titleHash(title: string): string {
  let h = 5381;
  for (const ch of title) {
    h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  }
  return h.toString(36);
}

export interface ScriptFingerprintInput {
  /** 剧本文风：留空不调整 */
  style?: string;
  /** 旁白压缩开关（#801）：开=精简提炼旁白；关（默认）=忠实保留全文旁白 */
  compressNarration?: boolean;
  /** 视觉模式（sprite=立绘版；imageOnly=图片小说）：进入指纹，保证两套页面缓存互不命中（#808） */
  visualMode?: string;
  /** 卡片指纹（cardsFingerprint）：重新提取导致角色/物品/场景 id 变化时旧剧本必须失效。
   *  否则渲染时按 id 找不到角色卡，人名会退化成内部 id（用户实测：游戏里显示 ouiriseri: 这类 id）。 */
  cardsFp?: string;
}

/**
 * 卡片指纹（脚本缓存键用）：角色/物品/场景的 id+名称排序后哈希。
 * 只含 id 与展示名——外貌/性格微调不影响剧本引用，不必触发重写。
 */
export function cardsFingerprint(cards: {
  characters?: { id: string; name?: string }[];
  items?: { id: string; name?: string }[];
  scenes?: { id: string; location?: string }[];
}): string {
  const parts: string[] = [];
  for (const c of cards.characters ?? []) parts.push(`c:${c.id}:${c.name ?? ""}`);
  for (const i of cards.items ?? []) parts.push(`i:${i.id}:${i.name ?? ""}`);
  for (const s of cards.scenes ?? []) parts.push(`s:${s.id}:${s.location ?? ""}`);
  parts.sort();
  return titleHash(parts.join("|"));
}

/**
 * 剧本缓存指纹（唯一实现，#802）：文风 + 旁白压缩开关 + 视觉模式 + 卡片指纹。
 * 此前公式 `style ? "_st" + titleHash(style) : ""` 在管线/看板/章节灯/核对共 7 处复制，
 * 新增任何剧本参数都可能漏改一处导致「看板绿灯但产物是旧的」或「永远重跑」；
 * 所有调用点必须改为调用本函数（旧字符串入参仍兼容）。
 */
export function scriptFingerprint(input: ScriptFingerprintInput | string | undefined): string {
  const opts: ScriptFingerprintInput = typeof input === "string" ? { style: input } : (input ?? {});
  const parts: string[] = [];
  const style = (opts.style ?? "").trim();
  if (style) parts.push(`_st${titleHash(style)}`);
  if (opts.compressNarration) parts.push("_cn1");
  const mode = (opts.visualMode ?? "sprite").trim() || "sprite";
  if (mode !== "sprite") parts.push(`_vm${titleHash(mode)}`);
  if (opts.cardsFp) parts.push(`_cd${opts.cardsFp}`);
  return parts.join("");
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
