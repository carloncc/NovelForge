/**
 * 「只思考未产出正文」自动重试 / 拆分（MiMo 深度思考偶发空产出复盘）：
 * - chatJson 空产出抛 EmptyContentError，不进入内部「修复/续写」，且 withRetry 不自动重试它；
 * - isThinkingOnlyFailure 判定（含历史「思考耗尽预算」文案，不含鉴权/参数/空 scenes）；
 * - genOnePart 对 EmptyContentError 原样重试 SCRIPT_THINKING_RETRY 次，仍失败：
 *   · 本节够大 → 降级对半拆分，各子块独立生成（深度思考保持开启）；
 *   · 已到最小粒度 → 抛出「已自动重试与拆分仍未成功」的最终结论。
 * 复用 tests/unit-model-spec.ts 的 stub tauri.http 方式，驱动真实 chatJson/scriptChapter。
 */
import { chatJson, withRetry, EmptyContentError } from "../src/api/openaiCompatible";
import {
  isThinkingOnlyFailure,
  scriptChapter,
  splitForDegrade,
  SCRIPT_THINKING_RETRY,
} from "../src/core/script";
import { tauri } from "../src/utils/tauri";
import type { ApiConfig, ChapterInfo, ExtractionResult, SceneJSON } from "../src/core/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface StubResponse {
  status: number;
  contentType: string;
  bodyBase64: string;
}

function responseBody(payload: unknown): StubResponse {
  return { status: 200, contentType: "application/json", bodyBase64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64") };
}

/* 思考型模型「只思考、正文为空」：finish_reason 缺失（网关常见），reasoning 里没有可用 JSON。 */
const THINKING_ONLY = {
  choices: [{ message: { content: "", reasoning_content: "我在反复权衡怎么改编这一章，但还没有输出正文。".repeat(30) }, finish_reason: null }],
  usage: { prompt_tokens: 100, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 300 } },
};

const SCENE = {
  id: "s1",
  location: "loc",
  atmosphere: "紧张",
  time: "夜",
  bgPrompt: "prompt",
  lines: [{ type: "narration", text: "林澈拔剑。" }],
  itemEvents: [],
};

