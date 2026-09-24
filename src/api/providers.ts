import type {
  ApiConfig,
  ApiProtocol,
  ChannelKey,
  ImageModelCapabilities,
  ImageReference,
} from "../core/types";

export type ReferenceErrorCode = "REFERENCE_UNSUPPORTED" | "REFERENCE_MISSING";

export class ReferenceImageError extends Error {
  constructor(
    message: string,
    readonly code: ReferenceErrorCode,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceImageError";
  }
}

/**
 * 部分中转站只开放纯文本 /v1/images/generations：请求体一旦带参考图（base64）就会撞上服务端请求体上限，
 * 并回执「exceeds ... KiB / which this route does not support / No image inputs, edits」。
 * 这类失败重试必然失败，也不应静默丢掉参考图继续跑（参考图缺失会让角色形象不一致），
 * 所以单独识别出来，交给上层给出可执行的修复提示。
 */
const REFERENCE_ROUTE_REJECTION = /exceeds \d+(?:\.\d+)?\s*KiB|this route does not support|no image (?:inputs|edits)/i;

/** 命中「线路不接受带图请求」回执时返回可执行的修复提示，否则返回 undefined */
export function referenceRouteRejection(message: string): string | undefined {
  if (!REFERENCE_ROUTE_REJECTION.test(message)) return undefined;
  return "当前图片线路不接受带参考图的请求（服务端限制了请求体大小，且回执明确说明不支持图像输入/图生图）。请在「API 配置 > 图片生成」对该线路重新点一次「测试连接」，让程序自动修正它的图像能力；或改选支持参考图/图生图的线路或模型。";
}

/**
 * #1125：参考图能力冲突（参考图数 > 0 但未启用图生图 / 模型不支持参考图）时的失败提示。
 * 运行期批量失败的信息里必须带上「去哪修」，否则用户只看到英文错误，联想不到配置页那个开关。
 */
const REFERENCE_UNSUPPORTED_HINT = "请在「API 配置 > 图像 API > 图片模型能力」中启用「图生图」（或点「一键修复」），或把「参考图数量」设为 0，然后重跑本阶段。";

const NO_IMAGE_REFERENCES: ImageModelCapabilities = {
  maxReferenceImages: 0,
  supportsSeed: false,
  supportsImageEdit: false,
  referenceEncoding: "raw-base64",
};

const KNOWN_IMAGE_CAPABILITIES: Record<string, ImageModelCapabilities> = {
  "Qwen/Qwen-Image-Edit-2509": {
    maxReferenceImages: 3,
    supportsSeed: true,
    supportsImageEdit: true,
    referenceEncoding: "data-url",
  },
  // MiniMax image-01 支持图生图参考（image/image2/image3 字段）
  "image-01": {
    maxReferenceImages: 3,
    supportsSeed: false,
    supportsImageEdit: true,
    referenceEncoding: "raw-base64",
  },
  // GPT-Image 系列（openai-image 适配器）
  "gpt-image-2": {
    maxReferenceImages: 3,
    supportsSeed: false,
    supportsImageEdit: true,
    referenceEncoding: "raw-base64",
  },
};

/**
 * 已知模型族前缀（#1149）：中转站/网关普遍给模型加前缀或后缀
 * （`openai/gpt-image-2`、`Qwen/Qwen-Image-Edit-2509:free`、`gpt-image-2-2026-01-15`），
 * 归一化后仍对不上时按族前缀命中，避免同一模型被静默降级成「0 参考图、不支持图生图」。
 */
const KNOWN_IMAGE_CAPABILITY_FAMILIES: { prefix: string; capabilities: ImageModelCapabilities }[] = [
  {
    prefix: "qwen-image-edit",
    capabilities: { maxReferenceImages: 3, supportsSeed: true, supportsImageEdit: true, referenceEncoding: "data-url" },
  },
  {
    prefix: "gpt-image",
    capabilities: { maxReferenceImages: 3, supportsSeed: false, supportsImageEdit: true, referenceEncoding: "raw-base64" },
  },
  {
    prefix: "image-01",
    capabilities: { maxReferenceImages: 3, supportsSeed: false, supportsImageEdit: true, referenceEncoding: "raw-base64" },
  },
];

/**
 * 归一化模型 id（#1149）：小写、去 vendor 前缀（取最后一段）、去 `:tag`/`@snapshot` 后缀。
 * 例：`siliconflow/Qwen/Qwen-Image-Edit-2509:free` → `qwen-image-edit-2509`；
 *     `openai/gpt-image-2` → `gpt-image-2`。
 */
