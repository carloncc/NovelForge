/**
 * F6 修复批次：剧本提示词新增「节奏与留白」（规则 15）。
 *
 * 背景（核查报告 F6）：SYSTEM_PROMPT 原有 14 条规则全部服务于「逐句保真」与 JSON 结构，
 * 与节奏相关的只有第 9 条「自然收束」，独白只写「按原文比例保留」而没有目标比例，
 * 全文没有「钩子 / 留白 / 高潮 / 情绪曲线」任何约束 —— 于是 LLM 的最优解是平铺原文，
 * 章节没有起伏；而渲染期的高潮判定只是关键词表 isDramatic()，读不到叙事结构。
 *
 * 本测试守两件事：
 *  1) 节奏条款确实存在（章首钩子 / 章末留白 / 内心独白比例 / 单场景台词量上限 / 情绪起伏），
 *     且 sprite 与 imageOnly 两种模式都拿到同一节；
 *  2) 保真硬约束一条都没被这些新条款挤掉（规则 11 逐句保留、旁白全文保留、段落覆盖率口径），
 *     并且节奏条款只能调「呈现顺序 / 停顿 / 独白比例 / 场景切分」，不能授权删台词。
 *  最后用 verifyScriptAgainstSource 实证：只做「行序调整 + 场景切分」时引语覆盖率与段落覆盖率都保持 1，
 *  即节奏条款授权的自由度碰不到 pipeline.ts 的保真重写闸门（那里只读 keptRatio / narrationRatio）。
 */
import { buildScriptSystemPrompt, narrationPolicyText, verifyScriptAgainstSource } from "../src/core/script";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const sprite = buildScriptSystemPrompt({ imageOnly: false });
const imageOnly = buildScriptSystemPrompt({ imageOnly: true });

/* ---------- 1) 节奏条款存在（两种模式都要有） ---------- */
for (const [name, p] of [["sprite", sprite], ["imageOnly", imageOnly]] as const) {
  assert(p.includes("15. 节奏与留白"), `${name} 提示词应含新增的规则 15「节奏与留白」`);
  assert(p.includes("14. 动笔前选定一种改编做法"), `${name} 原有规则 14 应仍在（新节是追加，不是替换）`);
  for (const kw of ["节奏", "钩子", "留白", "内心独白比例", "单场景台词量上限", "场景上限", "情绪起伏"]) {
    assert(p.includes(kw), `${name} 提示词应含节奏关键词「${kw}」`);
  }
  assert(p.includes("15%-25%"), `${name} 应给出内心独白的目标比例区间 15%-25%`);
  assert(p.includes("章首钩子") && p.includes("章末留白"), `${name} 应分别约束章首与章末`);
  assert(p.includes("不超过 40 句"), `${name} 应给出单场景台词量上限 40 句`);
  assert(p.includes("切成多个场景"), `${name} 超限时应要求切分场景而不是删台词`);
  assert(p.includes("不要全章只用一个情绪"), `${name} 应要求情绪贴合原文走向、不整章一个情绪`);
}

/* ---------- 2) 节奏条款不得授权删减台词 ---------- */
assert(sprite.includes("不覆盖上文的保真硬约束"), "规则 15 必须声明不覆盖保真硬约束");
assert(sprite.includes("不得新增、删减、改写任何一句台词"), "规则 15 必须明文禁止增删改台词");
assert(sprite.includes("规则 11、规则 12 的优先级仍高于本节"), "规则 15 必须声明规则 11/12 优先级更高");
assert(sprite.includes("不得为凑比例硬造独白"), "独白比例不得靠硬造凑数");
assert(sprite.includes("原文独白远超此比例时以原文为准，不得为压比例删减独白"), "独白过多时也不得为压比例删减");
assert(sprite.includes("禁止新增原文没有的内容"), "章首钩子不得新增原文没有的内容");
assert(sprite.includes("不得自行补写"), "章末留白不得自行补写");
assert(sprite.includes("不要用纯环境铺垫句开场"), "章首应要求落在原文已有的钩子句上");
// 与规则 2 的场景上限 20 不冲突：给出明确优先级阶梯，极端情况下宁可超 40 句也不删台词
assert(sprite.includes("上限 20 仅作极端保护"), "规则 2 的场景上限说明应保留");
assert(
  sprite.includes("优先级为「台词一句不删」＞「场景数上限 20」＞「单场景 40 句」"),
  "必须给出不与规则 2 打架的优先级阶梯",
);
assert(sprite.includes("不要为了制造停顿新增任何字段"), "节奏不得靠自造 JSON 字段表达（会被映射层静默丢弃）");
// 图片小说模式：规则 F 的既有授权范围不得被节奏条款放大
assert(imageOnly.includes("规则 F 的授权范围也不因本节扩大"), "图片小说模式必须声明规则 F 授权范围不扩大");
assert(imageOnly.includes("台词为画面让路"), "图片小说规则 F 应原样保留");
assert(!sprite.includes("台词为画面让路"), "立绘版不得混入图片小说规则");

