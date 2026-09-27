/**
 * 图片小说分镜的两条线上缺陷回归：
 *  ① 分镜被画成「角色设定稿」（左立绘+右三视图+脸部特写+配色圆点）→ 提示词必须钉死"单幅整屏插画"并剥掉设定稿措辞；
 *  ② 人物跨图漂移 → 分镜必须带角色基准图参考 + 重复固定外貌（官方 GPT Image 两步法：参考图 + images.edit + 重复外貌约束）。
 * 官方依据：https://developers.openai.com/api/docs/guides/image-prompting （Keep a character consistent）
 *          https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
 *          （Children's Book Art with Character Consistency: images.edit(image=[参考图], prompt=...)）
 * 同时覆盖：只为有分镜的角色建基准图（省成本）、无参考图时显式告警、多图 edit 的 multipart 字段名。
 */
import { buildEditMultipartFiles } from "../src/api/imageEdits";
import {
  buildShotPrompt,
  buildImageTasks,
  characterAppearanceAnchor,
  fitImagePrompt,
  shotAppearanceLock,
  shotCharacterIdsOfTask,
  shotConsistencySuffix,
  shotEditPrompt,
  stripCharacterSheetWording,
} from "../src/core/images";
import { buildImageStoryPlan, IMAGE_YUAN_EACH } from "../src/core/imageStory";
import type { ChapterScript, CharacterCard, ExtractionResult, ImageTask, ImageStoryOptions } from "../src/core/types";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function card(id: string, imagePrompt: string, extra: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id,
    name: id,
    appearance: "",
    clothing: "",
    personality: "",
    voiceDesc: "",
    imagePrompt,
    color: "#fff",
    ...extra,
  };
}

const alice = card("alice", "anime girl, silver long hair, red eyes, black school uniform with a red ribbon");
const bob = card("bob", "anime boy, short black hair, green eyes, blue coat");
const ghost = card("ghost", "a hooded figure");
const never = card("never", "an unused NPC with a green hat");
const cards: ExtractionResult = { title: "t", characters: [alice, bob, ghost, never], scenes: [], items: [] };

/* ---------- 1) 设定稿措辞剥离（纯函数） ---------- */
{
  const stripped = stripCharacterSheetWording(
    "a girl standing at the gate, three views, character reference sheet, front view / side view / back view, warm sunset lighting, 配色板, 三视图设定稿",
  );
  assert(stripped.includes("a girl standing at the gate"), "正常剧情描述必须保留");
  assert(stripped.includes("warm sunset lighting"), "光线等剧情描述必须保留");
  for (const bad of ["three views", "character reference sheet", "front view", "back view", "配色板", "三视图", "设定稿"]) {
    assert(!stripped.includes(bad), `设定稿措辞应被剥掉：${bad}（实际：${stripped}）`);
  }
  // 剧情道具"角色卡"不能误伤（只有"角色+设定/设计/参考+卡/稿"组合才删）
  const prop = stripCharacterSheetWording("a girl holding a character card in her hand, her mother in a doorway");
  assert(prop.includes("character card in her hand"), `剧情道具"角色卡"不应被剥掉：${prop}`);
  assert(prop.includes("her mother in a doorway"), "同子句剧情必须保留");
  // 已经是干净提示词时原样保留
  const clean = "a girl running through a wheat field, dusk, wide shot";
  assert(stripCharacterSheetWording(clean) === clean, `干净提示词不应被改写：${stripCharacterSheetWording(clean)}`);
  // 只丢设定稿子句，邻居子句必须留下（短语删完的残句也要整条丢，不能留半截）
  for (const junk of ["front view", "expression grid", "3 views", "2 poses", "close-up of the face inset"]) {
    const out = stripCharacterSheetWording(`a girl at the gate, ${junk}, warm sunset lighting`);
    assert(out === "a girl at the gate, warm sunset lighting", `残句应整条丢弃（${junk}）：${out}`);
  }
  assert(
    stripCharacterSheetWording("角色站在城门前，正侧背三视图，暖色夕阳") === "角色站在城门前, 暖色夕阳",
    `中文设定稿子句应整条丢弃：${stripCharacterSheetWording("角色站在城门前，正侧背三视图，暖色夕阳")}`,
  );
  // 删完措辞只剩标点的残渣子句也要丢（不能把 ":" 之类塞进提示词）
  assert(
    !stripCharacterSheetWording("角色设定稿：\na girl at the gate").includes(":"),
    `纯标点残渣应丢弃：${stripCharacterSheetWording("角色设定稿：\na girl at the gate")}`,
  );
}

