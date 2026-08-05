import type { AdapterTemplate } from "./universal";

/**
 * 预置服务商适配模板（图像 / TTS）。
 * 新增厂商：复制一个模板 JSON 调整即可，无需改代码。
 */
export const PRESET_TEMPLATES: AdapterTemplate[] = [
  {
    id: "openai-image",
    name: "OpenAI 兼容图像（智谱 CogView / 硅基流动 FLUX / OpenAI）",
    capability: "image",
    mode: "sync",
    endpoint: "/v1/images/generations",
    requestMap: {
      model: "$model",
      prompt: "$prompt",
      n: "$count",
      size: "$sizeOpenAI",
      response_format: { value: "b64_json" },
      image: "$refImage",
    },
    response: { path: "data", encoding: "base64", mime: "image/png" },
    description: "标准 OpenAI 兼容：POST /v1/images/generations，响应 data[0].b64_json 或 url",
  },
  {
    id: "openai-tts",
    name: "OpenAI 兼容 TTS（智谱 glm-4-voice / OpenAI audio/speech）",
    capability: "tts",
    mode: "sync",
    endpoint: "/v1/audio/speech",
    rawResponse: true,
    requestMap: {
      model: "$model",
      input: "$text",
      voice: "$voice",
      response_format: "$format",
    },
    response: { mime: "audio/mpeg" },
    voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer", "zhipu_lin", "zhipu_ling"],
    description: "OpenAI 兼容语音合成：POST /v1/audio/speech，响应为原始音频",
  },
  {
    id: "minimax-image",
    name: "MiniMax 图像（image-01 / image-01-live）",
    capability: "image",
    mode: "sync",
    endpoint: "/v1/image_generation",
    requestMap: {
      model: "$model",
      prompt: "$prompt",
      aspect_ratio: "$sizeRatio",
      n: "$count",
      response_format: { value: "base64" },
    },
    response: { path: "data.image_urls", encoding: "none", mime: "image/png" },
    description: "MiniMax 专有：POST /v1/image_generation，响应 data.image_urls（url 或 base64）",
  },
  {
    id: "minimax-tts",
    name: "MiniMax 语音（speech-2.8-hd / turbo）",
    capability: "tts",
    mode: "sync",
    endpoint: "/v1/t2a_v2",
    requestMap: {
      model: "$model",
      text: "$text",
      stream: { value: false },
      "voice_setting.voice_id": "$voice",
      "voice_setting.speed": { value: 1 },
      "voice_setting.vol": { value: 1 },
      "voice_setting.pitch": { value: 0 },
      "audio_setting.format": "$format",
      "audio_setting.sample_rate": { value: 32000 },
    },
    response: { path: "data.audio", encoding: "hex", mime: "audio/mpeg" },
    voices: [
      "male-qn-qingse",
      "male-qn-jingying",
      "male-qn-daxuesheng",
      "male-qn-badao",
      "male-qn-chengshu",
      "male-qn-shilang",
      "male-qn-yange",
      "female-yujie",
      "female-qn-jingling",
      "female-qn-qingxin",
      "female-qn-tianmei",
      "female-qn-wenrou",
      "female-qn-yujie",
      "female-shaonv",
      "female-chengshu",
      "female-tianmei",
    ],
    description: "MiniMax 专有：POST /v1/t2a_v2，响应 data.audio（HEX 编码音频）",
  },
  {
    id: "dashscope-image",
    name: "阿里百炼 万相（wanx-v1）",
    capability: "image",
    mode: "async",
    endpoint: "/api/v1/services/aigc/text2image/image-synthesis",
    headers: { "X-DashScope-Async": "enable" },
    requestMap: {
      model: "$model",
      "input.prompt": "$prompt",
      "parameters.size": "$sizeString",
      "parameters.n": "$count",
    },
    poll: {
      endpoint: "/api/v1/tasks/{taskId}",
      taskIdPath: "output.task_id",
      statusPath: "output.task_status",
      successWhen: "SUCCEEDED",
      failedWhen: "FAILED",
      resultPath: "output.results",
      resultItemPath: "url",
      intervalMs: 1500,
      maxPolls: 60,
    },
    response: { encoding: "none", mime: "image/png" },
    description: "阿里百炼任务式：提交 image-synthesis → 轮询 tasks/{id} → OSS URL。base_url 填 https://{workspaceId}.cn-beijing.maas.aliyuncs.com",
  },
  {
    id: "dashscope-tts",
    name: "阿里百炼 CosyVoice（cosyvoice-v2）",
    capability: "tts",
    mode: "async",
    endpoint: "/api/v1/services/audio/tts/speech-synthesis",
    headers: { "X-DashScope-Async": "enable" },
    requestMap: {
      model: "$model",
      "input.text": "$text",
      "parameters.voice": "$voice",
      "parameters.format": "$format",
    },
    poll: {
      endpoint: "/api/v1/tasks/{taskId}",
      taskIdPath: "output.task_id",
      statusPath: "output.task_status",
      successWhen: "SUCCEEDED",
      failedWhen: "FAILED",
      resultPath: "output.results",
      resultItemPath: "audio_url",
      intervalMs: 1500,
      maxPolls: 60,
    },
    response: { encoding: "none", mime: "audio/mpeg" },
    voices: [
      "longxiaochun",
      "longxiaoxia",
      "longshu",
      "longhua",
      "longchen",
      "longjing",
      "longxiaozhang",
      "longyue",
      "longzhou",
      "longxiang",
    ],
    description: "阿里百炼任务式语音合成：提交 speech-synthesis → 轮询 → audio_url。模型示例 cosyvoice-v2 / cosyvoice-v1；如字段有差异可在自定义模板中调整",
  },
  {
    id: "gemini-image",
    name: "Google Gemini（gemini-2.5-flash-image / 2.0-flash-exp）",
    capability: "image",
    mode: "sync",
    endpoint: "/v1beta/models/{model}:generateContent",
    requestMap: {
      "contents[0].parts[0].text": "$prompt",
      "generationConfig.responseModalities": { value: ["IMAGE"] },
    },
    response: { path: "candidates", encoding: "base64", mime: "image/png" },
    description:
      "Google 图像生成：POST /v1beta/models/{model}:generateContent，响应 candidates[0].content.parts[0].inlineData.data。base_url 填 https://generativelanguage.googleapis.com",
  },
  {
    id: "stability-image",
    name: "Stability AI（stable-image-core / sd3.5 / sdxl）",
    capability: "image",
    mode: "sync",
    endpoint: "/v1/generation/{model}/text-to-image",
    contentType: "form",
    auth: { type: "header", name: "Authorization" },
    rawResponse: true,
    requestMap: {
      prompt: "$prompt",
      aspect_ratio: "$sizeRatio",
      output_format: { value: "png" },
    },
    response: { mime: "image/png" },
    description:
      "Stability AI 专有：multipart/form-data POST，响应为原始 PNG 二进制。key 填 sk-...（Authorization: sk-...，不带 Bearer）",
  },
];

export function getTemplate(id: string | undefined): AdapterTemplate | undefined {
  return PRESET_TEMPLATES.find((t) => t.id === id);
}

/** 解析配置对应的适配器模板：优先自定义模板，其次预置模板 */
export function resolveTemplate(cfg: { adapter?: string; extra?: Record<string, unknown> }): AdapterTemplate | undefined {
  const custom = cfg.extra?.customTemplate;
  if (typeof custom === "string" && custom.trim()) {
    try {
      const parsed = JSON.parse(custom) as AdapterTemplate;
      if (parsed && parsed.endpoint && parsed.requestMap) return parsed;
    } catch {
      /* 自定义模板解析失败则回退预置 */
    }
  }
  return getTemplate(cfg.adapter);
}

export function templatesForCapability(capability: "image" | "tts"): AdapterTemplate[] {
  return PRESET_TEMPLATES.filter((t) => t.capability === capability);
}
