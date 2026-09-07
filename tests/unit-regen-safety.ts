import { buildImageTasks, taskSeedForId } from "../src/core/images";
import { vocalKeysForChapters, splitVocalFileName, buildVocalContentIndex } from "../src/core/voice";
import { scriptCacheRest } from "../src/core/cache";
import {
  novelBodyFingerprint,
  joinAppendText,
  pruneAssetRefs,
  mergeAppendedCards,
  alignExtractedIds,
  isExtractDegraded,
} from "../src/core/pipeline";
import { tauri } from "../src/utils/tauri";
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

// ---------- 9. 重提 id 对齐：同名沿用老 id，粘性字段保留 ----------
{
  const oldCards: ExtractionResult = {
    title: "t",
    characters: [
      { id: "iriyasatoshi", name: "入谷聪", appearance: "旧", imagePrompt: "old", voiceName: "lin", voiceProfileId: "vp1", referenceImagePath: "ref/old.png" } as never,
    ],
    scenes: [],
    items: [],
  };
  const fresh: ExtractionResult = {
    title: "t",
    characters: [
      { id: "routanakisaki", name: "入谷 聪", appearance: "新", imagePrompt: "new" } as never,
      { id: "brandnew", name: "新人", appearance: "新", imagePrompt: "new2" } as never,
      // 第二个同名新人：老 id 已被认领，保留自己的 id（不硬并）
      { id: "routanakisaki2", name: "入谷聪", appearance: "新", imagePrompt: "new3" } as never,
    ],
    scenes: [],
    items: [],
  };
  const { aligned, adopted } = alignExtractedIds(oldCards, fresh);
  assert(adopted === 1, `应认领 1 个，实际 ${adopted}`);
  const kept = aligned.characters.find((c) => c.name === "入谷 聪")!;
  assert(kept.id === "iriyasatoshi", "同名应沿用老 id");
  assert(kept.imagePrompt === "new", "描述取新的");
  assert((kept as { voiceProfileId?: string }).voiceProfileId === "vp1", "音色映射应沿用老的");
  assert(kept.voiceName === "lin", "已选音色应沿用老的");
  assert((kept as { referenceImagePath?: string }).referenceImagePath === "ref/old.png", "参考图应沿用老的");
  assert(aligned.characters.find((c) => c.name === "入谷聪")!.id === "routanakisaki2", "重复认领应保留新 id");
  // 无老卡片：原样返回
  const passthrough = alignExtractedIds(undefined, fresh);
  assert(passthrough.aligned === fresh && passthrough.adopted === 0, "无老卡片应原样返回");
}

// ---------- 10. 提取退化熔断 ----------
{
  assert(isExtractDegraded(9, 3) === true, "9→3 应熔断");
  assert(isExtractDegraded(9, 4) === true, "9→4（不足半数）应熔断");
  assert(isExtractDegraded(9, 5) === false, "9→5（过半）不应熔断");
  assert(isExtractDegraded(9, 9) === false, "持平不应熔断");
  assert(isExtractDegraded(2, 0) === false, "老卡片不足 3 人不熔断（小项目/首提）");
  assert(isExtractDegraded(0, 0) === false, "无老卡片不熔断");
}