/* ---------- 2) 分镜硬约束段 ---------- */
{
  const suffix = shotConsistencySuffix();
  assert(suffix.startsWith(", single scene illustration"), "硬约束段须以可识别的标记开头（fitImagePrompt 靠它保住尾段）");
  for (const must of [
    "not a character reference sheet",
    "no three-view or turnaround layout",
    "no multi-panel or grid",
    "no color palette chart",
    "no color swatches",
    "no facial close-up insets",
    "no costume or prop breakdown",
    "never render character card information as picture content",
    "no text",
    "no watermark",
    "no chroma key green screen",
  ]) {
    assert(suffix.includes(must), `硬约束缺少：${must}`);
  }
}

/* ---------- 3) 外貌锁定段（官方 "Repeat the appearance constraints"） ---------- */
{
  assert(characterAppearanceAnchor(alice) === alice.imagePrompt, "外貌锚点应取 imagePrompt");
  const noImagePrompt = characterAppearanceAnchor(card("x", "", { appearance: "金发碧眼", clothing: "白裙" }));
  assert(noImagePrompt.includes("金发碧眼") && noImagePrompt.includes("白裙"), `缺 imagePrompt 时应退回 appearance+clothing：${noImagePrompt}`);
  const withGreen = characterAppearanceAnchor(card("y", "a girl, plain solid green background, three views"));
  assert(!/background/i.test(withGreen) && !/three views/i.test(withGreen), `外貌锚点须剥掉绿幕与设定稿措辞：${withGreen}`);

  const lock = shotAppearanceLock([alice, bob, alice]);
  assert(lock.includes(alice.imagePrompt) && lock.includes(bob.imagePrompt), "每个出场角色的固定外貌都应重复");
  assert(lock.split(alice.imagePrompt).length === 2, "同角色不应重复写入");
  assert(shotAppearanceLock([]) === "", "无角色时不应产生空锁段");
  // 刻意不写角色名：名字会诱发模型把名字当画面文字渲染
  assert(!lock.includes("alice"), "外貌锁定段不应写角色名（避免诱发画面文字）");
}

/* ---------- 4) 分镜最终提示词：顺序 + 只作用于分镜 ---------- */
{
  const prompt = buildShotPrompt("a girl at the gate, character sheet layout", ", anime style", [alice]);
  assert(prompt.startsWith("a girl at the gate"), "剧情描述应在最前");
  assert(!prompt.includes("character sheet layout"), "设定稿措辞应在拼接前剥掉");
  assert(prompt.includes(", anime style"), "画风段应保留");
  assert(prompt.indexOf("character appearance lock") > prompt.indexOf("anime style"), "外貌锁定段排在画风之后（尾部才不会被压缩掉）");
  assert(prompt.indexOf("single scene illustration") > prompt.indexOf("character appearance lock"), "硬约束段排在最后");
  assert(prompt.includes(alice.imagePrompt), "分镜提示词必须带上角色固定外貌");

  // 立绘/三视图/物品不得被这条约束误伤
  const tasks = buildImageTasks([], cards, { styleAnchor: false, detail: "core" });
  for (const t of tasks) {
    assert(!t.prompt.includes("single scene illustration"), `${t.kind}:${t.id} 不应带分镜硬约束`);
  }
  const threeview = tasks.find((t) => t.kind === "threeview" && t.id === "alice_threeview")!;
  assert(threeview.prompt.includes("three-view character reference sheet"), "立绘版三视图仍是三视图设定稿（未改动）");
  assert(threeview.promptVersion === undefined, "立绘版三视图不带提示词版本号（存量缓存照旧复用，不额外计费）");
}

/* ---------- 5) 出场角色解析：声明优先，漏标退回场景表 ---------- */
{
  const valid = new Set(["alice", "bob"]);
  assert(shotCharacterIdsOfTask({ characters: ["alice", "nobody"] }, { figures: ["bob"] }, valid).join() === "alice", "声明优先且过滤无效 id");
  assert(shotCharacterIdsOfTask({}, { figures: ["bob", "nobody"] }, valid).join() === "bob", "分镜漏标 characters 时应退回场景出场表");
  assert(shotCharacterIdsOfTask({}, {}, valid).length === 0, "两处都没有时才是无角色");
}

