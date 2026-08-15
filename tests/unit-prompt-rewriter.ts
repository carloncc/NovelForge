import { sanitizePrompt, appendSafeStyleSuffix } from "../src/utils/promptRewriter";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  // 暴力 → 委婉
  let r = sanitizePrompt("a girl with blood on her sword");
  assert(r.replaced > 0, "应识别暴力词");
  assert(!/blood/i.test(r.prompt), "blood 应被替换");
  assert(!/sword/i.test(r.prompt), "sword 应被替换");
  assert(/scarlet/.test(r.prompt) && /staff/.test(r.prompt), "应替换为委婉词");

  // 中文
  r = sanitizePrompt("穿着内衣的少女，手持利剑");
  assert(r.replaced > 0, "应识别中文敏感词");
  assert(!/内衣/.test(r.prompt), "内衣应被替换");
  assert(!/剑/.test(r.prompt), "剑应被替换");

  // 年龄
  r = sanitizePrompt("schoolgirl in uniform");
  assert(!/schoolgirl/i.test(r.prompt), "schoolgirl 应被替换");

  // 裸露
  r = sanitizePrompt("nude bikini model");
  assert(!/nude/i.test(r.prompt) && !/bikini/i.test(r.prompt), "裸露词应被替换");

  // 无敏感词不改写
  r = sanitizePrompt("anime style portrait, gentle smile, elegant dress");
  assert(r.replaced === 0 && r.prompt.includes("anime"), "无敏感词不应改动");

  // 空输入
  r = sanitizePrompt("");
  assert(r.prompt === "" && r.replaced === 0, "空输入原样返回");

  // 安全风格后缀
  const suffixed = appendSafeStyleSuffix("a happy girl");
  assert(/safe for work|wholesome|family friendly/i.test(suffixed), "应追加安全风格后缀");

  console.log("=== 提示词改写器测试通过 ===");
}
main();
