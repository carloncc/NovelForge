/**
 * 保真批次（#793/#801/#800）：
 * - 旁白策略默认忠实全文，只有显式开启压缩（#801）才允许精简；
 * - 单章字数预算按模型上下文与剧本输出上限自适应（#800）。
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

/* ---------- 2) 单章字数预算 ---------- */
const zh = "林澈拔剑".repeat(3750); // 纯汉字（无标点），字符/token≈0.6
const bigCtx = { model: "m", extra: { contextLength: 128000 } } as never;
const zhBudget = chapterCharBudget(bigCtx, zh);
assert(zhBudget >= 10000 && zhBudget <= 20000, `中文 128k 上下文的单章预算应约 1.5 万字，实际 ${zhBudget}`);

// 带标点的正文（标点不计入 CJK 采样，比率略高）也不应超过 30000 字硬上限
const zhPunct = "林澈拔剑。".repeat(3000);
const zhPunctBudget = chapterCharBudget(bigCtx, zhPunct);
assert(zhPunctBudget <= 30000 && zhPunctBudget >= 10000, `带标点中文预算应在 1-3 万字，实际 ${zhPunctBudget}`);

const en = "The night watchman drew his sword. ".repeat(3000);
const enBudget = chapterCharBudget(bigCtx, en);
assert(enBudget > zhBudget, `英文语种应允许更大的章节体量（实际 zh=${zhBudget} en=${enBudget}）`);
assert(enBudget <= 30000, "单章预算上限 30000");

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

console.log("=== 保真策略与单章预算测试通过 ===");