/* ---------- 6) 图片小说计划：基准图只给有分镜的角色 + editVariant + 费用如实计入 ---------- */
function scene(id: string, figures: string[], shots: { prompt: string; characters?: string[] }[]): ChapterScript["scenes"][number] {
  return {
    id,
    location: "城门",
    atmosphere: "黄昏",
    time: "傍晚",
    bgPrompt: "gate",
    itemEvents: [],
    figures,
    lines: [{ type: "dialogue", characterId: "alice", text: "…" }],
    shots: shots.map((s, i) => ({
      id: `${id}_shot${i + 1}`,
      prompt: s.prompt,
      triggerLineIndex: 0,
      ...(s.characters ? { characters: s.characters } : {}),
    })),
  };
}

const options: ImageStoryOptions = {
  shotsPerScene: 0,
  shotsPerChapter: 0,
  shotsTotal: 0,
  imageStyle: "anime style",
  imageSeed: 0,
  styleAnchor: false,
  includeItems: false,
};

const chapters: ChapterScript[] = [
  {
    chapter: 0,
    title: "第一章",
    scenes: [
      scene("s1", ["alice", "bob"], [
        { prompt: "alice at the gate", characters: ["alice"] },
        { prompt: "alice and bob argue", characters: ["alice", "bob"] },
        { prompt: "bob alone, 分镜未标注出场角色" },
      ]),
    ],
  },
];
const plan = buildImageStoryPlan(chapters, cards, options);
{
  // never/ghost 都没有分镜 → 不建基准图（不出场不花钱）
  const baselineIds = plan.tasks.filter((t) => t.kind === "threeview").map((t) => t.id).sort();
  assert(baselineIds.join() === "alice_threeview,bob_threeview", `基准图只应给有分镜的角色：${baselineIds.join()}`);
  assert(plan.characterBaselineCount === 2, `基准图张数应如实报出：${plan.characterBaselineCount}`);
  assert(plan.threeviewCount === plan.characterBaselineCount, "两种口径应同值");
  // 费用：基准图张数计入总账（与改动前同为「每角色 1 张」，此处按有分镜的角色收窄 → 不增张数）
  assert(plan.estimatedYuan === Math.round(plan.tasks.length * IMAGE_YUAN_EACH * 100) / 100, "费用应按任务总数计");
  assert(plan.tasks.length === 5, `2 基准图 + 3 分镜 = 5，实际 ${plan.tasks.length}`);

  const declared = plan.tasks.find((t) => t.kind === "shot" && t.shotIndex === 0)!;
  assert(declared.editVariant === "shot", "有角色的分镜应标记 editVariant=shot（参考图走 images.edit）");
  assert(typeof declared.promptVersion === "number" && declared.promptVersion > 0, "分镜应带提示词版本号（存量旧分镜缓存判失效重画）");
  const baseline = plan.tasks.find((t) => t.kind === "threeview" && t.id === "alice_threeview")!;
  assert(baseline.promptVersion === declared.promptVersion, "基准图与分镜同批升级提示词约束");
  assert(/single character reference portrait/.test(baseline.prompt), "imageOnly 基准图应为单人正视全身（不再用三视图转面稿）");
  assert(!/three-view character reference sheet/.test(baseline.prompt), "imageOnly 基准图不得再要求三视图版式");
  assert(declared.refFromTask === "alice_threeview", "主身份参考图");
  assert(declared.prompt.includes("single scene illustration"), "分镜提示词应含单幅插画硬约束");
  assert(declared.prompt.includes(alice.imagePrompt), "分镜提示词应重复角色固定外貌");

  const multi = plan.tasks.find((t) => t.kind === "shot" && t.shotIndex === 1)!;
  assert(multi.editVariant === "shot" && multi.prompt.includes(bob.imagePrompt), "多人同框应锁定每个角色");

  // 未标注 characters 的分镜：退回场景表 → 拿到参考图（不再静默纯文生图）
  const inferred = plan.tasks.find((t) => t.kind === "shot" && t.shotIndex === 2)!;
  assert(inferred.refFromTask === "alice_threeview", "漏标 characters 的分镜应按场景出场表挂参考图");
  assert(inferred.editVariant === "shot", "漏标但推出角色的分镜同样走 edit");
}

