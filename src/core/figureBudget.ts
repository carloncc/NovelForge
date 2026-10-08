/**
 * 角色图片档位（按重要度给「立绘/表情/服装/动作」定预算）。
 *
 * 背景（实测某 25 角色项目）：`full` 档把 AI 提取的表情**全量**用上，且**完全不区分角色重要度**——
 * 8 个主要角色与 17 个只出场一次的路人（卡车司机 10 表情 + 3 服装 + 5 动作…）预算完全相同，
 * 立绘/表情类 309 张里 198 张（57%）花在路人身上；而动作早就有限流（`maxActionsPerCharacter`），
 * 表情却一个上限都没有。
 *
 * 本模块只做「档位 → 预算」这一件事，且**判定只依赖角色卡字段**（isNpc / figureTier），
 * 不依赖章节、不依赖调用参数。这一点是刻意的：
 *
 *   同一个角色会被 20 多处构建路径分别建任务（主管线、单章跳过的「已有成品」判定、
 *   章节灯、素材页补缺、批量重生成、视觉守门…）。只要档位判定带上「本次传了哪些章节」
 *   这类上下文，两条路径就会算出**不同的文件名清单**，直接复现 #1521 那一族 bug
 *   （单章模式永远凑不齐成品 → 每次重跑都真金白银地重新生成）。
 *   判定只吃角色卡，则任何调用方拿到的都是同一份清单，结构上不可能漂移。
 *
 * 想给某个角色加图/减图：改角色卡上的 `figureTier`（卡片编辑里的「图片档位」），
 * 而不是给构建函数加参数。
 */
import type { CharacterCard, FigureTier } from "./types";

export type { FigureTier, FigureTierSetting } from "./types";

/** 单个角色的图片预算；`Infinity` = 不限 */
interface FigureBudget {
  /** 表情图总数上限（**含 normal 默认立绘**）：5 = 默认立绘 + 4 张表情差分 */
  emotions: number;
  /** 服装差分立绘上限（0 = 不生成服装差分） */
  costumes: number;
  /** 动作立绘上限（0 = 不生成动作；主要角色另受 maxActionsPerCharacter 旋钮约束） */
  actions: number;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

/**
 * 档位预算表。
 *
 * · main       —— 主要角色：表情/服装/动作按剧本实际使用出图（无剧本记录时退回卡片全量 + 动作前 2）
 * · supporting —— 次要角色/NPC：标准 5 表情（默认 + 4 差分）、1 套服装、1 个动作
 * · cameo      —— 路人：默认立绘 + 1 张表情差分，无服装、无动作
 *
 * 主要角色的动作**不设张数上限**（档位预算 ∞）：挑选已经由"剧本用量降序"完成——
 * 实测出图端原本取卡面前 2 个、剧本端从整表挑，32 张里 15 张用不到，同时 69 处台词标注的
 * 动作没图；改成按用量出图后 72 张每张都用得上，且"手动重生成覆盖全部动作"的能力不丢。
 *
 * 为什么支持/路人档不把表情压到 0：渲染端对缺失的表情/服装/动作差分**有回退**
 * （render.ts 先找表情差分，找不到就用默认立绘；换装图缺失同样回退默认立绘），
 * 所以裁掉差分不会出现空场，只是该角色少几种脸色。
 */
export const FIGURE_TIER_BUDGET: Record<FigureTier, FigureBudget> = {
  main: { emotions: UNLIMITED, costumes: UNLIMITED, actions: UNLIMITED },
  supporting: { emotions: 5, costumes: 1, actions: 1 },
  cameo: { emotions: 2, costumes: 0, actions: 0 },
};

/**
 * 档位判定（纯函数，只读角色卡）：
 *   1. 卡片显式设置优先（用户在卡片编辑里选的档位）；
 *   2. auto：AI 提取时标了 `isNpc` 的按次要角色，其余按主要角色。
 *
 * 注意 auto **不会**把 isNpc=false 的角色降级：宁可多花几张图，也不要因为一次误判
 * 让主角只剩两种表情（主角缺表情是最容易被玩家一眼看出来的降级）。
 */
export function resolveFigureTier(card: Pick<CharacterCard, "isNpc" | "figureTier">): FigureTier {
  const explicit = card.figureTier;
  if (explicit === "main" || explicit === "supporting" || explicit === "cameo") return explicit;
  return card.isNpc === true ? "supporting" : "main";
}

/** 该角色的图片预算（纯函数） */
export function figureBudgetFor(card: Pick<CharacterCard, "isNpc" | "figureTier">): FigureBudget {
  return FIGURE_TIER_BUDGET[resolveFigureTier(card)];
}

/** 按上限裁剪列表（不改原数组；Infinity/非法值一律视为不限） */
export function capByBudget<T>(list: readonly T[], max: number): T[] {
  if (!Number.isFinite(max)) return [...list];
  const limit = Math.max(0, Math.floor(max));
  return list.length <= limit ? [...list] : list.slice(0, limit);
}
