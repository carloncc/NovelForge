/**
 * 项目恢复：卡片必须以磁盘上的工作副本（.novel2vn/cards.json）为准。
 * project_state.json 里的 cards 只是上次保存时的快照，生成结束后不一定落盘过；
 * 一旦快照与 cards.json 不一致，视觉守门批准时用快照算指纹、图像阶段用磁盘算指纹，
 * 就会出现「刚批准就被判输入已变化 → 视觉守门失效 → 图片永远生成不出来」。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { projectState, restoreProject } from "../src/stores/project";
import type { ExtractionResult } from "../src/core/types";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-restore-working-cards`;

// 状态存储的持久化是 window.setTimeout 防抖（与 tests/unit-persist.ts 同款桩）：
// 本测试只验证恢复逻辑，不需要真的回写磁盘。
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

function seed(outputDir: string, snapshotCharacters: ReturnType<typeof character>[], disk?: ExtractionResult): void {
  mkdirSync(`${outputDir}/.novel2vn`, { recursive: true });
  writeFileSync(`${outputDir}/.novel2vn/project_state.json`, JSON.stringify({
    materials: [],
    outputDir,
    options: {},
    lastResult: {
      meta: { title: "旧标题", gameKey: "k", chapterCount: 3, charCount: 1, sceneCount: 0, lineCount: 0, outputDir, webgalVersion: "4.6.3", generatedAt: "2026-09-09T00:00:00.000Z" },
      cards: cards(snapshotCharacters),
      cost: { llmTokens: 7, imageCount: 1, ttsChars: 0, llmCostYuan: 0, imageCostYuan: 0, ttsCostYuan: 0 },
    },
  }, null, 2), "utf8");
  if (disk) writeFileSync(`${outputDir}/.novel2vn/cards.json`, JSON.stringify(disk, null, 2), "utf8");
}

/** 快照里的旧卡片 + 磁盘上的新卡片 → 恢复后必须用磁盘卡片（否则视觉守门与图像阶段各算一套指纹） */
async function testDiskCardsWin(): Promise<void> {
  const outputDir = `${ROOT}/disk-wins`;
  seed(outputDir, [character("yingyue", "西园寺樱月")], cards([character("xigangjingyinyue", "西园寺樱月")]));

  await restoreProject(outputDir);
  const restored = projectState.lastResult?.cards.characters ?? [];
  assert(restored.length === 1, `应恢复 1 个角色，实际 ${restored.length}`);
  assert(restored[0].id === "xigangjingyinyue", `角色 id 应以磁盘 cards.json 为准，实际 ${restored[0].id}`);
  assert(restored[0].imagePrompt === "西园寺樱月 立绘", "提示词应以磁盘 cards.json 为准");
  assert(projectState.lastResult?.meta.title === "旧标题", "meta 等快照字段应保留");
  assert(projectState.lastResult?.cost.llmTokens === 7, "cost 等快照字段应保留");
}

/** 没有 cards.json 时退回快照卡片（老项目/演示项目） */
async function testSnapshotFallback(): Promise<void> {
  const outputDir = `${ROOT}/snapshot-only`;
  seed(outputDir, [character("yingyue", "西园寺樱月")]);

  await restoreProject(outputDir);
  const restored = projectState.lastResult?.cards.characters ?? [];
  assert(restored.length === 1 && restored[0].id === "yingyue", `无磁盘卡片时应沿用快照，实际 ${JSON.stringify(restored.map((c) => c.id))}`);
}

/** 磁盘卡片里没有角色（空数组）不算有效工作副本，仍用快照 */
async function testEmptyDiskCardsIgnored(): Promise<void> {
  const outputDir = `${ROOT}/empty-disk`;
  seed(outputDir, [character("yingyue", "西园寺樱月")], cards([]));

  await restoreProject(outputDir);
  const restored = projectState.lastResult?.cards.characters ?? [];
  assert(restored.length === 1 && restored[0].id === "yingyue", "磁盘卡片为空时应沿用快照");
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  try {
    await testDiskCardsWin();
    await testSnapshotFallback();
    await testEmptyDiskCardsIgnored();
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
  console.log("=== restore working-cards tests passed ===");
}

main().catch((error) => {
  console.error("restore working-cards tests failed:", error);
  process.exit(1);
});
