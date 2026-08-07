import { tauri } from "../utils/tauri";
import type { ApiConfig } from "../core/types";
import { sizeRatio, unifiedImage, unifiedTts, utf8FromB64 } from "./universal";
import { resolveTemplate, getTemplate } from "./templates";
import { protocolForConfig } from "./providers";
import { log } from "../utils/logger";

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

export function isRetryable(status: number, text: string): boolean {
  if (status >= 500 || status === 429) return true;
  return /timeout|timed out|network|socket|connect|ECONN|ETIMEDOUT|fetch failed/i.test(text);
}

export const RETRY_DELAYS = [800, 2500];

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
  const done = log.time("api", `chatCompletion ${cfg.model}`);
  log.debug("api", "chatCompletion 请求", {
    base,
    model: cfg.model,
    apiKey: maskKey(cfg.apiKey),
    messages: messages.map((m) => ({ role: m.role, contentLen: m.content.length, contentHead: m.content.slice(0, 80) })),
    json: !!opts.json,
    maxTokens: opts.maxTokens,
  });
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

  return withRetry(async () => {
    const res = await tauri.http({
      method: "POST",
      url: `${base}/chat/completions`,
      headers: headersFor(cfg),
      body: JSON.stringify(body),
      timeoutSecs: opts.timeoutSecs ?? 180,
    });
    if (res.status >= 500 || res.status === 429) {
      log.warn("api", `chatCompletion HTTP ${res.status}`, { url: `${base}/chat/completions` });
      throw { status: res.status, message: `HTTP ${res.status}` };
    }
    if (res.status >= 400) {
      const raw = b64ToUtf8(res.bodyBase64);
      log.error("api", `chatCompletion 返回错误 ${res.status}`, { raw: raw.slice(0, 300) });
      throw new Error(`LLM 返回错误 ${res.status}: ${raw.slice(0, 300)}`);
    }

    const text = b64ToUtf8(res.bodyBase64);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      log.error("api", "chatCompletion 响应不是合法 JSON", { textHead: text.slice(0, 300) });
      throw new Error(`LLM 响应不是合法 JSON: ${text.slice(0, 300)}`);
    }
    if (!data.choices || !data.choices.length) {
      log.error("api", "chatCompletion 响应缺少 choices", { data: JSON.stringify(data).slice(0, 400) });
      throw new Error(`LLM 返回错误: ${JSON.stringify(data).slice(0, 400)}`);
    }
    const content = data.choices[0].message?.content ?? "";
    const finishReason = data.choices[0].finish_reason as string | undefined;
    const usage = data.usage || {};
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
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
  });
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

  throw new Error(`无法解析 JSON 输出: ${cleaned.slice(0, 500)}`);
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
/** 视觉问答：把图片(base64) + 文本发给多模态模型，返回文本回复（供图像自检用） */
export async function chatVision(
  cfg: ApiConfig,
  system: string,
  userText: string,
  imageB64: string,
  opts: ChatOptions = {},
): Promise<string> {
  const base = normalizeBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
  const done = log.time("api", `chatVision ${cfg.model}`);
  log.debug("api", "chatVision 请求", {
    base,
    model: cfg.model,
    apiKey: maskKey(cfg.apiKey),
    imageB64Len: imageB64.length,
    userTextLen: userText.length,
  });
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:image/png;base64,${imageB64}` } },
        ],
      },
    ],
    temperature: 0.1,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const content = await withRetry(async () => {
    const res = await tauri.http({
      method: "POST",
      url: `${base}/chat/completions`,
      headers: headersFor(cfg),
      body: JSON.stringify(body),
      timeoutSecs: opts.timeoutSecs ?? 120,
    });
    if (res.status >= 500 || res.status === 429) {
      throw { status: res.status, message: `HTTP ${res.status}` };
    }
    if (res.status >= 400) {
      const raw = b64ToUtf8(res.bodyBase64);
      throw new Error(`LLM 返回错误 ${res.status}: ${raw.slice(0, 300)}`);
    }
    const text = b64ToUtf8(res.bodyBase64);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`LLM 响应不是合法 JSON: ${text.slice(0, 300)}`);
    }
    if (!data.choices || !data.choices.length) {
      throw new Error(`LLM 返回错误: ${JSON.stringify(data).slice(0, 400)}`);
    }
    const c = data.choices[0].message?.content ?? "";
    const usage = data.usage || {};
    opts.onUsage?.(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
    return typeof c === "string" ? c : JSON.stringify(c);
  });
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
  opts: { size?: string; count?: number; referenceImageB64?: string } = {},
): Record<string, unknown> {
  const protocol = protocolForConfig(cfg, "image");
  const count = opts.count ?? 1;
  if (protocol === "minimax-image") {
    const [w, h] = (opts.size ?? "1024x1024").split("x").map((n) => parseInt(n, 10));
    return {
      model: cfg.model,
      prompt,
      aspect_ratio: sizeRatio(w, h),
      n: count,
      ...(opts.referenceImageB64 ? { image: opts.referenceImageB64 } : {}),
    };
  }
  if (protocol === "siliconflow-image") {
    return {
      model: cfg.model,
      prompt,
      image_size: opts.size ?? "1024x1024",
      batch_size: count,
      ...(opts.referenceImageB64 ? { image: opts.referenceImageB64 } : {}),
    };
  }
  return {
    model: cfg.model,
    prompt,
    ...(opts.size ? { size: opts.size } : {}),
    n: count,
    ...(opts.referenceImageB64 ? { image: opts.referenceImageB64 } : {}),
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
  opts: { referenceImageB64?: string; size?: string } = {},
): Promise<{ dataB64: string; mime: string }> {
  const tpl = resolveTemplate(cfg) ?? getTemplate("openai-image")!;
  const [w, h] = (opts.size ?? "1024x1024").split("x").map((n) => parseInt(n, 10));
  const done = log.time("api", `generateImage ${cfg.model}`);
  log.debug("api", "generateImage 请求", {
    base: normalizeBaseUrl(cfg.baseUrl),
    model: cfg.model,
    protocol: protocolForConfig(cfg, "image"),
    apiKey: maskKey(cfg.apiKey),
    size: opts.size,
    hasRef: !!opts.referenceImageB64,
    promptHead: prompt.slice(0, 120),
  });
  try {
    const r = await unifiedImage(cfg, tpl, {
      prompt,
      width: w,
      height: h,
      referenceImageB64: opts.referenceImageB64,
    });
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

export function testLlm(cfg: ApiConfig): Promise<string> {
  return chatCompletion(cfg, [
    { role: "user", content: "请只回复两个字：正常" },
  ], { maxTokens: 8, temperature: 0 }).then((r) => r.content);
}

export async function testTts(cfg: ApiConfig): Promise<void> {
  const r = await ttsSpeech(cfg, "测试", "default", 60);
  if (!r.dataB64 || r.dataB64.length < 100) {
    throw new Error("TTS 返回数据异常");
  }
}

export async function testImage(cfg: ApiConfig): Promise<void> {
  const r = await generateImage(cfg, "a simple red square on white background", { size: "512x512" });
  if (!r.dataB64 || r.dataB64.length < 500) {
    throw new Error("图像 API 返回数据异常");
  }
}
