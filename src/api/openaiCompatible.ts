import { tauri } from "../utils/tauri";
import type { ApiConfig, ChannelKey, ImageModelCapabilities, ImageReference } from "../core/types";
import { sizeRatio, unifiedImage, unifiedTts, utf8FromB64 } from "./universal";
import { resolveTemplate, getTemplate } from "./templates";
import { ConcurrencyLimiter } from "../utils/performance";
import {
  configIsUsable,
  knownImageModelCapabilities,
  parseModelList,
  protocolForConfig,
  providerIdForConfig,
  rawReferenceBase64,
  ReferenceImageError,
  referenceDataUrl,
  resolveImageModelCapabilities,
  routeImageReferences,
  type DiscoveredModel,
  type ProviderId,
} from "./providers";
export { ReferenceImageError } from "./providers";
import { zlibSync } from "fflate";
import { log } from "../utils/logger";

/**
 * 全局图像请求并发上限：任务层并发再高（如 30），实际同时发往图片 API 的请求数也受此限制。
 * 许多图片服务（如 api2cn）并发上限很低，30 并发会触发大量 429；
 * 用信号量把实际并发压到 3，配合单请求退避即可稳定跑满而不再打爆服务端。
 * 上限会跟随用户设置的「图像/配音并发数」动态调整（setImageConcurrency），
 * 默认 3 仅是兜底，避免未设置时打爆服务端。
 */
const IMAGE_CONCURRENCY = new ConcurrencyLimiter(3);

/** 跟随用户并发设置动态调整图片请求上限（由生成/重生成入口调用） */
export function setImageConcurrency(n: number): void {
  IMAGE_CONCURRENCY.setMaxConcurrent(n);
}

/**
 * 全局文本/视觉 LLM 请求并发上限。
 * 文本生成默认串行（并发 1）：章节剧本/分章/翻译的请求体可达 2 万+ 字符，
 * 并发会同时向文本 API 发大请求，触发网关限流 / error sending request。
 * 图片有独立 IMAGE_CONCURRENCY（可调），文本保持保守。
 */
const LLM_CONCURRENCY = new ConcurrencyLimiter(1);

/**
 * 通过 OpenAI 兼容的 GET /models 拉取模型列表，并按通道能力过滤。
 * 无 apiKey 或请求失败时抛出可读错误；返回的列表可存入 config.extra.discoveredModels。
 */export async function fetchModelsForChannel(cfg: ApiConfig, kind: ChannelKey): Promise<DiscoveredModel[]> {
  if (!cfg.baseUrl?.trim()) throw new Error("请先填写 Base URL 再刷新模型");
  const base = normalizeBaseUrl(cfg.baseUrl, cfg.extra?.pathPrefix as string | undefined);
  const url = `${base}/models`;
  log.info("api", "拉取模型列表", { url, kind, model: cfg.model, apiKey: maskKey(cfg.apiKey) });
  const response = await tauri.http({
    method: "GET",
    url,
    headers: {
      Accept: "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    timeoutSecs: 20,
  });
  if (response.status >= 400) {
    const raw = utf8FromB64(response.bodyBase64).slice(0, 400);
    log.error("api", "拉取模型列表失败", { url, status: response.status, raw });
    throw new Error(`模型列表接口返回 ${response.status}${raw ? `：${raw}` : ""}`);
  }
  const payload = JSON.parse(utf8FromB64(response.bodyBase64));
  const provider = providerIdForConfig(cfg);
  const models = parseModelList(payload, provider).filter(
    (model) => model.capabilities.length === 0 || model.capabilities.includes(kind),
  );
  // 部分供应商的 /models 接口只返回对话模型，图像/语音模型不会出现在列表里。
  // 对这些供应商补充内置建议模型，保证下拉框能选到（如 MiniMax 的 image-01 / speech-2.8-hd）。
  const providerBuiltins = BUILTIN_CHANNEL_MODELS[provider]?.[kind] ?? [];
  for (const builtin of providerBuiltins) {
    if (!models.some((model) => model.id === builtin)) {
      models.push({ id: builtin, capabilities: [kind] });
    }
  }
  log.info("api", "拉取模型列表成功", { url, kind, count: models.length, builtins: providerBuiltins });
  return models;
}

/** 掩码 API Key，避免日志泄露密钥 */
function maskKey(key?: string): string {
  if (!key) return "(未设置)";
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function b64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return bin;
  }
}

/** 供应商 /models 接口遗漏的通道内置模型（如 MiniMax 图像/语音），保证模型下拉可选 */
const BUILTIN_CHANNEL_MODELS: Partial<Record<ProviderId, Partial<Record<ChannelKey, string[]>>>> = {
  minimax: {
    image: ["image-01", "image-01-live"],
    tts: ["speech-2.8-hd", "speech-2.6-hd", "speech-01-hd", "speech-01-turbo"],
  },
  siliconflow: {
    image: ["Qwen/Qwen-Image-Edit-2509", "black-forest-labs/FLUX.1-schnell", "Kwai-Kolors/Kolors"],
    tts: ["FunAudioLLM/CosyVoice2-0.5B", "fishaudio/fish-speech-1.5"],
  },
  openai: {
    image: ["gpt-image-1", "dall-e-3"],
    tts: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
  },
};

