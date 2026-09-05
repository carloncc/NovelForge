import { buildImageTasks, taskSeedForId } from "../src/core/images";
import { vocalKeysForChapters } from "../src/core/voice";
import { scriptCacheRest } from "../src/core/cache";
import {
  novelBodyFingerprint,
  joinAppendText,
  pruneAssetRefs,
  mergeAppendedCards,
} from "../src/core/pipeline";
import type { ChapterScript, ExtractionResult } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const line = (text: string, characterId = "c1") => ({ type: "dialogue" as const, characterId, text });

// ---------- 1. 小说指纹分隔符不敏感：重分章只改切分点时指纹不变 ----------
{
  const a = novelBodyFingerprint(["第一章正文abc", "第二章正文def"]);
  const b = novelBodyFingerprint(["第一章正文a", "bc第二章正文def"]);
  assert(a === b, `同文字不同切分指纹应一致：${a} vs ${b}`);
  const c = novelBodyFingerprint(["第一章正文abc", "第二章正文de改"]);
  assert(c !== a, "文字变化指纹必须变");
}

// ---------- 2. 追加拼接格式 ----------
{
  assert(joinAppendText("旧文  ", "  新文\n") === "旧文\n\n\n新文", "追加拼接格式异常");
}

// ---------- 3. 映射剪枝：过期删、新键留、旧 CG 键迁移 ----------
{
  const chapters: ChapterScript[] = [
    {
      chapter: 0,
      title: "第一章",
      scenes: [
        { id: "s1", location: "山", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [line("你好")], figures: [] },
        {
          id: "s2", location: "水", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [line("再见")], figures: [],
          cgEvent: { title: "决战", imagePrompt: "battle" } as never,
        },
      ],
    },
  ];
  const assets = {
    bg: { s1: "/p/bg_s1.png", sold: "/p/bg_sold.png" },
    cg: { s2: "/p/cg_s2.png", "0_s2": "/p/cg_0_s2.png", "5_sgone": "/p/cg_5_sgone.png" },
    vocal: { ch0_s1_0: "/p/a.mp3", ch9_sx_0: "/p/b.mp3" },
  };
  const stat = pruneAssetRefs(assets, chapters);
  assert(!("sold" in assets.bg) && assets.bg.s1, "过期背景应剪、现存应留");
  assert(!("5_sgone" in assets.cg), "场景已死的旧 CG 键应删");
  assert(!("0_s2" in assets.cg), "旧 CG 键迁移后应删除旧键");
  assert(assets.cg.s2 === "/p/cg_s2.png", "新 CG 键已有值时不应被旧值覆盖");
  assert(stat.cgMigrated === 0, "新键已存在时不计迁移");
  assert(!("ch9_sx_0" in assets.vocal) && assets.vocal.ch0_s1_0, "过期配音键应剪");
  assert(stat.bg === 1 && stat.cg === 1 && stat.vocal === 1, `剪枝计数异常：${JSON.stringify(stat)}`);

  // 旧 CG 键在场景仍存在且新键缺失时迁移
  const assets2 = { bg: {}, cg: { "3_s2": "/p/cg_3_s2.png" }, vocal: {} };
  const stat2 = pruneAssetRefs(assets2, chapters);
  assert(assets2.cg.s2 === "/p/cg_3_s2.png", "旧 CG 键应迁移为新键");
  assert(stat2.cgMigrated === 1, "应计 1 次迁移");
}

