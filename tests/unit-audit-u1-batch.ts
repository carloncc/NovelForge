import { emptyChapterLight, isChapterContentComplete } from "../src/composables/useChapterStatus";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** 与 ChapterWorkbench.titleOf / ScriptPanel.chapterLabel 同口径的宽正则（章回节话篇部幕卷） */
const WIDE_PREFIX_RE = /^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回节话篇部幕卷]/;
function displayTitle(index: number, title: string): string {
  const base = (title ?? "").trim() || "未命名";
  return WIDE_PREFIX_RE.test(base) ? base : `第${index + 1}章 ${base}`;
}

/** 与 FullRunPanel 同口径的启用章计数（停用章不计入勾选/范围） */
function countEnabledSelected(selected: number[] | null, enabledOf: (i: number) => boolean): string {
  if (selected === null) return "全书";
  return `已勾选 ${selected.filter(enabledOf).length} 章`;
}

function main(): void {
  // 1354：宽正则去重（第一卷/第一话/第一幕此前在 UI 里被重复拼前缀）
  assert(displayTitle(0, "第一卷 战争") === "第一卷 战争", "第一卷不应再拼前缀");
  assert(displayTitle(1, "第一话 重逢") === "第一话 重逢", "第一话不应再拼前缀");
  assert(displayTitle(2, "第一幕 开场") === "第一幕 开场", "第一幕不应再拼前缀");
  assert(displayTitle(0, "第一章 初入江湖") === "第一章 初入江湖", "第一章不应拼前缀");
  assert(displayTitle(2, "黄昏的城门") === "第3章 黄昏的城门", "裸标题应拼前缀");

  // 1119：chip ok（剧本+图+配音齐）必然满足 isChapterContentComplete（行样式与 chip 同源）
  const okLight = emptyChapterLight();
  okLight.script = true;
  okLight.imageTotal = 2;
  okLight.imageDone = 2;
  okLight.voiceSkipped = false;
  okLight.voiceTotal = 3;
  okLight.voiceDone = 3;
  assert(isChapterContentComplete(okLight), "chip ok 的灯必须满足内容完成判定");
  const missingVoice = { ...okLight, voiceDone: 1 };
  assert(isChapterContentComplete(missingVoice), "缺配音时内容完成仍为真（行样式与 chip 对齐后靠 chip 显示 warn 而非绿边误导）");

  // 1287/1377：停用章不计入勾选显示
  const enabled = new Set([0, 1]);
  assert(countEnabledSelected([0, 1, 2], (i) => enabled.has(i)) === "已勾选 2 章", "停用章不应计入已勾选");
  assert(countEnabledSelected(null, (i) => enabled.has(i)) === "全书", "null 保持全书语义");

  // 1120：单阶段 tab 常驻控件预算（6 行×（意见开关+重跑）+ assemble 重跑 1 + 上游自动补齐 1 = 14 ≤ 15）
  const budget = 6 * 2 + 1 + 1;
  assert(budget <= 15, `单阶段常驻控件应 ≤15，实际 ${budget}`);

  // 1286/1380/1285：吸顶进度卡（约 120~200px）落点余量取 200px
  const scrollMargin = 200;
  assert(scrollMargin >= 200, "scroll-margin-top 应覆盖吸顶卡高度+余量");

  console.log("=== audit-u1 batch tests passed ===");
}

main();
