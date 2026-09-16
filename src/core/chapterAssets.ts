import type { ChapterScript, ExtractionResult, GenerationOptions, ImageTask } from "./types";
import { buildImageTasks, chapterCharacterIds, chapterItemIds } from "./images";

// 兼容旧引用：实现已下沉到 images.ts（单章任务裁剪与章节灯共用同一口径，避免两处漂移）
export { chapterCharacterIds, chapterItemIds };

/**
 * 本章「自己的」图像任务：本章背景/CG ＋ 本章出现角色的三视图/立绘/表情/服装/动作
 * ＋ 本章出现物品的物品图（不含全书画风锚点）。任务 id 与提示词全部走 buildImageTasks，
 * 保证与管线产出的键完全一致。
 *
 * 口径说明：管线按章重画时只动背景/CG，人物与物品是项目级资产；但章节行上的
 * 「图像 x/y」是**覆盖度**灯具（决定「全选未完成」与队列目标），要回答的是
 * 「这一章要用的图齐了吗」。旧实现把全书角色的图都算进每一章，
 * 于是每章都是同一个大数字（如 76/91），既看不出本章缺什么，也漏掉了物品。
 */
export function chapterScopeImageTasks(
  chapter: ChapterScript,
  cards: ExtractionResult,
  options: GenerationOptions,
): ImageTask[] {
  const charIds = chapterCharacterIds(chapter);
  const itemIds = chapterItemIds(chapter);
  const scoped: ExtractionResult = {
    ...cards,
    characters: cards.characters.filter((c) => charIds.has(c.id)),
    items: (cards.items ?? []).filter((i) => itemIds.has(i.id)),
  };
  return buildImageTasks([chapter], scoped, {
    figurePerCharacter: 1,
    cgPerChapter: options.cgPerChapter ?? 0,
    maxPerChapter: options.imageBudgetPerChapter ?? 0,
    figureEmotions: options.figureEmotions,
    detail: options.figureDetail ?? "full",
    style: options.imageStyle,
    threeView: options.characterPoses !== false,
    actions: options.characterPoses !== false,
    styleAnchor: false,
  });
}