// ---------- 4. 增量卡片合并 ----------
{
  const oldCards: ExtractionResult = {
    title: "旧书",
    characters: [{ id: "lin", name: "林澈", appearance: "旧", imagePrompt: "old" } as never],
    scenes: [{ id: "s1" } as never],
    items: [{ id: "sword" } as never],
  };
  const fresh: ExtractionResult = {
    title: "旧书",
    characters: [
      { id: "lin_new", name: "林 澈", appearance: "", imagePrompt: "new", actions: [{ id: "wave" }] } as never,
      { id: "lin", name: "撞id新人", appearance: "新" } as never,
    ],
    scenes: [{ id: "s1" } as never, { id: "s9" } as never],
    items: [],
  };
  const { merged, addedCharacters } = mergeAppendedCards(oldCards, fresh);
  assert(merged.title === "旧书", "标题应保留旧的");
  const lin = merged.characters.find((c) => c.name === "林澈")!;
  assert(lin.id === "lin", "同名角色应保留老 id");
  assert(lin.appearance === "旧", "老字段不应被空值覆盖");
  assert((lin.actions ?? []).some((a) => a.id === "wave"), "新动作应并入");
  assert(addedCharacters.includes("撞id新人"), "新角色应计入新增");
  const newcomer = merged.characters.find((c) => c.name === "撞id新人")!;
  assert(newcomer.id !== "lin", "冲突 id 必须加后缀避让");
  assert(merged.scenes.filter((s) => s.id === "s1").length === 1, "老场景 s1 不应重复");
  assert(merged.scenes.some((s) => s.id === "s1_x2"), "冲突场景 id 应加后缀");
  assert(merged.scenes.some((s) => s.id === "s9"), "新场景应加入");
  assert(merged.items.length === 1, "老物品应保留");
}

// ---------- 5. 种子按任务 id 派生：顺序无关、同 id 稳定 ----------
{
  const s1 = taskSeedForId(100, "figure_lin_normal");
  const s2 = taskSeedForId(100, "figure_lin_normal");
  assert(s1 === s2, "同任务种子必须稳定");
  assert(Number.isInteger(s1) && s1 >= 0 && s1 < 2147483647, "种子应在 31bit 范围内");
  const other = taskSeedForId(100, "bg_s1");
  assert(other !== s1, "不同任务种子应不同");
}

// ---------- 6. 剧本缓存键全文敏感：8000 字后改动必须换键 ----------
{
  const head = "前".repeat(9000);
  const r1 = scriptCacheRest("章", `${head}甲`, "");
  const r2 = scriptCacheRest("章", `${head}乙`, "");
  assert(r1 !== r2, "8000 字后的改动必须换键（旧实现漏检）");
  assert(scriptCacheRest("章", "同文", "") === scriptCacheRest("章", "同文", ""), "同输入应稳定");
}

// ---------- 7. 配音 key 与任务一致 ----------
{
  const chapters: ChapterScript[] = [
    {
      chapter: 2,
      title: "第三章",
      scenes: [
        {
          id: "s-x", location: "城", atmosphere: "", time: "", bgPrompt: "", itemEvents: [],
          lines: [line("第一句"), { type: "narration", text: "旁白" } as never],
          figures: [],
          choices: [{ id: "c1", prompt: "选", lines: [line("分支句")] }],
        },
      ],
    },
  ];
  const keys = vocalKeysForChapters(chapters);
  assert(keys.includes("ch2_s-x_0"), `主流程 key 异常：${keys}`);
  assert(keys.includes("ch2_s-x_1"), "旁白 key 缺失");
  assert(keys.includes("ch2_s-x_1002"), `分支 key 公式异常（应为 lines.length+1000*(b+1)+j=2+1000+0）：${keys}`);
}

// ---------- 8. 人物两档：core 省图 ----------
{
  const cards = {
    title: "t",
    characters: [
      {
        id: "hero", name: "主角", imagePrompt: "hero", threeViewPrompt: "hero3",
        emotions: ["normal", "happy", "sad", "shy", "drunk", "proud", "tired", "shock", "cry", "laugh"],
        costumes: [{ id: "ct1", name: "礼服", prompt: "dress" }],
        actions: [{ id: "a1", name: "挥手", prompt: "wave" }],
      },
    ],
    scenes: [],
    items: [],
  } as unknown as ExtractionResult;
  const full = buildImageTasks([], cards, { detail: "full" });
  const core = buildImageTasks([], cards, { detail: "core" });
  const fullFig = full.filter((t) => t.kind === "figure").length;
  const coreFig = core.filter((t) => t.kind === "figure").length;
  assert(fullFig === 11, `full 档应为 10 表情＋1 服装＝11 张人物图，实际 ${fullFig}`);
  assert(coreFig === 5, `core 档应只有标准 5 表情，实际 ${coreFig}`);
  assert(full.some((t) => t.kind === "threeview"), "两档都应有三视图");
  assert(core.some((t) => t.kind === "threeview"), "两档都应有三视图");
}

console.log("=== regen safety tests passed ===");