export function normalizeBaseUrl(baseUrl: string, pathPrefix?: string): string {
  let b = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!b) throw new Error("base_url 为空");
  if (!b.startsWith("http")) {
    b = "http://" + b;
  }
  if (pathPrefix) {
    b = b.replace(/\/+$/, "") + "/" + pathPrefix.replace(/^\/+|\/+$/g, "");
  } else if (!/\/v\d+$/i.test(b) && !/\/v\d+\//i.test(b)) {
    b = b + "/v1";
  }
  return b;
}

function headersFor(cfg: ApiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  timeoutSecs?: number;
  onUsage?: (promptTokens: number, completionTokens: number) => void;
  /** JSON 输出被截断时最多续写次数（默认 3） */
  maxContinue?: number;
  /** JSON 解析失败时最多修复重试次数（默认 2） */
  maxRepair?: number;
}

export interface VisionChatOptions extends ChatOptions {
  imageMime?: string;
}

export type VisionApiErrorCode =
  | "VISION_CONFIGURATION_INVALID"
  | "VISION_CAPABILITY_UNSUPPORTED"
  | "VISION_RESPONSE_INVALID"
  | "VISION_UNAVAILABLE";

export class VisionApiError extends Error {
  constructor(message: string, public readonly code: VisionApiErrorCode) {
    super(message);
    this.name = "VisionApiError";
  }
}

const VISION_REFUSAL = /(?:cannot|can't|unable to)\s+(?:view|see|inspect|process|access|analy[sz]e).{0,30}(?:image|picture)|text[- ]only|不支持.{0,12}(?:图片|图像|视觉)|无法.{0,12}(?:查看|识别|分析|处理).{0,12}(?:图片|图像)/i;

function imageMimeFromBase64(dataB64: string): string {
  if (dataB64.startsWith("/9j/")) return "image/jpeg";
  if (dataB64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

function imageDataUrl(image: string, mime?: string): string {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(image)) return image;
  const resolvedMime = mime?.startsWith("image/") ? mime : imageMimeFromBase64(image);
  return `data:${resolvedMime};base64,${image}`;
}

function visionHttpError(status: number, raw: string): Error {
  if (VISION_REFUSAL.test(raw) || /(?:image_url|multimodal|vision).{0,40}(?:not supported|unsupported|not accept)/i.test(raw)) {
    return new VisionApiError(`当前模型不支持图片识别：${raw.slice(0, 200)}`, "VISION_CAPABILITY_UNSUPPORTED");
  }
  if ([400, 401, 403, 404].includes(status)) {
    return new VisionApiError(`图片识别 API 配置错误 ${status}: ${raw.slice(0, 200)}`, "VISION_CONFIGURATION_INVALID");
  }
  return new Error(`图片识别 API 返回错误 ${status}: ${raw.slice(0, 300)}`);
}

/** MiniMax 等厂商会把错误放进 HTTP 200 响应体的 base_resp 字段，这里提取成可读信息 */
function extractProviderBaseError(data: unknown): string | null {
  const baseResp = (data as { base_resp?: { status_code?: unknown; status_msg?: string } })?.base_resp;
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    const message = typeof baseResp.status_msg === "string" && baseResp.status_msg.trim()
      ? baseResp.status_msg
      : "无详细说明";
    return `MiniMax 错误 ${baseResp.status_code}: ${message}`;
  }
  return null;
}

export function isRetryable(status: number, text: string): boolean {
  if (status >= 500 || status === 429) return true;
  return /timeout|timed out|network|socket|connect|ECONN|ETIMEDOUT|fetch failed|error sending request|请求失败|dns|resolve|refused/i.test(text);
}

export const RETRY_DELAYS = [800, 2500, 6000];

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const err = e as { status?: number; message?: string };
      if (attempt >= RETRY_DELAYS.length || !isRetryable(err.status ?? 0, err.message ?? "")) {
        throw e;
      }
      log.warn("api", `请求失败，准备第 ${attempt + 1} 次重试`, {
        status: err.status ?? 0,
        message: (err.message ?? String(e)).slice(0, 300),
      });
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }
  throw lastErr;
}