function okScript(): StubResponse {
  return responseBody({
    choices: [{ message: { content: JSON.stringify({ title: "第一话", scenes: [SCENE] }) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 200 },
  });
}

const CARDS: ExtractionResult = { title: "t", characters: [], scenes: [], items: [] };

function configFor(model: string): ApiConfig {
  return {
    id: `unit-thinking-${model}`,
    name: "unit",
    baseUrl: "https://thinking-retry.test/v1",
    apiKey: "test-key",
    model,
    extra: { contextLength: 1_000_000, maxOutputTokens: 128_000 },
  };
}

const smallChapter: ChapterInfo = {
  index: 0,
  title: "第一章",
  text: "林澈拔剑。\n\n夜风骤起。\n\n".repeat(120),
  charCount: 0,
};

// 约 6.2K 字：仍在一个分块内（≤ SCRIPT_BLOCK_MAX_CHARS 8000），但已超过可再对半拆的阈值（>4000）
const bigChapter: ChapterInfo = {
  index: 0,
  title: "第一章",
  text: "林澈拔剑，剑光如雪。\n\n夜风骤起，吹动衣袂。\n\n".repeat(220),
  charCount: 0,
};

function syncChecks(): void {
  /* ---------- 1) isThinkingOnlyFailure 判定 ---------- */
  assert(isThinkingOnlyFailure(new EmptyContentError("模型本次没有输出任何正文（只产生了思考内容）")), "EmptyContentError 应判只思考");
  assert(
    isThinkingOnlyFailure(new Error("模型把全部输出预算用于思考，正文一个字都没出（已放大到 128000 tokens 仍被思考耗尽）")),
    "「思考耗尽预算」历史文案应判只思考",
  );
  assert(isThinkingOnlyFailure(new Error("模型本次没有输出任何正文（只产生了思考内容）")), "文案兜底应判只思考");
  assert(!isThinkingOnlyFailure({ status: 401, message: "unauthorized" }), "鉴权不得判只思考");
  assert(!isThinkingOnlyFailure(new Error("参数错误：模型不存在")), "参数错误不得判只思考");
  assert(!isThinkingOnlyFailure(new Error("第 2 章剧本未产出任何场景：模型返回无 scenes")), "空 scenes 不得判只思考");
  assert(!isThinkingOnlyFailure(new Error("已中止")), "中止不得判只思考");

  /* ---------- 2) 大章节确实能对半拆（否则后续「拆小成功」用例无意义） ---------- */
  assert(bigChapter.text.length > 4000, "大章节应超过可再拆分阈值 4000");
  assert(bigChapter.text.length <= 8000, "大章节应仍在一个分块内（≤8000），否则不再走降级拆分路径");
  assert(splitForDegrade(bigChapter.text).length >= 2, "大章节应可拆成 >= 2 块");
  assert(smallChapter.text.length <= 4000, "小章节应处在最小拆分粒度");
}

async function asyncChecks(): Promise<void> {
  const originalHttp = tauri.http;

  /* ---------- 3) chatJson 空产出 → EmptyContentError，只发 1 次请求（不进修复） ---------- */
  let chatCalls = 0;
  tauri.http = (async () => {
    chatCalls++;
    return responseBody(THINKING_ONLY);
  }) as typeof tauri.http;
  let chatErr: unknown;
  try {
    await chatJson(configFor("mimo-a"), "sys", "user", { maxTokens: 1000, maxRepair: 2, maxContinue: 3 });
  } catch (e) {
    chatErr = e;
  }
  assert(chatErr instanceof EmptyContentError, `chatJson 空产出应抛 EmptyContentError，实际 ${errorText(chatErr)}`);
  assert((chatErr as Error).name === "EmptyContentError", "错误 name 应为 EmptyContentError");
  assert(chatCalls === 1, `不得进入续写/修复，应只发 1 次请求，实际 ${chatCalls}`);

  /* ---------- 4) withRetry 不自动重试 EmptyContentError ---------- */
  let retryCalls = 0;
  try {
    await withRetry(
      async () => {
        retryCalls++;
        throw new EmptyContentError("only thinking");
      },
      { retries: 4, delayFor: () => 0 },
    );
  } catch {
    /* 预期抛出 */
  }
  assert(retryCalls === 1, `withRetry 不得重试 EmptyContentError，实际 ${retryCalls} 次`);

  /* ---------- 5) 小章节全空产出：重试 SCRIPT_THINKING_RETRY 次后给最终文案 ---------- */
  let smallCalls = 0;
  tauri.http = (async () => {
    smallCalls++;
    return responseBody(THINKING_ONLY);
  }) as typeof tauri.http;
  const smallLogs: string[] = [];
  let smallErr: unknown;
  try {
    await scriptChapter(configFor("mimo-b"), smallChapter, CARDS, undefined, { onLog: (m) => smallLogs.push(m) });
  } catch (e) {
    smallErr = e;
  }
  assert(smallErr !== undefined, "小章节持续空产出必须抛出");
  assert(/持续只思考未产出正文/.test(errorText(smallErr)), `最终文案应说明持续只思考，实际：${errorText(smallErr)}`);
  assert(/已自动重试与拆分仍未成功/.test(errorText(smallErr)), "最终文案应含「已自动重试与拆分仍未成功」");
  assert(!/关闭深度思考/.test(errorText(smallErr)), "最终文案不得再教用户关闭深度思考");
  assert(
    smallCalls === SCRIPT_THINKING_RETRY + 1,
    `主块应恰好请求 ${SCRIPT_THINKING_RETRY + 1} 次（1 + ${SCRIPT_THINKING_RETRY} 次重试），实际 ${smallCalls}`,
  );
  assert(
    smallLogs.filter((l) => /正在自动重试/.test(l)).length === SCRIPT_THINKING_RETRY,
    `应有 ${SCRIPT_THINKING_RETRY} 条「正在自动重试」可见日志，实际：${smallLogs.join(" | ")}`,
  );

  /* ---------- 6) 大章节主块空产出：重试后降级拆分，子块独立生成成功 ---------- */
  let bigCalls = 0;
  const mainCalls = SCRIPT_THINKING_RETRY + 1;
  tauri.http = (async () => {
    bigCalls++;
    return bigCalls <= mainCalls ? responseBody(THINKING_ONLY) : okScript();
  }) as typeof tauri.http;
  const bigLogs: string[] = [];
  const result = await scriptChapter(configFor("mimo-c"), bigChapter, CARDS, undefined, { onLog: (m) => bigLogs.push(m) });
  const scenes: SceneJSON[] = result.scenes;
  assert(scenes.length === 2, `拆分后应产出 2 个场景（每子块 1 个），实际 ${scenes.length}`);
  assert(
    bigCalls === mainCalls + 2,
    `应为主块 ${mainCalls} 次 + 两个子块各 1 次 = ${mainCalls + 2} 次请求，实际 ${bigCalls}`,
  );
  assert(bigLogs.some((l) => /正在自动重试/.test(l)), `应记录重试日志，实际：${bigLogs.join(" | ")}`);
  assert(bigLogs.some((l) => /已拆成 2 块/.test(l)), `应记录拆分日志，实际：${bigLogs.join(" | ")}`);

  tauri.http = originalHttp;
}

syncChecks();
asyncChecks()
  .then(() => {
    console.log("「只思考未产出正文」自动重试/拆分测试通过");
  })
  .catch((e) => {
    console.error("失败:", e);
    process.exit(1);
  });
