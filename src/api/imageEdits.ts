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
import { headersFor, runWithImageLimit, withRetry } from "./openaiCompatible";
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

interface EditImageVariantRequest {
  prompt: string;
  /** 原图（现有立绘，base64，不含 data URL 前缀） */
  imageB64: string;
  imageMime: string;
  width: number;
  height: number;
  outputFormat?: "png" | "jpeg" | "webp";
}

const CRLF = "\r\n";

// #1568：本文件原先自带一份 escapeDispositionName 副本，注释写「与 universal.escapeDispositionName 同口径」——
// 实测两份**逐字相同**，所以当时没有故障；但这是「同一份判据存在两处实现」的典型形态
//（本会话 #1565 展示单价、#1558 两个 stableHash 都栽在这上面）：将来只改一处、另一处漏改，
// 而这是**防引号/CRLF 注入 multipart part** 的安全相关转义，漏改意味着注入防护出现缺口。
// universal.ts 里那份是导出的、且 universal 不 import 本文件（已核，无环），故直接复用它，只留一份实现。
import { escapeDispositionName } from "./universal";

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
  // 此前裸调一次就抛：全项目只有这条付费路径没有退避重试，也没有 classifyError 分流。
  // 中转站对 /images/edits 的 429/503 比 generations 更频繁（generateImage 有
  // IMAGE_LIMITERS + 5 次退避专门压这类抖动），单次抖动就让整张图失败并回退旧路径。
  // 复用与 generateImage 同口径的 withRetry（同样会检查中止，不会在停止后继续计费）。
  return withRetry(
    async () => {
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
        const error = new Error(`编辑端点返回 ${res.status}${message ? `：${message}` : ""}`) as Error & { status?: number };
        // 状态码必须挂上：withRetry 内部按 classifyError(e, status) 决定是否退避重试，
        // 不带 status 会退化成纯文本匹配，4xx/5xx 一律被当成不可重试。
        error.status = res.status;
        throw error;
      }
      const b64 = parsed.data?.[0]?.b64_json;
      if (!b64) throw new Error(`编辑端点未返回图片（响应 ${text.slice(0, 160)}）`);
      return { dataB64: b64, mime };
    },
    { retries: 4, signal },
  );
}

function outputMimeFor(format: "png" | "jpeg" | "webp"): string {
  return format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}

/** multipart 中输入文件的扩展名：必须由输入 MIME 决定，与输出格式无关 */
function inputExtForMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  return "png";
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
    // 文件名与 MIME 必须都取**输入**图的格式：此前 filename 用了 outputFormat（输出格式），
    // 而 mime/bytes 是输入格式 —— JPEG 立绘 + 未指定 outputFormat 时会发出
    // `filename="source.png"` + `Content-Type: image/jpeg` + JPEG 字节，
    // 按扩展名嗅探的服务（Stability 及多数中转）会拒收或错解。
    // 输出格式仍由独立的 output_format 字段传递，两者本就不该混用。
    [{ name: "image", filename: `source.${inputExtForMime(req.imageMime)}`, mime: req.imageMime, bytes: b64decode(req.imageB64) }],
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
    // 与上面单图编辑同一口径：扩展名必须跟**输入** MIME 一致。此前写死 .png，
    // 而 mime/bytes 用的是输入格式（视觉圣经接受 JPEG 上传）→ 发出
    // filename="ref1.png" + Content-Type: image/jpeg + JPEG 字节，按扩展名嗅探的中转会拒收，
    // 失败后 images.ts 静默退回「纯参考图生成」，角色一致性变差。
    filename: `ref${index + 1}.${inputExtForMime(reference.mime || "image/png")}`,
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
