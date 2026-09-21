import type { ApiConfig, ImageReference } from "../core/types";
import { rawReferenceBase64, ReferenceImageError, referenceDataUrl, referenceRouteRejection } from "./providers";
import { tauri } from "../utils/tauri";
import { activeAbortSignal } from "./abort";
import { log } from "../utils/logger";
import { classifyError } from "../utils/errorClassifier";
import { normalizeProviderBaseUrl, customHeadersFor, joinApiPath } from "./baseUrl";

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
  /** 每句语速（0.5-2），优先于全局配置 */
  speed?: number;
  /** 每句配音情绪，优先于全局配置 */
  ttsEmotion?: string;
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
function smartErrorText(json: unknown): string | undefined {
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
  // B105（防御性）：自定义模板可能缺少 response 配置，这里按默认值处理，避免解构出的 undefined 直接抛 TypeError
  const response = template.response ?? {};
  const encoding = response.encoding ?? "base64";
  const mime = response.mime;

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
      const sub = { ...template, response: { ...response, mime: itemMime } };
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
      const res = await tauri.http({ method: "GET", url: value, timeoutSecs: 120 }, activeAbortSignal());
      // 之前不检查状态码：403/404 的错误 JSON 也会被当成"图片数据"返回（静默产出损坏文件）
      if (res.status < 200 || res.status >= 300) {
        let detail = "";
        try {
          detail = utf8FromB64(res.bodyBase64).slice(0, 200);
        } catch {
          /* 二进制响应体 */
        }
        throw new Error(`下载结果文件失败 HTTP ${res.status}${detail ? `：${detail}` : ""}`);
      }
      return { dataB64: res.bodyBase64, mime: res.contentType.split(";")[0] || "application/octet-stream" };
    }
    return { dataB64: value, mime: mime ?? "application/octet-stream" };
  }
  assertEncodedPayload(value, mime);
  return { dataB64: value, mime: mime ?? "image/png" };
}

/** 结果数据合法性校验：模型拒答/说明文字（Gemini 的 content.parts[0].text 等）常被 smartPick 当数据返回，
 * 直接在写盘后表现为损坏 .png。这里至少拦掉「非 base64 文本」与「图片缺少已知文件头」。 */
function assertEncodedPayload(value: string, mime: string | undefined): void {
  const compact = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new Error(`结果数据不是合法 base64（疑似模型返回了文本而非图片/音频）：${value.slice(0, 80)}`);
  }
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) {
    // 注意用「3 字节对齐」的前缀：base64 只有完整 3 字节组才稳定（8 字节 PNG 头 + 后续字节时
    // 第 9-12 位会变成下一组的编码，不能用 ^iVBORw0KGgo 这种跨越半组的写法）
    const magicOk =
      /^iVBORw0K/.test(compact) || // PNG（前 6 字节稳定前缀）
      /^\/9j\//.test(compact) || // JPEG
      /^R0lG/.test(compact) || // GIF
      /^UklG/.test(compact) || // WebP (RIFF)
      /^Qk/.test(compact); // BMP
    if (!magicOk) {
      throw new Error(`图片数据缺少已知文件头（疑似返回文本被当成图片）：${value.slice(0, 80)}`);
    }
  }
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

/**
 * 适配器请求重试间隔（4 档，最多 5 次请求）。
 * 旧实现 7 档（最多 8 次）与外层 images 的 3 次重试叠加，最坏一张图打出 24 个付费请求；
 * 收敛为 4 档并限制单请求退避上限 30s，配合外层任务级重试已足够覆盖服务端抖动。
 */
const RETRY_DELAYS = [1000, 5000, 15000, 30000];

/** GET 轮询失败的额外重试次数（B104）：网络抖动/429/5xx 才重试，最多 3 次 */
const GET_RETRY_COUNT = 3;

/** 退避抖动：0.7~1.3 倍，避免多个并发任务在同一时刻集体重试（thundering herd）再次打爆服务端 */
function jitterDelay(ms: number): number {
  return Math.round(ms * (0.7 + Math.random() * 0.6));
}

