/**
 * 项目恢复：project_state.json 里没有 lastResult 快照时，用磁盘上的
 * .novel2vn/cards.json + meta.json 把它补出来。
 * 上一轮生成没来得及保存就退出/被中断时就是这种情况；不补的话重启后
 * 「单阶段重跑」面板变成「还没有生成结果」，视觉守门拿不到卡片而批准静默失败，
 * 卡片/素材页全空，图像阶段也用不上角色。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { projectState, restoreProject } from "../src/stores/project";
import type { ExtractionResult } from "../src/core/types";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-restore-missing-result`;

(globalThis as unknown as { window: { setTimeout: () => number } }).window = { setTimeout: () => 1 };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function character(id: string, name: string) {
  return { id, name, appearance: "x", clothing: "y", personality: "z", voiceDesc: "v", imagePrompt: `${name} 立绘`, color: "#fff" };
}

function cards(characters: ReturnType<typeof character>[]): ExtractionResult {
  return { title: "t", characters, scenes: [], items: [] };
}

/** 只有 old-style 状态（materials/outputDir/options，没有 novel 也没有 lastResult） */
function seedState(outputDir: string): void {
  mkdirSync(`${outputDir}/.novel2vn`, { recursive: true });
  writeFileSync(`${outputDir}/.novel2vn/project_state.json`, JSON.stringify({
    materials: [],
    outputDir,
    options: {},
  }, null, 2), "utf8");
}

function seedSplit(outputDir: string, titles: string[]): void {
  writeFileSync(`${outputDir}/.novel2vn/split.json`, JSON.stringify({
    method: "ai",
    fp: "src:1",
    chapters: titles.map((title, index) => ({ index, title, text: `第 ${index + 1} 章正文` })),
  }, null, 2), "utf8");
}

/** 状态文件没有 lastResult，但磁盘上有卡片与元信息 → 必须补齐（否则单阶段面板/视觉守门全废） */
async function testResultRebuiltFromDisk(): Promise<void> {
  const outputDir = `${ROOT}/disk-only`;
  seedState(outputDir);
  seedSplit(outputDir, ["第1章 一", "第2章 二"]);
  writeFileSync(`${outputDir}/.novel2vn/cards.json`, JSON.stringify(cards([
    character("lijiacong", "李佳聪"),
    character("xigangjingyinyue", "西园寺樱月"),
  ]), null, 2), "utf8");
  writeFileSync(`${outputDir}/.novel2vn/meta.json`, JSON.stringify({
    title: "175812 gbk",
    gameKey: "175812gb",
    chapterCount: 22,
    charCount: 9,
    sceneCount: 88,
    lineCount: 7104,
    outputDir,
    webgalVersion: "4.6.3",
    generatedAt: "2026-09-10T12:37:06.078Z",
  }, null, 2), "utf8");

  await restoreProject(outputDir);
  const result = projectState.lastResult;
  assert(result, "磁盘上有卡片时必须补出 lastResult");
  assert(result.cards.characters.length === 2, `卡片应来自 cards.json，实际 ${result.cards.characters.length}`);
  assert(result.cards.characters[0].id === "lijiacong", "卡片顺序应以 cards.json 为准");
  assert(result.meta.title === "175812 gbk", `元信息应来自 meta.json，实际「${result.meta.title}」`);
  assert(result.meta.chapterCount === 22, "meta.chapterCount 应来自 meta.json");
  assert(result.meta.outputDir === outputDir, "meta.outputDir 必须回填当前输出目录");
  assert(result.cost.llmTokens === 0 && result.cost.imageCostYuan === 0, "无费用快照时应为零值而不是 undefined");
  assert(projectState.novel?.chapters.length === 2, "分章缓存仍应重建小说");
}

