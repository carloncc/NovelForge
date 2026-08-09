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
};

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
  const known = KNOWN_IMAGE_CAPABILITIES[model.trim()];
  return known ? { ...known } : undefined;
}

export function resolveImageModelCapabilities(config: ApiConfig): ImageModelCapabilities {
  // 优先用「测试连接」自动探测并写回配置的结果（用户无需手动配置能力）
  return customImageCapabilities(config.extra?.imageCapabilities)
    ?? knownImageModelCapabilities(config.model)
    ?? { ...NO_IMAGE_REFERENCES };
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
    throw new ReferenceImageError(`Model ${config.model} does not support required image references`, "REFERENCE_UNSUPPORTED");
  }
  if (requiredCount > capabilities.maxReferenceImages) {
    throw new ReferenceImageError(
      `Model ${config.model} accepts ${capabilities.maxReferenceImages} references but ${requiredCount} required identity/style references were supplied`,
      "REFERENCE_UNSUPPORTED",
    );
  }
  const selected = unique.slice(0, capabilities.maxReferenceImages);
  const discardedRequired = unique
    .slice(capabilities.maxReferenceImages)
    .find(referenceIsRequired);
  if (discardedRequired) {
    throw new ReferenceImageError(
      `Model ${config.model} would discard required ${discardedRequired.role} reference because of its ${capabilities.maxReferenceImages}-image limit`,
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

  const models = list.map((entry) => {
    if (typeof entry === "string") return { id: entry, capabilities: classifyModelCapabilities({ id: entry }, providerId) };
    if (!entry || typeof entry !== "object") throw new Error("模型列表包含无效条目");
    const record = entry as Record<string, unknown>;
    const id = record.id ?? record.name;
    if (typeof id !== "string" || !id.trim()) throw new Error("模型条目缺少有效 id");
    return { id: id.trim(), capabilities: classifyModelCapabilities(record, providerId) };
  });
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

export function siliconFlowVoices(model: string): string[] {
  const prefix = model || "FunAudioLLM/CosyVoice2-0.5B";
  return ["alex", "anna", "bella", "benjamin", "charles", "claire", "david", "diana"].map(
    (voice) => `${prefix}:${voice}`,
  );
}

export function applyProviderDefaults(
  channels: Record<ModelCapability, ApiConfig>,
  providerId: ProviderId,
  apiKey: string,
): void {
  const provider = PROVIDERS.find((item) => item.id === providerId);
  if (!provider) throw new Error(`未知供应商：${providerId}`);
  for (const kind of ["llm", "vision", "image", "tts"] as const) {
    const config = channels[kind];
    config.extra ??= {};
    config.extra.provider = providerId;
    config.extra.protocol = kind === "llm" || kind === "vision"
      ? "openai-chat"
      : providerId === "siliconflow"
        ? kind === "image" ? "siliconflow-image" : "siliconflow-speech"
        : providerId === "openai"
          ? kind === "image" ? "openai-image" : "openai-speech"
          : providerId === "minimax"
            ? kind === "image" ? "minimax-image" : "minimax-speech"
            : "custom-json";
    config.extra.discoveredModels = [];
    config.apiKey = apiKey;
    config.baseUrl = provider.supports[kind] ? provider.baseUrl : "";
    config.model = provider.defaults[kind] ?? "";
    if (kind === "tts" && providerId === "siliconflow") {
      config.extra.voiceLibrary = siliconFlowVoices(config.model);
    }
  }
}
