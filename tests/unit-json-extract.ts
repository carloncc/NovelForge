import { extractJson, sliceFirstJsonObject } from "../src/api/openaiCompatible";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const obj = `{"imagePrompt": "silver hair girl", "threeViewPrompt": "turnaround"}`;
  // 用户真实故障：JSON 后跟一段中文闲聊，以前报 Unexpected non-whitespace character after JSON
  const withTrailing = `${obj}\n希望这个描述对你有帮助！继续加油哦。`;
  assert(sliceFirstJsonObject(withTrailing) === obj, "应只切出完整对象，不带尾巴");
  assert((extractJson(withTrailing) as { imagePrompt: string }).imagePrompt === "silver hair girl", "带尾巴应解析成功");

  // 前导闲聊 + fence 包裹
  const fenced = `好的，这是你要的设定：\n\`\`\`json\n${obj}\n\`\`\`\n拿去用吧！`;
  assert((extractJson(fenced) as { threeViewPrompt: string }).threeViewPrompt === "turnaround", "fence 包裹应解析成功");

  // 字符串里的大括号不能干扰平衡（prompt 文本里常有 {} 示例）
  const tricky = `{"a": "x { y } z", "b": {"c": 1}} 尾巴`;
  assert(sliceFirstJsonObject(tricky) === `{"a": "x { y } z", "b": {"c": 1}}`, "字符串内括号不应计入深度");

  // 两个对象连发：取首个完整对象
  const two = `${obj} 另外：{"note": 1}`;
  assert(sliceFirstJsonObject(two) === obj, "应取首个完整对象");

  // 坏输入：无花括号 / 被截断
  assert(sliceFirstJsonObject("纯文字没有括号") === null, "无对象应返回 null");
  assert(sliceFirstJsonObject('{"a": 1, "b":') === null, "截断对象应返回 null");
  let threw = false;
  try {
    extractJson("纯文字没有括号");
  } catch {
    threw = true;
  }
  assert(threw, "无对象应抛错");

  // 尾随逗号修复仍有效
  assert((extractJson('{"a": 1,}') as { a: number }).a === 1, "尾随逗号应被修复");

  console.log("=== json extract tests passed ===");
}

main().catch((error) => {
  console.error("unit-json-extract failed:", error);
  process.exit(1);
});