/**
 * 可中止的退避等待：把长等待切成 250ms 分片，isAborted 回调返回 true 时最多再等一个分片即退出，
 * 不像旧实现那样把 1~30s 的退避睡满（期间还占着限流槽位，停止任务也要等退避结束）。
 */
async function retrySleep(ms: number, isAborted?: () => boolean): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    if (isAborted?.()) throw new Error("已中止");
    const step = Math.min(250, remaining);
    await new Promise((r) => setTimeout(r, step));
    remaining -= step;
  }
  if (isAborted?.()) throw new Error("已中止");
}

/** 请求体里是否真的带了图片（data-url 或 png/jpeg/gif/webp 的 base64 magic）——只有带了图才把 413 归到「线路拒图」 */
const IMAGE_PAYLOAD_MAGIC = /data:image\/[a-z0-9.+-]+;base64,|iVBORw0KGgo|\/9j\/|R0lGOD|UklGR/;
function bodyCarriesImagePayload(body: Record<string, unknown>): boolean {
  for (const value of Object.values(body)) {
    if (typeof value !== "string" || value.length <= 1024) continue;
    if (IMAGE_PAYLOAD_MAGIC.test(value.slice(0, 64))) return true;
  }
  return false;
}

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

interface HttpRawResult {
  status: number;
  raw: string;
  bodyBase64: string;
  contentType: string;
  json?: unknown;
}

/**
 * 带重试的底层 POST 请求（B90）。
 * 原 postJson 的重试/classifyError 逻辑抽到这里，rawResponse 同步模板也复用同一套：
 * 旧实现对二进制响应裸调 tauri.http，5xx/网络错误既不重试也不分类，与 JSON 模板行为不一致。
 * options.parseJson=true 时在重试循环内解析 JSON（解析失败仍可退避重试，保持旧行为）。
 */
async function requestWithRetry(
  cfg: ApiConfig,
  url: string,
  body: Record<string, unknown>,
  template: AdapterTemplate,
  options?: { isAborted?: () => boolean; parseJson?: boolean },
): Promise<HttpRawResult> {
  let lastErr: unknown;
  const isForm = template.contentType === "form";
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const headers: Record<string, string> = {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...authHeaders(cfg, template),
        ...customHeadersFor(cfg),
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
      }, activeAbortSignal());
      // 只在需要时解码响应体：rawResponse 的成功路径可能是几 MB 的音频/图片字节，
      // 每次都转成字符串（旧 postJson 为解析 JSON 才需要）会白白构造大字符串
      const needRaw = res.status >= 400 || options?.parseJson === true;
      const raw = needRaw ? utf8FromB64(res.bodyBase64) : "";
      if (res.status >= 400) {
        log.error("api", "适配器请求失败", {
          url,
          status: res.status,
          templateId: template.id,
          raw: raw.slice(0, 500),
        });
        const referenceError = referenceErrorFromResponse(raw);
        if (referenceError) throw referenceError;
        // 线路明确拒绝带图请求（请求体上限 + 不支持图像输入）：归一成类型化错误，
        // 既不做无意义的重试/提示词改写，也不静默丢掉参考图（会让角色形象不一致）。
        const routeHint = bodyCarriesImagePayload(body) ? referenceRouteRejection(raw) : undefined;
        if (routeHint) throw new ReferenceImageError(routeHint, "REFERENCE_UNSUPPORTED");
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
        // 状态码挂到 Error 上：上层 classifyError(e, status) 双信号分类
        // （审查 400 靠文本命中，鉴权/参数靠状态码），不带 status 会退化成纯文本分类。
        const apiError = new Error(`API 错误 ${res.status}: ${errText}`);
        (apiError as { status?: number }).status = res.status;
        throw apiError;
      }
      let json: unknown;
      if (options?.parseJson) {
        try {
          json = JSON.parse(raw);
        } catch {
          // 解析失败留在重试循环内：网关偶发返回截断/半截 JSON 时仍可退避重试（保持旧 postJson 行为）
          throw new Error(`API 响应不是合法 JSON: ${raw.slice(0, 300)}`);
        }
      }
      return { status: res.status, raw, bodyBase64: res.bodyBase64, contentType: res.contentType, json };
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
      await retrySleep(jitterDelay(RETRY_DELAYS[attempt]), options?.isAborted);
    }
  }
  throw lastErr;
}