export function normalizeModelId(model: string | undefined): string {
  const raw = (model ?? "").trim().toLowerCase();
  if (!raw) return "";
  const basename = raw.split("/").pop() ?? raw;
  return basename.split(/[:@]/)[0].trim();
}

/** 图片能力冲突判定（#1125，纯函数供配置页与单测共用）：参考图数 > 0 但未启用图生图 */
export function isImageCapabilityConflict(capabilities: { maxReferenceImages: number; supportsImageEdit: boolean }): boolean {
  return capabilities.maxReferenceImages > 0 && !capabilities.supportsImageEdit;
}

function customImageCapabilities(raw: unknown): ImageModelCapabilities | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<ImageModelCapabilities>;
  if (!Number.isInteger(candidate.maxReferenceImages)
    || candidate.maxReferenceImages! < 0
    || candidate.maxReferenceImages! > 3
    || typeof candidate.supportsSeed !== "boolean"
    || typeof candidate.supportsImageEdit !== "boolean"
    || !["raw-base64", "data-url"].includes(candidate.referenceEncoding as string)) {
    throw new ReferenceImageError("Custom image capabilities are incomplete or invalid", "REFERENCE_UNSUPPORTED");
  }
  if (candidate.maxReferenceImages! > 0 && !candidate.supportsImageEdit) {
    throw new ReferenceImageError("maxReferenceImages > 0 requires supportsImageEdit", "REFERENCE_UNSUPPORTED");
  }
  return candidate as ImageModelCapabilities;
}

export function knownImageModelCapabilities(model: string): ImageModelCapabilities | undefined {
  const normalized = normalizeModelId(model);
  if (!normalized) return undefined;
  const exact = KNOWN_IMAGE_CAPABILITIES[model.trim()]
    ?? Object.entries(KNOWN_IMAGE_CAPABILITIES).find(([key]) => normalizeModelId(key) === normalized)?.[1];
  if (exact) return { ...exact };
  const family = KNOWN_IMAGE_CAPABILITY_FAMILIES.find((entry) => normalized.startsWith(entry.prefix));
  return family ? { ...family.capabilities } : undefined;
}

/** 能力表是否识别该模型（配置页据此提示「请点一次测试连接自动探测」，#1149b） */
export function imageModelIsRecognized(model: string): boolean {
  return knownImageModelCapabilities(model) !== undefined;
}

export function resolveImageModelCapabilities(config: ApiConfig): ImageModelCapabilities {
  const stored = customImageCapabilities(config.extra?.imageCapabilities);
  const stamp = config.extra?.imageCapabilitiesModel;
  const known = knownImageModelCapabilities(config.model);
  // 新探测/手动写入都带模型标记：同模型直接信任；换模型后自动作废（防止旧模型能力套到新模型上）。
  // #1149：标记比较也要归一化——网关给模型加前缀/后缀后，探测结果不应被误判为「换了模型」而作废
  if (stored && typeof stamp === "string" && normalizeModelId(stamp) === normalizeModelId(config.model)) return stored;
  // 旧版遗留（无标记）只在「内置表不认识该模型」时继续信任：内置表优先，
  // 且不因缺少标记就丢掉未知模型上用户已有的正能力
  if (stored && stamp === undefined && !known) return stored;
  return known ?? { ...NO_IMAGE_REFERENCES };
}

function normalizedReferencePayload(reference: ImageReference): { payload: string; mime: string } {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(reference.dataB64.trim());
  const payload = (match?.[2] ?? reference.dataB64).replace(/\s+/g, "");
  if (!payload) {
    throw new ReferenceImageError(`Reference role ${reference.role} has no image data`, "REFERENCE_MISSING");
  }
  return { payload, mime: match?.[1] ?? reference.mime };
}

export function rawReferenceBase64(reference: ImageReference): string {
  return normalizedReferencePayload(reference).payload;
}

export function referenceDataUrl(reference: ImageReference): string {
  const normalized = normalizedReferencePayload(reference);
  return `data:${normalized.mime};base64,${normalized.payload}`;
}

function referenceIsRequired(reference: ImageReference): boolean {
  return reference.required ?? reference.role !== "structure";
}

