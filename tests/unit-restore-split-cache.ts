/**
 * 项目恢复：源小说文件不可读（被移动/删除、或导入时没有真实路径）时，
 * 必须用分章缓存（.novel2vn/split.json，含每章正文）把小说重建出来。
 * 否则重启 /「加载该项目」后 projectState.novel 为 null，
 * 生成页的「单章节生成」与「本次重跑 / 分章节生成章节」会整块消失（只剩「还没有小说」提示），
 * 而分章/卡片/剧本/图片其实都还在磁盘上，本该可以继续逐章生成。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { restoreProjectState } from "../src/utils/persist";

const ROOT = `${process.cwd().replace(/\\/g, "/")}/tests/.tmp-restore-split-cache`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function seedProject(outputDir: string, persisted: unknown, split?: unknown): void {
  mkdirSync(`${outputDir}/.novel2vn`, { recursive: true });
  writeFileSync(`${outputDir}/.novel2vn/project_state.json`, JSON.stringify(persisted, null, 2), "utf8");
  if (split !== undefined) {
    writeFileSync(`${outputDir}/.novel2vn/split.json`, JSON.stringify(split, null, 2), "utf8");
  }
}

function splitCache(): unknown {
  return {
    fp: "310120:1689e3x",
    method: "ai",
    chapters: [
      { index: 0, title: "缓存标题0", text: "第一章正文" },
      { index: 1, title: "缓存标题1", text: "第二章正文" },
      { index: 2, title: "缓存标题2", text: "第三章正文" },
    ],
  };
}

/** 源文件不可读 + 有分章缓存 → 用缓存重建小说（章节标题/停用状态以 project_state.json 为准） */
async function testNovelRebuiltFromSplitCache(): Promise<void> {
  const outputDir = `${ROOT}/missing-source`;
  seedProject(outputDir, {
    materials: [],
    outputDir,
    options: {},
    novel: {
      sourcePath: "310120",
      fileName: "成功回避死亡结局.txt",
      encoding: "gbk",
      chapters: [
        { index: 0, title: "第一卷 第一章", enabled: false },
        { index: 1, title: "第一卷 第二章" },
        { index: 2, title: "第一卷 第三章", enabled: true },
      ],
    },
  }, splitCache());

  const restored = await restoreProjectState(outputDir);
  assert(restored.novel, "源文件不可读时应能用分章缓存重建小说（否则逐章生成入口会消失）");
  assert(restored.novel.chapters.length === 3, `应恢复 3 章，实际 ${restored.novel.chapters.length}`);
  assert(restored.novel.chapters[0].title === "第一卷 第一章", "章节标题应以 project_state.json 保存的为准");
  assert(restored.novel.chapters[0].text === "第一章正文", "章节正文应来自分章缓存");
  assert(restored.novel.chapters[0].charCount === "第一章正文".length, "charCount 应与正文长度一致");
  assert(restored.novel.chapters[0].enabled === false, "停用状态应被保留");
  assert(restored.novel.chapters[2].enabled === true, "启用状态应被保留");
  assert(restored.novel.fileName === "成功回避死亡结局.txt", "文件名应沿用保存值");
  assert(restored.novel.sourcePath === "", "重建的小说不应携带失效的源文件路径");
  assert(restored.novel.fullText.includes("第二章正文"), "全文应由各章正文拼出");
  assert(
    restored.warnings.some((warning) => warning.includes("分章缓存")),
    `应给出「已用分章缓存重建」告警，实际 ${JSON.stringify(restored.warnings)}`,
  );
}

/** 源文件可读 → 仍然以源文件为准，不走缓存兜底 */
async function testReadableSourceWins(): Promise<void> {
  const outputDir = `${ROOT}/readable-source`;
  seedProject(outputDir, {
    materials: [],
    outputDir,
    options: {},
    novel: {
      sourcePath: `${outputDir}/novel.txt`,
      fileName: "novel.txt",
      encoding: "utf-8",
      chapters: [{ index: 0, title: "占位", enabled: true }],
    },
  }, splitCache());
  writeFileSync(`${outputDir}/novel.txt`, "第一章 甲\n正文甲\n第二章 乙\n正文乙\n", "utf8");

  const restored = await restoreProjectState(outputDir);
  assert(restored.novel, "源文件可读时应从源文件恢复小说");
  assert(restored.novel.sourcePath === `${outputDir}/novel.txt`, "应保留真实源文件路径");
  assert(restored.novel.fullText.includes("正文甲"), "应使用源文件正文而不是分章缓存");
  assert(
    !restored.warnings.some((warning) => warning.includes("分章缓存")),
    "源文件可读时不应给出分章缓存兜底告警",
  );
}

/** 既没有源文件也没有分章缓存 → 保持为 null（页面照旧提示先导入小说） */
async function testNoNovelWithoutEitherSource(): Promise<void> {
  const outputDir = `${ROOT}/nothing`;
  seedProject(outputDir, { materials: [], outputDir, options: {} });
  const restored = await restoreProjectState(outputDir);
  assert(restored.novel === null, "没有源文件也没有分章缓存时应保持 novel 为 null");
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  try {
    await testNovelRebuiltFromSplitCache();
    await testReadableSourceWins();
    await testNoNovelWithoutEitherSource();
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
  console.log("=== restore split cache tests passed ===");
}

main().catch((error) => {
  console.error("restore split cache tests failed:", error);
  process.exit(1);
});
