/**
 * 换任意模型自动带上正确参数：
 * 1) 内置「已核实模型目录」按 id 模式匹配（含前缀/大小写/`:tag`），解析优先级 手填 > 探测 > 目录 > 默认；
 * 2) 未知模型被厂商 400 拒绝时从错误报文学习最大输出上限，自动降级重试一次并缓存；
 * 3) 第二次起进入 chatCompletion 先按已学上限 clamp，不再撞 400。
 */
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  modelSpecFor,
  resolveContextLength,
  resolveMaxOutputTokens,
  type DiscoveredModel,
} from "../src/api/providers";
import { chatCompletion, parseMaxTokensLimitFromError } from "../src/api/openaiCompatible";
import { tauri } from "../src/utils/tauri";
import type { ApiConfig } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function toB64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function discovered(partial: Partial<DiscoveredModel> & { id: string }): DiscoveredModel {
  return { capabilities: ["llm"], ...partial };
}

function mainSync(): void {
  /* ---------- 1) 内置目录：命中/前缀/大小写/后缀/未命中 ---------- */
  const mimo = modelSpecFor("mimo-v2.6");
  assert(mimo?.contextLength === 1_024_000 && mimo.maxOutputTokens === 128_000, "mimo-v2.6 应命中 1M/128K");
  assert(modelSpecFor("mimo-v2.5-pro")?.contextLength === 1_024_000, "mimo-v2.5-pro 应命中");
  assert(modelSpecFor("mimo-v2.6-ultraspeed")?.contextLength === 1_024_000, "mimo-v2.6-ultraspeed 应命中");
  assert(modelSpecFor("opencode/mimo-v2.6-flash")?.contextLength === 1_024_000, "带 opencode/ 前缀应命中");
  assert(modelSpecFor("opencode-go/mimo-v2.6-flash")?.contextLength === 1_024_000, "带 opencode-go/ 前缀应命中");
  assert(modelSpecFor("OpenCode-Go/MiMo-V2.6-Flash")?.contextLength === 1_024_000, "大小写不敏感应命中");
  assert(modelSpecFor("mimo-v2.6-flash:free")?.contextLength === 1_024_000, "去 `:tag` 后应命中");
  assert(modelSpecFor("mimo-v2.7") === undefined, "未核实型号不得猜入目录");
  assert(modelSpecFor("deepseek-chat") === undefined, "DeepSeek 不在目录（走默认 + 自动学习）");
  assert(modelSpecFor("") === undefined && modelSpecFor(undefined) === undefined, "空模型返回 undefined");

  /* ---------- 2) 解析优先级：手填 > /models 探测 > 内置目录 > 默认 ---------- */
  assert(resolveContextLength({ model: "opencode/mimo-v2.6-flash" }) === 1_024_000, "目录命中上下文");
  assert(
    resolveContextLength({ model: "mimo-v2.6-flash", extra: { contextLength: 64_000 } }) === 64_000,
    "手填覆盖优先于目录",
  );
  assert(
    resolveContextLength({
      model: "mimo-v2.6-flash",
      extra: { discoveredModels: [discovered({ id: "mimo-v2.6-flash", contextLength: 200_000 })] },
    }) === 200_000,
    "/models 探测优先于目录",
  );
  assert(resolveContextLength({ model: "unknown-model" }) === 128_000, "未命中回退默认 128K");

  assert(resolveMaxOutputTokens({ model: "mimo-v2.6-flash" }) === 128_000, "目录命中最大输出 128K");
  assert(
    resolveMaxOutputTokens({ model: "mimo-v2.6-flash", extra: { maxOutputTokens: 64_000 } }) === 64_000,
    "手填覆盖优先于目录（最大输出）",
  );
  assert(
    resolveMaxOutputTokens({
      model: "mimo-v2.6-flash",
      extra: { discoveredModels: [discovered({ id: "mimo-v2.6-flash", maxOutputTokens: 40_000 })] },
    }) === 40_000,
    "/models 探测优先于目录（最大输出）",
  );
  assert(resolveMaxOutputTokens({ model: "unknown-model" }) === DEFAULT_MAX_OUTPUT_TOKENS, "最大输出未命中回退 32768");

  /* ---------- 3) 从 400 报文解析上限 ---------- */
  assert(
    parseMaxTokensLimitFromError("max_tokens: 131072 is greater than the maximum allowed 65536") === 65536,
    "greater than maximum 应取上限 65536（不是发出去的 131072）",
  );
  assert(
    parseMaxTokensLimitFromError("max_completion_tokens must be less than or equal to 8192") === 8192,
    "less than or equal to 应取 8192",
  );
  assert(parseMaxTokensLimitFromError("max_tokens 超限，最大 16384") === 16384, "中文「最大」应取 16384");
  assert(parseMaxTokensLimitFromError("max_tokens must be <= 4096") === 4096, "`<=` 应取 4096");
  assert(parseMaxTokensLimitFromError("max_tokens is too large") === undefined, "无数值返回 undefined");
  assert(parseMaxTokensLimitFromError("some unrelated error") === undefined, "未提到 max_tokens 返回 undefined");
  assert(parseMaxTokensLimitFromError("") === undefined, "空报文返回 undefined");
  assert(
    parseMaxTokensLimitFromError("max_tokens 超限，最大 100") === MIN_MAX_OUTPUT_TOKENS,
    "低于下限应 clamp 到 512",
  );
  assert(
    parseMaxTokensLimitFromError("max_tokens 超限，最大 999999") === MAX_MAX_OUTPUT_TOKENS,
    "高于上限应 clamp 到 131072",
  );
}

