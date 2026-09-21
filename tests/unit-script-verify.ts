import {
  applySpeakerFix,
  countSourceQuotes,
  deleteScriptLine,
  verifyIssueKey,
  verifyScriptAgainstSource,
} from "../src/core/script";

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

  // 存疑 key 稳定（忽略表用）
  assert(verifyIssueKey(1, 10, "context-mismatch") === "1:10:context-mismatch", "存疑 key 格式异常");

  // 接受建议说话人：只改 characterId，不碰其它内容
  const scriptForFix = {
    chapter: 0,
    title: "第一章",
    scenes: [
      {
        id: "s1", location: "教室", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], figures: [],
        lines: [
          { type: "dialogue", characterId: "sakura", text: "你好。" },
          { type: "narration", text: "旁白。" },
        ],
      },
    ],
  } as never;
  const fixed = applySpeakerFix(scriptForFix, 0, 0, "yuto");
  assert((fixed.scenes[0].lines[0] as { characterId: string }).characterId === "yuto", "说话人应被改掉");
  assert((fixed.scenes[0].lines[1] as { text: string }).text === "旁白。", "其它行不应被动");
  assert((scriptForFix.scenes[0].lines[0] as { characterId: string }).characterId === "sakura", "原对象不应被改动");
  let threw = false;
  try {
    applySpeakerFix(scriptForFix, 0, 1, "yuto");
  } catch {
    threw = true;
  }
  assert(threw, "旁白行改说话人应抛错");
  threw = false;
  try {
    applySpeakerFix(scriptForFix, 9, 0, "yuto");
  } catch {
    threw = true;
  }
  assert(threw, "不存在的场景应抛错");

  // 删除该句：删行不删场景，行号前移
  const scriptForDel = {
    chapter: 0,
    title: "第一章",
    scenes: [
      {
        id: "s1", location: "教室", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], figures: [],
        lines: [
          { type: "dialogue", characterId: "sakura", text: "第一句。" },
          { type: "dialogue", characterId: "yuto", text: "第二句。" },
        ],
      },
    ],
  } as never;
  const deleted = deleteScriptLine(scriptForDel, 0, 0);
  assert(deleted.scenes.length === 1, "场景应保留（背景仍需它）");
  assert(deleted.scenes[0].lines.length === 1, "应只剩一行");
  assert((deleted.scenes[0].lines[0] as { text: string }).text === "第二句。", "后行应前移");

  // 修正后重验：说话人存疑消失
  const srcFixed = "樱月说「你好。」";
  const before = verifyScriptAgainstSource(srcFixed, [
    { lines: [{ type: "dialogue", characterId: "yuto", text: "你好。" }] },
  ], characters);
  assert(before.speakerIssues.some((i) => i.reason === "context-mismatch"), "错说话人应先被检出");
  const repairedScript = applySpeakerFix(
    { chapter: 0, title: "t", scenes: [{ id: "s", location: "", atmosphere: "", time: "", bgPrompt: "", itemEvents: [], figures: [], lines: [{ type: "dialogue", characterId: "yuto", text: "你好。" }] }] } as never,
    0, 0, "sakura",
  );
  const afterRe = verifyScriptAgainstSource(srcFixed, repairedScript.scenes, characters);
  assert(!afterRe.speakerIssues.some((i) => i.reason === "context-mismatch"), "修正后说话人存疑应消失");

  // 段落覆盖率（#794）：对话全保但旁白/描写被删光时必须被发现
  const srcNarration = [
    "夜色像墨一样压下来，城门的火把在风里摇晃，守夜人握紧了剑柄。",
    "他想起十年前那个同样寒冷的夜晚，父亲在城墙上倒下时说的话。",
    "远处传来脚步声，越来越近，他抬头望向官道的尽头。",
    "「谁在那里？」他压低声音问道。",
  ].join("\n");
  const onlyDialogue = verifyScriptAgainstSource(srcNarration, [
    { lines: [{ type: "dialogue", characterId: "yuto", text: "谁在那里？" }] },
  ], characters);
  assert(onlyDialogue.paragraphCount === 4, `原文应有 4 段，实际 ${onlyDialogue.paragraphCount}`);
  assert(onlyDialogue.coveredParagraphCount === 1, `只有对话段被覆盖，实际 ${onlyDialogue.coveredParagraphCount}`);
  assert(onlyDialogue.narrationRatio < 0.4, `旁白删光后段落覆盖率应偏低，实际 ${onlyDialogue.narrationRatio}`);

  const keepNarration = verifyScriptAgainstSource(srcNarration, [
    {
      lines: [
        { type: "narration", text: "夜色像墨一样压下来，城门的火把在风里摇晃，守夜人握紧了剑柄。" },
        { type: "narration", text: "他想起十年前那个同样寒冷的夜晚，父亲在城墙上倒下时说的话。" },
        { type: "narration", text: "远处传来脚步声，越来越近，他抬头望向官道的尽头。" },
        { type: "dialogue", characterId: "yuto", text: "谁在那里？" },
      ],
    },
  ], characters);
  assert(keepNarration.coveredParagraphCount === 4, `旁白保留时段落应全部覆盖，实际 ${keepNarration.coveredParagraphCount}`);
  assert(keepNarration.narrationRatio === 1, `旁白保留时段落覆盖率应为 1，实际 ${keepNarration.narrationRatio}`);

  // 无段落（极短原文）时不误报
  const tiny = verifyScriptAgainstSource("「走。」", [{ lines: [{ type: "dialogue", characterId: "yuto", text: "走。" }] }], characters);
  assert(tiny.paragraphCount === 0 && tiny.narrationRatio === 1, "无长段落时段落覆盖率应为 1（不误报）");

  console.log("=== script verify tests passed ===");
}

main();