export async function chatCompletion(
  cfg: ApiConfig,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: ChatOptions = {},
): Promise<{ content: string; promptTokens: number; completionTokens: number; finishReason?: string }> {
  const base = normalizeBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
  const url = `${base}/chat/completions`;
  const done = log.time("api", `chatCompletion ${cfg.model}`);
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.json) {
    body.response_format = { type: "json_object" };
    body.temperature = 0.2;
  }
  log.info("api", "LLM 请求发出", {
    url,
    model: cfg.model,
    modelJson: JSON.stringify(cfg.model),
    baseUrl: cfg.baseUrl,
    pathPrefix: cfg.extra?.pathPrefix,
    apiKey: maskKey(cfg.apiKey),
    messageCount: messages.length,
    messages: messages.map((m) => ({ role: m.role, len: m.content.length, head: m.content.slice(0, 200) })),
    json: !!opts.json,
    maxTokens: opts.maxTokens,
    temperature: body.temperature,
    bodyJson: JSON.stringify(body).slice(0, 400),
  });

  // 推理型模型（deepseek 系列）会先消耗大量 token 在 reasoning_content 思考上。
  // 当 content 为空且 finish_reason=length 时，说明预算被思考耗尽、答案未输出，需放大预算重试。
  // 这里把 HTTP 调用做成可带独立 tokenBudget 的闭包，逐级放大。
  const perform = async (tokenBudget: number) => {
    const requestBody = { ...body };
    if (tokenBudget > 0) requestBody.max_tokens = tokenBudget;
    const res = await tauri.http({
      method: "POST",
      url,
      headers: headersFor(cfg),
      body: JSON.stringify(requestBody),
      timeoutSecs: opts.timeoutSecs ?? 180,
    });
    const text = b64ToUtf8(res.bodyBase64);
    if (res.status >= 500 || res.status === 429) {
      log.warn("api", `chatCompletion HTTP ${res.status}`, { url, raw: text.slice(0, 600) });
      throw { status: res.status, message: `HTTP ${res.status}` };
    }
    if (res.status >= 400) {
      log.error("api", `LLM HTTP 错误 ${res.status}`, { url, raw: text.slice(0, 1000) });
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: unknown } };
        const errorMessage = parsed?.error?.message;
        if (typeof errorMessage === "string" && errorMessage.trim()) message = errorMessage.trim();
      } catch {
        /* 非 JSON 错误体 */
      }
      if (/model.{0,20}(?:unavailable|not found|does not exist)|模型.{0,12}(?:不可用|不存在)/i.test(message)) {
        message += "（该模型当前可能不可用，请在 LLM 模型下拉框换一个，如 deepseek-v4-pro / minimax-m3）";
      }
      throw new Error(`LLM 返回错误 ${res.status}: ${message}`);
    }

    log.info("api", "LLM 响应返回", {
      url,
      status: res.status,
      bodyLen: text.length,
      body: text.slice(0, 600),
    });
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      log.error("api", "chatCompletion 响应不是合法 JSON", { textHead: text.slice(0, 300) });
      throw new Error(`LLM 响应不是合法 JSON: ${text.slice(0, 300)}`);
    }
    const providerError = extractProviderBaseError(data);
    if (providerError) {
      log.error("api", "chatCompletion 厂商返回业务错误", { providerError });
      throw new Error(`LLM 返回错误: ${providerError}`);
    }
    if (!data.choices || !data.choices.length) {
      log.error("api", "chatCompletion 响应缺少 choices", { data: JSON.stringify(data).slice(0, 400) });
      throw new Error(`LLM 返回错误: ${JSON.stringify(data).slice(0, 400)}`);
    }
    const message = data.choices[0].message ?? {};
    const rawContent = typeof message.content === "string" ? message.content : "";
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    return {
      rawContent,
      reasoning,
      finishReason: data.choices[0].finish_reason as string | undefined,
      promptTokens: (data.usage?.prompt_tokens as number | undefined) ?? 0,
      completionTokens: (data.usage?.completion_tokens as number | undefined) ?? 0,
    };
  };

  // 基础预算：调用方显式指定则用之，否则给推理型模型一个默认预算（避免思考耗尽）
  // 升级路径必须严格递增：opts.maxTokens=16000 → [16000, 24000, 32000]，
  // 修复旧版 [16000, 16000] 去重后只跑一次的 bug
  // 若调用方已给足预算（≥64K，通常是按模型上下文动态算的），首轮直接用最大预算，
  // 不再放大（避免超模型 max_tokens 被服务端 400 拒绝）。
  const baseBudget = opts.maxTokens ?? 8000;
  const generous = typeof opts.maxTokens === "number" && opts.maxTokens >= 64_000;
  const escalation = opts.maxTokens
    ? (generous
        ? [opts.maxTokens, opts.maxTokens]
        : Array.from(new Set([opts.maxTokens, opts.maxTokens + 8000, Math.max(opts.maxTokens * 2, 24000)])).sort((a, b) => a - b))
    : [baseBudget, baseBudget * 2];
  const seenBudgets = new Set<number>();

  // 文本请求全局限流：并发 1（串行），避免多章节剧本同时发大请求打爆网关
  return LLM_CONCURRENCY.run(() => withRetry(async () => {
    let response = await perform(escalation[0]);
    // 升级重试：
    //   ① content 为空且 finishReason=length → 预算被思考耗尽
    //   ② JSON 模式下解析失败且 finishReason=length → 残 JSON 也算截断
    //   满足任一即放大 max_tokens 再试（已给足预算时首轮即最大，跳过放大）
    for (let i = 1; i < escalation.length; i++) {
      const budget = escalation[i];
      if (seenBudgets.has(budget)) break;
      seenBudgets.add(budget);
      const truncated = response.finishReason === "length";
      const empty = !response.rawContent.trim();
      const brokenJson = truncated && opts.json && !canParseJson(response.rawContent);
      if (!truncated || (!empty && !brokenJson)) break;
      log.warn("api", "输出被截断（content 为空或 JSON 不完整），放大 max_tokens 重试", {
        budget,
        reasoningLen: response.reasoning.length,
        rawLen: response.rawContent.length,
        empty,
        brokenJson,
      });
      response = await perform(budget);
    }

    let content = response.rawContent;
    // 推理型模型可能把答案写进 reasoning_content，content 为空时回退读取。
    if (!content.trim() && response.reasoning.trim()) {
      log.warn("api", "message.content 为空，已回退使用 reasoning_content", {
        reasoningLen: response.reasoning.length,
        finishReason: response.finishReason ?? "?",
      });
      // JSON 模式下：reasoning_content 先是一大段"思考过程"，真正的 JSON 往往在末尾。
      // 逐段尝试解析，取最后一个合法 JSON（而不是盲目取首个 { 到最后一个 }，避免思考里的伪 JSON 干扰）。
      content = opts.json ? extractJsonFromMixed(response.reasoning) : response.reasoning;
      if (content !== response.reasoning) {
        log.info("api", "reasoning_content 中提取到 JSON", {
          reasoningLen: response.reasoning.length,
          candidateLen: content.length,
        });
      }
    }
    const finishReason = response.finishReason;
    const promptTokens = response.promptTokens;
    const completionTokens = response.completionTokens;
    opts.onUsage?.(promptTokens, completionTokens);
    done(`pt=${promptTokens} ct=${completionTokens} fr=${finishReason ?? "?"}`);
    log.debug("api", "chatCompletion 成功", {
      promptTokens,
      completionTokens,
      finishReason,
      contentLen: content.length,
      contentHead: content.slice(0, 120),
    });
    return { content, promptTokens, completionTokens, finishReason };
  }));
}

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, "").trim();

  // 尝试直接解析
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fallthrough */
  }

  // 截取首个 { 到最后一个 } 再解析（容忍前后多余文字）
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* fallthrough */
    }
    // 常见损坏修复：去掉对象/数组末尾的尾随逗号后重试（截断时很常见）
    const repaired = cleaned
      .slice(start, end + 1)
      .replace(/,\s*([\]}])/g, "$1")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    try {
      return JSON.parse(repaired);
    } catch {
      /* fallthrough */
    }
  }
  throw new Error("无法从响应中提取合法 JSON");
}

