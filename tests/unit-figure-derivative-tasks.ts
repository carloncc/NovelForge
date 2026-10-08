/**
 * #1521：单章模式的「该角色成品是否齐全」判定，其文件名清单必须与 buildImageTasks 实际产出的
 * 文件名逐条一致——现在清单直接由 buildImageTasks 派生（images.ts 的 builtCharacterTasks），
 * 结构上不可能再漂移。
 *
 * 旧实现有一份手写的 derivativeFileNames，抄了一遍命名规则却漏了 maxActionsPerCharacter：
 * buildImageTasks 对动作有 `?? 2` 的上限（只生成前 2 个），手写清单却列全部。动作超过 2 个的
 * 角色因此永远「凑不齐成品」→ 单章模式每次都重建它的三视图与全部差分，反复计费。
 *
 * 本测试锁定派生所依赖的几条行为（上限、角色独占构建、表情口径、服装/动作门槛）：
 * 它们一旦变动，派生清单会随之变动，而本测试负责把变动本身钉住。
 */
import type { ChapterScript, CharacterCard, ExtractionResult } from "../src/core/types";
import { buildImageTasks } from "../src/core/images";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const card = (over: Partial<CharacterCard> = {}): CharacterCard => ({
  id: "alice",
  name: "爱丽丝",
  appearance: "银发少女",
  clothing: "校服",
  personality: "开朗",
  voiceDesc: "少女音",
  voiceName: "female-shaonv",
  imagePrompt: "alice, silver hair, school uniform",
  color: "#9ca3af",
  ...over,
});

const cardsOf = (c: CharacterCard): ExtractionResult => ({ title: "t", characters: [c], scenes: [], items: [] });
const NO_CHAPTERS: ChapterScript[] = [];

function main(): void {
  // 1) 动作上限：默认只生成前 2 个动作（这就是旧手写清单对不上的地方）
  {
    const c = card({
      actions: [
        { id: "a1", name: "挥手", prompt: "waving" },
        { id: "a2", name: "奔跑", prompt: "running" },
        { id: "a3", name: "坐下", prompt: "sitting" },
        { id: "a4", name: "回头", prompt: "looking back" },
      ],
    });
    const tasks = buildImageTasks(NO_CHAPTERS, cardsOf(c), { threeView: true, actions: true });
    const actions = tasks.filter((t) => t.kind === "action");
    assert(actions.length === 2, `动作默认上限为 2，实际 ${actions.length}（上限口径变了，派生清单随之变化）`);
    assert(
      actions.every((t) => t.characterId === "alice"),
      "动作任务必须归属该角色",
    );
    // 显式传 0 表示不限：重生成路径就是这么调的，两条路径口径本就不同
    const all = buildImageTasks(NO_CHAPTERS, cardsOf(c), { threeView: true, actions: true, maxActionsPerCharacter: 0 });
    assert(
      all.filter((t) => t.kind === "action").length === 4,
      "maxActionsPerCharacter=0 应覆盖全部 4 个动作",
    );
  }

  // 2) 只有角色、无场景的构建不应产生背景/CG——派生清单因此纯粹是「差分文件名」
  {
    const tasks = buildImageTasks(NO_CHAPTERS, cardsOf(card()), { threeView: true, actions: true });
    assert(!tasks.some((t) => t.kind === "background" || t.kind === "cg"), "无场景时不应产生背景/CG 任务");
  }

  // 3) 表情口径（#1493 三条：sanitizeId、强制含 normal、消毒后去重）
  {
    const c = card({ emotions: ["微笑", "大笑"] });
    const files = buildImageTasks(NO_CHAPTERS, cardsOf(c), { figureEmotions: true, detail: "full" })
      .filter((t) => t.kind === "figure")
      .map((t) => t.fileName);
    assert(files.includes("figure_alice_normal.png"), "表情差分必须强制包含 normal（默认立绘）");
    // 「微笑」「大笑」同为 2 个中文字符，sanitizeId 后可能撞成同一 id——必须去重
    const ids = buildImageTasks(NO_CHAPTERS, cardsOf(c), { figureEmotions: true, detail: "full" })
      .filter((t) => t.kind === "figure")
      .map((t) => t.id);
    assert(new Set(ids).size === ids.length, `表情 id 去重后不得重复：${ids.join(",")}`);

    const core = buildImageTasks(NO_CHAPTERS, cardsOf(c), { figureEmotions: true, detail: "core" })
      .filter((t) => t.kind === "figure")
      .map((t) => t.fileName);
    assert(core.includes("figure_alice_normal.png"), "core 档同样必须含 normal");
  }

  // 4) 服装差分仅在三视图开启且非 core 档时产出
  {
    const c = card({ costumes: [{ id: "ct1", name: "礼服", prompt: "formal dress" }] });
    const withCostume = buildImageTasks(NO_CHAPTERS, cardsOf(c), { threeView: true, detail: "full" })
      .some((t) => t.fileName === "figure_alice_ct_ct1_normal.png");
    assert(withCostume, "完整档 + 三视图应产出服装差分");
    const core = buildImageTasks(NO_CHAPTERS, cardsOf(c), { threeView: true, detail: "core" })
      .some((t) => t.fileName === "figure_alice_ct_ct1_normal.png");
    assert(!core, "core 档不产出服装差分");
  }

  console.log("=== 角色差分任务口径测试通过（#1521）===");
}

main();