async function postJson(
  cfg: ApiConfig,
  url: string,
  body: Record<string, unknown>,
  template: AdapterTemplate,
): Promise<{ status: number; json: unknown; raw: string }> {
  const res = await requestWithRetry(cfg, url, body, template, { parseJson: true });
  return { status: res.status, json: res.json, raw: res.raw };
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

/**
 * GET（异步任务轮询）请求（B104）。
 * 旧实现单次裸调，一次网络抖动就让整个异步任务轮询中断、任务白提交；
 * 这里仅对网络层错误/429/5xx 做有限退避重试（最多 GET_RETRY_COUNT 次），
 * 4xx（除 429）与响应解析失败属于永久错误，立即抛出不做无谓重试。
 */
async function getJson(cfg: ApiConfig, url: string, template: AdapterTemplate, isAborted?: () => boolean): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= GET_RETRY_COUNT; attempt++) {
    try {
      const res = await tauri.http({
        method: "GET",
        url,
        headers: { ...authHeaders(cfg, template), ...customHeadersFor(cfg) },
        timeoutSecs: 60,
      }, activeAbortSignal());
      const raw = utf8FromB64(res.bodyBase64);
      if (res.status >= 500 || res.status === 429) {
        throw { status: res.status, message: `HTTP ${res.status}` };
      }
      if (res.status >= 400) {
        let errText = raw.slice(0, 200);
        try {
          const smart = smartErrorText(JSON.parse(raw));
          if (smart) errText = smart;
        } catch {
          /* 非 JSON */
        }
        const apiError = new Error(`轮询请求失败 ${res.status}: ${errText}`);
        (apiError as { status?: number }).status = res.status;
        throw apiError;
      }
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`轮询响应不是合法 JSON: ${raw.slice(0, 200)}`);
      }
    } catch (e) {
      lastErr = e;
      const err = e as { status?: number; message?: string };
      const cls = classifyError(e, err.status);
      if (cls !== "network" && cls !== "rate_limit") throw e;
      if (attempt >= GET_RETRY_COUNT) throw e;
      const delay = jitterDelay(RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]);
      log.warn("api", `轮询请求失败，${(delay / 1000).toFixed(1)}s 后重试`, {
        url,
        status: err.status ?? 0,
        message: err.message?.slice(0, 200),
      });
      await retrySleep(delay, isAborted);
    }
  }
  throw lastErr;
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
  // base 已含版本段（/v1、/v4、/v1beta…）时丢掉 endpoint 自带的首个版本段：
  // 既避免 /v1/v1，也避免 zhipu 这类 base=/paas/v4 + endpoint=/v1/... 的双版本 404
  if (/\/v\d+(?:alpha|beta|p\d+)?$/i.test(b) && /^\/v\d+(?:alpha|beta|p\d+)?\//i.test(e)) {
    e = e.replace(/^\/v\d+(?:alpha|beta|p\d+)?/i, "");
  }
  // joinApiPath：base 带 query（?key=...）时接口路径必须拼进 pathname，不能落进 query（B109）
  return joinApiPath(b, e);
}

/**
 * B102：是否为官方 OpenAI 图像通道：base_url 命中 api.openai.com，或模型名为 GPT-image/DALL·E 系列。
 * 官方 /v1/images/generations 不接受 response_format（会 400 unknown_parameter），
 * 也不支持在 generations 里携带参考图（参考图必须走 /v1/images/edits，本版本未实现）。
 */
