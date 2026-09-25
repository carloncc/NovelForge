/**
 * 保真批次（#793/#801/#800）：
 * - 旁白策略默认忠实全文，只有显式开启压缩（#801）才允许精简；
 * - 单章字数预算按模型输入上下文自适应、不再设固定 30000 上限（长章靠顺序生成覆盖）。
 */
import { narrationPolicyText, planScriptChunks } from "../src/core/script";
import { chapterCharBudget } from "../src/core/split";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/* ---------- 1) 旁白处理策略 ---------- */const faithful = narrationPolicyText();
assert(faithful.includes("忠实全文"), "默认策略必须是忠实全文");
assert(faithful.includes("完整保留原文全部旁白"), "默认策略必须要求完整保留旁白");
assert(!faithful.includes("可以精简提炼旁白"), "默认策略不得授权压缩旁白");
assert(narrationPolicyText(false) === faithful, "false 与缺省一致（默认忠实）");

const compressed = narrationPolicyText(true);
assert(compressed.includes("精简模式"), "开启开关才允许精简");
assert(compressed.includes("可以精简提炼旁白"), "开启开关时注入精简授权");
assert(compressed !== faithful, "两种策略必须不同");

/* ---------- 2) 单章字数预算（模型自适应，无固定 30000 上限） ---------- */
const zh = "林澈拔剑".repeat(3750); // 纯汉字（无标点），字符/token≈0.6
const bigCtx = { model: "m", extra: { contextLength: 128000 } } as never;
const zhBudget = chapterCharBudget(bigCtx, zh);
assert(zhBudget > 30000, `去掉固定上限后，中文 128k 上下文的单章预算应远大于 3 万，实际 ${zhBudget}`);

// 带标点的正文（标点不计入 CJK 采样，字符/token 更高）预算应更大，且同样不再受 30000 限制
const zhPunct = "林澈拔剑。".repeat(3000);
const zhPunctBudget = chapterCharBudget(bigCtx, zhPunct);
assert(zhPunctBudget > zhBudget, `带标点中文预算应更大（实际 zh=${zhBudget} punct=${zhPunctBudget}）`);
assert(zhPunctBudget <= 150000, `不得超过模型输入硬顶，实际 ${zhPunctBudget}`);

const en = "The night watchman drew his sword. ".repeat(3000);
const enBudget = chapterCharBudget(bigCtx, en);
assert(enBudget > zhBudget, `英文语种应允许更大的章节体量（实际 zh=${zhBudget} en=${enBudget}）`);
assert(enBudget <= 150000, "不得超过模型输入硬顶");

// 上下文越小，单章预算越小（模型自适应）
const midCtx = { model: "m", extra: { contextLength: 32000 } } as never;
assert(chapterCharBudget(midCtx, zh) < zhBudget, "小上下文模型的单章预算应更小");

const smallCtx = { model: "m", extra: { contextLength: 8000 } } as never;
assert(chapterCharBudget(smallCtx, zh) === 6000, "极小上下文模型保底 6000 字");

/* ---------- 3) 剧本分块（忠实全文回归修复：长章输出截断 → scenes 为空） ---------- */
const emptyCards = { title: "t", characters: [], scenes: [], items: [] } as never;
const shortChapter = { index: 0, title: "第一章", text: "短章节内容。".repeat(30), charCount: 0 } as never;
const longChapter = { index: 0, title: "第一章", text: "林澈拔剑。".repeat(4000), charCount: 0 } as never; // 约 2 万字
const tinyCtx = { model: "m", extra: { contextLength: 8192 } } as never;

assert(planScriptChunks(bigCtx, shortChapter, "sys", [], emptyCards).length === 1, "短章节不应分块");
const parts = planScriptChunks(tinyCtx, longChapter, "sys", [], emptyCards);
assert(parts.length > 1, `小上下文 + 长章节应分块，实际 ${parts.length}`);
assert(parts.join("") === longChapter.text, "剧本分块必须无损覆盖原文");
assert(parts.every((p) => p.length <= 4000), `每块体量应显著小于整章（实际最大 ${Math.max(...parts.map((p) => p.length))}）`);

// 大上下文模型：约 3 万字长章**也必须切成小段逐段生成**（像 agent 分段读取那样）。
// 整章一次喂进去，思考型模型会失控：实测 MiMo 单次思考数万 token、一次 6~57 分钟不产出正文，
// 而且整章 JSON 一次写不完必被截断（续写补残 JSON 不可靠）。切小段后每块输入小、JSON 小且能一次写完。
const longZh = { index: 0, title: "第1部分", text: "林澈拔剑。".repeat(6000), charCount: 0 } as never; // 约 3 万字
const bigParts = planScriptChunks(bigCtx, longZh, "sys", [], emptyCards);
assert(bigParts.length >= 4, `大上下文下 3 万字长章也必须切成小段（每段 ≤8000 字），实际 ${bigParts.length} 段`);
assert(bigParts.join("") === longZh.text, "剧本分块必须无损覆盖原文");
assert(
  bigParts.every((p) => p.length <= 8000),
  `每段不应超过单次生成上限 8000 字（实际最大 ${Math.max(...bigParts.map((p) => p.length))}）`,
);

// 但输入侧仍要切：超过上下文能容纳的正文量时必须分块
const hugeZh = { index: 0, title: "超长章", text: "林澈拔剑。".repeat(40000), charCount: 0 } as never; // 约 20 万字
const hugeParts = planScriptChunks(bigCtx, hugeZh, "sys", [], emptyCards);
assert(hugeParts.length > 1, `超过输入上下文的超长章仍必须分块，实际 ${hugeParts.length}`);
assert(hugeParts.join("") === hugeZh.text, "超长章分块必须无损覆盖原文");

console.log("=== 保真策略与单章预算测试通过 ===");