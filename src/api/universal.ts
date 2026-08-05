import type { ApiConfig } from "../core/types";
import { tauri } from "../utils/tauri";

/* ============ 统一能力模型 ============ */

export type Capability = "image" | "tts";
export type AdapterMode = "sync" | "async";

export interface AdapterTemplate {
  id: string;
  name: string;
  capability: Capability;
  mode: AdapterMode;
  /** 相对 base_url 的路径（以 / 开头）或绝对 URL */
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  /** 请求体构造：字段 JSON 路径 → 值模板 */
  requestMap: Record<string, TemplateValue>;
  response: {
    /** 结果提取路径（点号，如 data.image_urls / data.audio / data[0].b64_json）；rawResponse 时可为空 */
    path?: string;
    /** base64 / hex / none（none 视为 URL 或原样 base64 字符串） */
    encoding?: "base64" | "hex" | "none";
    mime?: string;
  };
  poll?: {
    /** 轮询端点，{taskId} 占位 */
    endpoint: string;
    taskIdPath: string;
    statusPath: string;
    successWhen: string;
    failedWhen?: string;
    /** 结果提取路径（数组或对象） */
    resultPath: string;
    resultItemPath?: string;
    intervalMs: number;
    maxPolls: number;
  };
  /** 可用音色列表（TTS 模板），自动并入音色库 */
  voices?: string[];
  /** 响应直接是二进制内容（如 OpenAI TTS 的原始音频），不解析 JSON */
  rawResponse?: boolean;
  description?: string;
}

export type TemplateValue = string | { value: unknown } | { ref: string };

export interface UnifiedImageInput {
  prompt: string;
  width?: number;
  height?: number;
  referenceImageB64?: string;
  count?: number;
}

export interface UnifiedTtsInput {
  text: string;
  voice: string;
  format?: "mp3" | "ogg" | "wav" | "opus";
}

export interface UnifiedResult {
  dataB64: string;
  mime: string;
}

/* ============ JSON Path 工具 ============ */