/* ---------- 7) 全无角色分镜：无参考图、无 editVariant（运行期会显式告警） ---------- */
{
  const noCharCards: ExtractionResult = { title: "t", characters: [alice, never], scenes: [], items: [] };
  const noCharChapters: ChapterScript[] = [
    { chapter: 0, title: "c", scenes: [scene("s1", [], [{ prompt: "an empty street at dawn" }])] },
  ];
  const noCharPlan = buildImageStoryPlan(noCharChapters, noCharCards, options);
  const shot = noCharPlan.tasks.find((t) => t.kind === "shot")!;
  assert(!shot.refFromTask, "无角色分镜不应有身份参考");
  assert(!shot.editVariant, "无角色分镜没有可编辑的参考图，不应标 editVariant");
  assert(noCharPlan.characterBaselineCount === 0, "无角色分镜时不应生成基准图（省成本）");
  assert(shot.prompt.includes("single scene illustration"), "无角色分镜同样要有单幅插画硬约束");
  assert(shot.prompt.includes("character appearance lock") === false, "无角色时不应有空的外貌锁定段");
}

/* ---------- 8) 超长分镜提示词压缩：外貌锁定段 + 硬约束段必须保住 ---------- */
{
  const filler = Array.from({ length: 80 }, (_, i) => `detail-${i} with ornate engraving and flowing cape`).join(", ");
  const longShot = buildShotPrompt(`a brave knight at the gate, ${filler}`, ", anime style", [alice]);
  assert(longShot.length > 1500, "夹具应超长");
  const fitted = fitImagePrompt(longShot, 1500);
  assert(fitted.length <= 1500, `压缩后应 ≤1500，实际 ${fitted.length}`);
  assert(fitted.includes("character appearance lock"), "压缩后必须保住外貌锁定段");
  assert(fitted.includes(alice.imagePrompt), "压缩后必须保住角色固定外貌正文");
  assert(fitted.includes("single scene illustration"), "压缩后必须保住单幅插画硬约束");
  assert(fitted.startsWith("a brave knight at the gate"), "主体描述开头应保留");
}

/* ---------- 9) 分镜 edit 指令：重复身份约束 + 禁止重新设计 ---------- */
{
  const task: ImageTask = {
    kind: "shot",
    id: "s1_shot1",
    prompt: buildShotPrompt("a girl at the gate", ", anime style", [alice]),
    fileName: "shot_ch1_s1_1.png",
    width: 1536,
    height: 1024,
  };
  const editPrompt = shotEditPrompt(task);
  assert(editPrompt.includes("identity reference"), "edit 指令应说明参考图只作身份基准");
  assert(/same facial features/i.test(editPrompt) && /same color palette/i.test(editPrompt), "edit 指令应重复身份约束");
  assert(/Do not redesign the character/i.test(editPrompt), "edit 指令应禁止重新设计角色");
  assert(editPrompt.includes(task.prompt), "edit 指令应带上分镜提示词本体");
}

/* ---------- 10) 多图 edit 的 multipart：单图 image / 多图 image[] ---------- */
{
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 8]);
  const single = new TextDecoder("latin1").decode(
    buildEditMultipartFiles("B", { model: "gpt-image-2" }, [{ filename: "a.png", mime: "image/png", bytes }]),
  );
  assert(single.includes('name="image"; filename="a.png"'), "单图应使用 image 字段");
  assert(!single.includes("image[]"), "单图不应使用 image[]");

  const multi = new TextDecoder("latin1").decode(
    buildEditMultipartFiles("B", { model: "gpt-image-2" }, [
      { filename: "a.png", mime: "image/png", bytes },
      { filename: "b.png", mime: "image/png", bytes },
      { filename: "c.jpg", mime: "image/jpeg", bytes },
    ]),
  );
  assert((multi.match(/name="image\[\]"/g) ?? []).length === 3, "多图应重复 image[] 字段（官方 curl 写法）");
  assert(multi.includes('filename="c.jpg"; ') === false && multi.includes('name="image[]"; filename="c.jpg"'), "每个参考图都应带自己的文件名");
  assert(multi.includes("Content-Type: image/jpeg"), "应保留各参考图自己的 MIME");
  assert(multi.startsWith("--B\r\n") && multi.endsWith("--B--\r\n"), "multipart 边界应正确");
}

console.log("=== image shot consistency tests passed ===");
