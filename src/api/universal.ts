import type { ApiConfig, ImageReference } from "../core/types";
import { rawReferenceBase64, ReferenceImageError, referenceDataUrl } from "./providers";
import { tauri } from "../utils/tauri";
import { log } from "../utils/logger";
import { classifyError } from "../utils/errorClassifier";

/* ============ 统一能力模型 ============ */

export type Capability = "image" | "tts";
export type AdapterMode = "sync" | "async";

export interface AdapterTemplate {
  id: string;
  name: string;
  capability: Capability;
  mode: AdapterMode;
  /** 相对 base_url 的路径（以 / 开头）或绝对 URL；支持 {model} 占位 */
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  /** 请求体格式：json（默认）/ form（multipart/form-data，requestMap 键为字面量字段名） */
  contentType?: "json" | "form";
  /** 鉴权方式，默认 Bearer（Authorization: Bearer {key}） */
  auth?: { type: "bearer" } | { type: "header"; name: string };
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
    method?: "GET" | "POST";
    taskIdPath: string;
    statusPath: string;
    successWhen: string;
    failedWhen?: string;
    /** 轮询请求体（POST 轮询时使用，可用 {taskId} 占位） */
    requestBody?: Record<string, unknown>;
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
  negativePrompt?: string;
  width?: number;
  height?: number;
  references?: ImageReference[];
  referenceEncoding?: "raw-base64" | "data-url";
  count?: number;
  seed?: number;
  format?: string;
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
    const arrMatch = key.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      const arrName = arrMatch[1];
      const idx = parseInt(arrMatch[2], 10);
      if (!Array.isArray(cur[arrName])) cur[arrName] = [];
      const arr = cur[arrName] as unknown[];
      if (arr[idx] === undefined) arr[idx] = {};
      cur = arr[idx] as Record<string, unknown>;
      continue;
    }
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  const arrMatch = last.match(/^(\w+)\[(\d+)\]$/);
  if (arrMatch) {
    if (!Array.isArray(cur[arrMatch[1]])) cur[arrMatch[1]] = [];
    (cur[arrMatch[1]] as unknown[])[parseInt(arrMatch[2], 10)] = value;
  } else {
    cur[last] = value;
  }
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
  if (template.contentType === "form") {
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(template.requestMap)) {
      fields[name] = evalValue(value, vars);
    }
    return fields;
  }
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

const RESULT_KEYS = [
  "b64_json",
  "base64",
  "data",
  "audio",
  "audio_url",
  "image_url",
  "image_urls",
  "images",
  "url",
  "text",
];

/** 深度智能提取：递归查找常见结果字段（Gemini 的 inlineData.data 等深层结构也能取到） */
function smartPick(raw: unknown, depth = 0): { value: unknown; mime?: string } | undefined {
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const hit = smartPick(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of RESULT_KEYS) {
      if (key in obj) {
        const v = obj[key];
        if (Array.isArray(v)) {
          if (v.length) {
            const hit = smartPick(v[0], depth + 1);
            if (hit) return hit;
          }
        } else if (v !== undefined && v !== null && v !== "") {
          const mime =
            typeof obj.mimeType === "string"
              ? obj.mimeType
              : key === "audio" || key === "audio_url"
                ? "audio/mpeg"
                : undefined;
          return { value: v, mime };
        }
      }
    }
    if (obj.inlineData && typeof obj.inlineData === "object") {
      const id = obj.inlineData as Record<string, unknown>;
      if (typeof id.data === "string" && id.data) {
        return { value: id.data, mime: typeof id.mimeType === "string" ? id.mimeType : undefined };
      }
    }
    if (depth < 3) {
      for (const v of Object.values(obj)) {
        if (v && typeof v === "object") {
          const hit = smartPick(v, depth + 1);
          if (hit) return hit;
        }
      }
    }
    return undefined;
  }
  if (typeof raw === "string" && raw) return { value: raw };
  return undefined;
}

