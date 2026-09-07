import type { CharacterCard, ExtractionResult, ItemCard } from "./types";
import { sanitizeId } from "./render";
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
  demo = false,
): Promise<CardsSaveResult> {
  const metaDir = `${outputDir}/.novel2vn`;
  const cacheDir = `${metaDir}/cache`;

  // 保留旧缓存中的小说指纹（防止用户编辑被指纹校验误判作废），同时留一份旧卡片做差分
  let novelFp: string | undefined;
  let oldCards: ExtractionResult | null = null;
  for (const f of ["cards.json", "cards_demo.json"]) {
    try {
      const { text } = await tauri.readTextFile(`${metaDir}/${f}`);
      const parsed = JSON.parse(text) as ExtractionResult & { _novelFp?: string };
      if (parsed._novelFp && !novelFp) novelFp = parsed._novelFp;
      if (!oldCards && Array.isArray(parsed.characters)) oldCards = parsed;
    } catch {
      /* 无旧缓存 */
    }
  }
  // demo/正式隔离：只写当前模式的文件。旧实现同时写两份同一 payload，
  // demo 改卡污染正式、正式改卡污染 demo，且 _novelFp 被单值覆盖导致误作废。
  const cachePrefix = demo ? "cards_demo" : "cards";
  const payload = novelFp ? { ...cards, _novelFp: novelFp } : cards;

  await tauri.writeTextFile(`${metaDir}/${cachePrefix}.json`, JSON.stringify(payload, null, 2));

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

  // 立绘/物品图缓存失效：只清「被删除/绘画相关字段变化」的角色与物品。
  // 旧实现每次保存全删 figure_/item_：只改个音色也要重画全书立绘。绘画相关字段以外
  // （音色/性别/性格/主题色等）的改动不碰图片缓存。
  const IMAGE_FIELDS: (keyof CharacterCard)[] = ["imagePrompt", "threeViewPrompt", "actions", "costumes", "emotions"];
  const deadCharIds = new Set<string>();
  const deadItemIds = new Set<string>();
  if (oldCards) {
    const oldChars = new Map(oldCards.characters.map((c) => [c.id, c]));
    const newChars = new Map(cards.characters.map((c) => [c.id, c]));
    for (const [id, oc] of oldChars) {
      const nc = newChars.get(id);
      if (!nc) {
        deadCharIds.add(id);
        continue;
      }
      if (IMAGE_FIELDS.some((k) => JSON.stringify(oc[k] ?? null) !== JSON.stringify(nc[k] ?? null))) {
        deadCharIds.add(id);
      }
    }
    const oldItems = new Map((oldCards.items ?? []).map((i) => [i.id, i]));
    const newItems = new Map((cards.items ?? []).map((i) => [i.id, i]));
    for (const [id, oi] of oldItems) {
      const ni: ItemCard | undefined = newItems.get(id);
      if (!ni || oi.imagePrompt !== ni.imagePrompt) deadItemIds.add(id);
    }
  } else {
    // 无旧卡片可比对（首存）：沿用旧的全量清理，避免新旧混用
    for (const c of cards.characters) deadCharIds.add(c.id);
    for (const i of cards.items ?? []) deadItemIds.add(i.id);
  }
  try {
    const imageDir = `${cacheDir}/images`;
    const entries = await tauri.listDir(imageDir);
    // 存活 id 前缀保护（id "a" 与 "a_b" 的 figure 文件都会命中 figure_a_，后者不能误删）
    const liveFigurePrefix = cards.characters
      .filter((c) => !deadCharIds.has(c.id))
      .map((c) => `figure_${sanitizeId(c.id).toLowerCase()}_`);
    const liveThreeview = new Set(
      cards.characters.filter((c) => !deadCharIds.has(c.id)).map((c) => `threeview_${sanitizeId(c.id).toLowerCase()}`),
    );
    const liveItem = new Set(
      (cards.items ?? []).filter((i) => !deadItemIds.has(i.id)).map((i) => `item_${sanitizeId(i.id).toLowerCase()}`),
    );
    const baseNoExt = (name: string): string => name.replace(/\.(png|jpg|jpeg|webp)$/i, "");
    for (const e of entries) {
      if (e.isDir) continue;
      const lower = e.name.toLowerCase();
      const base = baseNoExt(lower);
      let dead = false;
      if (lower.startsWith("figure_")) {
        const hitDead = [...deadCharIds].some((id) => lower.startsWith(`figure_${sanitizeId(id).toLowerCase()}_`));
        const hitLive = liveFigurePrefix.some((pre) => lower.startsWith(pre));
        dead = hitDead && !hitLive;
      } else if (lower.startsWith("threeview_")) {
        const sid = [...deadCharIds].map((id) => `threeview_${sanitizeId(id).toLowerCase()}`);
        dead = sid.includes(base) && !liveThreeview.has(base);
      } else if (lower.startsWith("item_")) {
        const sid = [...deadItemIds].map((id) => `item_${sanitizeId(id).toLowerCase()}`);
        dead = sid.includes(base) && !liveItem.has(base);
      }
      if (dead) {
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
      : imageCleared > 0
        ? `卡片已保存：${imageCleared} 个立绘/物品图缓存已失效（仅绘画相关改动，未改动的不重画）；剧本缓存保留，如需重写剧本请用「重新生成此章」`
        : "卡片已保存：本次改动不涉及绘画（音色/文字类），图片缓存全部保留",
    "success",
  );
  return { scriptCacheCleared: scriptCleared, imageCacheCleared: imageCleared };
}
