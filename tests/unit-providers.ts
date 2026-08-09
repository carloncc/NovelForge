import {
  PROVIDERS,
  applyProviderDefaults,
  classifyModelCapabilities,
  parseModelList,
} from "../src/api/providers";
import type { ApiConfig } from "../src/core/types";
import { buildImageRequestBody, buildTtsRequestBody, extractImageValue, imageEndpointForConfig, parseMinimaxAudioResponse, ttsEndpointForConfig } from "../src/api/openaiCompatible";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function config(): ApiConfig {
  return { id: "test", name: "测试", baseUrl: "", apiKey: "", model: "", extra: {} };
}

function main(): void {
  const siliconflow = PROVIDERS.find((provider) => provider.id === "siliconflow");
  assert(siliconflow?.baseUrl === "https://api.siliconflow.cn/v1", "硅基流动地址应为官方 v1 地址");
  assert(siliconflow?.supports.vision === true && siliconflow.supports.image === true && siliconflow.supports.tts === true, "硅基流动应支持四通道");

  const channels = { llm: config(), vision: config(), image: config(), tts: config() };
  applyProviderDefaults(channels, "deepseek", "sk-shared");
  assert(channels.llm.baseUrl === "https://api.deepseek.com", "DeepSeek 应使用官方 Base URL");
  assert(channels.llm.apiKey === "sk-shared", "快速配置应同步 API Key");
  assert(channels.vision.baseUrl === "" && channels.image.baseUrl === "" && channels.tts.baseUrl === "", "不支持的通道不应伪造地址");

  const models = parseModelList({
    data: [
      { id: "deepseek-ai/DeepSeek-V3.2" },
      { id: "zai-org/GLM-4.6V" },
      { id: "black-forest-labs/FLUX.1-schnell" },
      { id: "FunAudioLLM/CosyVoice2-0.5B" },
    ],
  }, "siliconflow");
  assert(models.length === 4, "应解析 OpenAI 兼容的 data 模型列表");
  assert(models[0].capabilities.includes("llm"), "DeepSeek 模型应识别为文本");
  assert(models[1].capabilities.includes("vision"), "GLM-4.6V 应识别为视觉模型");
  assert(models[2].capabilities.includes("image"), "FLUX 模型应识别为图片");
  assert(models[3].capabilities.includes("tts"), "CosyVoice 模型应识别为 TTS");

  const explicit = classifyModelCapabilities({ id: "vendor/custom", capabilities: ["image_generation"] }, "custom");
  assert(explicit.length === 1 && explicit[0] === "image", "应优先使用供应商返回的能力标签");

  let invalidThrew = false;
  try {
    parseModelList({ data: [{ id: "ok" }, { id: 42 }] }, "custom");
  } catch {
    invalidThrew = true;
  }
  assert(invalidThrew, "第三方模型响应字段类型错误时应拒绝");

  const sfImage = config();
  sfImage.baseUrl = "https://api.siliconflow.cn/v1";
  sfImage.model = "black-forest-labs/FLUX.1-schnell";
  sfImage.extra = { provider: "siliconflow" };
  const sfImageBody = buildImageRequestBody(sfImage, "cat", { size: "768x1024" });
  assert(sfImageBody.image_size === "768x1024" && sfImageBody.batch_size === 1, "硅基流动图片应使用 image_size/batch_size");
  assert(sfImageBody.size === undefined && sfImageBody.response_format === undefined, "硅基流动请求不应混入 OpenAI 图片参数");

  const openAiImage = config();
  openAiImage.baseUrl = "https://api.openai.com/v1";
  openAiImage.model = "gpt-image-1";
  openAiImage.extra = { provider: "openai" };
  const openAiImageBody = buildImageRequestBody(openAiImage, "cat", { size: "1024x1024" });
  assert(openAiImageBody.size === "1024x1024", "OpenAI 图片应使用 size");
  assert(openAiImageBody.response_format === undefined, "GPT Image 不支持 response_format，不应发送");

  const sfTts = config();
  sfTts.baseUrl = "https://api.siliconflow.cn/v1";
  sfTts.model = "FunAudioLLM/CosyVoice2-0.5B";
  sfTts.extra = { provider: "siliconflow" };
  const sfTtsBody = buildTtsRequestBody(sfTts, "你好", "anna");
  assert(sfTtsBody.voice === "FunAudioLLM/CosyVoice2-0.5B:anna", "硅基流动音色应带模型前缀");

  const openAiTts = config();
  openAiTts.baseUrl = "https://api.openai.com/v1";
  openAiTts.model = "gpt-4o-mini-tts";
  openAiTts.extra = { provider: "openai" };
  assert(buildTtsRequestBody(openAiTts, "hello", "default").voice === "alloy", "OpenAI 默认音色应映射到 alloy");

  console.log("=== 供应商与模型能力测试通过 ===");
}

  const minimaxImage = config();
  minimaxImage.baseUrl = "https://api.minimaxi.com";
  minimaxImage.model = "image-01";
  minimaxImage.extra = { protocol: "minimax-image" };
  const minimaxImageBody = buildImageRequestBody(minimaxImage, "cat", { size: "1024x576" });
  assert(imageEndpointForConfig(minimaxImage).endsWith("/v1/image_generation"), "MiniMax 图片应使用 image_generation 端点");
  assert(minimaxImageBody.aspect_ratio === "16:9" && minimaxImageBody.n === 1, "MiniMax 图片应使用 aspect_ratio/n");
  assert(minimaxImageBody.size === undefined && minimaxImageBody.image_size === undefined, "MiniMax 图片不应发送 OpenAI/硅基字段");
  assert(extractImageValue({ data: { image_urls: ["https://img.example/x.png"] } }) === "https://img.example/x.png", "应解析 MiniMax data.image_urls 响应");

  const minimaxTts = config();
  minimaxTts.baseUrl = "https://api.minimaxi.com";
  minimaxTts.model = "speech-2.8-hd";
  minimaxTts.extra = { protocol: "minimax-speech" };
  const minimaxTtsBody = buildTtsRequestBody(minimaxTts, "你好", "male-qn-qingse");
  assert(ttsEndpointForConfig(minimaxTts).endsWith("/v1/t2a_v2"), "MiniMax TTS 应使用 t2a_v2 端点");
  assert((minimaxTtsBody.voice_setting as Record<string, unknown>).voice_id === "male-qn-qingse", "MiniMax TTS 应使用 voice_setting.voice_id");
  assert(minimaxTtsBody.input === undefined && minimaxTtsBody.voice === undefined, "MiniMax TTS 不应发送 OpenAI input/voice 字段");
  assert(parseMinimaxAudioResponse({ data: { audio: "000102ff" } }).dataB64 === "AAEC/w==", "应将 MiniMax TTS 十六进制音频转为 base64");

main();