export function routeImageReferences(config: ApiConfig, references: ImageReference[]): ImageReference[] {
  const rolePriority = { identity: 0, style: 1, structure: 2 } as const;
  const sorted = references
    .map((reference, index) => ({ reference, index }))
    .sort((left, right) => rolePriority[left.reference.role] - rolePriority[right.reference.role] || left.index - right.index);
  const unique: ImageReference[] = [];
  const payloadIndexes = new Map<string, number>();
  const sourcePathIndexes = new Map<string, number>();
  for (const { reference } of sorted) {
    const payload = rawReferenceBase64(reference);
    const sourcePath = reference.sourcePath?.replace(/\\/g, "/");
    const duplicateIndex = payloadIndexes.get(payload) ?? (sourcePath ? sourcePathIndexes.get(sourcePath) : undefined);
    if (duplicateIndex !== undefined) {
      const existing = unique[duplicateIndex];
      unique[duplicateIndex] = {
        ...existing,
        sourcePath: existing.sourcePath ?? reference.sourcePath,
        required: referenceIsRequired(existing) || referenceIsRequired(reference),
      };
      payloadIndexes.set(payload, duplicateIndex);
      if (sourcePath) sourcePathIndexes.set(sourcePath, duplicateIndex);
      continue;
    }
    const uniqueIndex = unique.push(reference) - 1;
    payloadIndexes.set(payload, uniqueIndex);
    if (sourcePath) sourcePathIndexes.set(sourcePath, uniqueIndex);
  }
  if (unique.length === 0) return [];

  const capabilities = resolveImageModelCapabilities(config);
  const requiredCount = unique.filter(referenceIsRequired).length;
  if (!capabilities.supportsImageEdit || capabilities.maxReferenceImages === 0) {
    if (requiredCount === 0) return [];
    throw new ReferenceImageError(
      `Model ${config.model} does not support required image references（该线路/模型当前被判定为不支持参考图或图生图）。${REFERENCE_UNSUPPORTED_HINT}`,
      "REFERENCE_UNSUPPORTED",
    );
  }
  if (requiredCount > capabilities.maxReferenceImages) {
    throw new ReferenceImageError(
      `Model ${config.model} accepts ${capabilities.maxReferenceImages} references but ${requiredCount} required identity/style references were supplied（参考图数量超过该模型能力上限）。${REFERENCE_UNSUPPORTED_HINT}`,
      "REFERENCE_UNSUPPORTED",
    );
  }
  const selected = unique.slice(0, capabilities.maxReferenceImages);
  const discardedRequired = unique
    .slice(capabilities.maxReferenceImages)
    .find(referenceIsRequired);
  if (discardedRequired) {
    throw new ReferenceImageError(
      `Model ${config.model} would discard required ${discardedRequired.role} reference because of its ${capabilities.maxReferenceImages}-image limit（参考图数量超过该模型能力上限）。${REFERENCE_UNSUPPORTED_HINT}`,
      "REFERENCE_UNSUPPORTED",
    );
  }
  return selected;
}

export function protocolForConfig(config: ApiConfig, kind: ChannelKey): ApiProtocol {
  const explicit = config.extra?.protocol;
  if (typeof explicit === "string" && [
    "openai-chat", "openai-image", "openai-speech", "siliconflow-image", "siliconflow-speech",
    "minimax-image", "minimax-speech", "custom-json",
  ].includes(explicit)) return explicit as ApiProtocol;

  const provider = providerIdForConfig(config);
  if (kind === "image" && provider === "siliconflow") return "siliconflow-image";
  if (kind === "tts" && provider === "siliconflow") return "siliconflow-speech";
  if (kind === "image" && provider === "openai") return "openai-image";
  if (kind === "tts" && provider === "openai") return "openai-speech";
  return kind === "llm" || kind === "vision" ? "openai-chat" : "custom-json";
}

export function configIsUsable(config: ApiConfig | undefined, kind: ChannelKey): config is ApiConfig {
  if (!config?.baseUrl?.trim() || !config.model?.trim()) return false;
  if (config.apiKey?.trim()) return true;
  const url = config.baseUrl.toLowerCase();
  return url.includes("localhost") || url.includes("127.0.0.1") || url.includes("::1") || config.extra?.apiKeyOptional === true;
}

export type ModelCapability = ChannelKey;
export type ProviderId = "siliconflow" | "openai" | "deepseek" | "dashscope" | "moonshot" | "ollama" | "minimax" | "custom";

export interface ProviderPreset {
  id: ProviderId;
  name: string;
  baseUrl: string;
  apiKeyOptional?: boolean;
  supports: Record<ModelCapability, boolean>;
  defaults: Partial<Record<ModelCapability, string>>;
}

