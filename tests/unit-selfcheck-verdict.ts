/**
 * #1552：视觉质检回覆的判定词解析。
 *
 * 两条约束互相拉扯，本测试就是把它们同时钉住：
 *   ① 容忍 markdown 强调与「判定：」前缀 —— 否则模型写「**符合**」时，
 *      **合格图会被判不合格 → 走失败分支重画**。这个应用每张图都付费，误判是实打实的钱。
 *   ② 绝不能把「不符合」判成通过 —— 否则坏图会过检、直接进游戏。
 * ②比①重要：所以下面「不符合」系列（含加粗、带前缀、以及最阴的「不完全符合」）必须全判不通过。
 */
import { parseSelfCheckReply } from "../src/core/selfcheck";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** [回覆, 期望通过?] */
const CASES: Array<[string, boolean]> = [
  // ① 正常通过（含复述检查项——这正是 #780 修过的误判）
  ["符合", true],
  ["符合，人物无畸形", true],
  ["符合，没有变形", true],
  ["符合，未见明显变形", true],
  ["符合，人物完整无缺胳膊少腿", true],
  ["  符合，背景纯色  ", true],
  // ① markdown / 前缀容忍（本轮新增能力）
  ["**符合**，人物正常", true],
  ["判定：符合，人物正常", true],
  ["结果符合要求", true],
  // ② 必须判不通过
  ["不符合，人物畸形", false],
  ["不符合，画风不一致", false],
  ["**不符合**，人物畸形", false],
  ["判定：不符合，人物畸形", false],
  ["不完全符合，人物畸形", false],
  ["不完全符合", false],
  ["符合，但人物有畸形", false],
];

function main(): void {
  const wrong: string[] = [];
  for (const [reply, want] of CASES) {
    const got = parseSelfCheckReply(reply).ok;
    if (got !== want) wrong.push(JSON.stringify(reply) + " 期望 " + want + " 实际 " + got);
  }
  assert(wrong.length === 0, wrong.join("；") + "（#1552）");

  // 逐条再确认「不符合」系列一条都不能漏（防止将来放宽前缀时把否定式吃掉）
  const negatives = CASES.filter(([r]) => r.includes("不符合") || r.startsWith("不完全符合"));
  assert(negatives.length >= 5, "否定用例至少要 5 条，实际 " + negatives.length + "（#1552）");
  for (const [reply] of negatives) {
    assert(!parseSelfCheckReply(reply).ok, "任何形态的「不符合」都必须判不通过：" + JSON.stringify(reply) + "（#1552）");
  }

  // reason 仍保留完整回覆（截断 200）
  const long = "符合，" + "好".repeat(300);
  assert(parseSelfCheckReply(long).reason.length === 200, "reason 应截断到 200 字（#1552）");

  console.log("=== 视觉质检判定词解析测试通过（#1552：" + CASES.length + " 例，含 " + negatives.length + " 条否定式全判不通过）===");
}

main();