/** 轻量 JSON 可解析性探测（用于截断重试判断） */
function canParseJson(text: string): boolean {
  const cleaned = text.replace(/```json|```/g, "").trim();
  if (!cleaned) return false;
  try {
    JSON.parse(cleaned);
    return true;
  } catch {
    /* fallthrough */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      JSON.parse(cleaned.slice(start, end + 1));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 从「思考过程 + JSON 混排」的文本里提取最后一个合法的 JSON。
 * 推理型模型（deepseek 系列）的 reasoning_content 通常是：思考文字 + 末尾一个完整 JSON。
 * 策略：从文本末尾向前找闭合符，再向后做括号平衡扫描定位匹配的开括号，尝试 JSON.parse。
 */
export function extractJsonFromMixed(text: string): string {
  const cleaned = text.replace(/```json|```/g, "");
  const endIndexes: number[] = [];
  for (let i = cleaned.length - 1; i >= 0; i--) {
    const ch = cleaned[i];
    if (ch === "}" || ch === "]") {
      endIndexes.push(i);
      if (endIndexes.length >= 5) break;
    }
  }
  for (const endIdx of endIndexes) {
    // 从闭合符向左做括号平衡扫描，找到与之匹配的开括号（正确嵌套，不会错配内层）
    let depth = 1;
    let startIdx = -1;
    for (let i = endIdx - 1; i >= 0; i--) {
      const ch = cleaned[i];
      if (ch === "}" || ch === "]") depth++;
      else if (ch === "{" || ch === "[") {
        depth--;
        if (depth === 0) {
          startIdx = i;
          break;
        }
      }
    }
    if (startIdx < 0) continue;
    const candidate = cleaned.slice(startIdx, endIdx + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 尝试修复尾随逗号
      try {
        const repaired = candidate
          .replace(/,\s*([\]}])/g, "$1")
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
        JSON.parse(repaired);
        return repaired;
      } catch {
        /* 继续找下一个候选 */
      }
    }
  }
  return cleaned;
}