/* ---------- 3) 保真硬约束与段落覆盖率文案未被删 ---------- */
for (const [name, p] of [["sprite", sprite], ["imageOnly", imageOnly]] as const) {
  assert(p.includes("台词完整性（硬约束，优先级最高）"), `${name} 规则 11 标题应保留`);
  assert(
    p.includes("原文「」内的每一句对话都必须原样保留，一句不许删、一句不许合并"),
    `${name} 逐句保留条款应逐字保留`,
  );
  assert(p.includes("禁止改写对话文字"), `${name} 禁止改写条款应保留`);
  assert(p.includes("内心独白按原文比例保留，不要机械砍到只剩 2 条"), `${name} 独白按原文比例保留条款应保留`);
  assert(p.includes("旁白/心理/环境/氛围描写按用户消息中的「旁白处理策略」执行"), `${name} 旁白策略条款应保留`);
  assert(p.includes("说话人判定（硬约束）"), `${name} 规则 12 说话人硬约束应保留`);
}
// 段落覆盖率复核（pipeline.ts:2193-2212）依赖用户消息里的旁白策略文案，这里一并守住
const policy = narrationPolicyText();
assert(policy.includes("完整保留原文全部旁白"), "忠实全文策略应保留（段落覆盖率复核的前提）");
assert(policy.includes("原文每个自然段至少要产出一条 line"), "每段至少一条 line 的覆盖率口径应保留");
assert(!policy.includes("可以精简提炼旁白"), "默认策略仍不得授权压缩旁白");

/* ---------- 4) 实证：只调行序 / 场景切分碰不到保真闸门 ---------- */
{
  // 章首钩子：把原文第 3 段的悬念台词提到开场；同时按 40 句上限把同章切成两个场景。
  // 原文（5 段）：环境铺垫 → 回忆 → 「谁在那里？」 → 脚步逼近 → 「别动。剑放下。」
  const src = [
    "夜色像墨一样压下来，城门的火把在风里摇晃，守夜人握紧了剑柄。",
    "他想起十年前那个同样寒冷的夜晚，父亲在城墙上倒下时说的话。",
    "「谁在那里？」他压低声音问道。",
    "远处传来脚步声，越来越近，他抬头望向官道的尽头。",
    "「别动。剑放下。」陌生人的声音从黑暗里传来。",
  ].join("\n");
  const paced = [
    { lines: [{ type: "dialogue" as const, characterId: "yuto", text: "谁在那里？" }] },
    {
      lines: [
        { type: "narration" as const, text: "夜色像墨一样压下来，城门的火把在风里摇晃，守夜人握紧了剑柄。" },
        { type: "narration" as const, text: "他想起十年前那个同样寒冷的夜晚，父亲在城墙上倒下时说的话。" },
        { type: "narration" as const, text: "远处传来脚步声，越来越近，他抬头望向官道的尽头。" },
        { type: "dialogue" as const, characterId: "yuto", text: "别动。剑放下。" },
      ],
    },
  ];
  const vr = verifyScriptAgainstSource(src, paced, []);
  assert(vr.originalQuoteCount === 2, `原文引语应为 2，实际 ${vr.originalQuoteCount}`);
  assert(vr.keptRatio === 1, `行序调整 + 场景切分后引语覆盖率必须仍为 1，实际 ${vr.keptRatio}`);
  assert(vr.notFoundCount === 0, `不得出现「原文中找不到」的台词，实际 ${vr.notFoundCount}`);
  assert(vr.narrationRatio === 1, `行序调整 + 场景切分后段落覆盖率必须仍为 1，实际 ${vr.narrationRatio}`);
  assert(!vr.speakerIssues.some((i) => i.reason === "not-in-source"), "行序调整不得被判成捏造台词");
}

{
  // 呈现顺序的边界：把后一句台词提到前一句之前，只会被记为「乱序存疑」（pipeline 仅打日志），
  // 引语覆盖率与段落覆盖率仍是 1 —— 这正是规则 15 敢把「呈现顺序」列为可调旋钮的前提。
  const src2 = [
    "夜色像墨一样压下来，城门的火把在风里摇晃，守夜人握紧了剑柄。",
    "「第一句。」他说。",
    "「第二句。」她又说。",
    "远处传来脚步声，越来越近，他抬头望向官道的尽头。",
  ].join("\n");
  const swapped = [
    {
      lines: [
        { type: "dialogue" as const, characterId: "a", text: "第二句。" },
        { type: "dialogue" as const, characterId: "b", text: "第一句。" },
        { type: "narration" as const, text: "夜色像墨一样压下来，城门的火把在风里摇晃，守夜人握紧了剑柄。" },
        { type: "narration" as const, text: "远处传来脚步声，越来越近，他抬头望向官道的尽头。" },
      ],
    },
  ];
  const vr2 = verifyScriptAgainstSource(src2, swapped, []);
  assert(vr2.keptRatio === 1, `交换两句顺序后引语覆盖率仍应为 1，实际 ${vr2.keptRatio}`);
  assert(vr2.notFoundCount === 0, `交换顺序不得被判成捏造台词，实际 ${vr2.notFoundCount}`);
  assert(vr2.narrationRatio === 1, `交换顺序后段落覆盖率仍应为 1，实际 ${vr2.narrationRatio}`);
  assert(vr2.orderSuspectCount === 1, `后句提前应只记 1 处乱序存疑，实际 ${vr2.orderSuspectCount}`);
  assert(vr2.speakerIssues.some((i) => i.reason === "order-suspect"), "乱序应以「存疑」形式暴露，供人工确认");
}

console.log("=== 节奏与留白提示词（F6）测试通过 ===");
