import type { ApiConfig } from "../core/types";

/**
 * 是否含版本段（/v1、/v1beta、/v4…）。
 * B101：旧判定 `/\/v\d+$/` + `/\/v\d+\//` 认不出「版本段不在末尾」的 base
 * （如 https://host/v1beta/openai），会再追加 /v1 拼出错误 URL。这里只看 pathname 前缀匹配。
 */
function hasVersionSegment(path: string): boolean {
  return /\/v\d/i.test(path);
}

/**
 * 在 base_url 上追加接口路径（B109）。
 * base 带 query（如 https://host/api?key=xxx）时不能直接字符串拼接，否则 `...?key=xxx/v1/...`
 * 会把接口路径拼进 query 里。用 URL 重组：pathname 拼接口路径，query 保持在末尾。
 */
export function joinApiPath(base: string, endpoint: string): string {
  const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  try {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`;
    return url.toString();
  } catch {
    // base 本身不是合法 URL（调用方会先补协议）：退回字符串拼接，行为与旧版一致
    return `${base.replace(/\/+$/, "")}${suffix}`;
  }
}

/**
 * 归一化 base_url：补协议、去尾斜杠、按需应用 pathPrefix 或补 /v1。
 * 移到独立模块：通用适配器路径（图像/配音）与 openai 兼容路径都必须应用同一套规则，
 * 否则 pathPrefix 只对文本/视觉生效（图像/配音静默忽略）。
 */
export function normalizeBaseUrl(baseUrl: string, pathPrefix?: string): string {
  return normalizeWithVersion(baseUrl, pathPrefix, true);
}

/**
 * 通用适配器 base_url：只补协议、去尾斜杠、应用显式 pathPrefix。
 * 不自动补 /v1 —— 端点模板自带版本段（Gemini /v1beta、zhipu /v4、stability /v1…），
 * 补 /v1 会与模板拼出错误 URL（Gemini 会变成 /v1/models/... 直接 404）。
 */
export function normalizeProviderBaseUrl(baseUrl: string, pathPrefix?: string): string {
  return normalizeWithVersion(baseUrl, pathPrefix, false);
}

function normalizeWithVersion(baseUrl: string, pathPrefix: string | undefined, appendV1: boolean): string {
  const raw = (baseUrl || "").trim();
  if (!raw) throw new Error("base_url 为空");
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error(`base_url 不是合法 URL：${baseUrl}`);
  }
  // pathPrefix / 版本段只在 pathname 上处理，query 原样保留在末尾
  let path = url.pathname.replace(/\/+$/, "");
  if (pathPrefix) {
    path = `${path}/${pathPrefix.replace(/^\/+|\/+$/g, "")}`;
  } else if (appendV1 && !hasVersionSegment(path)) {
    path = `${path}/v1`;
  }
  url.pathname = path || "/";
  return url.toString().replace(/\/$/, "");
}

/** 用户自定义请求头（cfg.extra.headers），供需要额外请求头的通道使用（如 opencode Go） */
export function customHeadersFor(cfg: ApiConfig): Record<string, string> {
  const raw = cfg.extra?.headers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim()) headers[key] = value.trim();
  }
  return headers;
}