export async function chatJson<T>(
  cfg: ApiConfig,
  system: string,
  user: string,
  opts: ChatOptions = {},
): Promise<T> {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const maxContinue = opts.maxContinue ?? 3;
  const maxRepair = opts.maxRepair ?? 2;
  let continueCount = 0;
  let repairCount = 0;
  let accumulated = "";

  for (;;) {
    const { content, finishReason } = await chatCompletion(cfg, messages, { ...opts, json: true });
    accumulated += content;

    // 输出因长度上限被截断 → 请求模型从中断处续写
    if (finishReason === "length" && continueCount < maxContinue) {
      continueCount++;
      log.warn("api", "JSON 输出被截断，请求续写", { accumulatedLen: accumulated.length, attempt: continueCount });
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: "你的上一轮 JSON 输出因长度限制被截断。请只输出缺失的剩余 JSON 部分（严格从中断处继续，不要重复已输出的内容，不要任何解释文字）。",
      });
      continue;
    }

    try {
      return extractJson(accumulated) as T;
    } catch (e) {
      if (repairCount < maxRepair) {
        repairCount++;
        log.warn("api", "JSON 解析失败，请求模型修复", {
          error: e instanceof Error ? e.message.slice(0, 200) : String(e),
          attempt: repairCount,
        });
        accumulated = "";
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: "你上一轮输出的 JSON 无法解析。请重新输出完整、严格合法的 JSON（不要 markdown 代码块，不要任何解释文字）。",
        });
        continue;
      }
      log.error("api", "JSON 解析失败（重试耗尽）", {
        error: e instanceof Error ? e.message : String(e),
        accumulatedLen: accumulated.length,
      });
      throw e;
    }
  }
}
/** 视觉问答：把图片(base64) + 文本发给多模态模型，返回文本回复（供图像自检用；可选附一张参考图做一致性对比） */
export async function chatVision(
  cfg: ApiConfig,
  system: string,
  userText: string,
  imageB64: string,
  opts: VisionChatOptions = {},
  references: ImageReference[] = [],
): Promise<string> {
  if (!configIsUsable(cfg, "vision")) {
    throw new VisionApiError("图片识别 API 未配置或不可用", "VISION_CONFIGURATION_INVALID");
  }
  const base = normalizeBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
  const done = log.time("api", `chatVision ${cfg.model}`);
  log.debug("api", "chatVision 请求", {
    base,
    model: cfg.model,
    apiKey: maskKey(cfg.apiKey),
    imageB64Len: imageB64.length,
    referenceCount: references.length,
    userTextLen: userText.length,
  });
  const imageParts: { type: "image_url"; image_url: { url: string } }[] = [
    { type: "image_url", image_url: { url: imageDataUrl(imageB64, opts.imageMime) } },
  ];
  const rolePriority = { identity: 0, style: 1, structure: 2 } as const;
  const orderedReferences = references
    .map((reference, index) => ({ reference, index }))
    .sort((left, right) => rolePriority[left.reference.role] - rolePriority[right.reference.role] || left.index - right.index);
  for (const { reference } of orderedReferences) {
    imageParts.push({ type: "image_url", image_url: { url: referenceDataUrl(reference) } });
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          ...imageParts,
        ],
      },
    ],
    temperature: opts.temperature ?? 0.1,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  // 视觉请求与文本请求共享全局串行限流，避免并发打爆网关
  const content = await LLM_CONCURRENCY.run(() => withRetry(async () => {
    const res = await tauri.http({
      method: "POST",
      url: `${base}/chat/completions`,
      headers: headersFor(cfg),
      body: JSON.stringify(body),
      timeoutSecs: opts.timeoutSecs ?? 120,
    });
    if (res.status >= 500 || res.status === 429) {
      log.error("api", `chatVision 服务端错误 ${res.status}`, { url: `${base}/chat/completions`, model: cfg.model });
      throw { status: res.status, message: `HTTP ${res.status}` };
    }
    if (res.status >= 400) {
      const raw = b64ToUtf8(res.bodyBase64);
      log.error("api", `chatVision 失败 ${res.status}`, {
        url: `${base}/chat/completions`,
        model: cfg.model,
        apiKey: maskKey(cfg.apiKey),
        raw: raw.slice(0, 600),
      });
      throw visionHttpError(res.status, raw);
    }
    const text = b64ToUtf8(res.bodyBase64);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      log.error("api", "chatVision 响应不是合法 JSON", { model: cfg.model, textHead: text.slice(0, 400) });
      throw new VisionApiError(`图片识别 API 响应不是合法 JSON: ${text.slice(0, 300)}`, "VISION_RESPONSE_INVALID");
    }
    const providerError = extractProviderBaseError(data);
    if (providerError) {
      log.error("api", "chatVision 厂商返回业务错误", { model: cfg.model, providerError, raw: text.slice(0, 400) });
      throw new VisionApiError(`图片识别 API 返回错误：${providerError}`, "VISION_CONFIGURATION_INVALID");
    }
    if (!data.choices || !data.choices.length) {
      log.error("api", "chatVision 响应缺少 choices", { model: cfg.model, raw: text.slice(0, 500) });
      throw new VisionApiError(`图片识别 API 响应缺少 choices: ${JSON.stringify(data).slice(0, 400)}`, "VISION_RESPONSE_INVALID");
    }
    const c = data.choices[0].message?.content ?? "";
    const usage = data.usage || {};
    opts.onUsage?.(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
    const reply = typeof c === "string" ? c : JSON.stringify(c);
    if (!reply.trim()) {
      log.error("api", "chatVision 返回空白内容", { model: cfg.model, raw: text.slice(0, 300) });
      throw new VisionApiError("图片识别 API 返回了空白内容", "VISION_RESPONSE_INVALID");
    }
    if (VISION_REFUSAL.test(reply)) {
      log.error("api", "chatVision 模型拒绝看图", { model: cfg.model, reply: reply.slice(0, 300) });
      throw new VisionApiError(`当前模型无法识别图片：${reply.slice(0, 120)}`, "VISION_CAPABILITY_UNSUPPORTED");
    }
    log.debug("api", "chatVision 成功", {
      model: cfg.model,
      replyHead: reply.slice(0, 160),
      replyLen: reply.length,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
    });
    return reply;
  }));
  done(`len=${content.length}`);
  return content;
}