export interface DiscoveredModel {
  id: string;
  capabilities: ModelCapability[];
  /** 模型上下文窗口大小（token 数），由 /models 探测到的字段 */
  contextLength?: number;
}

/**
 * 默认上下文长度：128K（token）。网关 /models 不返回 context_length、
 * 用户也没手动覆盖时使用。需要更大/更小的模型请在「配置页 → 上下文长度」里改。
 */
const DEFAULT_CONTEXT_LENGTH = 128_000;

/** 上下文长度输入下限（#1384）：与输入框 min=1024 对齐，手输更小值时 clamp */
export const MIN_CONTEXT_LENGTH = 1024;

/**
 * #1384 上下文长度输入清洗（纯函数，供 ConfigPage 与单测共用）：
 * - 空串 → undefined（回显空，走自动探测）
 * - 非有限数（abc/NaN/Infinity）→ undefined（不再写入 NaN 落盘变 null）
 * - 有限数 → 向下取整后 clamp 到 >= MIN_CONTEXT_LENGTH
 */
export function sanitizeContextLengthInput(raw: string): number | undefined {
  const v = (raw ?? "").trim();
  if (v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(MIN_CONTEXT_LENGTH, Math.floor(n));
}

/** 从 /models 单项里尽量抽出一个 token 数；找不到返回 undefined */
function extractContextLength(record: Record<string, unknown>): number | undefined {
  const candidates = [
    record.context_length,
    record.max_input_tokens,
    record.max_context_length,
    record.context_window,
    record.contextWindow,
    (record.limits as Record<string, unknown> | undefined)?.context_length,
    (record.top_provider as Record<string, unknown> | undefined)?.context_length,
  ];
  for (const raw of candidates) {
    const n = typeof raw === "string" ? Number(raw) : (raw as number | undefined);
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * 解析一个 API 配置的最终上下文 token 数。
 * 优先级：手动覆盖 (cfg.extra.contextLength) > /models 探测 > 默认 128K
 * #1149：/models 探测结果与配置里的模型名都要归一化后比较（网关加前缀/后缀/`:free` 时
 * 仍能命中，否则会静默回退 128K 导致长章超限报错）。
 */
export function resolveContextLength(cfg: { model?: string; extra?: Record<string, unknown> } | undefined): number {
  if (!cfg) return DEFAULT_CONTEXT_LENGTH;
  const override = cfg.extra?.contextLength;
  const overrideNum = typeof override === "string" ? Number(override) : (override as number | undefined);
  if (typeof overrideNum === "number" && Number.isFinite(overrideNum) && overrideNum > 0) {
    return Math.floor(overrideNum);
  }
  const discovered = Array.isArray(cfg.extra?.discoveredModels)
    ? (cfg.extra!.discoveredModels as DiscoveredModel[])
    : [];
  const normalized = normalizeModelId(cfg.model);
  if (normalized) {
    const usable = discovered.filter((m) => typeof m.contextLength === "number");
    const hit = usable.find((m) => m.id === cfg.model)
      ?? usable.find((m) => normalizeModelId(m.id) === normalized)
      // 前缀命中：探测列表里是完整 id（`Qwen/Qwen3-235B-A22B-Instruct`），配置里填的是族名
      ?? usable.find((m) => normalizeModelId(m.id).startsWith(normalized) || normalized.startsWith(normalizeModelId(m.id)));
    if (hit?.contextLength) return hit.contextLength;
  }
  // 回退默认值也记一条 warn：便于定位「为什么长章被截断/超上下文」
  if (discovered.length) {
    console.warn(`[providers] 未能从 /models 探测结果匹配模型「${cfg.model ?? ""}」的上下文长度，回退默认 ${DEFAULT_CONTEXT_LENGTH} token`);
  }
  return DEFAULT_CONTEXT_LENGTH;
}

/**
 * 按实际文本语种估算字符/token 比率（采样前 2 万字）。
 * 英文约 4 字符/token，中文约 0.6 字符/token（1 个汉字 ≈ 1.5~2 token），线性混合。
 * 注意以前这里写反了（按 1.5 字符/token 给中文小说算预算），导致中文长文分段超大。
 */
export function estimateCharsPerToken(text: string): number {
  const sample = text.slice(0, 20_000);
  if (!sample.length) return 0.7;
  const cjk = (sample.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g) || []).length;
  const cjkRatio = cjk / [...sample].length;
  return 4 * (1 - cjkRatio) + 0.6 * cjkRatio;
}

/** 单次请求字符硬上限：上下文再长也别一次塞太多——
 * 巨型负载易触发网关 500/超时，且超长输入提取质量明显下降（lost in the middle） */
export const MAX_INPUT_CHUNK_CHARS = 150_000;

/** 按实际文本语种估算的安全输入字符预算（中文小说约按 0.6 字符/token） */
export function inputCharBudgetForText(cfg: { model?: string; extra?: Record<string, unknown> } | undefined, text: string): number {
  const context = resolveContextLength(cfg);
  const reservedOutput = 36_000;
  const safeTokens = Math.max(2_000, context - reservedOutput);
  return Math.min(MAX_INPUT_CHUNK_CHARS, Math.floor(safeTokens * estimateCharsPerToken(text)));
}

/**
 * 单次请求的输出 token 预算：从上下文里扣掉输入估算与固定余量。
 * 旧实现直接用 min(context, 32768) 不扣输入，小上下文模型 input+maxTokens 直接超上下文，
 * 请求报错或输出被截断（翻译 #781 / 提取补全 #637 共用）。
 */
export function outputTokensForText(
  cfg: { model?: string; extra?: Record<string, unknown> } | undefined,
  text: string,
  cap = 32_768,
): number {
  const context = resolveContextLength(cfg);
  const inputTokens = Math.ceil(text.length / Math.max(0.1, estimateCharsPerToken(text)));
  return Math.max(512, Math.min(cap, context - inputTokens - 1_000));
}

/**
 * 根据模型上下文算"安全输入字符预算"。
 * - 无原文时的粗估：1 token ≈ 1.5 字符（偏英文）；有原文请用 inputCharBudgetForText
 *   （中文小说实际约 0.6 字符/token，用 1.5 会超预算触发网关 500）
 * - 扣掉输出预留（默认 32K 输出 + 4K reasoning 余量 = 36K token）
 * - 绝对上限 1_000_000 字符防荒谬值
 */
export function inputCharBudget(cfg: { model?: string; extra?: Record<string, unknown> } | undefined): number {
  const context = resolveContextLength(cfg);
  const reservedOutput = 36_000;
  const safeTokens = Math.max(2_000, context - reservedOutput);
  return Math.min(1_000_000, Math.floor(safeTokens * 1.5));
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "siliconflow",
    name: "硅基流动（四通道）",
    baseUrl: "https://api.siliconflow.cn/v1",
    supports: { llm: true, vision: true, image: true, tts: true },
    defaults: {
      llm: "deepseek-ai/DeepSeek-V3.2",
      vision: "zai-org/GLM-4.6V",
      image: "Qwen/Qwen-Image-Edit-2509",
      tts: "FunAudioLLM/CosyVoice2-0.5B",
    },
  },
  {
    id: "openai",
    name: "OpenAI（四通道）",
    baseUrl: "https://api.openai.com/v1",
    supports: { llm: true, vision: true, image: true, tts: true },
    defaults: { llm: "gpt-4o-mini", vision: "gpt-4o-mini", image: "gpt-image-1", tts: "gpt-4o-mini-tts" },
  },
  {
    id: "deepseek",
    name: "DeepSeek（文本）",
    baseUrl: "https://api.deepseek.com",
    supports: { llm: true, vision: false, image: false, tts: false },
    defaults: { llm: "deepseek-chat" },
  },
  {
    id: "dashscope",
    name: "通义千问兼容模式（文本）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    supports: { llm: true, vision: false, image: false, tts: false },
    defaults: { llm: "qwen-plus" },
  },
  {
    id: "moonshot",
    name: "Kimi / Moonshot（文本）",
    baseUrl: "https://api.moonshot.cn/v1",
    supports: { llm: true, vision: false, image: false, tts: false },
    defaults: { llm: "moonshot-v1-8k" },
  },
  {
    id: "ollama",
    name: "Ollama 本地（文本）",
    baseUrl: "http://localhost:11434/v1",
    apiKeyOptional: true,
    supports: { llm: true, vision: false, image: false, tts: false },
    defaults: { llm: "" },
  },
  {
    id: "minimax",
    name: "MiniMax（四通道）",
    baseUrl: "https://api.minimaxi.com/v1",
    supports: { llm: true, vision: true, image: true, tts: true },
    defaults: {
      llm: "MiniMax-M3",
      vision: "MiniMax-M3",
      image: "image-01",
      tts: "speech-2.8-hd",
    },
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容",
    baseUrl: "",
    supports: { llm: true, vision: true, image: true, tts: true },
    defaults: {},
  },
];

const IMAGE_MODEL = /(?:flux|stable[-_ ]?diffusion|sdxl|kolors|qwen[-_/]?image|wanx|dall-e|gpt-image|seedream|imagen)/i;
const VISION_MODEL = /(?:vision|visual|qwen[^/]*[-_]vl|glm[-\w.]*v\b|llava|minicpm[-_]v)/i;
/** 可同时用于文本对话与图片理解的多模态聊天模型（既出现在 LLM 通道也出现在图片识别通道） */
const MULTIMODAL_CHAT_MODEL = /^mini[-_ ]?max[-_ ]?m3$/i;
const TTS_MODEL = /(?:tts|text[-_ ]?to[-_ ]?speech|cosyvoice|fish[-_ ]?speech|fishaudio|chattts|kokoro|bark)/i;
const NON_CHAT_MODEL = /(?:embedding|rerank|re-rank|moderation|whisper|speech[-_ ]?to[-_ ]?text|sensevoice)/i;

function normalizeCapability(value: unknown): ModelCapability | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replace(/[ -]/g, "_");
  if (["llm", "chat", "text", "text_generation"].includes(normalized)) return "llm";
  if (["vision", "visual", "image_understanding", "multimodal"].includes(normalized)) return "vision";
  if (["image", "images", "image_generation", "text_to_image"].includes(normalized)) return "image";
  if (["tts", "speech", "text_to_speech", "audio_speech"].includes(normalized)) return "tts";
  return undefined;
}

