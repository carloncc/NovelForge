/**
 * #1575：角色图片档位（主要角色/次要角色/路人）——预算裁剪 + 各构建路径一致性。
 *
 * 背景：`full` 档把 AI 提取的表情全量用上且不区分角色重要度，实测某 25 角色项目里
 * 立绘/表情类 309 张有 198 张（57%）花在只出场一次的路人身上。修法是给角色卡加「图片档位」，
 * 由 core/figureBudget.ts 给出表情/服装/动作预算。
 *
 * 本测试锁定两件事：
 *   ① 预算真的生效（含「normal 必须保留」「重生成路径的 0=全量也不能突破档位硬上限」）；
 *   ② 档位判定只依赖角色卡——同一张卡在「主管线（带章节）」与「单章跳过判定（不带章节）」
 *      两条路径上必须产出**逐字相同的文件名清单**。这一条是 #1521 那一族 bug 的根因，
 *      一旦有人把档位判定改成依赖章节/调用参数，这里会立刻红。
 */
import type { ChapterScript, CharacterCard, ExtractionResult } from "../src/core/types";
import { buildImageTasks, figureActionEntries, figureCostumeEntries, figureEmotionEntries, figureBudgetReport } from "../src/core/images";
import { FIGURE_TIER_BUDGET, resolveFigureTier } from "../src/core/figureBudget";

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
  imagePrompt: "alice, silver hair, school uniform",
  color: "#9ca3af",
  ...over,
});

const cardsOf = (c: CharacterCard): ExtractionResult => ({ title: "t", characters: [c], scenes: [], items: [] });
const NO_CHAPTERS: ChapterScript[] = [];

/** 一份「AI 全量」角色卡：10 表情 + 3 服装 + 5 动作（路人档要能砍到 2/0/0） */
const richCard = (over: Partial<CharacterCard> = {}): CharacterCard =>
  card({
    emotions: ["happy", "sad", "angry", "surprised", "shy", "worried", "excited", "calm", "smug", "tired"],
    costumes: [
      { id: "ct1", name: "礼服", prompt: "formal dress" },
      { id: "ct2", name: "泳装", prompt: "swimsuit" },
      { id: "ct3", name: "睡衣", prompt: "pajamas" },
    ],
    actions: [
      { id: "a1", name: "挥手", prompt: "waving" },
      { id: "a2", name: "奔跑", prompt: "running" },
      { id: "a3", name: "坐下", prompt: "sitting" },
      { id: "a4", name: "回头", prompt: "looking back" },
      { id: "a5", name: "鞠躬", prompt: "bowing" },
    ],
    ...over,
  });

const figureFiles = (tasks: ReturnType<typeof buildImageTasks>): string[] =>
  tasks.filter((t) => t.kind === "figure" || t.kind === "action").map((t) => t.fileName).filter((n): n is string => !!n).sort();

const actionFiles = (tasks: ReturnType<typeof buildImageTasks>): string[] =>
  tasks.filter((t) => t.kind === "action").map((t) => t.fileName).filter((n): n is string => !!n).sort();

