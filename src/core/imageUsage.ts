/**
 * 角色图片的「剧本实际使用情况」统计（纯函数 + 写回卡片）。
 *
 * 为什么需要它：出图端与剧本端长期对不上——
 *   · 表情：提取端给每角色 7~10 个自定义表情，出图端 full 档全量生成，而剧本端提示词把表情
 *     写死成 5 种（script.ts 的 dialogue 规则），实测 30 章 9862 行台词里 emotion 只有
 *     5 种标准值 + 极少量自造值 → 160 张表情差分里 115 张永远不会出现。
 *   · 服装：提取端"由 AI 按剧情决定数量、不设上限"，剧本端只在"剧情明确写了换装"时标注
 *     → 80 张服装差分里只有 6 套真被穿上。
 *   · 动作：出图端取卡面前 2 个，剧本端从整张动作表里挑最贴切的 → 69 处台词标注的动作没图。
 * 统计一次、写回卡片后，所有构建路径都从卡片读同一份使用集合，于是"按需出图"既省图，
 * 又不会让两条路径的文件名清单漂移（#1521 那一族 bug 的根因）。
 *
 * 口径：台词行（含分支选项里的台词）的 characterId + emotion/costume/action 字段；
 * 只保留能在角色卡里找到的 id（自造 id 无提示词可用，生成不了）；按使用次数降序排序。
 */
import type { ChapterScript, CharacterCard, CharacterImageUsage, ExtractionResult } from "./types";
import { sanitizeId } from "./render";

/** 单角色计数：使用次数 → id */
type Counts = Map<string, number>;

/**
 * 该角色的使用记录是否可信（= 剧本阶段统计过）。
 *
 * 这是「省图」与「漏图」的分界线，必须用**字段存在性**判定，不能用 `length`：
 *   · `undefined`         → 剧本阶段没统计过（旧项目 / 只跑了提取）→ 只能回退卡片全量，否则会漏图；
 *   · 存在但三份清单为空   → 统计过，剧本确实没用 → 应当**不出差分**。
 * 实测某 30 章项目：9 个零台词角色若被当成"没统计"回退全量，会多出 63 张永远不上屏的差分。
 */
export function usageIsKnown(card: Pick<CharacterCard, "imageUsage">): boolean {
  return !!card.imageUsage;
}

function bump(counts: Counts, id: string): void {
  if (!id) return;
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

/** 统计一份剧本里各角色的表情/服装/动作使用次数（纯函数，供单测） */
export function countCharacterUsage(chapters: ChapterScript[]): Map<string, { emotions: Counts; costumes: Counts; actions: Counts }> {
  const out = new Map<string, { emotions: Counts; costumes: Counts; actions: Counts }>();
  const visit = (line: { characterId?: string; emotion?: string; costume?: string; action?: string } | undefined): void => {
    const id = line?.characterId;
    if (!id) return;
    const rec = out.get(id) ?? { emotions: new Map(), costumes: new Map(), actions: new Map() };
    if (line!.emotion) bump(rec.emotions, sanitizeId(String(line!.emotion)));
    if (line!.costume) bump(rec.costumes, sanitizeId(String(line!.costume)));
    if (line!.action) bump(rec.actions, sanitizeId(String(line!.action)));
    out.set(id, rec);
  };
  for (const chapter of chapters) {
    for (const scene of chapter.scenes ?? []) {
      for (const line of scene.lines ?? []) {
        visit(line as never);
        for (const choice of (line as unknown as { choices?: { lines?: unknown[] }[] }).choices ?? []) {
          for (const branchLine of choice.lines ?? []) visit(branchLine as never);
        }
      }
    }
  }
  return out;
}

/** 计数 → 卡内合法 id 列表（按次数降序，同次数按 id 升序保证确定性） */
function toOrderedIds(counts: Counts | undefined, known: Map<string, string>): string[] {
  if (!counts) return [];
  return [...counts.entries()]
    .filter(([id]) => known.has(id))
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([id]) => known.get(id)!);
}

