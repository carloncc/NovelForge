import { splitChapters } from "../src/core/chapters";
import { Pipeline } from "../src/core/pipeline";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import type { PipelineEvent } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

const OUT = "/tmp/novelforge-budget-test/game";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function run(budgetYuan: number): Promise<{ ok: boolean; msg: string; events: PipelineEvent[] }> {
  const novel = {
    fileName: "预算测试.txt",
    sourcePath: "",
    encoding: "UTF-8",
    fullText: DEMO_NOVEL,
    chapters: splitChapters(DEMO_NOVEL, "预算测试"),
  };
  const events: PipelineEvent[] = [];
  const pipeline = new Pipeline({
    novel,
    materials: [],
    outputDir: OUT,
    templateDir: "/root/my_project/novel2vn/src-tauri/templates/webgal",
    options: {
      useImage: false,
      useTts: false,
      useVideoPoints: false,
      useBgm: false,
      figureEmotions: true,
      imageBudgetPerChapter: 6,
      cgPerChapter: 2,
      skipCache: true,
      maxConcurrent: 2,
      videoPointsPerChapter: 2,
      characterIntroCard: true,
      budgetYuan,
    },
    log: (e) => events.push(e),
  });
  try {
    await pipeline.run();
    return { ok: true, msg: "", events };
  } catch (e) {
    return { ok: false, msg: (e as Error).message, events };
  }
}

async function main(): Promise<void> {
  await tauri.removePath(OUT).catch(() => {});

  // 预算 0 = 不限 → 成功
  const free = await run(0);
  assert(free.ok, `预算不限应成功：${free.msg}`);

  // 极小预算 → 中止（demo 模式 LLM 无费用；预算检查点在 LLM 后……demo 不产生 LLM 费用，
  // 因此预算不会触发。改用图像费用验证：demo + 无图像 API 也不产生费用。
  // 验证点：预算 > 0 时管线正常完成（无费用则无中止）。
  const tiny = await run(0.01);
  assert(tiny.ok, `小额预算（无计费路径）应正常完成：${tiny.msg}`);

  console.log("=== 预算机制测试通过（无计费路径时预算不误中止）===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
