/**
 * nb-nC 修复回归（1398/1421/1422/1423/1424/1426/1427）：
 * 只覆盖白名单内新增/改动的纯函数；1425/1428 在禁区无改动，不在此覆盖。
 */
import { clampItemTriggerIndex } from "../src/core/script";
import { isValidTriggerIndex, parseChapterScript } from "../src/core/dataValidation";
import { buildVoiceJobs, buildVoiceJobsOrEmpty } from "../src/core/voice";
import { planStageCascade } from "../src/core/stageCascade";
import {
  shouldConfirmChapterFullRegen,
  buildChapterFullRegenConfirmMessage,
  enabledSelectedIndexes,
  buildScriptStageFeedbackMap,
  resolveCascadeResumeRerunChapters,
} from "../src/stores/generate";
import type { ApiConfig, CharacterCard, ChapterScript, ExtractionResult, GenerationOptions } from "../src/core/types";
import { STAGE_ORDER } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  // #1422：钳制与校验同口径（允许 ==lineCount）
  assert(clampItemTriggerIndex(99, 5) === 5, "钳制上界应为 lineCount（允许场景末尾事件）");
  assert(clampItemTriggerIndex(2, 5) === 2, "范围内原样保留");
  assert(clampItemTriggerIndex(-3, 5) === 0, "下界为 0");
  assert(clampItemTriggerIndex(5, 0) === 0, "空场景为 0");
  assert(isValidTriggerIndex(2, 2) === true, "==lineCount 合法（场景末尾事件）");
  assert(isValidTriggerIndex(3, 2) === false, ">lineCount 非法");
  assert(isValidTriggerIndex(-1, 2) === false, "负数非法");
  assert(isValidTriggerIndex(0, 0) === true, "空场景 0 合法");
  const baseScene = {
    id: "s1",
    location: "教室",
    atmosphere: "日常",
    time: "白天",
    bgPrompt: "classroom",
    figures: [],
    lines: [
      { type: "dialogue", characterId: "alice", text: "嗨。" },
      { type: "narration", text: "雨。" },
    ],
  };
  const withEndEvent = {
    chapter: 0,
    title: "第一章",
    scenes: [{ ...baseScene, itemEvents: [{ triggerIndex: 2, itemId: "it1", action: "show", description: "" }] }],
  };
  parseChapterScript(withEndEvent);
  let threw = false;
  try {
    parseChapterScript({
      chapter: 0,
      title: "第一章",
      scenes: [{ ...baseScene, itemEvents: [{ triggerIndex: 3, itemId: "it1", action: "show", description: "" }] }],
    });
  } catch {
    threw = true;
  }
  assert(threw, ">lineCount 应判缓存损坏");

  // #1398：单章全链确认（全量或意见都要确认，批量跳过）
  assert(shouldConfirmChapterFullRegen(true, false, false) === true, "全量应确认");
  assert(shouldConfirmChapterFullRegen(false, true, false) === true, "填意见应确认（此前无确认）");
  assert(shouldConfirmChapterFullRegen(false, false, false) === false, "无意见无全量不确认（只补缺失）");
  assert(shouldConfirmChapterFullRegen(true, true, true) === false, "批量聚合入口跳过逐章确认");
  const opinionMsg = buildChapterFullRegenConfirmMessage(2, "风起", { forceAll: false, canFillImages: true, includeVoice: true });
  assert(opinionMsg.includes("按意见重写剧本") && opinionMsg.includes("单章全链") && opinionMsg.includes("含配音"), "意见确认须明示单章全链与是否含配音");
  const forceMsg = buildChapterFullRegenConfirmMessage(2, "风起", { forceAll: true, canFillImages: true, includeVoice: false });
  assert(forceMsg.includes("全量重跑") && forceMsg.includes("重画"), "全量确认须明示重画影响");

  // #1421：启用过滤（停用章不参与）
  assert(JSON.stringify(enabledSelectedIndexes([0, 1, 2], new Set([0, 2]))) === "[0,2]", "只保留启用章");
  assert(enabledSelectedIndexes([0, 1], new Set()).length === 0, "全停用时为空（调用方须给反馈）");
  assert(JSON.stringify(enabledSelectedIndexes([1], [1])) === "[1]", "数组入参同口径");

  // #1423：标题去重（镜像 ChapterWorkbench.titleOf + 修复后 nameList 口径）
  const titleOf = (c: { index: number; title?: string }): string => {
    const base = (c.title ?? "").trim() || "未命名";
    return /^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回节话篇部幕卷]/.test(base)
      ? base
      : `第${c.index + 1}章 ${base}`;
  };
  const fixedNameList = (idxs: number[], byIndex: Map<number, { index: number; title?: string }>): string =>
    idxs.map((i) => {
      const c = byIndex.get(i);
      if (!c) return `第${i + 1}章`;
      return `「${titleOf(c)}」`;
    }).join("、");
  const byIndex = new Map([[2, { index: 2, title: "第3章 风起" }]]);
  assert(!fixedNameList([2], byIndex).includes("第3章「第3章"), "自带前缀标题不得重复嵌套章号");
  assert(fixedNameList([2], byIndex) === "「第3章 风起」", "自带前缀直接复用");
  const byIndex2 = new Map([[0, { index: 0, title: "风起" }]]);
  assert(fixedNameList([0], byIndex2) === "「第1章 风起」", "无前缀正常拼接");

  // #1424：意见只铺选中章节
  const chapters = [{ index: 0 }, { index: 1 }, { index: 2 }];
  const scoped = buildScriptStageFeedbackMap("快一点", chapters, [0, 2]);
  assert(JSON.stringify(Object.keys(scoped).map(Number).sort()) === "[0,2]", "意见只铺勾选范围");
  const all = buildScriptStageFeedbackMap("快一点", chapters, null);
  assert(Object.keys(all).length === 3, "全书范围铺全书");
  assert(Object.keys(buildScriptStageFeedbackMap("", chapters, [0])).length === 0, "无意见不铺");

  // #1426：级联守门续跑与确认同口径（全书 null）
  assert(resolveCascadeResumeRerunChapters() === null, "级联续跑范围应为全书 null，与确认规模一致");

  // #1427：计数不抛（空库计 0），执行路径仍抛可读错误
  const emptyTts: ApiConfig = {
    id: "tts-1", name: "语音", baseUrl: "https://example.invalid/v1",
    apiKey: "test", model: "speech-1", extra: { voiceLibrary: [] },
  };
  const alice: CharacterCard = {
    id: "alice", name: "爱丽丝", appearance: "银发", clothing: "校服",
    personality: "开朗", voiceDesc: "", imagePrompt: "", color: "",
  };
  const demoChapters: ChapterScript[] = [{
    chapter: 0, title: "第一章",
    scenes: [{
      id: "scene_1", location: "教室", atmosphere: "日常", time: "白天",
      bgPrompt: "classroom", itemEvents: [], figures: ["alice"],
      lines: [{ type: "dialogue", characterId: "alice", text: "早上好。" }],
    }],
  }];
  const demoCards: ExtractionResult = { title: "测试", characters: [alice], scenes: [], items: [] };
  assert(buildVoiceJobsOrEmpty(emptyTts, demoChapters, [alice]).length === 0, "空库计数返回 [] 不抛");
  let execThrew = false;
  try {
    buildVoiceJobs(emptyTts, demoChapters, [alice]);
  } catch (e) {
    execThrew = String((e as Error)?.message ?? e).includes("音色库为空");
  }
  assert(execThrew, "执行路径空库仍须抛可读错误");
  const options: GenerationOptions = {
    useImage: true, useTts: true, useVideoPoints: false, useBgm: false,
    figureEmotions: false, figureDetail: "core", figureActions: false, characterPoses: false,
    imageSelfCheck: false, imageBudgetPerChapter: 0, cgPerChapter: 0, skipCache: false,
    videoPointsPerChapter: 0, characterIntroCard: false, imageStyle: "", imageSeed: 0,
    styleAnchor: false, scriptStyle: "", language: "",
  };
  const completed = {} as Record<(typeof STAGE_ORDER)[number], boolean>;
  for (const k of STAGE_ORDER) completed[k] = k === "split" || k === "translate" || k === "extract" || k === "script";
  const plan = planStageCascade({
    completed, enabled: { image: true, voice: true }, trigger: "script",
    chapters: demoChapters, cards: demoCards, options, assets: undefined, tts: emptyTts,
  });
  assert(plan.voices === 0, "空库时级联配音计 0 而不抛");

  console.log("=== nb-nC fixes tests passed ===");
}

try {
  main();
} catch (e) {
  console.error("failed:", e);
  process.exit(1);
}