// ---------- 11. 配音文件名解析＋孤儿认领 ----------
{
  const p1 = splitVocalFileName("v_ch0_school_gate_2_abc123_def456.mp3");
  assert(p1?.key === "ch0_school_gate_2" && p1.fp === "abc123" && p1.hash === "def456", `key 含下划线应从右切：${JSON.stringify(p1)}`);
  assert(splitVocalFileName("bg_s1.png") === null, "非配音文件应返回 null");
  assert(splitVocalFileName("v_nofp.mp3") === null, "格式不全应返回 null");

  const dir = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-vocal-relink`;
  await tauri.removePath(dir).catch(() => {});
  await tauri.mkdirAll(dir);
  await tauri.writeTextFile(`${dir}/v_ch0_olds_5_fp9x_hash7q.mp3`, "fake-audio");
  await tauri.writeTextFile(`${dir}/bg_s1.png`, "img");
  const index = await buildVocalContentIndex(dir);
  assert(index.get("fp9x_hash7q")?.endsWith("v_ch0_olds_5_fp9x_hash7q.mp3") === true, "应按音色＋文本哈希建索引");
  assert(!index.has("fp9x_other"), "不同文本哈希不应命中");
  assert(index.size === 1, "非配音文件不应进索引");
  await tauri.removePath(dir).catch(() => {});
}

// ---------- 12. 旧人物新形态：追加合并收录新服装/新表情 ----------
{
  const oldCards: ExtractionResult = {
    title: "t",
    characters: [{
      id: "hero", name: "主角", appearance: "旧", imagePrompt: "old",
      costumes: [{ id: "daily", name: "日常服", prompt: "daily" }],
      emotions: ["normal", "happy"],
      actions: [],
    } as never],
    scenes: [],
    items: [],
  };
  const fresh: ExtractionResult = {
    title: "t",
    characters: [{
      id: "hero_new", name: "主角", appearance: "", imagePrompt: "new",
      costumes: [{ id: "daily", name: "日常服", prompt: "daily新版" }, { id: "battle", name: "战斗服", prompt: "battle" }],
      emotions: ["happy", "angry"],
      actions: [{ id: "wave", name: "挥手", prompt: "wave" }],
    } as never],
    scenes: [],
    items: [],
  };
  const { merged } = mergeAppendedCards(oldCards, fresh);
  const hero = merged.characters.find((c) => c.name === "主角")!;
  assert(hero.id === "hero", "同名应沿用老 id");
  const costumeIds = (hero.costumes ?? []).map((c) => c.id);
  assert(costumeIds.includes("daily") && costumeIds.includes("battle"), `新服装应并入：${costumeIds}`);
  assert((hero.emotions ?? []).includes("angry"), "新表情应并入");
  assert(new Set(hero.emotions ?? []).size === (hero.emotions ?? []).length, "表情不应重复");
  assert((hero.actions ?? []).some((a) => a.id === "wave"), "新动作应并入");
}

// ---------- 13. 批量 CG 选择键（新纯 scene.id 语义） ----------
{
  const { imageTaskMatchesSelectionKey } = await import("../src/core/regenerate");
  const cgTask = { kind: "cg", id: "s9", fileName: "cg_s9.png", prompt: "", width: 0, height: 0 } as never;
  assert(imageTaskMatchesSelectionKey(cgTask, "cg:3:s9") === true, "批量 CG 应按 scene 命中（忽略显示章号）");
  assert(imageTaskMatchesSelectionKey(cgTask, "cg:3:s8") === false, "不同场景不应命中");
}

// ---------- 14. 剪枝数字开头 scene.id 保护 ----------
{
  const chapters: ChapterScript[] = [{
    chapter: 0, title: "t",
    scenes: [{ id: "1_a", location: "x", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], lines: [], figures: [], cgEvent: { title: "c", imagePrompt: "p" } as never }],
  }];
  const assets = { bg: {}, cg: { "1_a": "/p/cg_1_a.png" }, vocal: {} };
  const stat = pruneAssetRefs(assets, chapters);
  assert(assets.cg["1_a"] === "/p/cg_1_a.png", "新键本身在保留集时不得当旧版迁移/删除");
  assert(stat.cg === 0 && stat.cgMigrated === 0, "不应计数");
}

// ---------- 15. 配音文件名多扩展名解析 ----------
{
  const ogg = splitVocalFileName("v_ch2_s1_10_fpab_hashcd.ogg");
  assert(ogg?.key === "ch2_s1_10" && ogg.fp === "fpab" && ogg.hash === "hashcd", `ogg 应正常解析：${JSON.stringify(ogg)}`);
}

// ---------- 16. 卡片保存差分失效：只改音色不碰图，改提示词只清该角色 ----------
{
  const { saveEditedCards } = await import("../src/core/cards");
  const dir = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-cards-save`;
  await tauri.removePath(dir).catch(() => {});
  await tauri.mkdirAll(`${dir}/.novel2vn/cache/images`);
  const mkCards = (voice: string, prompt: string) => ({
    title: "t",
    characters: [
      { id: "hero", name: "主角", appearance: "", clothing: "", personality: "", voiceDesc: "", voiceName: voice, imagePrompt: prompt, color: "" },
      { id: "side", name: "配角", appearance: "", clothing: "", personality: "", voiceDesc: "", voiceName: "v2", imagePrompt: "sideprompt", color: "" },
    ],
    scenes: [],
    items: [],
  });
  await tauri.writeTextFile(`${dir}/.novel2vn/cards.json`, JSON.stringify(mkCards("v1", "p1")));
  for (const f of ["figure_hero_normal.png", "figure_side_normal.png", "threeview_hero.png", "item_sword.png"]) {
    await tauri.writeTextFile(`${dir}/.novel2vn/cache/images/${f}`, "x");
  }
  const noop: (msg: string) => void = () => {};
  // 只改音色：一张图都不该动
  const r1 = await saveEditedCards(dir, mkCards("v9", "p1") as never, noop);
  assert(r1.imageCacheCleared === 0, `纯音色改动不应清图，实际清了 ${r1.imageCacheCleared}`);
  for (const f of ["figure_hero_normal.png", "figure_side_normal.png", "threeview_hero.png"]) {
    assert(await tauri.pathExists(`${dir}/.novel2vn/cache/images/${f}`).catch(() => false), `音色改动不应删 ${f}`);
  }
  // 改 hero 提示词：只清 hero 的图，side 的保留
  const r2 = await saveEditedCards(dir, mkCards("v9", "p2") as never, noop);
  assert(r2.imageCacheCleared === 2, `应只清 hero 的 2 张图，实际 ${r2.imageCacheCleared}`);
  assert(!(await tauri.pathExists(`${dir}/.novel2vn/cache/images/figure_hero_normal.png`).catch(() => false)), "hero 图应被清");
  assert(await tauri.pathExists(`${dir}/.novel2vn/cache/images/figure_side_normal.png`).catch(() => false), "side 图应保留");
  await tauri.removePath(dir).catch(() => {});
}

// ---------- 17. 配音命中跨扩展名 ----------
{
  const { vocalHit } = await import("../src/core/voice");
  const dir = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-vocal-hit`;
  await tauri.removePath(dir).catch(() => {});
  await tauri.mkdirAll(dir);
  await tauri.writeTextFile(`${dir}/v_ch0_s1_0_fp_hash.ogg`, "fake");
  const hit = await vocalHit(dir, "v_ch0_s1_0_fp_hash.mp3");
  assert(hit?.endsWith(".ogg") === true, `ogg 文件应被命中：${hit}`);
  const miss = await vocalHit(dir, "v_ch0_s9_9_fp_hash.mp3");
  assert(miss === null, "不存在的应返回 null");
  await tauri.removePath(dir).catch(() => {});
}

console.log("=== regen safety tests passed ===");