function responseBody(payload: unknown): { status: number; contentType: string; bodyBase64: string } {
  return { status: 200, contentType: "application/json", bodyBase64: toB64(JSON.stringify(payload)) };
}

const OK_PAYLOAD = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} };

async function mainAsync(): Promise<void> {
  const originalHttp = tauri.http;
  let requestBodies: Record<string, unknown>[] = [];
  let responder: (body: Record<string, unknown>) => { status: number; contentType: string; bodyBase64: string } = () =>
    responseBody(OK_PAYLOAD);

  try {
    tauri.http = (async (request: { body?: string }) => {
      const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      requestBodies.push(body);
      return responder(body);
    }) as typeof tauri.http;

    const config = (model: string): ApiConfig => ({
      id: `unit-model-spec-${model}`,
      name: "unit",
      baseUrl: "https://model-spec.test/v1",
      apiKey: "test-key",
      model,
      extra: {},
    });

    /* ---------- 4) 首次撞 400：按厂商上限自动降级重试一次 ---------- */
    const cfgX = config("mystery-model-x");
    let calls = 0;
    responder = () => {
      calls++;
      if (calls === 1) {
        return {
          status: 400,
          contentType: "application/json",
          bodyBase64: toB64(
            JSON.stringify({ error: { message: "max_tokens: 100000 is greater than the maximum allowed 65536" } }),
          ),
        };
      }
      return responseBody(OK_PAYLOAD);
    };
    requestBodies = [];
    const first = await chatCompletion(cfgX, [{ role: "user", content: "hi" }], { maxTokens: 100_000 });
    assert(first.content === "ok", "降级重试后应成功");
    assert(requestBodies.length === 2, `应恰好降级重试一次，实际请求 ${requestBodies.length} 次`);
    assert(requestBodies[0].max_tokens === 100_000, "首次请求用原预算");
    assert(requestBodies[1].max_tokens === 65536, "重试请求应降到厂商上限 65536");

    /* ---------- 5) 缓存命中：第二次调用进入即 clamp，只发一次请求 ---------- */
    responder = () => responseBody(OK_PAYLOAD);
    requestBodies = [];
    await chatCompletion(cfgX, [{ role: "user", content: "hi again" }], { maxTokens: 100_000 });
    assert(requestBodies.length === 1, `缓存命中应只发一次请求，实际 ${requestBodies.length} 次`);
    assert(requestBodies[0].max_tokens === 65536, "缓存命中时首个请求即 clamp 到 65536");

    /* ---------- 6) 降级后仍失败：按原错误抛出，不无限重试 ---------- */
    const cfgY = config("mystery-model-y");
    responder = () => ({
      status: 400,
      contentType: "application/json",
      bodyBase64: toB64(
        JSON.stringify({ error: { message: "max_tokens: 100000 is greater than the maximum allowed 20000" } }),
      ),
    });
    requestBodies = [];
    let threw = false;
    try {
      await chatCompletion(cfgY, [{ role: "user", content: "hi" }], { maxTokens: 100_000 });
    } catch (e) {
      threw = true;
      assert(/LLM 返回错误 400/.test(String(e instanceof Error ? e.message : e)), "应抛出原 400 错误");
    }
    assert(threw, "降级后仍失败必须抛出");
    assert(requestBodies.length === 2, `降级重试一次后应停止，实际请求 ${requestBodies.length} 次`);
  } finally {
    tauri.http = originalHttp;
  }
}

mainSync();
mainAsync()
  .then(() => {
    console.log("=== 模型目录与最大输出自动学习测试通过 ===");
  })
  .catch((e) => {
    console.error("失败:", e);
    process.exit(1);
  });
