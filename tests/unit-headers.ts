/**
 * 验证 OpenAI 兼容通道请求头构造：
 * - opencode.ai 网关自动注入 x-opencode-session + 自定义 User-Agent（修复 400 MissingSessionID）
 * - 其他通道不注入会话头
 * - 用户自定义头（cfg.extra.headers）可合并 / 覆盖默认头
 */
import { headersFor } from "../src/api/openaiCompatible";
import type { ApiConfig } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function cfg(overrides: Partial<ApiConfig>): ApiConfig {
  return { id: "test", name: "t", baseUrl: "", apiKey: "sk-test", model: "m", ...overrides } as ApiConfig;
}

function main(): void {
  // opencode.ai 网关：自动注入会话头 + 自定义 UA
  const oc = headersFor(cfg({ baseUrl: "https://opencode.ai/zen/go/v1" }));
  assert(oc["Content-Type"] === "application/json", "应带 Content-Type");
  assert(oc.Authorization === "Bearer sk-test", "应带 Bearer 鉴权");
  assert(typeof oc["x-opencode-session"] === "string" && oc["x-opencode-session"].length >= 8, "opencode 应注入 x-opencode-session");
  assert(oc["User-Agent"]?.startsWith("NovelForge/"), "opencode 应带自定义 User-Agent");

  // 会话 ID 跨请求稳定（同一进程内复用）
  const oc2 = headersFor(cfg({ baseUrl: "https://opencode.ai/zen/go/v1" }));
  assert(oc["x-opencode-session"] === oc2["x-opencode-session"], "会话 ID 应保持稳定");

  // 其他通道：不注入会话头 / UA
  const ds = headersFor(cfg({ baseUrl: "https://api.deepseek.com" }));
  assert(!("x-opencode-session" in ds), "DeepSeek 不应注入会话头");
  assert(!("User-Agent" in ds), "非 opencode 不应改 User-Agent");

  // 用户自定义头：合并 + 覆盖默认（如强制指定鉴权）
  const custom = headersFor(cfg({
    baseUrl: "https://api.deepseek.com",
    extra: { headers: { "X-Custom": "1", Authorization: "Bearer custom" } },
  }));
  assert(custom["X-Custom"] === "1", "自定义头应合并");
  assert(custom.Authorization === "Bearer custom", "自定义头应覆盖默认鉴权");

  // 用户自定义头也能覆盖 opencode 注入的默认 UA
  const customOc = headersFor(cfg({
    baseUrl: "https://opencode.ai/zen/go/v1",
    extra: { headers: { "User-Agent": "my-coding-agent/1.0" } },
  }));
  assert(customOc["User-Agent"] === "my-coding-agent/1.0", "自定义 UA 应覆盖默认 UA");
  assert(typeof customOc["x-opencode-session"] === "string", "自定义 UA 不影响会话头注入");

  console.log("=== 请求头构造测试通过 ===");
}

try {
  main();
} catch (e) {
  console.error("失败:", e);
  process.exit(1);
}
