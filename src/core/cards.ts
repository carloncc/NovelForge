import type { ExtractionResult } from "./types";
import { tauri } from "../utils/tauri";

export interface CardsSaveResult {
  scriptCacheCleared: number;
  imageCacheCleared: number;
}

export async function saveEditedCards(
  outputDir: string,
  cards: ExtractionResult,
  log: (msg: string, level?: "info" | "warn" | "success") => void,
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

  // 剧本缓存失效：角色/物品信息变化会影响剧本引用
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
    `卡片已保存：剧本缓存清除 ${scriptCleared} 个，立绘/物品图缓存清除 ${imageCleared} 个（重新生成时将使用新卡片）`,
    "success",
  );
  return { scriptCacheCleared: scriptCleared, imageCacheCleared: imageCleared };
}
