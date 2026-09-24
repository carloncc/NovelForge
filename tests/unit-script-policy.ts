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

// 大上下文模型：约 3 万字长章**仍要按单次输出预算切块**——思考型模型会先思考数万 token
// （实测 mimo-v2.6-flash：3 万字章节思考 3.8 万 token 后 JSON 被截断，续写只补 274 字就 stop，
// 拼接解析失败），必须让每块的正文量与「一次能给多少 JSON」匹配，才能在一次响应里产出完整 JSON。
const longZh = { index: 0, title: "第1部分", text: "林澈拔剑。".repeat(6000), charCount: 0 } as never; // 约 3 万字
const bigParts = planScriptChunks(bigCtx, longZh, "sys", [], emptyCards);
assert(bigParts.length > 1, `大上下文下 3 万字长章也必须按输出预算切块，实际 ${bigParts.length}`);
assert(bigParts.join("") === longZh.text, "剧本分块必须无损覆盖原文");
const maxPart = Math.max(...bigParts.map((p) => p.length));
assert(maxPart <= 20000, `每块体量应与「一次能给的 JSON」匹配（实际最大 ${maxPart}）`);

console.log("=== 保真策略与单章预算测试通过 ===");