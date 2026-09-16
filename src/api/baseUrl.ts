import type { ApiConfig } from "../core/types";

/**
 * 归一化 base_url：补协议、去尾斜杠、按需应用 pathPrefix 或补 /v1。
 * 移到独立模块：通用适配器路径（图像/配音）与 openai 兼容路径都必须应用同一套规则，
 * 否则 pathPrefix 只对文本/视觉生效（图像/配音静默忽略）。
 */
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

/**
 * 通用适配器 base_url：只补协议、去尾斜杠、应用显式 pathPrefix。
 * 不自动补 /v1 —— 端点模板自带版本段（Gemini /v1beta、zhipu /v4、stability /v1…），
 * 补 /v1 会与模板拼出错误 URL（Gemini 会变成 /v1/models/... 直接 404）。
 */
export function normalizeProviderBaseUrl(baseUrl: string, pathPrefix?: string): string {
  let b = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!b) throw new Error("base_url 为空");
  if (!b.startsWith("http")) b = "http://" + b;
  if (pathPrefix) b = b.replace(/\/+$/, "") + "/" + pathPrefix.replace(/^\/+|\/+$/g, "");
  return b;
}