export function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      const arr = (cur as Record<string, unknown>)?.[arrMatch[1]];
      cur = Array.isArray(arr) ? arr[parseInt(arrMatch[2], 10)] : undefined;
    } else if (Array.isArray(cur) && /^\d+$/.test(part)) {
      cur = cur[parseInt(part, 10)];
    } else {
      cur = (cur as Record<string, unknown>)?.[part];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/* ============ 尺寸转换 ============ */

export function sizeRatio(width?: number, height?: number): string {
  if (!width || !height) return "1:1";
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

export function sizeString(width?: number, height?: number): string {
  if (!width || !height) return "1024*1024";
  return `${width}*${height}`;
}

export function sizeOpenAI(width?: number, height?: number): string {
  if (!width || !height) return "1024x1024";
  return `${width}x${height}`;
}

function gcd(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

/* ============ 模板求值 ============ */

function evalValue(
  value: TemplateValue,
  vars: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$")) return vars[value.slice(1)];
    return value;
  }
  if ("value" in value) return value.value;
  if ("ref" in value) return vars[value.ref];
  return undefined;
}

export function buildRequestBody(
  template: AdapterTemplate,
  vars: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(template.requestMap)) {
    setByPath(body, path, evalValue(value, vars));
  }
  return body;
}

/* ============ 结果解码 ============ */

function hexToBase64(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function decodeResult(
  raw: unknown,
  template: AdapterTemplate,
  cfg: ApiConfig,
): Promise<UnifiedResult> {
  const encoding = template.response.encoding ?? "base64";
  const mime = template.response.mime;

  // 数组：取第一项递归
  if (Array.isArray(raw)) {
    if (!raw.length) throw new Error("结果数组为空");
    return decodeResult(raw[0], template, cfg);
  }
  // 对象：智能提取常见字段
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const candidate =
      obj.b64_json ?? obj.url ?? obj.audio ?? obj.audio_url ??
      (Array.isArray(obj.image_urls) ? obj.image_urls[0] : undefined) ??
      (Array.isArray(obj.images) ? obj.images[0] : undefined);
    if (candidate !== undefined) {
      return decodeResult(candidate, template, cfg);
    }
    throw new Error(`结果对象中未找到图片/音频字段：${JSON.stringify(obj).slice(0, 300)}`);
  }

  const value = String(raw);
  if (encoding === "hex") {
    return { dataB64: hexToBase64(value), mime: mime ?? "audio/mpeg" };
  }
  if (encoding === "none" || /^https?:\/\//i.test(value)) {
    if (/^https?:\/\//i.test(value)) {
      const res = await tauri.http({ method: "GET", url: value, timeoutSecs: 120 });
      return { dataB64: res.bodyBase64, mime: res.contentType.split(";")[0] || "application/octet-stream" };
    }
    return { dataB64: value, mime: mime ?? "application/octet-stream" };
  }
  return { dataB64: value, mime: mime ?? "image/png" };
}

/* ============ HTTP 请求（带重试） ============ */

function isRetryable(status: number, text: string): boolean {
  if (status >= 500 || status === 429) return true;
  return /timeout|timed out|network|socket|connect|ECONN|ETIMEDOUT|fetch failed/i.test(text);
}

const RETRY_DELAYS = [800, 2500];

async function postJson(
  cfg: ApiConfig,
  url: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> | undefined,
): Promise<{ status: number; json: unknown; raw: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const res = await tauri.http({
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...(extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        timeoutSecs: 300,
      });
      const raw = utf8FromB64(res.bodyBase64);
      if (res.status >= 500 || res.status === 429) {
        throw { status: res.status, message: `HTTP ${res.status}` };
      }
      if (res.status >= 400) {
        throw new Error(`API 错误 ${res.status}: ${raw.slice(0, 300)}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`API 响应不是合法 JSON: ${raw.slice(0, 300)}`);
      }
      return { status: res.status, json, raw };
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

export function utf8FromB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return bin;
  }
}

async function getJson(cfg: ApiConfig, url: string): Promise<unknown> {
  const res = await tauri.http({
    method: "GET",
    url,
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    timeoutSecs: 60,
  });
  if (res.status >= 400) {
    throw new Error(`轮询请求失败 ${res.status}: ${utf8FromB64(res.bodyBase64).slice(0, 200)}`);
  }
  return JSON.parse(utf8FromB64(res.bodyBase64));
}

/* ============ 通用调用入口 ============ */

export interface CallContext {
  cfg: ApiConfig;
  template: AdapterTemplate;
  vars: Record<string, unknown>;
}

export function joinUrl(base: string, endpoint: string): string {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  let b = (base || "").trim().replace(/\/+$/, "");
  let e = endpoint;
  // base 已含 /v1 时去掉 endpoint 的 /v1 前缀（避免 /v1/v1/...）
  if (/\/v\d+$/i.test(b) && e.startsWith("/v1/")) {
    e = e.replace(/^\/v1/, "");
  }
  return `${b}${e}`;
}

export async function callUnified(ctx: CallContext): Promise<UnifiedResult> {
  const { cfg, template, vars } = ctx;
  const url = joinUrl(cfg.baseUrl, template.endpoint);
  const body = buildRequestBody(template, vars);

  if (template.mode === "sync") {
    if (template.rawResponse) {
      const res = await tauri.http({
        method: "POST",
        url,
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
          ...(template.headers ?? {}),
        },
        body: JSON.stringify(body),
        timeoutSecs: 300,
      });
      if (res.status >= 400) {
        throw new Error(`API 错误 ${res.status}: ${utf8FromB64(res.bodyBase64).slice(0, 300)}`);
      }
      return {
        dataB64: res.bodyBase64,
        mime: (template.response.mime ?? res.contentType.split(";")[0]) || "application/octet-stream",
      };
    }
    const { json } = await postJson(cfg, url, body, template.headers);
    const raw = getByPath(json, template.response.path ?? "");
    if (raw === undefined || raw === null || raw === "") {
      throw new Error(`响应中未找到结果字段「${template.response.path}」：${JSON.stringify(json).slice(0, 300)}`);
    }
    return decodeResult(raw, template, cfg);
  }

  // async：提交 → 轮询 → 取结果
  if (!template.poll) throw new Error("异步模板缺少 poll 配置");
  const poll = template.poll;
  const { json: submitJson } = await postJson(cfg, url, body, template.headers);
  const taskId = getByPath(submitJson, poll.taskIdPath);
  if (!taskId || typeof taskId !== "string") {
    throw new Error(`提交任务失败，未获取到 task_id：${JSON.stringify(submitJson).slice(0, 300)}`);
  }

  const pollUrl = joinUrl(cfg.baseUrl, poll.endpoint.replace("{taskId}", taskId));

  for (let i = 0; i < poll.maxPolls; i++) {
    await new Promise((r) => setTimeout(r, poll.intervalMs));
    const statusJson = await getJson(cfg, pollUrl);
    const status = getByPath(statusJson, poll.statusPath);
    if (poll.failedWhen && String(status) === poll.failedWhen) {
      throw new Error(`任务失败：${JSON.stringify(statusJson).slice(0, 300)}`);
    }
    if (String(status) === poll.successWhen) {
      const results = getByPath(statusJson, poll.resultPath);
      let picked: unknown;
      if (Array.isArray(results)) {
        picked = results[0];
      } else if (results && typeof results === "object") {
        picked = results;
      }
      if (picked === undefined || picked === null) {
        throw new Error(`任务成功但结果为空：${JSON.stringify(statusJson).slice(0, 300)}`);
      }
      if (poll.resultItemPath) {
        const item = getByPath(picked, poll.resultItemPath);
        if (item === undefined) {
          throw new Error(`结果中缺少字段「${poll.resultItemPath}」：${JSON.stringify(picked).slice(0, 300)}`);
        }
        return decodeResult(item, template, cfg);
      }
      if (typeof picked === "object") {
        // 尝试常见字段：url / b64_json / audio
        const urlVal = getByPath(picked, "url") ?? getByPath(picked, "b64_json") ?? getByPath(picked, "audio");
        if (urlVal !== undefined) return decodeResult(urlVal, template, cfg);
      }
      return decodeResult(picked, template, cfg);
    }
  }
  throw new Error(`任务轮询超时（${poll.maxPolls} 次）`);
}

/* ============ 高层便捷函数 ============ */

export async function unifiedImage(
  cfg: ApiConfig,
  template: AdapterTemplate,
  input: UnifiedImageInput,
): Promise<UnifiedResult> {
  return callUnified({
    cfg,
    template,
    vars: {
      prompt: input.prompt,
      model: cfg.model,
      refImage: input.referenceImageB64,
      count: input.count ?? 1,
      sizeRatio: sizeRatio(input.width, input.height),
      sizeString: sizeString(input.width, input.height),
      sizeOpenAI: sizeOpenAI(input.width, input.height),
    },
  });
}

export async function unifiedTts(
  cfg: ApiConfig,
  template: AdapterTemplate,
  input: UnifiedTtsInput,
): Promise<UnifiedResult> {
  return callUnified({
    cfg,
    template,
    vars: {
      text: input.text,
      model: cfg.model,
      voice: input.voice,
      format: input.format ?? "mp3",
    },
  });
}
