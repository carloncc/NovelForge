import type { ExtractionResult } from "./types";
import { tauri } from "../utils/tauri";

export interface CardsSaveResult {
  scriptCacheCleared: number;
  imageCacheCleared: number;
}

/**
 * 保存编辑后的卡片。
 * 默认只清立绘/物品图缓存（外貌变化需重新出图），不清剧本缓存——
 * 剧本引用的是角色 id/name，多数编辑（音色/服装/外貌微调）不该触发全量重跑剧本，
 * 否则一章失败会让整个项目的剧本缓存被清空、下次全部重跑，白烧大量 token。
 * 明确改动了台词相关的角色信息时，可传 invalidateScriptCache=true 主动清剧本缓存。
 */
export async function saveEditedCards(
  outputDir: string,
  cards: ExtractionResult,
  log: (msg: string, level?: "info" | "warn" | "success") => void,
  invalidateScriptCache = false,
): Promise<CardsSaveResult> {
  const metaDir = `${outputDir}/.novel2vn`;
  const cacheDir = `${metaDir}/cache`;

  // 保留旧缓存中的小说指纹（防止用户编辑被指纹校验误判作废）
  let novelFp: string | undefined;
  for (const f of ["cards.json", "cards_demo.json"]) {
    try {
      const { text } = await tauri.readTextFile(`${metaDir}/${f}`);
      const parsed = JSON.parse(text) as { _novelFp?: string };
      if (parsed._novelFp) {
        novelFp = parsed._novelFp;
        break;
      }
    } catch {
      /* 无旧缓存 */
    }
  }
  const payload = novelFp ? { ...cards, _novelFp: novelFp } : cards;

  await tauri.writeTextFile(`${metaDir}/cards.json`, JSON.stringify(payload, null, 2));
  await tauri.writeTextFile(`${metaDir}/cards_demo.json`, JSON.stringify(payload, null, 2));

  let scriptCleared = 0;
  let imageCleared = 0;

  // 剧本缓存：仅显式要求时清空（默认保留，避免全量重跑白烧 token）
  if (invalidateScriptCache) {
    try {
      const entries = await tauri.listDir(cacheDir);
      for (const e of entries) {
        if (!e.isDir && /^script(_demo)?_ch\d+_/.test(e.name)) {
          await tauri.removePath(e.path).catch(() => {});
          scriptCleared++;
        }
      }
    } catch {
      /* cache 目录不存在 */
    }
  }

  // 立绘/物品图缓存失效：外貌描述变化需要重新生成
  try {
    const imageDir = `${cacheDir}/images`;
    const entries = await tauri.listDir(imageDir);
    for (const e of entries) {
      if (!e.isDir && /^(figure_|item_)/.test(e.name)) {
        await tauri.removePath(e.path).catch(() => {});
        imageCleared++;
      }
    }
  } catch {
    /* images 目录不存在 */
  }

  log(
    invalidateScriptCache
      ? `卡片已保存：剧本缓存清除 ${scriptCleared} 个，立绘/物品图缓存清除 ${imageCleared} 个（重新生成时将使用新卡片）`
      : `卡片已保存：立绘/物品图缓存清除 ${imageCleared} 个（剧本缓存保留，仅外貌/音色改动不会重跑全部剧本；如需重写剧本请用「重新生成此章」）`,
    "success",
  );
  return { scriptCacheCleared: scriptCleared, imageCacheCleared: imageCleared };
}
