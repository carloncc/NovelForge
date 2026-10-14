/**
 * #1576：按剧本实际使用出图（表情/服装/动作）+ 背景「同一地点每章上限」+ CG 空提示词兜底。
 *
 * 背景（实测某 30 章项目）：
 *   · 表情 160 张里 115 张从未被任何台词引用（剧本端表情枚举写死 5 种，提取端给 7~10 种）；
 *   · 服装 80 张里只有 6 套真被穿上；动作 32 张里 15 张用不到，同时 69 处台词标注的动作没图；
 *   · 背景 502 张里同一间公寓 79 张（LLM 给每个场景实例写一条独一无二的氛围）；
 *   · 11 张 CG 里 7 张提示词逐字相同（cgEvent 只有 triggerIndex，imagePrompt 为空）。
 *
 * 本测试锁定：
 *   ① 使用集合的统计与写回（含"只保留卡内合法 id""按次数降序"）；
 *   ② 三份清单按使用集合出图（不再生成永远用不上的差分）；
 *   ③ 背景按「每章同地点上限」收敛，且整本构建与单章构建结果一致（#1521 那族不变量）；
 *   ④ CG 缺提示词时兜底正文各不相同、并带失效版本号。
 */
import type { ChapterScript, CharacterCard, ExtractionResult, SceneJSON } from "../src/core/types";
import { buildImageTasks, cgFallbackPromptBody, selectBackgroundScenes, figureActionEntries, figureCostumeEntries, figureEmotionEntries } from "../src/core/images";
import { attachCharacterImageUsage, collectCharacterImageUsage, countCharacterUsage } from "../src/core/imageUsage";

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
  imagePrompt: "alice, silver hair",
  color: "#9ca3af",
  emotions: ["happy", "sad", "angry", "surprised", "shy", "cry", "relieved", "determined", "jealous", "smug"],
  costumes: [
    { id: "school_uniform", name: "校服", prompt: "school uniform" },
    { id: "bikini", name: "泳装", prompt: "bikini" },
    { id: "yukata", name: "浴衣", prompt: "yukata" },
  ],
  actions: [
    { id: "stand", name: "站立", prompt: "standing" },
    { id: "walk", name: "走路", prompt: "walking" },
    { id: "sit", name: "坐下", prompt: "sitting" },
    { id: "hold_phone", name: "拿手机", prompt: "holding phone" },
    { id: "run", name: "跑", prompt: "running" },
    { id: "sleep", name: "睡", prompt: "sleeping" },
  ],
  ...over,
});

const cardsOf = (...list: CharacterCard[]): ExtractionResult => ({ title: "t", characters: list, scenes: [], items: [] });

const scene = (over: Partial<SceneJSON> & { id: string }): SceneJSON => ({
  location: "教室",
  time: "白天",
  atmosphere: "平静",
  bgPrompt: "empty classroom, no people",
  lines: [],
  ...over,
} as SceneJSON);

const line = (over: Record<string, unknown>): SceneJSON["lines"][number] => ({ type: "dialogue", text: "…", characterId: "alice", ...over } as never);

const chapterOf = (index: number, scenes: SceneJSON[]): ChapterScript => ({ chapter: index, title: `第${index + 1}章`, scenes } as ChapterScript);

