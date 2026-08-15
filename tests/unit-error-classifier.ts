import { classifyError } from "../src/utils/errorClassifier";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  // 内容审查
  assert(classifyError(new Error("content_rejected by reviewer")) === "content_moderation", "content_rejected");
  assert(classifyError(new Error("The request was rejected by safety filter")) === "content_moderation", "safety filter");
  assert(classifyError(new Error("敏感内容，请调整后重试")) === "content_moderation", "中文敏感");
  assert(classifyError(new Error("prompt blocked by moderation")) === "content_moderation", "moderation blocked");
  assert(classifyError(new Error("content policy violation detected")) === "content_moderation", "policy violation");
  // 中文色情/裸露/未成年审查（用户实测的报错）
  assert(classifyError(new Error("非常抱歉，生成的图片可能违反了关于裸露、色情或情色内容的防护限制。如果你认为此判断有误，请重试或修改提示语。"), 400) === "content_moderation", "中文裸露色情 400");
  assert(classifyError(new Error("抱歉，我不能帮助生成带有性化描写的未成年角色图像。"), 400) === "content_moderation", "中文未成年性化 400");
  assert(classifyError(new Error("The image was rejected for explicit adult content"), 400) === "content_moderation", "英文 explicit adult 400");

  // 限流
  assert(classifyError(new Error("HTTP 429 too many requests")) === "rate_limit", "429");
  assert(classifyError(new Error("rate limit exceeded")) === "rate_limit", "rate limit");
  assert(classifyError(new Error("insufficient balance, please recharge")) === "rate_limit", "余额不足");
  assert(classifyError(new Error("额度不足")) === "rate_limit", "中文额度");

  // 鉴权
  assert(classifyError(new Error("invalid api key")) === "auth", "invalid api key");
  assert(classifyError(new Error("HTTP 401 unauthorized")) === "auth", "401");
  assert(classifyError(new Error("authentication failed")) === "auth", "auth failed");
  assert(classifyError(new Error("permission denied")) === "auth", "permission denied");

  // 参数/资源
  assert(classifyError(new Error("bad request"), 400) === "invalid_param", "400 status");
  assert(classifyError(new Error("invalid request format")) === "invalid_param", "invalid request");
  assert(classifyError(new Error("model not found")) === "invalid_param", "model not found");
  assert(classifyError(new Error("unsupported parameter")) === "invalid_param", "unsupported");

  // 网络
  assert(classifyError(new Error("fetch failed: network error")) === "network", "network");
  assert(classifyError(new Error("connection timed out")) === "network", "timeout");
  assert(classifyError(new Error("HTTP 502 bad gateway")) === "network", "502");
  assert(classifyError(new Error("server overloaded")) === "network", "overloaded");

  // 中止
  assert(classifyError(new Error("已中止")) === "aborted", "已中止");

  // status 优先于 message
  assert(classifyError(new Error("some error"), 500) === "network", "status 500 优先");
  assert(classifyError(new Error("some error"), 401) === "auth", "status 401 优先");
  assert(classifyError(new Error("some error"), 429) === "rate_limit", "status 429 优先");
  assert(classifyError(new Error("refused by policy"), 200) === "content_moderation", "200 时靠 message 识别审查");

  // 未知
  assert(classifyError(new Error("unknown gibberish")) === "unknown", "未知归 unknown");

  console.log("=== 错误分类器测试通过 ===");
}
main();