export function classifyModelCapabilities(model: Record<string, unknown>, providerId: ProviderId): ModelCapability[] {
  const explicit = [model.capabilities, model.capability, model.tasks, model.task]
    .flatMap((value) => Array.isArray(value) ? value : value == null ? [] : [value])
    .map(normalizeCapability)
    .filter((value): value is ModelCapability => Boolean(value));
  if (explicit.length) return [...new Set(explicit)];

  const id = String(model.id ?? model.name ?? "");
  if (MULTIMODAL_CHAT_MODEL.test(id)) return ["llm", "vision"];
  if (IMAGE_MODEL.test(id)) return ["image"];
  if (VISION_MODEL.test(id)) return ["vision"];
  if (TTS_MODEL.test(id)) return ["tts"];
  if (NON_CHAT_MODEL.test(id)) return [];

  const provider = PROVIDERS.find((item) => item.id === providerId);
  return provider?.supports.llm ? ["llm"] : [];
}

export function parseModelList(payload: unknown, providerId: ProviderId): DiscoveredModel[] {
  if (!payload || typeof payload !== "object") throw new Error("模型接口返回的不是 JSON 对象");
  const root = payload as Record<string, unknown>;
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : undefined;
  if (!list) throw new Error("模型接口缺少 data 或 models 数组");

  const models: DiscoveredModel[] = [];
  for (const entry of list) {
    // 1317：一坏条即全抛。改为坏条过滤（warn 后跳过），空列表才抛。
    if (typeof entry === "string") {
      models.push({ id: entry, capabilities: classifyModelCapabilities({ id: entry }, providerId) });
      continue;
    }
    if (!entry || typeof entry !== "object") {
      console.warn(`[providers] 跳过无效模型条目：${String(entry).slice(0, 80)}`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.name;
    if (typeof id !== "string" || !id.trim()) {
      console.warn("[providers] 跳过缺少有效 id 的模型条目");
      continue;
    }
    const contextLength = extractContextLength(record);
    const model: DiscoveredModel = { id: id.trim(), capabilities: classifyModelCapabilities(record, providerId) };
    if (contextLength) model.contextLength = contextLength;
    models.push(model);
  }
  if (!models.length) throw new Error("模型列表无有效条目");
  return models.filter((model, index) => models.findIndex((candidate) => candidate.id === model.id) === index);
}

export function providerIdForConfig(config: ApiConfig): ProviderId {
  const explicit = config.extra?.provider;
  if (typeof explicit === "string" && PROVIDERS.some((provider) => provider.id === explicit)) return explicit as ProviderId;
  const url = config.baseUrl.toLowerCase();
  if (url.includes("siliconflow")) return "siliconflow";
  if (url.includes("openai.com")) return "openai";
  if (url.includes("deepseek.com")) return "deepseek";
  if (url.includes("dashscope")) return "dashscope";
  if (url.includes("moonshot")) return "moonshot";
  if (url.includes("minimaxi") || url.includes("minimax")) return "minimax";
  if (url.includes("localhost:11434") || url.includes("127.0.0.1:11434")) return "ollama";
  return "custom";
}