export interface ImageResult {
  fileName: string;
  dataB64: string;
}

export function imageEndpointForConfig(cfg: ApiConfig): string {
  return protocolForConfig(cfg, "image") === "minimax-image"
    ? "/v1/image_generation"
    : "/v1/images/generations";
}

export function buildImageRequestBody(
  cfg: ApiConfig,
  prompt: string,
  opts: { size?: string; count?: number; references?: ImageReference[] } = {},
): Record<string, unknown> {
  const protocol = protocolForConfig(cfg, "image");
  const count = opts.count ?? 1;
  const capabilities = resolveImageModelCapabilities(cfg);
  const references = routeImageReferences(cfg, opts.references ?? []);
  const encoded = references.map((reference) => capabilities.referenceEncoding === "data-url"
    ? referenceDataUrl(reference)
    : rawReferenceBase64(reference));
  const referenceFields = {
    ...(encoded[0] ? { image: encoded[0] } : {}),
    ...(encoded[1] ? { image2: encoded[1] } : {}),
    ...(encoded[2] ? { image3: encoded[2] } : {}),
  };
  if (protocol === "minimax-image") {
    const [w, h] = (opts.size ?? "1024x1024").split("x").map((n) => parseInt(n, 10));
    return {
      model: cfg.model,
      prompt,
      aspect_ratio: sizeRatio(w, h),
      n: count,
      ...referenceFields,
    };
  }
  if (protocol === "siliconflow-image") {
    return {
      model: cfg.model,
      prompt,
      image_size: opts.size ?? "1024x1024",
      batch_size: count,
      ...referenceFields,
    };
  }
  return {
    model: cfg.model,
    prompt,
    ...(opts.size ? { size: opts.size } : {}),
    n: count,
    ...referenceFields,
  };
}

export function ttsEndpointForConfig(cfg: ApiConfig): string {
  return protocolForConfig(cfg, "tts") === "minimax-speech"
    ? "/v1/t2a_v2"
    : "/v1/audio/speech";
}

export function buildTtsRequestBody(
  cfg: ApiConfig,
  text: string,
  voice: string,
): Record<string, unknown> {
  const protocol = protocolForConfig(cfg, "tts");
  if (protocol === "minimax-speech") {
    return {
      model: cfg.model,
      text,
      stream: false,
      voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { format: "mp3", sample_rate: 32000 },
    };
  }
  if (protocol === "siliconflow-speech") {
    const model = cfg.model || "FunAudioLLM/CosyVoice2-0.5B";
    return {
      model,
      input: text,
      voice: `${model}:${voice === "default" ? "anna" : voice}`,
    };
  }
  return {
    model: cfg.model,
    input: text,
    voice: voice === "default" ? "alloy" : voice,
  };
}

export function extractImageValue(raw: unknown): string {
  const obj = raw as { data?: unknown };
  const data = obj?.data;
  const first = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : data as Record<string, unknown> | undefined;
  const imageUrls = first?.image_urls;
  if (Array.isArray(imageUrls) && typeof imageUrls[0] === "string") return imageUrls[0];
  if (typeof first?.url === "string") return first.url;
  if (typeof first?.b64_json === "string") return first.b64_json;
  if (typeof first?.base64 === "string") return first.base64;
  if (typeof first === "string") return first;
  throw new Error("图片响应中未找到结果字段");
}

