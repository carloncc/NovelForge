import {
  PROVIDERS,
  classifyModelCapabilities,
  estimateCharsPerToken,
  inputCharBudgetForText,
  MAX_INPUT_CHUNK_CHARS,
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

  // 语种感知预算：中文约 0.6 字符/token（以前按 1.5 算，中文长文分段超大触发网关 500）
  const zh = "林澈拔剑而起，星陨剑划破长空，剑气纵横三万里。".repeat(2000);
  const en = "The quick brown fox jumps over the lazy dog. ".repeat(1000);
  const zhRatio = estimateCharsPerToken(zh);
  assert(zhRatio > 0.5 && zhRatio < 0.8, `中文比率应在 0.6 附近，实际 ${zhRatio}`);
  const enRatio = estimateCharsPerToken(en);
  assert(enRatio > 3.5 && enRatio <= 4, `英文比率应在 4 附近，实际 ${enRatio}`);
  assert(estimateCharsPerToken("") === 0.7, "空文本应回退保守值");
  const cfg128k = { model: "m", extra: { contextLength: 128000 } };
  const zh128 = inputCharBudgetForText(cfg128k, zh);
  assert(zh128 > 30000 && zh128 < 80000, `128K 中文预算应在 5 万字级，实际 ${zh128}`);
  const cfg700k = { model: "m", extra: { contextLength: 700000 } };
  assert(inputCharBudgetForText(cfg700k, zh) === MAX_INPUT_CHUNK_CHARS, "超大上下文中文也应被硬上限截断");
  assert(inputCharBudgetForText(cfg700k, en) === MAX_INPUT_CHUNK_CHARS, "超大上下文英文也应被硬上限截断");

  console.log("=== 供应商与模型能力测试通过 ===");
}

main();
