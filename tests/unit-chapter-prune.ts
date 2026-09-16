import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImages } from "../src/core/images";
import type { ChapterScript, ExtractionResult, PipelineEvent } from "../src/core/types";

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

const cards = {
  title: "T",
  characters: [
    // A：有三视图，但缺 happy 差分 → 不能被"三视图存在"裁掉
    { id: "a", name: "A", imagePrompt: "a", emotions: ["normal", "happy"] },
    // B：三视图与全部差分齐 → 可以裁掉（不建任务）
    { id: "b", name: "B", imagePrompt: "b", emotions: ["normal", "happy"] },
    // C：只出现在第 2 章，本次 scope 只跑第 1 章 → 必须完全不出现在任务里
    { id: "c", name: "C", imagePrompt: "c", emotions: ["normal"] },
  ],
  scenes: [],
  items: [
    { id: "it1", name: "道具1", prompt: "props one" },
    { id: "it2", name: "道具2", prompt: "props two" },
  ],
} as unknown as ExtractionResult;

const chapters = [
  {
    chapter: 0,
    title: "第一章",
    scenes: [
      {
        id: "s1",
        location: "城门",
        atmosphere: "",
        time: "",
        figures: [],
        lines: [{ type: "dialogue", characterId: "a", text: "甲" }],
        choices: [],
        itemEvents: [{ itemId: "it1", triggerLine: 0, description: "道具1出现" }],
      },
      {
        id: "s2",
        location: "街道",
        atmosphere: "",
        time: "",
        figures: [],
        lines: [{ type: "dialogue", characterId: "b", text: "乙" }],
        choices: [],
        itemEvents: [],
      },
    ],
  },
  {
    chapter: 1,
    title: "第二章",
    scenes: [
      {
        id: "s3",
        location: "森林",
        atmosphere: "",
        time: "",
        figures: [],
        lines: [{ type: "dialogue", characterId: "c", text: "丙" }],
        choices: [],
        itemEvents: [{ itemId: "it2", triggerLine: 0, description: "道具2出现" }],
      },
    ],
  },
] as unknown as ChapterScript[];

async function main(): Promise<void> {
  const root = (await mkdtemp(join(tmpdir(), "novelforge-chapter-prune-"))).replace(/\\/g, "/");
  const cacheRoot = `${root}/.novel2vn/cache`;
  const imagesDir = `${cacheRoot}/images`;
  await mkdir(imagesDir, { recursive: true });

  // B：完整成品；A/C 只有三视图（A 缺 happy；C 不在 scope，不该被看）
  for (const name of [
    "threeview_a.png", "figure_a_normal.png", // A 缺 figure_a_happy.png
    "threeview_b.png", "figure_b_normal.png", "figure_b_happy.png",
    "threeview_c.png", "figure_c_normal.png",
  ]) {
    await writeFile(`${imagesDir}/${name}`, pngBuffer(1024, 1024));
  }

  const logs: PipelineEvent[] = [];
  await generateImages(
    undefined,
    chapters,
    cards,
    [],
    cacheRoot,
    (e) => logs.push(e),
    3,
    true,
    undefined, // style
    undefined, // feedback
    false, // force
    true, // threeView
    true, // withActions
    undefined, // verifyCfg
    undefined, // baseSeed
    false, // styleAnchor
    undefined, // isAborted
    undefined, // visualBible
    undefined, // visionCfg
    undefined, // safeRewriteCfg
    0, // cgPerChapter
    0, // maxPerChapter
    new Set([0]), // 只跑第 1 章（0-based 位置 0）
    "full",
  );
  const messages = logs.map((l) => l.message);
  const attempted = messages.filter((m) => m.startsWith("生成中：") || m.includes("未配置图像 API，跳过：")).join("\n");

  // 1) 出场范围收窄：第 2 章的角色/物品不建任务
  assert(messages.some((m) => m.includes("按本次章节的出场范围收窄")), "应有按出场范围收窄的日志");
  assert(!attempted.includes("立绘-C") && !attempted.includes("三视图-C"), `未出场角色 C 不应建任务：\n${attempted}`);
  assert(!attempted.includes("道具2"), `未出场物品 it2 不应建任务：\n${attempted}`);

  // 2) 差分齐全的角色被裁掉（不建任务）
  assert(!attempted.includes("立绘-B") && !attempted.includes("三视图-B"), `差分齐全的 B 不应建任务：\n${attempted}`);
  assert(messages.some((m) => m.includes("本次不构建任务")), "应有跳过已齐角色的日志");

  // 3) 缺差分的角色必须保留（此前只查三视图会把 A 一起裁掉 → 永远补不齐）
  assert(attempted.includes("立绘-A（happy）"), `缺 happy 差分的 A 必须建任务：\n${attempted}`);
  assert(attempted.includes("立绘-A"), "A 的默认立绘也应建任务");

  // 4) 本章物品保留（it1 在第 1 章被引用）
  assert(attempted.includes("道具1"), `本章引用物品 it1 必须建任务：\n${attempted}`);

  console.log("=== 单章图像任务裁剪（差分齐/出场范围）测试通过 ===");
}

await main();
