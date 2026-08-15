import {
  PROVIDERS,
  classifyModelCapabilities,
  parseModelList,
} from "../src/api/providers";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  const siliconflow = PROVIDERS.find((provider) => provider.id === "siliconflow");
  assert(siliconflow?.baseUrl === "https://api.siliconflow.cn/v1", "硅基流动地址应为官方 v1 地址");
  assert(siliconflow?.supports.vision === true && siliconflow.supports.image === true && siliconflow.supports.tts === true, "硅基流动应支持四通道");

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

  console.log("=== 供应商与模型能力测试通过 ===");
}

main();
