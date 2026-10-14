import { splitChapters } from "../src/core/chapters";
import { Pipeline, pruneAssetRefs, buildPruneKeepChapters } from "../src/core/pipeline";
import type { PipelineEvent } from "../src/core/types";
import { tauri } from "../src/utils/tauri";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function runPipeline(out: string, novelText: string, skipCache: boolean, log: (ev: PipelineEvent) => void): Promise<{ meta: any }> {
  const novel = { fileName: "缓存测试.txt", sourcePath: "", encoding: "UTF-8", fullText: novelText, chapters: splitChapters(novelText, "缓存测试") };
  const pipeline = new Pipeline({
    novel,
    materials: [],
    outputDir: out,
    templateDir: `${import.meta.dirname.replace(/\\/g, "/")}/../src-tauri/templates/webgal`,
    options: { useImage: false, useTts: false, useVideoPoints: false, useBgm: false, figureEmotions: false, figureActions: false, characterPoses: false, imageSelfCheck: false, imageBudgetPerChapter: 6, cgPerChapter: 2, skipCache, videoPointsPerChapter: 0, characterIntroCard: false },
    log,
  });
  return pipeline.run();
}

async function main(): Promise<void> {
  const OUT = `${(await mkdtemp(join(tmpdir(), "novelforge-cache-test-"))).replace(/\\/g, "/")}/game`;
  await tauri.removePath(OUT).catch(() => {});
  const novelText = "第一章 初见\n林澈:你好;\n第二章 再见\n苏晚晴:再见;";

  // 第一次：完整生成
  const logs1: PipelineEvent[] = [];
  await runPipeline(OUT, novelText, false, (e) => logs1.push(e));
  assert(logs1.some((l) => l.message.includes("提取完成")), "首次应执行提取");
  assert(logs1.some((l) => l.message.includes("生成第 1 章剧本")), "首次应生成剧本");
  const generated = logs1.filter((l) => l.step === "组装" && l.level === "success").length;
  assert(generated === 1, "首次组装应完成");

  // 第二次：全部命中缓存
  const logs2: PipelineEvent[] = [];
  await runPipeline(OUT, novelText, false, (e) => logs2.push(e));
  assert(logs2.some((l) => l.message.includes("[缓存] 复用角色/场景/物品卡")), "第二次应复用卡片缓存");
  assert(logs2.some((l) => l.message.includes("[缓存] 第 1 章")), "第二次应复用剧本缓存");
  assert(!logs2.some((l) => l.message.includes("提取完成")), "第二次不应重新提取");
  assert(!logs2.some((l) => l.message.includes("生成第 1 章剧本")), "第二次不应重新生成剧本");

  // 第三次：改章节标题 → 剧本缓存失效，但卡片缓存仍命中
  const logs3: PipelineEvent[] = [];
  await runPipeline(OUT, "第一章 改过的标题\n林澈:你好;\n第二章 再见\n苏晚晴:再见;", false, (e) => logs3.push(e));
  assert(logs3.some((l) => l.message.includes("[缓存] 复用角色/场景/物品卡")), "改标题不应影响卡片缓存");
  assert(logs3.some((l) => l.message.includes("生成第 1 章剧本")), "改标题后应重新生成第 1 章剧本");
  assert(logs3.some((l) => l.message.includes("[缓存] 第 2 章")), "未改的章节应复用缓存");

  // 第四次：skipCache=true 强制全量重跑
  const logs4: PipelineEvent[] = [];
  await runPipeline(OUT, novelText, true, (e) => logs4.push(e));
  assert(logs4.some((l) => l.message.includes("提取完成")), "skipCache 应重新提取");
  assert(!logs4.some((l) => l.message.includes("[缓存]")), "skipCache 不应有任何缓存命中");

  // demo 缓存隔离：缓存文件命名区分 demo / LLM 模式
  const demoCache = await tauri.pathExists(`${OUT}/.novel2vn/cards_demo.json`);
  assert(demoCache, "应存在 demo 卡片缓存（cards_demo.json）");
  // 组装按**当前模式**写卡片工作副本（demo → cards_demo.json）。
  // 旧断言写的是「应存在卡片快照（cards.json，组装产物）」——那正是缺陷本身：
  // 组装无条件写 cards.json，把演示卡片灌进正式工作副本，同时用没有 _novelFp 的内存对象
  // 覆写它、抹掉刚生成的指纹，于是正式模式下次运行必判「小说内容变化」→ 整本重新提取（付费）。
  // 断言改为"不得创建 cards.json"（跨模式污染），见 tests/unit-fix-cache-fp.ts 的正式模式回归。
  const snapshot = await tauri.pathExists(`${OUT}/.novel2vn/cards.json`);
  assert(!snapshot, "demo 模式组装不得创建 cards.json（正式工作副本，跨模式污染）");

  // ① 卡片指纹必须活过组装：第二次运行不得判「小说内容变化」重新提取
  const cardsAfter = JSON.parse((await tauri.readTextFile(`${OUT}/.novel2vn/cards_demo.json`)).text) as { _novelFp?: string };
  assert(!!cardsAfter._novelFp, "组装后 cards_demo.json 必须仍带 _novelFp（否则每轮都重新提取，付费）");
  assert(
    !logs2.some((l) => l.message.includes("检测到小说内容变化")),
    "第二次运行不得判「小说内容变化」（指纹被组装抹掉的旧行为）",
  );

  console.log("=== 缓存/重跑一致性测试通过 ===");

  await testChapterKeysPruneRegression(OUT);
}