export function isOfficialOpenAIImage(cfg: ApiConfig): boolean {
  const base = (cfg.baseUrl || "").trim().toLowerCase().replace(/^https?:\/\//, "");
  // 只认官方域名：中转站常代理 gpt-image 模型但仍支持 b64_json/参考图字段（实测 relay 413 场景），
  // 仅凭模型名判断会把中转线路误判成官方通道、错误地剔除 response_format 或提前拒绝参考图
  return /(^|\.)api\.openai\.com([:/]|$)/.test(base);
}

async function callUnified(ctx: CallContext): Promise<UnifiedResult> {
  const { cfg, template, vars } = ctx;
  // 与文本/视觉同口径地补协议/应用 pathPrefix；但通用适配器端点自带版本段，不自动补 /v1
  const base = normalizeProviderBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
  const url = joinUrl(base, template.endpoint.replace("{model}", String(vars.model ?? "")));
  const body = buildRequestBody(template, vars);
  // B102：官方 OpenAI 图像通道不支持 response_format 字段，带上会 400 unknown_parameter，组装后剔除；
  // 中转站/其它线路仍需 b64_json 指定返回格式，保持原样。
  if (template.capability === "image" && isOfficialOpenAIImage(cfg) && "response_format" in body) {
    delete body.response_format;
  }

  if (template.mode === "sync") {
    if (template.rawResponse) {
      // B90：二进制响应同样走 requestWithRetry（5xx/429/网络错误退避重试 + 类型化错误分类），
      // 不再裸调 tauri.http 导致探测/测试连接一遇抖动就失败
      const res = await requestWithRetry(cfg, url, body, template);
      return {
        dataB64: res.bodyBase64,
        // 优先真实响应的 Content-Type：模板写死的 mime（如 audio/mpeg）会把 ogg/opus/wav 结果存成 .mp3
        mime: (res.contentType?.split(";")[0] || template.response?.mime) || "application/octet-stream",
      };
    }
    const { json } = await postJson(cfg, url, body, template);
    const raw = getByPath(json, template.response?.path ?? "");
    if (raw !== undefined && raw !== null && raw !== "") {
      return decodeResult(raw, template, cfg);
    }
    // 配置路径未命中时，尝试深度智能提取（兼容 image_urls / inlineData 等变体响应）
    try {
      return await decodeResult(json, template, cfg);
    } catch (e) {
      const errMsg = smartErrorText(json);
      throw new Error(
        errMsg ? `API 错误：${errMsg}` : `响应中未找到结果字段「${template.response?.path ?? ""}」：${JSON.stringify(json).slice(0, 300)}`,
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

  const pollUrl = joinUrl(base, poll.endpoint.replace("{taskId}", taskId));

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
  // B102：官方 GPT-image/DALL·E 通道无法在 /v1/images/generations 携带参考图（需 /v1/images/edits）。
  // 提前抛类型化错误给出可行动提示，避免用户只看到官方 400 unknown_parameter/请求体超限后不知所措。
  if (references.length > 0 && isOfficialOpenAIImage(cfg)) {
    throw new ReferenceImageError(
      "官方 GPT-image/DALL·E 的参考图需走 /v1/images/edits（本版本暂不支持），请改用支持 reference 的中转线路，或换用支持图生图的图像模型",
      "REFERENCE_UNSUPPORTED",
    );
  }
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
  const extra = (cfg.extra ?? {}) as Record<string, unknown>;
  return callUnified({
    cfg,
    template,
    vars: {
      text: input.text,
      model: cfg.model,
      voice: input.voice,
      format: (typeof extra.ttsFormat === "string" && extra.ttsFormat) ? extra.ttsFormat : input.format ?? "mp3",
      // 每句标注优先，其次全局配置；缺省语速 1.1（官方默认 1.0 对中文朗读偏慢、像念字）
      emotion: typeof input.ttsEmotion === "string" && input.ttsEmotion
        ? input.ttsEmotion
        : typeof extra.emotion === "string" && extra.emotion ? extra.emotion : undefined,
      speed: typeof input.speed === "number" ? input.speed : typeof extra.speed === "number" ? extra.speed : 1.1,
      vol: typeof extra.vol === "number" ? extra.vol : 1,
      pitch: typeof extra.pitch === "number" ? extra.pitch : 0,
    },
  });
}
