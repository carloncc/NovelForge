import type { ApiConfig, ApiProtocol, ChannelKey } from "../core/types";

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
  return kind === "llm" ? "openai-chat" : "custom-json";
}

export function configIsUsable(config: ApiConfig | undefined, kind: ChannelKey): config is ApiConfig {
  if (!config?.baseUrl?.trim() || !config.model?.trim()) return false;
  if (config.apiKey?.trim()) return true;
  const url = config.baseUrl.toLowerCase();
  return url.includes("localhost") || url.includes("127.0.0.1") || url.includes("::1") || config.extra?.apiKeyOptional === true;
}

export type ModelCapability = ChannelKey;
export type ProviderId = "siliconflow" | "openai" | "deepseek" | "dashscope" | "moonshot" | "ollama" | "custom";

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
    name: "硅基流动（三通道）",
    baseUrl: "https://api.siliconflow.cn/v1",
    supports: { llm: true, image: true, tts: true },
    defaults: {
      llm: "deepseek-ai/DeepSeek-V3.2",
      image: "black-forest-labs/FLUX.1-schnell",
      tts: "FunAudioLLM/CosyVoice2-0.5B",
    },
  },
  {
    id: "openai",
    name: "OpenAI（三通道）",
    baseUrl: "https://api.openai.com/v1",
    supports: { llm: true, image: true, tts: true },
    defaults: { llm: "gpt-4o-mini", image: "gpt-image-1", tts: "gpt-4o-mini-tts" },
  },
  {
    id: "deepseek",
    name: "DeepSeek（文本）",
    baseUrl: "https://api.deepseek.com",
    supports: { llm: true, image: false, tts: false },
    defaults: { llm: "deepseek-chat" },
  },
  {
    id: "dashscope",
    name: "通义千问兼容模式（文本）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    supports: { llm: true, image: false, tts: false },
    defaults: { llm: "qwen-plus" },
  },
  {
    id: "moonshot",
    name: "Kimi / Moonshot（文本）",
    baseUrl: "https://api.moonshot.cn/v1",
    supports: { llm: true, image: false, tts: false },
    defaults: { llm: "moonshot-v1-8k" },
  },
  {
    id: "ollama",
    name: "Ollama 本地（文本）",
    baseUrl: "http://localhost:11434/v1",
    apiKeyOptional: true,
    supports: { llm: true, image: false, tts: false },
    defaults: { llm: "" },
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容",
    baseUrl: "",
    supports: { llm: true, image: true, tts: true },
    defaults: {},
  },
];

const IMAGE_MODEL = /(?:flux|stable[-_ ]?diffusion|sdxl|kolors|qwen[-_/]?image|wanx|dall-e|gpt-image|seedream|imagen)/i;
const TTS_MODEL = /(?:tts|text[-_ ]?to[-_ ]?speech|cosyvoice|fish[-_ ]?speech|fishaudio|chattts|kokoro|bark)/i;
const NON_CHAT_MODEL = /(?:embedding|rerank|re-rank|moderation|whisper|speech[-_ ]?to[-_ ]?text|sensevoice)/i;

function normalizeCapability(value: unknown): ModelCapability | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replace(/[ -]/g, "_");
  if (["llm", "chat", "text", "text_generation"].includes(normalized)) return "llm";
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
  if (IMAGE_MODEL.test(id)) return ["image"];
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
  for (const kind of ["llm", "image", "tts"] as const) {
    const config = channels[kind];
    config.extra ??= {};
    config.extra.provider = providerId;
    config.extra.protocol = kind === "llm"
      ? "openai-chat"
      : providerId === "siliconflow"
        ? kind === "image" ? "siliconflow-image" : "siliconflow-speech"
        : providerId === "openai"
          ? kind === "image" ? "openai-image" : "openai-speech"
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