function main(): void {
  /* ---------- 1) 档位判定：只看角色卡 ---------- */
  {
    assert(resolveFigureTier(card()) === "main", "未标 isNpc 的角色应为主要角色");
    assert(resolveFigureTier(card({ isNpc: false })) === "main", "isNpc=false 应为主要角色");
    assert(resolveFigureTier(card({ isNpc: true })) === "supporting", "isNpc=true 应为次要角色");
    assert(resolveFigureTier(card({ isNpc: true, figureTier: "auto" })) === "supporting", "显式 auto 等价于缺省");
    assert(resolveFigureTier(card({ figureTier: "cameo" })) === "cameo", "显式档位优先于 isNpc");
    assert(resolveFigureTier(card({ isNpc: true, figureTier: "main" })) === "main", "显式主要角色应覆盖 isNpc=true");
    assert(FIGURE_TIER_BUDGET.main.emotions === Number.POSITIVE_INFINITY, "主要角色表情预算必须是不限（改动前行为）");
  }

  /* ---------- 2) 主要角色：与改动前完全一致 ---------- */
  {
    const tasks = buildImageTasks(NO_CHAPTERS, cardsOf(richCard()), { threeView: true, actions: true, detail: "full" });
    const figures = tasks.filter((t) => t.kind === "figure");
    // 卡片表情集不含 normal，管线强制补一张默认立绘 → 11 表情图 + 3 服装差分 = 14
    assert(figures.length === 14, `主要角色应为 11 表情（10 差分 + normal）+ 3 服装 = 14 张，实际 ${figures.length}`);
    assert(actionFiles(tasks).length === 2, "主要角色动作仍受 maxActionsPerCharacter 默认 2 的约束");
  }

  /* ---------- 3) 次要角色：5 表情 / 1 服装 / 1 动作 ---------- */
  {
    const c = richCard({ isNpc: true });
    const tasks = buildImageTasks(NO_CHAPTERS, cardsOf(c), { threeView: true, actions: true, detail: "full" });
    const figures = tasks.filter((t) => t.kind === "figure").map((t) => t.fileName);
    assert(figures.length === 6, `次要角色应为 5 表情 + 1 服装 = 6 张，实际 ${figures.length}`);
    assert(figures.includes("figure_alice_normal.png"), "次要角色同样必须保留 normal 默认立绘");
    // 顺序确定：按卡片表情顺序取前 4 个差分（同一项目重跑文件名稳定）
    for (const e of ["happy", "sad", "angry", "surprised"]) {
      assert(figures.includes(`figure_alice_${e}.png`), `次要角色应保留前 4 个表情中的 ${e}`);
    }
    assert(!figures.includes("figure_alice_shy.png"), "次要角色第 5 个及以后的表情差分应被裁掉");
    assert(figures.includes("figure_alice_ct_ct1_normal.png"), "次要角色保留第 1 套服装差分");
    assert(!figures.includes("figure_alice_ct_ct2_normal.png"), "次要角色第 2 套及以后服装差分应被裁掉");
    assert(actionFiles(tasks).length === 1, "次要角色动作上限为 1");
    // 重生成/补缺路径传 0（调用方不额外限制），但档位是硬上限——
    // 否则「补全缺失图片」会把裁掉的动作又补回来，两条路径的文件名清单也会再次分叉
    const regen = buildImageTasks(NO_CHAPTERS, cardsOf(c), { threeView: true, actions: true, maxActionsPerCharacter: 0 });
    assert(actionFiles(regen).length === 1, "maxActionsPerCharacter=0 不得突破档位硬上限（次要角色仍为 1 个动作）");
  }

  /* ---------- 4) 路人：默认立绘 + 1 表情，无服装/动作 ---------- */
  {
    const c = richCard({ isNpc: true, figureTier: "cameo" });
    const tasks = buildImageTasks(NO_CHAPTERS, cardsOf(c), { threeView: true, actions: true, detail: "full" });
    const figures = tasks.filter((t) => t.kind === "figure").map((t) => t.fileName);
    assert(figures.length === 2, `路人应为 normal + 1 表情 = 2 张，实际 ${figures.length}`);
    assert(figures.includes("figure_alice_normal.png"), "路人必须保留 normal（渲染兜底与差分链的锚点）");
    assert(figures.includes("figure_alice_happy.png"), "路人保留第 1 个表情差分");
    assert(actionFiles(tasks).length === 0, "路人不生成动作立绘");
    assert(tasks.some((t) => t.kind === "threeview"), "路人仍生成三视图（身份锚点，缺了立绘无法图生图）");
  }

  /* ---------- 5) 表情差分的 refFromTask 链不能断 ---------- */
  {
    const c = richCard({ isNpc: true });
    const tasks = buildImageTasks(NO_CHAPTERS, cardsOf(c), { threeView: true, actions: true });
    const base = tasks.find((t) => t.id === "alice");
    assert(!!base, "默认立绘任务必须存在");
    for (const t of tasks.filter((x) => x.kind === "figure" && x.emotion && x.emotion !== "normal")) {
      assert(t.refFromTask === "alice", `表情差分 ${t.id} 必须以默认立绘为图生图基准`);
    }
  }

  /* ---------- 6) 两条构建路径的文件名清单必须逐字相同（#1521 那一族） ---------- */
  {
    const c = richCard({ isNpc: true });
    const chapters: ChapterScript[] = [{
      chapter: 0,
      title: "第一章",
      scenes: [{
        id: "s1",
        location: "教室",
        time: "白天",
        atmosphere: "平静",
        bgPrompt: "classroom",
        figures: ["alice"],
        lines: [{ kind: "dialogue", characterId: "alice", text: "早上好" }],
      }],
    } as unknown as ChapterScript];
    const opts = { threeView: true, actions: true, figureEmotions: true, detail: "full" as const, styleAnchor: false };
    // 主管线：整本书 + 全部角色
    const pipeline = figureFiles(buildImageTasks(chapters, cardsOf(c), opts));
    // 单章模式的「该角色成品是否齐全」判定：不带章节、只带该角色（images.ts 的 builtCharacterTasks）
    const skipCheck = figureFiles(buildImageTasks(NO_CHAPTERS, { title: "", characters: [c], scenes: [], items: [] }, opts));
    assert(
      pipeline.join("|") === skipCheck.join("|"),
      `档位清单在两条路径上必须一致（否则单章模式永远凑不齐成品、反复重新计费）\n主管线：${pipeline.join(",")}\n跳过判定：${skipCheck.join(",")}`,
    );
  }

  /* ---------- 7) 素材页口径：不显示永远不会生成的图 ---------- */
  {
    const npc = richCard({ isNpc: true });
    // 素材页动作行传 maxActionsPerCharacter: 0（要能看到全部动作以便手动重生成），
    // 但档位上限仍然生效：次要角色只列 1 个动作行，与管线实际会生成的张数一致
    assert(figureActionEntries(npc, { actions: true, threeView: true, maxActionsPerCharacter: 0 }).length === 1, "素材页动作行应受档位约束");
    assert(figureCostumeEntries(npc, { detail: "full", threeView: true }).length === 1, "素材页服装行应受档位约束");
    assert(figureEmotionEntries(npc, { figureEmotions: true, detail: "full" }).length === 5, "素材页表情行应受档位约束");
    // 主要角色：动作行仍是全部 5 个（手动重生成可以覆盖被默认上限挡掉的动作，这是既有行为）
    assert(figureActionEntries(richCard(), { actions: true, threeView: true, maxActionsPerCharacter: 0 }).length === 5, "主要角色动作行不受默认上限约束");
  }

  /* ---------- 8) core 档 / 关闭表情时的口径不被档位破坏 ---------- */
  {
    const cameo = richCard({ isNpc: true, figureTier: "cameo" });
    assert(figureEmotionEntries(cameo, { figureEmotions: false }).length === 1, "关闭表情差分时只剩 normal（不再受档位影响）");
    assert(figureCostumeEntries(cameo, { detail: "core", threeView: true }).length === 0, "core 档不产出服装差分");
    assert(figureCostumeEntries(cameo, { detail: "full", threeView: false }).length === 0, "未开三视图不产出服装差分");
  }

  /* ---------- 9) 汇总口径：省下的张数可被日志如实报出 ---------- */
  {
    const cards = [
      richCard({ id: "hero", name: "主角" }),
      richCard({ id: "npc", name: "店员", isNpc: true }),
      richCard({ id: "extra", name: "卡车司机", isNpc: true, figureTier: "cameo" }),
    ];
    const report = figureBudgetReport(cards, { figureEmotions: true, detail: "full", threeView: true, actions: true });
    assert(report.byTier.main === 1 && report.byTier.supporting === 1 && report.byTier.cameo === 1, "分档计数应各 1");
    // 全按主要档出图 = 3 × (11 表情 + 3 服装 + 2 动作) = 48；
    // 实际 = 主要 16 + 次要 (5+1+1)=7 + 路人 2 = 25 → 省 23
    assert(report.saved === 23, `应省下 23 张差分，实际 ${report.saved}`);
  }

  console.log("=== 角色图片档位预算测试通过（#1575）===");
}

main();
