import { isRateLimitError } from "../src/core/voice";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  // 1) 限流错误识别
  assert(isRateLimitError("MiniMax 错误(1002): rate limit exceeded"), "code 1002 应识别为限流");
  assert(isRateLimitError("API 错误：rate limit exceeded(RPM)（code 1002）"), "RPM 文案应识别为限流");
  assert(isRateLimitError("rate limit exceeded"), "rate limit 应识别");
  assert(isRateLimitError("请求过于频繁，触发限流"), "中文限流应识别");
  assert(!isRateLimitError("MiniMax 错误(2013): prompt too long"), "2013 不应误判为限流");
  assert(!isRateLimitError("网络连接失败"), "普通错误不应误判为限流");
  assert(!isRateLimitError("invalid api key"), "鉴权错误不应误判为限流");

  console.log("=== 配音限流识别测试通过 ===");
}
main();
