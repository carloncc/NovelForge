/**
 * 图片小说台词合并（用户反馈：单独成句的"！！！"怪怪的）：
 * - 纯标点/符号行（去掉标点后无实质文字）不许单独成句，并入相邻行；
 * - 单字感叹（啊/嗯）含实质字符，不由映射合并（走提示词规则 F 生成侧约束）；
 * - 提示词规则 F 只进 imageOnly，立绘版提示词不得混入；
 * - 全是标点、无处可并时原样保留（不丢信息）。
 */
import { buildScriptSystemPrompt, isPunctuationOnlyText, mergePunctuationOnlyLines } from "../src/core/script";
import type { Line } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const dlg = (text: string, characterId = "alice"): Line => ({ type: "dialogue", characterId, emotion: "normal", text });
const nar = (text: string): Line => ({ type: "narration", text });

/* ---------- 1) 纯标点判定 ---------- */
assert(isPunctuationOnlyText("！！！"), "！！！应判纯标点");
assert(isPunctuationOnlyText("……？！"), "……？！应判纯标点");
assert(isPunctuationOnlyText("..."), "半角省略号应判纯标点");
assert(isPunctuationOnlyText("？"), "单个问号应判纯标点");
assert(!isPunctuationOnlyText("啊！"), "单字感叹含实质字符，不由映射合并");
assert(!isPunctuationOnlyText("嗯……"), "嗯……含实质字符，不由映射合并");
assert(!isPunctuationOnlyText("你好！！"), "带文字的感叹句不动");
assert(!isPunctuationOnlyText(""), "空行不算（上游过滤）");
assert(!isPunctuationOnlyText("   "), "空白行不算（上游过滤）");

/* ---------- 2) 缀到上一行（优先） ---------- */
{
  const r = mergePunctuationOnlyLines([dlg("你先走"), dlg("！！！"), dlg("我断后", "bob")]);
  assert(r.lines.length === 2, `应剩 2 行，实际 ${r.lines.length}`);
  assert(r.lines[0].text === "你先走！！！", `应缀尾，实际 ${r.lines[0].text}`);
  assert(r.lines[0].characterId === "alice", "宿主行说话人不变");
  assert(r.lines[1].text === "我断后", "后行不动");
  assert(r.merged === 1, "应计 1 句合并");
}

/* ---------- 3) 首行标点缀到下一行行首 ---------- */
{
  const r = mergePunctuationOnlyLines([dlg("！！！"), dlg("小心")]);
  assert(r.lines.length === 1, "首行标点应并入下一行");
  assert(r.lines[0].text === "！！！小心", `应缀首，实际 ${r.lines[0].text}`);
}

/* ---------- 4) 连续多行标点按原文顺序拼接 ---------- */
{
  const r = mergePunctuationOnlyLines([dlg("快跑"), dlg("！！"), dlg("？！")]);
  assert(r.lines.length === 1, "连续标点应全并入同一行");
  assert(r.lines[0].text === "快跑！！？！", `顺序应与原文一致，实际 ${r.lines[0].text}`);
  assert(r.merged === 2, "应计 2 句合并");
}

/* ---------- 5) 旁白与对话混合：只认位置不认类型 ---------- */
{
  const r = mergePunctuationOnlyLines([nar("夜色渐深。"), dlg("……")]);
  assert(r.lines.length === 1, "标点对话应并入上一行旁白");
  assert(r.lines[0].type === "narration" && r.lines[0].text === "夜色渐深。……", "宿主行类型不变");
}

/* ---------- 6) 全是标点：互相合并成一句，不丢信息 ---------- */
{
  const r = mergePunctuationOnlyLines([dlg("！！！"), dlg("？？？", "bob")]);
  assert(r.lines.length === 1, "无正常台词时标点行应互相合并");
  assert(r.merged === 1, "第二句应并入第一句");
  assert(r.lines[0].text === "！！！？？？", `实际 ${r.lines[0].text}`);
}
{
  const r = mergePunctuationOnlyLines([dlg("！！！")]);
  assert(r.lines.length === 1 && r.merged === 0, "单行标点无处可并，原样保留");
}

/* ---------- 7) 正常台词原样不动（纯函数不改入参） ---------- */
{
  const input = [dlg("你好"), nar("风吹过。"), dlg("再见", "bob")];
  const r = mergePunctuationOnlyLines(input);
  assert(r.lines.length === 3 && r.merged === 0, "无标点行时不动");
  assert(input[0].text === "你好", "入参不得被改动");
}

/* ---------- 8) 提示词规则 F：只进 imageOnly ---------- */
{
  const imageOnly = buildScriptSystemPrompt({ imageOnly: true });
  assert(imageOnly.includes("台词为画面让路"), "图片小说提示词应含规则 F");
  assert(imageOnly.includes("纯语气/标点行不许单独成句"), "规则 F 应约束标点行");
  assert(imageOnly.includes("画面已表达的不重复说"), "规则 F 应约束画面复述");
  const sprite = buildScriptSystemPrompt({ imageOnly: false });
  assert(!sprite.includes("台词为画面让路"), "立绘版提示词不得混入图片小说规则（保真约束不动）");
}

console.log("=== 图片小说纯标点行合并测试通过 ===");
