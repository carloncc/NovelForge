import { tauri } from "../utils/tauri";
import type { ApiConfig } from "../core/types";

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
): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  const base = normalizeBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
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
    const content = data.choices[0].message?.content ?? "";
    const usage = data.usage || {};
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    opts.onUsage?.(promptTokens, completionTokens);
    return { content, promptTokens, completionTokens };
  });
}

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* fallthrough */
    }
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`无法解析 JSON 输出: ${cleaned.slice(0, 500)}`);
  }
}

export async function chatJson<T>(
  cfg: ApiConfig,
  system: string,
  user: string,
  opts: ChatOptions = {},
): Promise<T> {
  const { content } = await chatCompletion(cfg, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { ...opts, json: true });
  return extractJson(content) as T;
}
export interface ImageResult {
  fileName: string;
  dataB64: string;
}

export async function generateImage(
  cfg: ApiConfig,
  prompt: string,
  opts: { referenceImageB64?: string; size?: string } = {},
): Promise<{ dataB64: string; mime: string }> {
  const base = normalizeBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
  const body: Record<string, unknown> = {
    model: cfg.model,
    prompt,
    n: 1,
    size: opts.size ?? "1024x1024",
    response_format: "b64_json",
  };
  if (opts.referenceImageB64) {
    body.image = opts.referenceImageB64;
  }
  const extraBody = cfg.extra?.imageBody as Record<string, unknown> | undefined;
  if (extraBody) {
    for (const [k, v] of Object.entries(extraBody)) {
      if (body[k] === undefined) body[k] = v;
    }
  }

  return withRetry(async () => {
    const res = await tauri.http({
      method: "POST",
      url: `${base}/images/generations`,
      headers: headersFor(cfg),
      body: JSON.stringify(body),
      timeoutSecs: 300,
    });
    if (res.status >= 500 || res.status === 429) {
      throw { status: res.status, message: `HTTP ${res.status}` };
    }
    if (res.status >= 400) {
      const raw = b64ToUtf8(res.bodyBase64);
      throw new Error(`图像 API 错误 ${res.status}: ${raw.slice(0, 300)}`);
    }

    const text = b64ToUtf8(res.bodyBase64);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`图像 API 响应不是合法 JSON: ${text.slice(0, 300)}`);
    }

  const pick = (d: any): string | undefined => {
    if (d?.data?.length) {
      const first = d.data[0];
      if (first?.b64_json) return first.b64_json;
      if (first?.url) return first.url;
    }
    if (d?.images?.length) {
      const first = d.images[0];
      if (first?.b64_json) return first.b64_json;
      if (first?.url) return first.url;
      if (typeof first === "string") return first;
    }
    if (typeof d?.b64_json === "string") return d.b64_json;
    if (typeof d?.url === "string") return d.url;
    return undefined;
  };

  const picked = pick(data);
  if (!picked) {
    throw new Error(`图像 API 未返回图片: ${JSON.stringify(data).slice(0, 400)}`);
  }
  if (picked.startsWith("http")) {
    const img = await tauri.http({
      method: "GET",
      url: picked,
      timeoutSecs: 120,
    });
    return { dataB64: img.bodyBase64, mime: img.contentType.split(";")[0] || "image/png" };
  }
  return { dataB64: picked, mime: "image/png" };
  });
}

export async function ttsSpeech(
  cfg: ApiConfig,
  text: string,
  voice: string,
  timeoutSecs = 120,
): Promise<{ dataB64: string; mime: string }> {
  const base = normalizeBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
  const res = await tauri.http({
    method: "POST",
    url: `${base}/audio/speech`,
    headers: headersFor(cfg),
    body: JSON.stringify({ model: cfg.model, input: text, voice, response_format: "mp3" }),
    timeoutSecs,
  });
  return { dataB64: res.bodyBase64, mime: res.contentType.split(";")[0] || "audio/mpeg" };
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
