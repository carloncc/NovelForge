/**
 * GPT-Image 系的「编辑模式」通道（表情差分专用，2026-09-21）：
 * - 走官方 `POST /v1/images/edits`（multipart/form-data）：把现有立绘当原图，只改表情、其余保持不变。
 * - 通过 `tauri.http` 的 bodyBase64 直发二进制 multipart，Tauri 与网页版两条传输通用（无需 Rust 改动）。
 * - 仅用于 GPT Image 模型（`gpt-image-*` / `chatgpt-image-*`）；其他线路 `supportsImageEdits` 返回 false，
 *   调用方继续走原来的「参考图生图」路径；本通道失败也由调用方回退旧路径，不影响出图。
 */
import type { ApiConfig } from "../core/types";
import { headersFor, runWithImageLimit } from "./openaiCompatible";
import { activeAbortSignal } from "./abort";
import { joinApiPath, normalizeBaseUrl } from "./baseUrl";
import { tauri } from "../utils/tauri";
import { b64decode, b64encode } from "../utils/base64";

/** 是否支持官方编辑端点（GPT Image 家族）：与官方 SDK 的模型清单对齐 */
export function supportsImageEdits(model: string | undefined): boolean {
  const m = (model ?? "").trim().toLowerCase();
  return /^(gpt-image|chatgpt-image)/.test(m);
}

export interface EditImageVariantRequest {
  prompt: string;
  /** 原图（现有立绘，base64，不含 data URL 前缀） */
  imageB64: string;
  imageMime: string;
  width: number;
  height: number;
  outputFormat?: "png" | "jpeg" | "webp";
}

const CRLF = "\r\n";

/** multipart name/filename 转义（1297）：与 universal.escapeDispositionName 同口径，避免引号/CRLF 注入 part。 */
function escapeDispositionName(name: string): string {
  return String(name ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, "_")
    .slice(0, 200);
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function makeBoundary(): string {
  return `----novelforge${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 组装 multipart/form-data 请求体（导出供单测）：普通字段 + 一个 image 文件 part */
export function buildEditMultipart(
  boundary: string,
  fields: Record<string, string>,
  file: { name: string; filename: string; mime: string; bytes: Uint8Array },
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [rawName, value] of Object.entries(fields)) {
    const name = escapeDispositionName(rawName);
    parts.push(textBytes(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
  }
  const safeFileName = escapeDispositionName(file.name);
  const safeFilename = escapeDispositionName(file.filename);
  parts.push(
    textBytes(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${safeFileName}"; filename="${safeFilename}"${CRLF}Content-Type: ${file.mime}${CRLF}${CRLF}`,
    ),
  );
  parts.push(file.bytes);
  parts.push(textBytes(`${CRLF}--${boundary}--${CRLF}`));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** 表情差分编辑：以现有立绘为原图，只改表情；返回编辑后的图片 base64 与 mime */
export async function editImageVariant(
  cfg: ApiConfig,
  req: EditImageVariantRequest,
  opts?: { signal?: AbortSignal },
): Promise<{ dataB64: string; mime: string }> {
  const base = normalizeBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
  const url = joinApiPath(base, "/images/edits");
  const format = req.outputFormat ?? "png";
  const boundary = makeBoundary();
  const body = buildEditMultipart(
    boundary,
    {
      model: cfg.model,
      prompt: req.prompt,
      size: `${req.width}x${req.height}`,
      n: "1",
      output_format: format,
    },
    { name: "image", filename: `source.${format === "jpeg" ? "jpg" : format}`, mime: req.imageMime, bytes: b64decode(req.imageB64) },
  );
  const res = await runWithImageLimit(cfg, () =>
    tauri.http({
      method: "POST",
      url,
      headers: { ...headersFor(cfg), "Content-Type": `multipart/form-data; boundary=${boundary}` },
      bodyBase64: b64encode(body),
      timeoutSecs: 300,
    }, opts?.signal ?? activeAbortSignal()),
  );
  const text = new TextDecoder().decode(b64decode(res.bodyBase64));
  let parsed: { data?: { b64_json?: string }[]; error?: { message?: string } } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* 非 JSON（网关 HTML 错误页） */
  }
  if (res.status < 200 || res.status >= 300) {
    const message = parsed.error?.message ?? text.slice(0, 200) ?? "";
    const error = new Error(`编辑端点返回 ${res.status}${message ? `：${message}` : ""}`);
    (error as { status?: number }).status = res.status;
    throw error;
  }
  const b64 = parsed.data?.[0]?.b64_json;
  if (!b64) throw new Error(`编辑端点未返回图片（响应 ${text.slice(0, 160)}）`);
  const mime = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  return { dataB64: b64, mime };
}
