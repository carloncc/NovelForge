/**
 * GPT-Image 系的「编辑模式」通道（表情差分 / 图片小说分镜，2026-09-21）：
 * - 走官方 `POST /v1/images/edits`（multipart/form-data）：把已有图片当输入，按提示词产出新图。
 * - 通过 `tauri.http` 的 bodyBase64 直发二进制 multipart，Tauri 与网页版两条传输通用（无需 Rust 改动）。
 * - 仅用于 GPT Image 模型（`gpt-image-*` / `chatgpt-image-*`）；其他线路 `supportsImageEdits` 返回 false，
 *   调用方继续走原来的「参考图生图」路径；本通道失败也由调用方回退旧路径，不影响出图。
 *
 * 官方依据（图片小说分镜的人物一致性两步法，见下方 editImageWithReferences 注释）：
 * https://developers.openai.com/api/reference/resources/images/methods/edit
 *   —— `image` 参数「The image(s) to edit. Must be a supported image file or an array of images…
 *      You can provide up to 16 images」；curl 多图示例用重复的 `image[]` 字段
 *      （`-F "image[]=@a.png" -F "image[]=@b.png"`），单图示例用 `image`。
 *   故本实现：1 张 → `image`；多张 → 重复 `image[]`（两种写法都是官方文档里的形式）。
 */
import type { ApiConfig, ImageReference } from "../core/types";
import { headersFor, runWithImageLimit } from "./openaiCompatible";
import { rawReferenceBase64 } from "./providers";
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

/** 组装 multipart/form-data 请求体（导出供单测）：普通字段 + 若干图片文件 part。
 *  字段名：调用方显式给了 `name` 就用它；否则单图 `image`、多图重复 `image[]`
 *  （官方 curl 示例的两种写法，见文件头注释）。 */
export function buildEditMultipartFiles(
  boundary: string,
  fields: Record<string, string>,
  files: { name?: string; filename: string; mime: string; bytes: Uint8Array }[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  const pushField = (rawName: string, value: string): void => {
    const name = escapeDispositionName(rawName);
    parts.push(textBytes(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
  };
  for (const [rawName, value] of Object.entries(fields)) pushField(rawName, value);
  for (const file of files) {
    const safeFileName = escapeDispositionName(file.name ?? (files.length > 1 ? "image[]" : "image"));
    const safeFilename = escapeDispositionName(file.filename);
    parts.push(
      textBytes(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${safeFileName}"; filename="${safeFilename}"${CRLF}Content-Type: ${file.mime}${CRLF}${CRLF}`,
      ),
    );
    parts.push(file.bytes);
    parts.push(textBytes(CRLF));
  }
  parts.push(textBytes(`--${boundary}--${CRLF}`));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** 单图版（保持既有调用方/单测契约不变） */
export function buildEditMultipart(
  boundary: string,
  fields: Record<string, string>,
  file: { name: string; filename: string; mime: string; bytes: Uint8Array },
): Uint8Array {
  return buildEditMultipartFiles(boundary, fields, [{ name: file.name, filename: file.filename, mime: file.mime, bytes: file.bytes }]);
}

async function postEditMultipart(
  cfg: ApiConfig,
  boundary: string,
  body: Uint8Array,
  mime: string,
  signal?: AbortSignal,
): Promise<{ dataB64: string; mime: string }> {
  const base = normalizeBaseUrl(cfg.baseUrl, (cfg.extra?.pathPrefix as string) || undefined);
  const url = joinApiPath(base, "/images/edits");
  const res = await runWithImageLimit(cfg, () =>
    tauri.http({
      method: "POST",
      url,
      headers: { ...headersFor(cfg), "Content-Type": `multipart/form-data; boundary=${boundary}` },
      bodyBase64: b64encode(body),
      timeoutSecs: 300,
    }, signal ?? activeAbortSignal()),
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
  return { dataB64: b64, mime };
}

function outputMimeFor(format: "png" | "jpeg" | "webp"): string {
  return format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}

/** 表情差分编辑：以现有立绘为原图，只改表情；返回编辑后的图片 base64 与 mime */
export async function editImageVariant(
  cfg: ApiConfig,
  req: EditImageVariantRequest,
  opts?: { signal?: AbortSignal },
): Promise<{ dataB64: string; mime: string }> {
  const format = req.outputFormat ?? "png";
  const boundary = makeBoundary();
  const body = buildEditMultipartFiles(
    boundary,
    {
      model: cfg.model,
      prompt: req.prompt,
      size: `${req.width}x${req.height}`,
      n: "1",
      output_format: format,
    },
    [{ name: "image", filename: `source.${format === "jpeg" ? "jpg" : format}`, mime: req.imageMime, bytes: b64decode(req.imageB64) }],
  );
  const out = await postEditMultipart(cfg, boundary, body, outputMimeFor(format), opts?.signal);
  return { dataB64: out.dataB64, mime: out.mime };
}

/** 官方图片小说一致性两步法的输入上限（远低于 16，够覆盖同框角色数；超出的角色只能靠提示词锁定） */
const MAX_EDIT_REFERENCE_IMAGES = 3;

/**
 * 带参考图的编辑（图片小说分镜专用）：
 * 把已解析好的 identity 参考图作为 `image` / `image[]` 输入送进 /images/edits，按提示词产出**新场景**画面。
 *
 * 官方依据（GPT Image 提示指南「Keep a character consistent」两步法）：
 * ① 先用 images.generate 为每个角色生成一张可复用的角色参考图；
 * ② 之后每张插画用 images.edit 把该参考图作为输入，并在提示词里重复角色固定外貌描述
 *    （"Repeat the appearance constraints"、"Same facial features, proportions, and color palette"、
 *      "Do not redesign the character"、"No text"）。
 * 参考：https://developers.openai.com/api/docs/guides/image-prompting
 *      https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
 *      （"Children's Book Art with Character Consistency (multi-image workflow)"：`images.edit(image=[参考图], prompt=...)` 逐帧续画）
 * 走 edit 而不是 generate 的第二个好处：官方 /images/generations 根本不接受参考图
 *      （universal.ts isOfficialOpenAIImage 已按此拦截），edit 是官方唯一能带图出画的端点。
 */
export async function editImageWithReferences(
  cfg: ApiConfig,
  req: { prompt: string; width: number; height: number; outputFormat?: "png" | "jpeg" | "webp" },
  references: ImageReference[],
  opts?: { signal?: AbortSignal },
): Promise<{ dataB64: string; mime: string }> {
  const files = references.slice(0, MAX_EDIT_REFERENCE_IMAGES).map((reference, index) => ({
    filename: `ref${index + 1}.png`,
    mime: reference.mime || "image/png",
    bytes: b64decode(rawReferenceBase64(reference)),
  }));
  if (!files.length) throw new Error("编辑端点至少需要一张输入图");
  const format = req.outputFormat ?? "png";
  const boundary = makeBoundary();
  const body = buildEditMultipartFiles(
    boundary,
    {
      model: cfg.model,
      prompt: req.prompt,
      size: `${req.width}x${req.height}`,
      n: "1",
      output_format: format,
    },
    files,
  );
  const out = await postEditMultipart(cfg, boundary, body, outputMimeFor(format), opts?.signal);
  return { dataB64: out.dataB64, mime: out.mime };
}
