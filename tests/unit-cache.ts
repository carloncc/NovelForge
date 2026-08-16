import { splitChapters } from "../src/core/chapters";
import { Pipeline } from "../src/core/pipeline";
import { DEMO_NOVEL } from "../src/core/demoNovel";
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
    options: { useImage: false, useTts: false, imageBudgetPerChapter: 6, cgPerChapter: 2, skipCache, maxConcurrent: 2 },
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
  const snapshot = await tauri.pathExists(`${OUT}/.novel2vn/cards.json`);
  assert(demoCache, "应存在 demo 卡片缓存（cards_demo.json）");
  assert(snapshot, "应存在卡片快照（cards.json，组装产物）");

  console.log("=== 缓存/重跑一致性测试通过 ===");
}
main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