function hexToBase64(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function parseMinimaxAudioResponse(json: unknown): { dataB64: string; mime: string } {
  const audio = (json as { data?: { audio?: unknown } })?.data?.audio;
  if (typeof audio !== "string" || !audio) {
    throw new Error("MiniMax TTS 响应缺少 data.audio");
  }
  return { dataB64: hexToBase64(audio), mime: "audio/mpeg" };
}

export async function generateImage(
  cfg: ApiConfig,
  prompt: string,
  opts: { references?: ImageReference[]; size?: string; seed?: number; negativePrompt?: string } = {},
): Promise<{ dataB64: string; mime: string }> {
  const tpl = resolveTemplate(cfg)
    ?? getTemplate(protocolForConfig(cfg, "image") === "siliconflow-image" ? "siliconflow-image" : "openai-image")!;
  const capabilities = resolveImageModelCapabilities(cfg);
  const references = routeImageReferences(cfg, opts.references ?? []);
  const [w, h] = (opts.size ?? "1024x1024").split("x").map((n) => parseInt(n, 10));
  const done = log.time("api", `generateImage ${cfg.model}`);
  log.debug("api", "generateImage 请求", {
    base: normalizeBaseUrl(cfg.baseUrl),
    model: cfg.model,
    protocol: protocolForConfig(cfg, "image"),
    apiKey: maskKey(cfg.apiKey),
    size: opts.size,
    seed: capabilities.supportsSeed ? opts.seed : undefined,
    referenceRoles: references.map((reference) => reference.role),
    promptHead: prompt.slice(0, 120),
  });
  try {
    // 全局图像请求限流：任务并发再高，实际同时发往图片 API 的请求数也受此限制，
    // 避免 30 个 worker 同时打爆服务端并发上限（429 Too Many Requests）。
    const r = await IMAGE_CONCURRENCY.run(() => unifiedImage(cfg, tpl, {
      prompt,
      width: w,
      height: h,
      references,
      referenceEncoding: capabilities.referenceEncoding,
      seed: capabilities.supportsSeed ? opts.seed : undefined,
      negativePrompt: opts.negativePrompt,
    }));
    done(`b64len=${r.dataB64.length}`);
    log.debug("api", "generateImage 成功", { dataB64Len: r.dataB64.length, mime: r.mime });
    return r;
  } catch (e) {
    log.error("api", "generateImage 失败", { error: e instanceof Error ? e.message : e });
    throw e;
  }
}

export async function ttsSpeech(
  cfg: ApiConfig,
  text: string,
  voice: string,
  _timeoutSecs = 120,
): Promise<{ dataB64: string; mime: string }> {
  const tpl = resolveTemplate(cfg) ?? getTemplate("openai-tts")!;
  const done = log.time("api", `ttsSpeech ${cfg.model} ${voice}`);
  log.debug("api", "ttsSpeech 请求", {
    base: normalizeBaseUrl(cfg.baseUrl),
    model: cfg.model,
    protocol: protocolForConfig(cfg, "tts"),
    apiKey: maskKey(cfg.apiKey),
    voice,
    textLen: text.length,
    textHead: text.slice(0, 80),
  });
  try {
    const r = await unifiedTts(cfg, tpl, { text, voice });
    done(`b64len=${r.dataB64.length}`);
    log.debug("api", "ttsSpeech 成功", { dataB64Len: r.dataB64.length, mime: r.mime });
    return r;
  } catch (e) {
    log.error("api", "ttsSpeech 失败", { error: e instanceof Error ? e.message : e });
    throw e;
  }
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, payload.length);
  const crcData = new Uint8Array(typeBytes.length + payload.length);
  crcData.set(typeBytes, 0);
  crcData.set(payload, typeBytes.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(crcData));
  const out = new Uint8Array(12 + payload.length);
  out.set(length, 0);
  out.set(typeBytes, 4);
  out.set(payload, 8);
  out.set(crc, 8 + payload.length);
  return out;
}

function b64FromBytes(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) binary += String.fromCharCode(...data.subarray(i, i + chunk));
  return btoa(binary);
}