/** 统计每个角色的使用集合（**每个角色都有一条**，含"统计过但一次没用"的空记录；纯函数，供单测） */
export function collectCharacterImageUsage(
  chapters: ChapterScript[],
  cards: ExtractionResult,
): Map<string, CharacterImageUsage> {
  const raw = countCharacterUsage(chapters);
  const out = new Map<string, CharacterImageUsage>();
  for (const card of cards.characters ?? []) {
    const rec = raw.get(card.id);
    // 卡内 id → 消毒后的 key（文件名用的就是消毒后的形态）
    const known = (list: { id: string }[] | undefined): Map<string, string> => {
      const m = new Map<string, string>();
      for (const item of list ?? []) {
        const key = sanitizeId(String(item.id));
        if (key && !m.has(key)) m.set(key, String(item.id));
      }
      return m;
    };
    const emoKnown = new Map<string, string>();
    for (const e of card.emotions ?? []) {
      const key = sanitizeId(String(e));
      if (key && !emoKnown.has(key)) emoKnown.set(key, String(e));
    }
    // 没有台词记录的角色也要写一条空记录：否则下游无法区分
    // 「剧本确实没用过」与「剧本阶段还没统计」，只能回退卡片全量 → 白出图。
    out.set(card.id, {
      emotions: toOrderedIds(rec?.emotions, emoKnown),
      costumes: toOrderedIds(rec?.costumes, known(card.costumes)),
      actions: toOrderedIds(rec?.actions, known(card.actions)),
      chapters: chapters.length,
    });
  }
  return out;
}

function sameUsage(a: CharacterImageUsage | undefined, b: CharacterImageUsage): boolean {
  if (!a) return false;
  return a.chapters === b.chapters
    && a.emotions.join("|") === b.emotions.join("|")
    && a.costumes.join("|") === b.costumes.join("|")
    && a.actions.join("|") === b.actions.join("|");
}

/**
 * 把使用情况写回卡片（就地修改）。返回本次真正变化的角色数与"有使用记录"的角色数。
 * 只在内容变化时写入：避免每次跑管线都把卡片写脏（连带触发保存与缓存指纹变化）。
 *
 * **每个被统计到的角色都会拿到一条记录**（哪怕三份清单全空）——这条空记录本身就是信息，
 * 下游据此把「剧本确实没用过」与「还没统计」分开，前者不再回退卡片全量。
 */
export function attachCharacterImageUsage(
  cards: ExtractionResult,
  chapters: ChapterScript[],
): { changed: number; withUsage: number } {
  const usage = collectCharacterImageUsage(chapters, cards);
  let changed = 0;
  let withUsage = 0;
  for (const card of cards.characters ?? []) {
    const next = usage.get(card.id);
    if (!next) continue;
    withUsage++;
    if (sameUsage(card.imageUsage, next)) continue;
    card.imageUsage = next;
    changed++;
  }
  return { changed, withUsage };
}

/**
 * 使用情况汇总（日志用）：各角色"卡片里有 → 剧本真用到"的张数对比。
 * 让用户在日志里直接看到"为什么这次的图少了"，而不是怀疑漏生成。
 */
export function imageUsageReport(cards: readonly CharacterCard[]): {
  characters: number;
  emotions: [number, number];
  costumes: [number, number];
  actions: [number, number];
} {
  const out = { characters: 0, emotions: [0, 0] as [number, number], costumes: [0, 0] as [number, number], actions: [0, 0] as [number, number] };
  for (const card of cards ?? []) {
    const u = card.imageUsage;
    if (!u) continue;
    out.characters++;
    out.emotions[0] += card.emotions?.length ?? 0;
    out.emotions[1] += u.emotions.length;
    out.costumes[0] += card.costumes?.length ?? 0;
    out.costumes[1] += u.costumes.length;
    out.actions[0] += card.actions?.length ?? 0;
    out.actions[1] += u.actions.length;
  }
  return out;
}