/**
 * ② 停用章剪枝保留集必须与映射键同口径（回归）。
 *
 * 场景：三章共享同一张场景卡（同地点跨章复用 → 各章剧本都输出 s3）→ 产出侧去重成
 * s3 / s3_2 / s3_3，assets.json 里的背景键就是 s3_2。此时停用第 2 章再跑一次：
 * 停用章的剧本来自**磁盘缓存**（里面是去重前的 s3），旧实现拿它当保留集，
 * 于是 assets.bg.s3_2 被当过期删掉 —— 重新启用第 2 章、只跑组装就缺背景。
 * 修复后 chapter-keys.json 把停用章的 scene.id 对齐到 s3_2，映射必须完整保留。
 */
async function testChapterKeysPruneRegression(OUT: string): Promise<void> {
  // 预置映射：三章的背景图都已生成。键名用演示剧本真实产出的场景 id 口径
  // （demoScriptAll 各章都输出 s1 → 去重成 s1 / s1_2 / s1_3）。
  await tauri.writeTextFile(
    `${OUT}/.novel2vn/assets.json`,
    JSON.stringify({ bg: { s1: "bg1.png", s1_2: "bg2.png", s1_3: "bg3.png" }, cg: {}, figure: {}, item: {}, vocal: {} }),
  );
  // 预置章节键映射：第 2 章（novel index 1）在产出侧是 s1_2
  await tauri.writeTextFile(
    `${OUT}/.novel2vn/chapter-keys.json`,
    JSON.stringify({
      version: 1,
      novelFp: "",
      demo: true,
      posByIndex: { "0": 0, "1": 1, "2": 2 },
      sceneIdsByIndex: { "0": ["s1"], "1": ["s1_2"], "2": ["s1_3"] },
      vocalKeysByPos: {},
      at: "2026-01-01T00:00:00.000Z",
    }),
  );

  const text = "第一章 甲\n林澈:一;\n第二章 乙\n林澈:二;\n第三章 丙\n林澈:三;";
  const chapters = splitChapters(text, "缓存测试");
  assert(chapters.length === 3, `本用例需要 3 章，实际 ${chapters.length}`);
  chapters[1].enabled = false;
  const novel = { fileName: "缓存测试.txt", sourcePath: "", encoding: "UTF-8", fullText: text, chapters };
  const logs: PipelineEvent[] = [];
  const pipeline = new Pipeline({
    novel,
    materials: [],
    outputDir: OUT,
    templateDir: `${import.meta.dirname.replace(/\\/g, "/")}/../src-tauri/templates/webgal`,
    options: { useImage: false, useTts: false, useVideoPoints: false, useBgm: false, figureEmotions: false, figureActions: false, characterPoses: false, imageSelfCheck: false, imageBudgetPerChapter: 6, cgPerChapter: 2, skipCache: false, videoPointsPerChapter: 0, characterIntroCard: false },
    log: (e) => logs.push(e),
  });
  await pipeline.run();

  const assets = JSON.parse((await tauri.readTextFile(`${OUT}/.novel2vn/assets.json`)).text) as { bg: Record<string, string> };
  assert(assets.bg.s1 === "bg1.png", "启用章背景必须保留");
  assert(assets.bg.s1_3 === "bg3.png", "启用章背景必须保留（第三章）");
  assert(
    assets.bg.s1_2 === "bg2.png",
    `停用章的真实产出键 s1_2 必须保留（旧实现会把它当过期删掉，重新启用后缺背景）；实际 keys=${JSON.stringify(Object.keys(assets.bg))}`,
  );
  // 复现旧行为：不传映射时 s1_2 必被删（证明这条断言真的在测这个口径）
  const legacy = { bg: { s1: "a", s1_2: "b" }, cg: {}, vocal: {} };
  pruneAssetRefs(legacy, buildPruneKeepChapters(
    [{ chapter: 0, title: "t", scenes: [{ id: "s1", lines: [], choices: [] }] } as never],
    [{ chapter: 1, title: "t", scenes: [{ id: "s1", lines: [], choices: [] }] } as never],
  ));
  assert(legacy.bg.s1_2 === undefined, "不传映射时应复现旧行为（s1_2 被误删）");

  // chapter-keys.json 里第 2 章的 scene.id 必须是去重后的 s1_2
  const keys = JSON.parse((await tauri.readTextFile(`${OUT}/.novel2vn/chapter-keys.json`)).text) as { sceneIdsByIndex: Record<string, string[]> };
  assert(keys.sceneIdsByIndex["1"]?.[0] === "s1_2", `章节键映射应记录停用章的真实键（实际 ${JSON.stringify(keys.sceneIdsByIndex)}）`);
  console.log("  ✓ ② 停用章剪枝保留集与 chapter-keys 同口径");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