/** 磁盘上连卡片都没有 → 保持 null（不能凭空造一个空结果，否则「还没有生成结果」的提示会消失） */
async function testNoCardsStaysNull(): Promise<void> {
  const outputDir = `${ROOT}/no-cards`;
  seedState(outputDir);
  seedSplit(outputDir, ["第1章 一"]);

  await restoreProject(outputDir);
  assert(projectState.lastResult === null, "没有 cards.json 时 lastResult 应保持 null");
  assert(projectState.novel !== null, "小说仍应由分章缓存重建");
}

/** 有卡片但没有 meta.json → 仍补出 lastResult，meta 用空壳兜底（不阻塞单阶段/视觉守门） */
async function testMissingMetaFallsBack(): Promise<void> {
  const outputDir = `${ROOT}/no-meta`;
  seedState(outputDir);
  seedSplit(outputDir, ["第1章 一"]);
  writeFileSync(`${outputDir}/.novel2vn/cards.json`, JSON.stringify(cards([character("yingyue", "西园寺樱月")]), null, 2), "utf8");

  await restoreProject(outputDir);
  const result = projectState.lastResult;
  assert(result, "有卡片时即使没有 meta.json 也应补出 lastResult");
  assert(result.meta.title === "" && result.meta.generatedAt === "", "meta 缺失时用空壳兜底");
  assert(result.meta.outputDir === outputDir, "空壳 meta 也要带上输出目录");
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  try {
    await testResultRebuiltFromDisk();
    await testNoCardsStaysNull();
    await testMissingMetaFallsBack();
    await testNoStateFileStillContinues();
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
  /**
 * #1509：**完全没有 project_state.json** 的项目（用户把开发中的项目拷到另一台机器、
 * 只带了 .novel2vn 与产物，或快照被清理）也必须能加载并继续未完成的部分。
 * 旧实现在缺少该文件时直接返回空状态 → 小说/卡片/章节全丢，生成页只剩「还没有小说」。
 */
async function testNoStateFileStillContinues(): Promise<void> {
  const outputDir = `${ROOT}/no-state-file`;
  mkdirSync(`${outputDir}/.novel2vn/cache`, { recursive: true });
  // 注意：不写 project_state.json
  seedSplit(outputDir, ["第1章 一", "第2章 二", "第3章 三"]);
  writeFileSync(`${outputDir}/.novel2vn/cards.json`, JSON.stringify(cards([
    character("linche", "林澈"),
  ]), null, 2), "utf8");
  writeFileSync(`${outputDir}/.novel2vn/meta.json`, JSON.stringify({
    title: "半成品项目", gameKey: "abc12345", chapterCount: 3, charCount: 9, sceneCount: 3,
    lineCount: 6, outputDir, webgalVersion: "4.6.3", generatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2), "utf8");
  // 已有剧本缓存（"开发到一半"的典型形态）
  writeFileSync(`${outputDir}/.novel2vn/cache/script_ch1_aaa.json`, JSON.stringify({ chapter: 0, title: "第1章 一", scenes: [] }), "utf8");

  await restoreProject(outputDir);
  assert(projectState.novel, "没有状态快照时仍必须恢复出小说（否则无法继续逐章生成）");
  assert(projectState.novel.chapters.length === 3, `应恢复 3 章，实际 ${projectState.novel.chapters.length}`);
  assert(projectState.lastResult, "磁盘上有 cards.json 时必须补出 lastResult");
  assert(projectState.lastResult.cards.characters.length === 1, "卡片应来自 cards.json");
  assert(projectState.lastResult.meta.title === "半成品项目", "meta 应来自 meta.json（不是空壳）");
  assert(
    projectState.visualBibleWarnings.some((w) => w.includes("缺少项目状态快照")),
    `应明确提示按磁盘恢复，实际 ${JSON.stringify(projectState.visualBibleWarnings)}`,
  );
}

console.log("=== restore missing-result tests passed ===");
}

main().catch((error) => {
  console.error("restore missing-result tests failed:", error);
  process.exit(1);
});