/** 从任意响应中提取可读错误信息（各厂商错误字段不一） */
export function smartErrorText(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  for (const key of ["status_message", "message", "msg", "error_message", "errorMsg"]) {
    if (typeof obj[key] === "string" && obj[key]) return obj[key];
  }
  if (obj.error && typeof obj.error === "object") {
    const e = obj.error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.msg === "string") return e.msg;
  }
  if (obj.base_resp && typeof obj.base_resp === "object") {
    const b = obj.base_resp as Record<string, unknown>;
    if (typeof b.status_message === "string" && b.status_message) return b.status_message;
    // MiniMax：base_resp.status_msg + status_code（如 2013 prompt 超长）
    if (typeof b.status_msg === "string" && b.status_msg) {
      const code = typeof b.status_code === "number" ? `（code ${b.status_code}）` : "";
      return `${b.status_msg}${code}`;
    }
  }
  if (obj.output && typeof obj.output === "object") {
    const o = obj.output as Record<string, unknown>;
    for (const key of ["message", "msg", "status_message"]) {
      if (typeof o[key] === "string" && o[key]) return o[key];
    }
  }
  return undefined;
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
  // 对象：深度智能提取常见字段
  if (raw && typeof raw === "object") {
    const hit = smartPick(raw);
    if (hit !== undefined && hit.value !== undefined) {
      const itemMime = hit.mime ?? mime;
      const sub = { ...template, response: { ...template.response, mime: itemMime } };
      return decodeResult(hit.value, sub, cfg);
    }
    const errMsg = smartErrorText(raw);
    throw new Error(errMsg ? `API 错误：${errMsg}` : `结果对象中未找到图片/音频字段：${JSON.stringify(raw).slice(0, 300)}`);
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

function referenceErrorFromResponse(raw: string): ReferenceImageError | undefined {
  const match = /\b(REFERENCE_UNSUPPORTED|REFERENCE_MISSING)\b/i.exec(raw);
  if (!match) return undefined;
  const code = match[1].toUpperCase() as "REFERENCE_UNSUPPORTED" | "REFERENCE_MISSING";
  let message = raw.slice(0, 300);
  try {
    message = smartErrorText(JSON.parse(raw)) ?? message;
  } catch {
    // Plain-text local adapters use the same typed code prefix.
  }
  return new ReferenceImageError(message, code);
}

const RETRY_DELAYS = [1000, 10000, 20000, 30000, 40000, 50000, 60000];

/** 构造 multipart/form-data 字符串（跨 Tauri/浏览器统一，无需真实 FormData） */
export function buildMultipartBody(
  fields: Record<string, unknown>,
): { body: string; contentType: string } {
  const boundary = `novelforge-${Math.random().toString(36).slice(2, 12)}`;
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return { body: parts.join(""), contentType: `multipart/form-data; boundary=${boundary}` };
}

function authHeaders(cfg: ApiConfig, template: AdapterTemplate): Record<string, string> {
  if (!cfg.apiKey) return {};
  const auth = template.auth;
  if (auth?.type === "header") return { [auth.name]: cfg.apiKey };
  return { Authorization: `Bearer ${cfg.apiKey}` };
}

async function postJson(
  cfg: ApiConfig,
  url: string,
  body: Record<string, unknown>,
  template: AdapterTemplate,
): Promise<{ status: number; json: unknown; raw: string }> {
  let lastErr: unknown;
  const isForm = template.contentType === "form";
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const headers: Record<string, string> = {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...authHeaders(cfg, template),
        ...(template.headers ?? {}),
      };
      let payload: string;
      if (isForm) {
        const mp = buildMultipartBody(body);
        headers["Content-Type"] = mp.contentType;
        payload = mp.body;
      } else {
        payload = JSON.stringify(body);
      }
      const res = await tauri.http({
        method: "POST",
        url,
        headers,
        body: payload,
        timeoutSecs: 300,
      });
      const raw = utf8FromB64(res.bodyBase64);
      if (res.status >= 400) {
        log.error("api", "适配器请求失败", {
          url,
          status: res.status,
          templateId: template.id,
          raw: raw.slice(0, 500),
        });
        const referenceError = referenceErrorFromResponse(raw);
        if (referenceError) throw referenceError;
      }
      if (res.status >= 500 || res.status === 429) {
        throw { status: res.status, message: `HTTP ${res.status}` };
      }
      if (res.status >= 400) {
        let errText = raw.slice(0, 300);
        try {
          const parsed = JSON.parse(raw);
          const smart = smartErrorText(parsed);
          if (smart) errText = smart;
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new Error(`API 错误 ${res.status}: ${errText}`);
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
      const cls = classifyError(e, err.status);
      if (cls === "auth" || cls === "invalid_param" || cls === "aborted" || cls === "content_moderation") {
        throw e;
      }
      if (attempt >= RETRY_DELAYS.length) {
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

async function getJson(cfg: ApiConfig, url: string, template: AdapterTemplate): Promise<unknown> {
  const res = await tauri.http({
    method: "GET",
    url,
    headers: authHeaders(cfg, template),
    timeoutSecs: 60,
  });
  if (res.status >= 400) {
    let errText = utf8FromB64(res.bodyBase64).slice(0, 200);
    try {
      const smart = smartErrorText(JSON.parse(utf8FromB64(res.bodyBase64)));
      if (smart) errText = smart;
    } catch {
      /* 非 JSON */
    }
    throw new Error(`轮询请求失败 ${res.status}: ${errText}`);
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
  // base 已含 /v1（或 /v1beta 等带后缀版本）时去掉 endpoint 的同名版本前缀（避免 /v1/v1/...）
  const versionMatch = /\/v\d+(?:alpha|beta|p\d+)?$/i.exec(b);
  if (versionMatch) {
    const versionPrefix = versionMatch[0].replace(/^\//, ""); // 如 v1 / v1beta
    if (e.startsWith(`/${versionPrefix}/`)) {
      e = e.replace(new RegExp(`^/${versionPrefix}`, "i"), "");
    }
  }
  return `${b}${e}`;
}

export async function callUnified(ctx: CallContext): Promise<UnifiedResult> {
  const { cfg, template, vars } = ctx;
  const url = joinUrl(cfg.baseUrl, template.endpoint.replace("{model}", String(vars.model ?? "")));
  const body = buildRequestBody(template, vars);

  if (template.mode === "sync") {
    if (template.rawResponse) {
      const isForm = template.contentType === "form";
      const headers: Record<string, string> = {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...authHeaders(cfg, template),
        ...(template.headers ?? {}),
      };
      let payload: string;
      if (isForm) {
        const mp = buildMultipartBody(body);
        headers["Content-Type"] = mp.contentType;
        payload = mp.body;
      } else {
        payload = JSON.stringify(body);
      }
      const res = await tauri.http({
        method: "POST",
        url,
        headers,
        body: payload,
        timeoutSecs: 300,
      });
      if (res.status >= 400) {
        const raw = utf8FromB64(res.bodyBase64);
        const referenceError = referenceErrorFromResponse(raw);
        if (referenceError) throw referenceError;
        let errText = raw.slice(0, 300);
        try {
          const smart = smartErrorText(JSON.parse(raw));
          if (smart) errText = smart;
        } catch {
          /* 非 JSON */
        }
        throw new Error(`API 错误 ${res.status}: ${errText}`);
      }
      return {
        dataB64: res.bodyBase64,
        mime: (template.response.mime ?? res.contentType.split(";")[0]) || "application/octet-stream",
      };
    }
    const { json } = await postJson(cfg, url, body, template);
    const raw = getByPath(json, template.response.path ?? "");
    if (raw !== undefined && raw !== null && raw !== "") {
      return decodeResult(raw, template, cfg);
    }
    // 配置路径未命中时，尝试深度智能提取（兼容 image_urls / inlineData 等变体响应）
    try {
      return await decodeResult(json, template, cfg);
    } catch (e) {
      const errMsg = smartErrorText(json);
      throw new Error(
        errMsg ? `API 错误：${errMsg}` : `响应中未找到结果字段「${template.response.path}」：${JSON.stringify(json).slice(0, 300)}`,
      );
    }
  }

  // async：提交 → 轮询 → 取结果
  if (!template.poll) throw new Error("异步模板缺少 poll 配置");
  const poll = template.poll;
  const { json: submitJson } = await postJson(cfg, url, body, template);
  const taskId = getByPath(submitJson, poll.taskIdPath);
  if (!taskId || typeof taskId !== "string") {
    const errMsg = smartErrorText(submitJson);
    throw new Error(
      errMsg ? `API 错误：${errMsg}` : `提交任务失败，未获取到 task_id：${JSON.stringify(submitJson).slice(0, 300)}`,
    );
  }

  const pollUrl = joinUrl(cfg.baseUrl, poll.endpoint.replace("{taskId}", taskId));

  for (let i = 0; i < poll.maxPolls; i++) {
    await new Promise((r) => setTimeout(r, poll.intervalMs));
    let statusJson: unknown;
    if (poll.method === "POST") {
      const pollBody = { ...(poll.requestBody ?? {}) } as Record<string, unknown>;
      if (poll.requestBody) {
        for (const [k, v] of Object.entries(poll.requestBody)) {
          if (v === "{taskId}") pollBody[k] = taskId;
        }
      }
      statusJson = (await postJson(cfg, pollUrl, pollBody, template)).json;
    } else {
      statusJson = await getJson(cfg, pollUrl, template);
    }
    const status = getByPath(statusJson, poll.statusPath);
    if (poll.failedWhen && String(status) === poll.failedWhen) {
      const errMsg = smartErrorText(statusJson);
      throw new Error(errMsg ? `API 错误：${errMsg}` : `任务失败：${JSON.stringify(statusJson).slice(0, 300)}`);
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
  const references = input.references ?? [];
  const rawReferences = references.map(rawReferenceBase64);
  const dataUrlReferences = references.map(referenceDataUrl);
  const encodedReferences = input.referenceEncoding === "data-url" ? dataUrlReferences : rawReferences;
  return callUnified({
    cfg,
    template,
    vars: {
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      model: cfg.model,
      refImage: encodedReferences[0],
      refImage2: encodedReferences[1],
      refImage3: encodedReferences[2],
      refImageRaw: rawReferences[0],
      refImage2Raw: rawReferences[1],
      refImage3Raw: rawReferences[2],
      refImageDataUrl: dataUrlReferences[0],
      refImage2DataUrl: dataUrlReferences[1],
      refImage3DataUrl: dataUrlReferences[2],
      count: input.count ?? 1,
      seed: input.seed,
      width: input.width,
      height: input.height,
      format: input.format,
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