/** 生成纯色不透明 PNG（RGB 色彩类型，无 alpha），用于视觉连接测试 */
function solidColorPngBase64(hexColor: string, size = 64): string {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  const stride = size * 3 + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0;
    for (let x = 0; x < size; x++) {
      const p = rowOffset + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 2; // 色彩类型：RGB（不带 alpha）
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = pngChunk("IHDR", ihdr);
  const idatChunk = pngChunk("IDAT", zlibSync(raw, { level: 0 }));
  const iendChunk = pngChunk("IEND", new Uint8Array(0));
  const png = new Uint8Array(signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let offset = 0;
  png.set(signature, offset); offset += signature.length;
  png.set(ihdrChunk, offset); offset += ihdrChunk.length;
  png.set(idatChunk, offset); offset += idatChunk.length;
  png.set(iendChunk, offset);
  return b64FromBytes(png);
}

export function testLlm(cfg: ApiConfig): Promise<string> {
  return chatCompletion(cfg, [
    { role: "user", content: "请只回复两个字：正常" },
  ], { maxTokens: 8, temperature: 0 }).then((r) => r.content);
}

/** 64×64 纯品红测试图：比 1×1 更易于各视觉模型稳定识别 */
const VISION_TEST_PNG_B64 = solidColorPngBase64("#ff00ff", 64);
/**
 * 视觉连接测试只校验"模型确实看到了图"（返回了可感知的视觉内容），
 * 不校验具体颜色——各模型对同一颜色的命名差异很大（例如 MiniMax-M3 把品红说成 teal/blue/green）。
 * 命中任一颜色/可视描述词即通过。
 */
const VISION_GROUNDED = /magenta|fuchsia|pink|purple|violet|red|green|blue|yellow|orange|cyan|teal|brown|black|white|gray|grey|洋红|品红|粉红|紫|红|绿|蓝|黄|橙|青|褐|黑|白|灰/i;
/** 明确表示看不清/无法判断颜色的回答，说明模型没有真正看到图片，必须失败 */
const VISION_NOT_GROUNDED = /(?:cannot|can't|unable to|unable)\s+(?:see|identify|determine|tell|perceive)\s+(?:the\s+)?(?:color|colour|image)|看不清|无法.{0,4}(?:识别|辨认|确定).{0,4}(?:颜色|图像)|no\s+(?:visible\s+)?(?:color|colour)/i;

export async function testVision(cfg: ApiConfig): Promise<string> {
  log.info("api", "testVision 开始", {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: maskKey(cfg.apiKey),
    testImage: "64x64 纯品红",
  });
  const description = (await chatVision(
    cfg,
    "You are testing image understanding. Describe only what is visibly present.",
    "Identify the exact visible color of this opaque square. Answer in one short sentence.",
    VISION_TEST_PNG_B64,
    { maxTokens: 40, temperature: 0 },
  )).trim();
  if (!description) {
    log.error("api", "testVision 未返回视觉描述", { model: cfg.model });
    throw new VisionApiError("图片识别 API 未返回视觉描述", "VISION_RESPONSE_INVALID");
  }
  if (!VISION_GROUNDED.test(description) || VISION_NOT_GROUNDED.test(description)) {
    log.error("api", "testVision 未给出可验证的视觉描述", { model: cfg.model, description });
    throw new VisionApiError(`图片识别未能给出可验证的视觉描述（模型可能没有真正看到图片）：${description.slice(0, 120)}`, "VISION_RESPONSE_INVALID");
  }
  log.info("api", "testVision 通过", { model: cfg.model, description: description.slice(0, 160) });
  return description;
}

export async function testTts(cfg: ApiConfig): Promise<void> {
  const r = await ttsSpeech(cfg, "测试", "default", 60);
  if (!r.dataB64 || r.dataB64.length < 100) {
    throw new Error("TTS 返回数据异常");
  }
}

/** 带参考图的能力探测：用一张纯色小图作为参考图请求图生图，成功说明该模型支持参考图/图生图 */
async function probeImageEditSupport(cfg: ApiConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const probe = await generateImage(
      cfg,
      "a simple red square next to the reference image, same style",
      { references: [{ role: "structure", dataB64: VISION_TEST_PNG_B64, mime: "image/png" }], size: "512x512" },
    );
    if (!probe.dataB64 || probe.dataB64.length < 500) {
      return { ok: false, detail: "返回数据异常" };
    }
    return { ok: true, detail: "" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function testImage(cfg: ApiConfig): Promise<{ imageOk: boolean; editOk: boolean; detail: string }> {
  const r = await generateImage(cfg, "a simple red square on white background", { size: "512x512" });
  if (!r.dataB64 || r.dataB64.length < 500) {
    throw new Error("图像 API 返回数据异常");
  }
  // 自动探测该模型是否支持参考图/图生图，并把结果写回配置，避免手动改配置。
  // 合并而不是覆盖已知能力表，保留准确配置（如 Qwen 的 supportsSeed / data-url 编码）。
  const probe = await probeImageEditSupport(cfg);
  const known = knownImageModelCapabilities(cfg.model);
  const base = known ?? { maxReferenceImages: 0, supportsSeed: false, supportsImageEdit: false, referenceEncoding: "raw-base64" as const };
  const capabilities: ImageModelCapabilities = {
    ...base,
    supportsImageEdit: probe.ok,
    maxReferenceImages: probe.ok ? 3 : 0,
  };
  cfg.extra ??= {};
  cfg.extra.imageCapabilities = capabilities;
  log.info("api", "图像模型能力自动探测完成", {
    model: cfg.model,
    supportsImageEdit: probe.ok,
    supportsSeed: capabilities.supportsSeed,
    referenceEncoding: capabilities.referenceEncoding,
    detail: probe.detail.slice(0, 120),
  });
  return { imageOk: true, editOk: probe.ok, detail: probe.detail };
}
