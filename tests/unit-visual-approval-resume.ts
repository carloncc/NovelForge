/**
 * 视觉守门「批准并续跑生成」只允许续跑「被守门挡下的那次运行」记下的计划。
 *
 * 回归背景：旧实现里计划为空时会回退成「当前勾选的阶段」，而阶段勾选默认全开
 * （split/translate/extract/script/image/voice/assemble），于是用户只是点一下批准，
 * 就会按全书范围静默重跑 图像 → 配音 → 组装，白烧一遍图像费用；
 * 而且 pendingResumeStages 从不清空，第二次点批准会把同一批阶段再放一遍。
 */
import { approvalResumePlan } from "../src/core/visualBibleWorkflow";
import type { StageKey } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function eq(actual: StageKey[], expected: StageKey[], label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

function main(): void {
  // 1) 没有待续跑计划 = 只盖章，不生成任何阶段（关键回归点）
  eq(approvalResumePlan([]), [], "空计划");
  eq(approvalResumePlan(null), [], "null 计划");
  eq(approvalResumePlan(undefined), [], "undefined 计划");

  // 2) 有计划时只跑计划里的可续跑阶段，且按 STAGE_ORDER 排序
  eq(approvalResumePlan(["image", "voice", "assemble"]), ["image", "voice", "assemble"], "图像+配音+组装");
  eq(approvalResumePlan(["assemble", "image"]), ["image", "assemble"], "乱序输入按标准顺序输出");
  eq(approvalResumePlan(["script", "image"]), ["image"], "script 不是可续跑阶段，被剔除");
  eq(approvalResumePlan(["split", "translate", "extract"]), [], "纯上游阶段不续跑");

  // 3) 去重（同一阶段重复传入不产生重复项）
  eq(approvalResumePlan(["image", "image"]), ["image"], "重复项去重");

  console.log("=== 视觉守门批准续跑计划测试通过 ===");
}

main();
