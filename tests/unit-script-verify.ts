import { countSourceQuotes, verifyScriptAgainstSource } from "../src/core/script";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const characters = [
  { id: "sakura", name: "西园寺樱月" },
  { id: "yuto", name: "佐野优斗" },
];

function main(): void {
  // 引用计数
  assert(countSourceQuotes("甲「你好。」乙说「再见。」旁白。") === 2, "应数出 2 处引语");
  assert(countSourceQuotes("没有引号的旁白") === 0, "无引语应为 0");

  // 全保留：无告警
  const src = "樱月逼问他。「对优斗君来说，我们算什么？」优斗说道「等等，冷静一点。」";
  const ok = verifyScriptAgainstSource(src, [
    {
      lines: [
        { type: "dialogue", characterId: "sakura", text: "对优斗君来说，我们算什么？" },
        { type: "dialogue", characterId: "yuto", text: "等等，冷静一点。" },
      ],
    },
  ], characters);
  assert(ok.originalQuoteCount === 2, `原文引语应为 2，实际 ${ok.originalQuoteCount}`);
  assert(ok.dialogueCount === 2 && ok.keptRatio === 1, "全保留时覆盖率应为 1");
  assert(ok.notFoundCount === 0 && ok.speakerIssues.length === 0, `全保留不应有存疑，实际 ${JSON.stringify(ok.speakerIssues)}`);

  // 丢短句：覆盖率掉到 0.5 以下
  const src2 = "「甲」\n「嗯。」\n「乙」\n「啊。」";
  const dropped = verifyScriptAgainstSource(src2, [
    { lines: [{ type: "dialogue", characterId: "sakura", text: "甲" }] },
  ], characters);
  assert(dropped.keptRatio < 0.9, `丢句后覆盖率应 <0.9，实际 ${dropped.keptRatio}`);

  // 说话人张冠李戴：上下文指向樱月，剧本写优斗
  const src3 = "樱月说「够了。」";
  const wrong = verifyScriptAgainstSource(src3, [
    { lines: [{ type: "dialogue", characterId: "yuto", text: "够了。" }] },
  ], characters);
  const ctx = wrong.speakerIssues.find((i) => i.reason === "context-mismatch");
  assert(!!ctx && ctx.suggestedSpeakerId === "sakura", `应检出张冠李戴并建议樱月，实际 ${JSON.stringify(wrong.speakerIssues)}`);

  // 第三人称自指：优斗说"对优斗来说"
  const selfRef = verifyScriptAgainstSource("正文。", [
    { lines: [{ type: "dialogue", characterId: "yuto", text: "原来对优斗来说，我只是这种程度的东西啊。" }] },
  ], characters);
  assert(selfRef.speakerIssues.some((i) => i.reason === "third-person-self"), "应检出第三人称自指");

  // 乱序：原文先 A 后 B，剧本先 B 后 A
  const src4 = "甲说「第一句。」乙说「第二句。」";
  const reordered = verifyScriptAgainstSource(src4, [
    {
      lines: [
        { type: "dialogue", characterId: "yuto", text: "第二句。" },
        { type: "dialogue", characterId: "sakura", text: "第一句。" },
      ],
    },
  ], characters);
  assert(reordered.orderSuspectCount > 0, "乱序应被检出");

  // 原文无出处：凭空捏造的台词
  const fabricated = verifyScriptAgainstSource("甲说「第一句。」", [
    { lines: [{ type: "dialogue", characterId: "sakura", text: "完全不存在的台词内容。" }] },
  ], characters);
  assert(fabricated.notFoundCount === 1, "捏造台词应计入 notFound");
  assert(fabricated.speakerIssues.some((i) => i.reason === "not-in-source"), "捏造台词应有 not-in-source 记录");

  console.log("=== script verify tests passed ===");
}

main();
