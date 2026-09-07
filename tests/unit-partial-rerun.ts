import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitChapters } from "../src/core/chapters";
import { Pipeline } from "../src/core/pipeline";
import { demoExtract } from "../src/core/extract";
import { demoScriptAll } from "../src/core/script";
import { buildImageTasks } from "../src/core/images";
import { generateImages } from "../src/core/images";
import { buildVoiceJobs, generateVoice } from "../src/core/voice";
import { scriptCacheFileName } from "../src/core/cache";
import { DEMO_NOVEL } from "../src/core/demoNovel";
import type { PipelineEvent } from "../src/core/types";
import { tauri } from "../src/utils/tauri";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 最小 PNG（仅文件头，供尺寸校验读取宽高） */
function pngBuffer(w: number, h: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

const demoChapters = splitChapters(DEMO_NOVEL, "星陨之城的守夜人");
const demoCards = demoExtract(DEMO_NOVEL, "星陨之城的守夜人");
const demoScripts = demoScriptAll(demoChapters, demoCards);

const dummyTts = { id: "t", name: "t", baseUrl: "", apiKey: "", model: "" };

async function main(): Promise<void> {
  const root = (await mkdtemp(join(tmpdir(), "novelforge-partial-"))).replace(/\\/g, "/");

  /* ---------- 图像：全命中 → 零进度事件、零执行 ---------- */
  {
    const cacheRoot = `${root}/img/.novel2vn/cache`;
    await mkdir(`${cacheRoot}/images`, { recursive: true });
    const tasks = buildImageTasks(demoScripts, demoCards, {
      figurePerCharacter: 1, cgPerChapter: 0, maxPerChapter: 0,
      figureEmotions: false, threeView: false, actions: false, styleAnchor: false,
    });
    assert(tasks.length > 0, "应有图像任务");
    assert(!tasks.some((t) => t.kind === "anchor"), "styleAnchor:false 不应有锚点任务");
    for (const t of tasks) {
      await writeFile(`${cacheRoot}/images/${t.fileName}`, pngBuffer(t.width, t.height));
    }
    const logs: PipelineEvent[] = [];
    const r = await generateImages(
      undefined, demoScripts, demoCards, [], cacheRoot, (e) => logs.push(e),
      3, false, undefined, undefined, false, false, false,
      undefined, undefined, false,
    );
    const progress = logs.filter((l) => (l as { progress?: unknown }).progress);
    assert(progress.length === 0, `全命中不应有进度事件，实际 ${progress.length}`);
    assert(logs.some((l) => l.message.includes("全部命中缓存")), "应有全命中总结日志");
    assert(r.failed.length === 0, "全命中不应有失败");
    const produced = Object.keys(r.images.bg).length + Object.keys(r.images.cg).length
      + Object.keys(r.images.figure).length + Object.keys(r.images.item).length;
    // demo 剧本章节间 scene.id 可能重复（管线内有跨章去重，直接调则互相覆盖），按唯一 key 断言
    const uniq = (ts: typeof tasks, pick: (t: (typeof tasks)[number]) => string | null): number =>
      new Set(ts.map(pick).filter((x): x is string => !!x)).size;
    const expect =
      uniq(tasks.filter((t) => t.kind === "background"), (t) => t.id)
      + uniq(tasks.filter((t) => t.kind === "cg"), (t) => t.id)
      + uniq(tasks.filter((t) => t.kind === "figure" || t.kind === "threeview" || t.kind === "action"), (t) => t.id)
      + uniq(tasks.filter((t) => t.kind === "item"), (t) => t.id);
    assert(produced === expect, `产物映射应完整：${produced}/${expect}`);
    assert(r.failed.length === 0, "图像全命中不应有失败");
    assert(r.generated === 0, `图像全命中实际生成数应为 0，实际 ${r.generated}`);

    // 删掉一张 → 只有它走执行（无 API 则跳过），其余依旧静默（选文件名唯一的任务，避免同 id 覆盖干扰计数）
    const fileUseCount = new Map<string, number>();
    for (const t of tasks) fileUseCount.set(t.fileName, (fileUseCount.get(t.fileName) ?? 0) + 1);
    const victim = tasks.find((t) => t.kind === "background" && fileUseCount.get(t.fileName) === 1)!;
    assert(!!victim, "应有文件名唯一的背景任务");
    await tauri.removePath(`${cacheRoot}/images/${victim.fileName}`).catch(() => {});
    const logs2: PipelineEvent[] = [];
    const r2 = await generateImages(
      undefined, demoScripts, demoCards, [], cacheRoot, (e) => logs2.push(e),
      3, false, undefined, undefined, false, false, false,
      undefined, undefined, false,
    );
    const progress2 = logs2.filter((l) => (l as { progress?: unknown }).progress);
    assert(progress2.length === 1, `缺 1 张应只有 1 个进度事件，实际 ${progress2.length}`);
    assert(logs2.some((l) => l.message.includes("缓存复用")), "应有复用总结");
    assert(r2.images.bg[victim.id] === undefined, "缺失的图不应有映射");
  }

  /* ---------- 配音：全命中 → 零进度、零计费字符 ---------- */
  {
    const cacheRoot = `${root}/voice/.novel2vn/cache`;
    await mkdir(`${cacheRoot}/vocal`, { recursive: true });
    const jobs = buildVoiceJobs(dummyTts, demoScripts, demoCards.characters);
    assert(jobs.length > 0, "应有配音任务");
    for (const j of jobs) {
      await writeFile(`${cacheRoot}/vocal/${j.file}`, "");
    }
    const logs: PipelineEvent[] = [];
    const r = await generateVoice(dummyTts, demoScripts, demoCards.characters, cacheRoot, (e) => logs.push(e), 2, false);
    const progress = logs.filter((l) => (l as { progress?: unknown }).progress);
    assert(progress.length === 0, `全命中不应有进度事件，实际 ${progress.length}`);
    assert(logs.some((l) => l.message.includes("全部命中缓存")), "应有全命中总结日志");
    assert(Object.keys(r.vocal).length === jobs.length, "配音映射应完整");
    assert(r.chars === 0, `全命中计费字符应为 0，实际 ${r.chars}`);
    assert(r.failed.length === 0, "全命中不应有失败");
  }

  /* ---------- 管线单章剧本：只动目标章，不动其他章缓存，不丢章 ---------- */
  {
    const out = `${root}/pipe`;
    const novelText = "第一章 初见\n林澈：你好。\n嗯。\n第二章 再见\n苏晚晴：再见。\n啊。";
    const novel = {
      fileName: "单章测试.txt", sourcePath: "", encoding: "UTF-8",
      fullText: novelText, chapters: splitChapters(novelText, "单章测试"),
    };
    const templateDir = `${import.meta.dirname.replace(/\\/g, "/")}/../src-tauri/templates/webgal`;
    const runAll = (log: (ev: PipelineEvent) => void, extra: object = {}) => new Pipeline({
      novel, materials: [], outputDir: out, templateDir,
      options: { useImage: false, useTts: false, skipCache: false, maxConcurrent: 2, ...(extra as object) },
      log,
    }).run();
    const logs1: PipelineEvent[] = [];
    const res1 = await runAll((e) => logs1.push(e));
    assert(res1.chapters.length === 2, `首次应产出 2 章，实际 ${res1.chapters.length}`);
    const cacheDir = `${out}/.novel2vn/cache`;
    const ch0File = scriptCacheFileName(cacheDir, true, 0, novel.chapters[0].title, novel.chapters[0].text, "");
    const ch0Before = await readFile(ch0File, "utf8");

    // 单章重跑第 2 章（带意见）：第 1 章必须复用、文件内容不变；总章数不丢
    const logs2: PipelineEvent[] = [];
    const res2 = await new Pipeline({
      novel, materials: [], outputDir: out, templateDir,
      options: { useImage: false, useTts: false, skipCache: false, maxConcurrent: 2, rerunChapters: [1] },
      stages: ["script"],
      feedback: { script: { [1]: "更燃一点" } },
      log: (e) => logs2.push(e),
    }).run();
    assert(logs2.some((l) => l.message.includes("生成第 2 章剧本")), "应重新生成第 2 章");
    assert(!logs2.some((l) => /生成第 1 章剧本/.test(l.message)), "不应重新生成第 1 章");
    assert(!logs2.some((l) => l.message.includes("[缓存] 第 1 章")), "非目标章复用应静默，不打逐章日志");
    assert(logs2.some((l) => l.message.includes("静默复用")), "应有静默复用总结");
    const ch0After = await readFile(ch0File, "utf8");
    assert(ch0After === ch0Before, "第 1 章缓存文件内容不应被改动");
    assert(res2.chapters.length === 2, `单章重跑不应丢章，实际 ${res2.chapters.length}`);

    // 单章全量（无意见，经 rerunChaptersForce）：第 2 章跳过缓存直接重写，第 1 章不动
    const logs3: PipelineEvent[] = [];
    const res3 = await new Pipeline({
      novel, materials: [], outputDir: out, templateDir,
      options: { useImage: false, useTts: false, skipCache: false, maxConcurrent: 2, rerunChapters: [1], rerunChaptersForce: [1] },
      stages: ["script"],
      log: (e) => logs3.push(e),
    }).run();
    assert(logs3.some((l) => l.message.includes("生成第 2 章剧本") && l.message.includes("全量重写")), "无意见全量应重写第 2 章并注明");
    assert(!logs3.some((l) => /生成第 1 章剧本/.test(l.message)), "全量单章不应动第 1 章");
    const ch0AfterForce = await readFile(ch0File, "utf8");
    assert(ch0AfterForce === ch0Before, "全量单章不应改动第 1 章缓存");
    assert(res3.chapters.length === 2, `全量单章不应丢章，实际 ${res3.chapters.length}`);
  }

  /* ---------- 图像单章强制：范围内背景进执行，人物/物品保持静默复用 ---------- */
  {
    const cacheRoot = `${root}/imgforce/.novel2vn/cache`;
    await mkdir(`${cacheRoot}/images`, { recursive: true });
    const scope = new Set([demoScripts[0].chapter]);
    const tasks = buildImageTasks(demoScripts, demoCards, {
      figurePerCharacter: 1, cgPerChapter: 0, maxPerChapter: 0,
      figureEmotions: false, threeView: false, actions: false, styleAnchor: false,
      chapterIndexes: scope,
    });
    const bgInScope = tasks.filter((t) => t.kind === "background");
    // cgPerChapter: 0 = 不限制（全要），目标章有 cgEvent 的场景同样会建 CG 任务
    const bgCgInScope = tasks.filter((t) => t.kind === "background" || t.kind === "cg");
    assert(bgInScope.length > 0, "目标章应有背景任务");
    for (const t of tasks) {
      await writeFile(`${cacheRoot}/images/${t.fileName}`, pngBuffer(t.width, t.height));
    }
    const logs: PipelineEvent[] = [];
    const r = await generateImages(
      undefined, demoScripts, demoCards, [], cacheRoot, (e) => logs.push(e),
      3, false, undefined, undefined, false, false, false,
      undefined, undefined, false, undefined, undefined, undefined, undefined, 0, 0,
      scope, "full", true,
    );
    const progress = logs.filter((l) => (l as { progress?: unknown }).progress);
    // 无 API 时强制的背景/CG 进执行后跳过（无映射），人物/物品静默复用（有映射、无进度）
    assert(progress.length === bgCgInScope.length, `单章强制应只执行范围内背景/CG：${progress.length}/${bgCgInScope.length}`);
    for (const t of bgCgInScope) {
      const section = t.kind === "cg" ? r.images.cg : r.images.bg;
      assert(section[t.id] === undefined, "强制背景/CG 无 API 时不应有映射");
    }
    const figMapped = Object.keys(r.images.figure).length;
    assert(figMapped > 0, "人物图应静默复用不断映射");
    assert(logs.some((l) => l.message.includes("缓存复用")), "应有复用总结");
  }

  console.log("=== partial rerun tests passed ===");
}

main().catch((e) => {
  console.error("failed:", e);
  process.exit(1);
});