function main(): void {
  /* ---------- 1) 使用集合统计：按次数降序、只留卡内合法 id ---------- */
  {
    const chapter = chapterOf(0, [
      scene({
        id: "s1",
        lines: [
          line({ emotion: "happy" }),
          line({ emotion: "happy" }),
          line({ emotion: "sad" }),
          line({ emotion: "nonexistent_emotion" }), // 卡里没有 → 不该进集合（生成不了）
          line({ costume: "bikini" }),
          line({ action: "walk" }),
          line({ action: "walk" }),
          line({ action: "fly" }), // 卡里没有
        ],
      }),
    ]);
    const raw = countCharacterUsage([chapter]);
    assert(raw.get("alice")!.emotions.get("happy") === 2, "同一表情出现两次应计 2 次");
    const usage = collectCharacterImageUsage([chapter], cardsOf(card()));
    const u = usage.get("alice")!;
    assert(u.emotions.join(",") === "happy,sad", `表情应按次数降序且只留卡内 id，实际 ${u.emotions.join(",")}`);
    assert(u.costumes.join(",") === "bikini", "服装应只留剧情真穿的");
    assert(u.actions.join(",") === "walk", "动作应只留剧本用到的");
    assert(u.chapters === 1, "应记录统计口径的章节数");

    // 分支选项里的台词同样计入（渲染会切到那些差分）
    const withChoice = chapterOf(0, [scene({ id: "s1", lines: [{ ...line({}), choices: [{ lines: [line({ emotion: "angry" })] }] } as never] })]);
    const u2 = collectCharacterImageUsage([withChoice], cardsOf(card())).get("alice")!;
    assert(u2.emotions.includes("angry"), "分支选项里的表情也要统计");
  }

  /* ---------- 2) 写回卡片：只在变化时写 ---------- */
  {
    const alice = card();
    const chapters = [chapterOf(0, [scene({ id: "s1", lines: [line({ emotion: "happy" })] })])];
    const first = attachCharacterImageUsage(cardsOf(alice), chapters);
    assert(first.changed === 1 && first.withUsage === 1, "首次应写入 1 个角色");
    assert(alice.imageUsage?.emotions.join(",") === "happy", "使用集合应写到卡片上");
    const second = attachCharacterImageUsage(cardsOf(alice), chapters);
    assert(second.changed === 0, "内容未变时不应重复写（避免把卡片写脏、触发无谓的保存与缓存失效）");
    // 零台词角色也要拿到一条（空）记录：这条空记录是「剧本确实没用过」的凭据，
    // 下游据此省图；若干脆不写，下游只能回退卡片全量 → 白出整卡差分。
    const npcNoLines = card({ id: "bob", name: "路人" });
    const written = attachCharacterImageUsage(cardsOf(alice, npcNoLines), chapters);
    assert(written.withUsage === 2, `每个角色都应拿到使用记录（含空记录），实际 ${written.withUsage}`);
    assert(npcNoLines.imageUsage !== undefined, "零台词角色必须被写入空使用记录（不能跳过）");
    assert(
      npcNoLines.imageUsage!.emotions.length === 0 && npcNoLines.imageUsage!.costumes.length === 0 && npcNoLines.imageUsage!.actions.length === 0,
      "零台词角色的使用记录三份清单都应为空",
    );
  }

  /* ---------- 3) 三份清单按使用集合出图 ---------- */
  {
    const alice = card({ imageUsage: { emotions: ["happy"], costumes: ["bikini"], actions: ["walk", "hold_phone"], chapters: 1 } });
    // 【2026-10-13 修复：使用集合是**排序提示**而不是白名单】
    // 旧断言 `normal,happy` 把「卡片里存在但上次统计没用过」的表情全部裁掉，后果是用户在卡片编辑里
    // 新补的 sad/angry 永远不出图（哪怕剧本里已经标注了它们，渲染端只能回退默认立绘），且毫无提示。
    // 现在口径：用过的按用量降序排在前，其余卡片表情接在后面，最后由档位预算裁剪——
    // 主要角色表情预算不限，故这里是「normal + 用过的 happy + 卡片其余 10 个」。
    // 「统计过且剧本一次没用 → 只留 normal」的省图口径**没有放宽**，见下面 analyzedEmpty 的断言。
    const emos = figureEmotionEntries(alice, { figureEmotions: true, detail: "full" }).map((e) => e.id);
    assert(
      emos.slice(0, 2).join(",") === "normal,happy",
      `用过的表情必须排在最前（其余卡片表情接在后面），实际 ${emos.join(",")}`,
    );
    assert(emos.length === 11, `主要角色表情预算不限，应出卡片全量 + normal，实际 ${emos.length}`);
    assert(emos.includes("sad") && emos.includes("angry"), "卡片里存在但上次没用过的表情也必须出图（否则用户后加的永远不构建）");
    const costumes = figureCostumeEntries(alice, { detail: "full", threeView: true }).map((c) => c.id);
    assert(costumes[0] === "bikini", `剧情真穿过的服装必须排在最前，实际 ${costumes.join(",")}`);
    assert(costumes.length === 3, `主要角色服装预算不限，应出卡片全量，实际 ${costumes.join(",")}`);
    const acts = figureActionEntries(alice, { actions: true, threeView: true });
    assert(acts.map((a) => a.id).join(",") === "walk,hold_phone,stand,sit,run,sleep", `动作应按剧本用量在前、卡片其余在后，实际 ${acts.map((a) => a.id).join(",")}`);
    // 没有使用记录时退回旧行为：卡面前 2 个动作、卡片全量表情/服装
    const bare = card();
    assert(figureActionEntries(bare, { actions: true, threeView: true }).map((a) => a.id).join(",") === "stand,walk", "无使用记录时沿用卡面前 2 个动作");
    assert(figureEmotionEntries(bare, { figureEmotions: true, detail: "full" }).length === 11, "无使用记录时表情仍是卡片全量 + normal");
    // 主要角色的动作不设张数上限：挑选已由「剧本用量降序」完成，每张都用得上
    const many = card({ imageUsage: { emotions: [], costumes: [], actions: ["stand", "walk", "sit", "hold_phone", "run", "sleep"], chapters: 1 } });
    const manyActs = figureActionEntries(many, { actions: true, threeView: true }).map((a) => a.id);
    assert(manyActs.length === 6, `主要角色应按用量出全部用到的动作，实际 ${manyActs.length}`);
    assert(manyActs.join(",") === "stand,walk,sit,hold_phone,run,sleep", "顺序按使用次数降序（同次数按 id 稳定排序）");
    // 【省图核心】"统计过但一次没用" ≠ "还没统计"：前者只留默认立绘，后者才回退卡片全量。
    // 判据必须是字段存在性——用 `length` 会把空记录当成没统计，白出整卡差分。
    // 实测某 30 章项目：9 个零台词角色因此多出 63 张永远不上屏的差分。
    {
      const analyzedEmpty = card({ imageUsage: { emotions: [], costumes: [], actions: [], chapters: 1 } });
      assert(
        figureEmotionEntries(analyzedEmpty, { figureEmotions: true, detail: "full" }).map((e) => e.id).join(",") === "normal",
        "统计过且剧本没用表情 → 只留 normal 默认立绘（不是回退整卡 11 张）",
      );
      assert(figureCostumeEntries(analyzedEmpty, { detail: "full", threeView: true }).length === 0, "统计过且剧本没换过装 → 0 张服装差分");
      assert(figureActionEntries(analyzedEmpty, { actions: true, threeView: true }).length === 0, "统计过且剧本没标注动作 → 0 张动作（不是盲选卡面前 2 个）");
      // 对照：完全没有记录（旧项目 / 只跑了提取）仍回退卡片全量，宁可多出也不漏图
      const notAnalyzed = card();
      assert(figureEmotionEntries(notAnalyzed, { figureEmotions: true, detail: "full" }).length === 11, "无记录时仍回退整卡表情 + normal（不省图，避免漏图）");
      assert(figureCostumeEntries(notAnalyzed, { detail: "full", threeView: true }).length === 3, "无记录时仍回退整卡服装");
      assert(figureActionEntries(notAnalyzed, { actions: true, threeView: true }).length === 2, "无记录时仍沿用卡面前 2 个动作");
    }
    // 次要角色仍是 1 个动作、路人 0 个（档位预算优先于使用集合）
    const npc = card({ isNpc: true, imageUsage: { emotions: ["happy"], costumes: ["bikini"], actions: ["walk", "sit"], chapters: 1 } });
    assert(figureActionEntries(npc, { actions: true, threeView: true }).length === 1, "次要角色动作仍限 1 个");
    assert(figureCostumeEntries(npc, { detail: "full", threeView: true }).length === 1, "次要角色服装仍限 1 套");
    const cameo = card({ isNpc: true, figureTier: "cameo", imageUsage: { emotions: ["happy", "sad"], costumes: ["bikini"], actions: ["walk"], chapters: 1 } });
    assert(figureActionEntries(cameo, { actions: true, threeView: true }).length === 0, "路人不生成动作");
    assert(figureCostumeEntries(cameo, { detail: "full", threeView: true }).length === 0, "路人不生成服装差分");
    assert(figureEmotionEntries(cameo, { figureEmotions: true, detail: "full" }).length === 2, "路人表情仍限 2（normal + 1）");
  }

  /* ---------- 4) 背景：同一地点每章上限 + 单章/整本一致性 ---------- */
  {
    const ch = chapterOf(0, [
      scene({ id: "apartment", location: "satoru_apartment" }),
      scene({ id: "apartment_2", location: "satoru_apartment_3" }),
      scene({ id: "apartment_3", location: "satoru_apartment_5" }),
      scene({ id: "school", location: "school_classroom" }),
      scene({ id: "school_2", location: "school_classroom" }),
    ]);
    const capped = selectBackgroundScenes(ch, 2);
    // satoru_apartment / satoru_apartment_3 / satoru_apartment_5 归并成同一地点（去掉尾部 _数字）
    // → 该地点留 2 张、裁 1 张；school_classroom 正好 2 张全留
    assert(capped.scenes.length === 4 && capped.skipped === 1, `同地点上限 2 应留 4 张、裁 1 张，实际 ${capped.scenes.length}/${capped.skipped}`);
    assert(capped.scenes.map((s) => s.id).join(",") === "apartment,apartment_2,school,school_2", "应保留每地点最先出现的 N 张（顺序确定，重跑结果稳定）");
    assert(selectBackgroundScenes(ch, 0).scenes.length === 5, "0 = 不限制，全部保留");
    const whole = buildImageTasks([ch, chapterOf(1, [scene({ id: "s9", location: "school_classroom" })])], cardsOf(card()), { backgroundsPerLocation: 2, styleAnchor: false });
    const single = buildImageTasks([ch], cardsOf(card()), { backgroundsPerLocation: 2, styleAnchor: false });
    const bgIds = (t: ReturnType<typeof buildImageTasks>): string[] => t.filter((x) => x.kind === "background" && x.chapter === 0).map((x) => x.id).sort();
    assert(
      bgIds(whole).join("|") === bgIds(single).join("|"),
      `背景清单在整本与单章构建下必须一致（否则章节灯永远显示缺图）\n整本：${bgIds(whole).join(",")}\n单章：${bgIds(single).join(",")}`,
    );
  }

  /* ---------- 5) CG 缺提示词兜底 ---------- */
  {
    const bodyA = cgFallbackPromptBody({ location: "县立大型医院病房", atmosphere: "洁白寂静", time: "傍晚", bgPrompt: "Anime-style empty hospital ward, no people, no characters" });
    const bodyB = cgFallbackPromptBody({ location: "高级烤肉店", atmosphere: "热闹", time: "夜", bgPrompt: "Anime-style empty yakiniku restaurant, uninhabited" });
    assert(bodyA !== bodyB, "两张缺提示词的 CG 兜底正文必须不同（否则又是同一张画风图）");
    assert(!/\bno people\b|\bempty\b|\buninhabited\b/i.test(bodyA), `兜底正文必须剥掉"空镜/无人物"措辞：${bodyA}`);
    assert(bodyA.includes("县立大型医院病房"), "兜底正文应带上场景地点");
    const ch = chapterOf(0, [
      scene({ id: "cg1", figures: ["alice"], cgEvent: { triggerIndex: 1, title: "", description: "", imagePrompt: "" } }),
      scene({ id: "cg2", location: "烤肉店", figures: ["alice"], cgEvent: { triggerIndex: 2, title: "", description: "", imagePrompt: "" } }),
    ]);
    const tasks = buildImageTasks([ch], cardsOf(card()), { styleAnchor: false }).filter((t) => t.kind === "cg");
    assert(tasks.length === 2, "两个 CG 场景应产出两个任务");
    assert(tasks[0].prompt !== tasks[1].prompt, "缺提示词的两张 CG 不能再逐字相同");
    assert(tasks.every((t) => (t.promptVersion ?? 0) > 0), "兜底提示词必须带版本号，否则存量空提示词 CG 会被当成缓存命中继续复用");
    // 有提示词时逐字沿用（缓存照旧复用、不额外计费）
    const withPrompt = chapterOf(0, [scene({ id: "cg3", figures: ["alice"], cgEvent: { triggerIndex: 1, title: "告白", description: "d", imagePrompt: "cinematic confession scene at the school gate" } })]);
    const t3 = buildImageTasks([withPrompt], cardsOf(card()), { styleAnchor: false }).find((t) => t.kind === "cg")!;
    assert(t3.prompt.includes("cinematic confession scene at the school gate"), "有提示词的 CG 必须原样使用模型写的提示词");
  }

  console.log("=== 按剧本使用出图 / 背景收敛 / CG 兜底测试通过（#1576）===");
}

main();
