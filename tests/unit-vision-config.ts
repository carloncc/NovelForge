import type { ApiConfig } from "../src/core/types";
import { chatVision, RETRY_DELAYS, testVision, VisionApiError } from "../src/api/openaiCompatible";
import { PROVIDERS, protocolForConfig } from "../src/api/providers";
import { loadConfigFile, migrateConfigFile } from "../src/stores/configMigration";
import { createApiPreset, defaultApiConfig } from "../src/stores/config";
import { verifyImage } from "../src/core/selfcheck";
import { tauri } from "../src/utils/tauri";
import { inflateSync } from "node:zlib";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function legacyPreset(): Record<string, unknown> {
  const llm: ApiConfig = {
    id: "llm-active",
    name: "文本模型",
    baseUrl: "https://text.example/v1",
    apiKey: "sk-text",
    model: "text-model",
    extra: { provider: "custom", nested: { timeout: 30 } },
  };
  return {
    id: "preset-1",
    name: "旧配置",
    channels: {
      llm: [llm],
      image: [{ id: "image-1", name: "图像", baseUrl: "https://image.example", apiKey: "sk-image", model: "old-image" }],
      tts: [{ id: "tts-1", name: "语音", baseUrl: "https://tts.example", apiKey: "sk-tts", model: "old-tts" }],
    },
    active: { llm: llm.id, image: "image-1", tts: "tts-1" },
  };
}

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: "vision-1",
    name: "图片识别",
    baseUrl: "https://vision.example/v1",
    apiKey: "sk-vision",
    model: "vision-model",
    ...overrides,
  };
}

function encodedJson(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function main(): Promise<void> {
  const legacy = {
    presets: [legacyPreset()],
    activePresetId: "preset-1",
    outputDir: "D:/exports",
  };
  const firstMigration = migrateConfigFile(legacy, () => "vision-new", () => defaultApiConfig("vision"));
  assert(firstMigration.migrated, "旧配置应迁移到 schema v2");
  assert(firstMigration.config.configSchemaVersion === 2, "迁移后应写入 schema v2");
  const migratedPreset = firstMigration.config.presets[0];
  assert(migratedPreset.channels.vision.length === 1, "每个旧配置组应创建一个图片识别配置");
  assert(migratedPreset.active.vision === "vision-new", "新图片识别配置应成为当前配置");
  assert(migratedPreset.channels.vision[0].model === "text-model", "迁移应复制当前文本模型");
  assert(migratedPreset.channels.vision[0].apiKey === "sk-text", "迁移应保留文本配置凭据");
  assert(migratedPreset.active.llm === "llm-active", "迁移应保留原文本模型选择");
  assert(migratedPreset.channels.vision[0].name !== migratedPreset.channels.llm[0].name, "视觉配置应使用独立名称");
  assert(migratedPreset.channels.image[0].model === "old-image", "迁移不得改写已有图片模型");
  assert(migratedPreset.channels.vision[0] !== migratedPreset.channels.llm[0], "图片识别配置不能与文本配置共享对象");
  assert(migratedPreset.channels.vision[0].extra !== migratedPreset.channels.llm[0].extra, "extra 必须深拷贝");
  (migratedPreset.channels.vision[0].extra!.nested as { timeout: number }).timeout = 90;
  assert((migratedPreset.channels.llm[0].extra!.nested as { timeout: number }).timeout === 30, "修改图片识别 extra 不应影响文本配置");

  const secondMigration = migrateConfigFile(firstMigration.config, () => "should-not-run", () => defaultApiConfig("vision"));
  assert(!secondMigration.migrated, "schema v2 配置不应重复迁移");
  assert(secondMigration.config.presets[0].channels.vision.length === 1, "重复加载不得再次克隆图片识别配置");
  assert(secondMigration.config.presets[0].active.vision === "vision-new", "重复加载应保留当前图片识别配置");

  const malformedMigration = migrateConfigFile({ presets: [{ id: "broken", name: "缺损配置", channels: {}, active: {} }] }, () => "fallback-vision", () => defaultApiConfig("vision"));
  const repairedPreset = malformedMigration.config.presets[0];
  assert(repairedPreset.channels.llm.length === 0, "缺损配置不应伪造文本凭据");
  assert(repairedPreset.channels.vision[0].model === "zai-org/GLM-4.6V", "无文本配置时应使用新的视觉默认值");

  const invalidActiveLlm = legacyPreset() as any;
  invalidActiveLlm.channels.llm = [
    { id: "bad", name: "损坏模型", baseUrl: "", apiKey: "sk-bad", model: "", extra: null },
    { id: "usable", name: "可用模型", baseUrl: "https://usable.example/v1", apiKey: "sk-good", model: "vision-capable" },
  ];
  invalidActiveLlm.active.llm = "bad";
  const usableFallback = migrateConfigFile(
    { presets: [invalidActiveLlm] },
    () => "vision-from-usable",
    () => defaultApiConfig("vision"),
  ).config.presets[0];
  assert(usableFallback.channels.vision[0].model === "vision-capable", "迁移不得克隆缺少 baseUrl/model 的活动文本配置");
  assert(usableFallback.active.llm === "bad", "残缺但有 ID 的活动配置必须维持活动选择");
  assert(usableFallback.channels.llm[0].id === "bad" && usableFallback.channels.llm[0].apiKey === "sk-bad", "残缺活动配置及其凭据不得被迁移丢弃");
  const retainedExtras: Record<string, unknown>[] = [];
  for (const channel of Object.values(usableFallback.channels)) {
    for (const retainedConfig of channel) {
      assert(retainedConfig.extra && typeof retainedConfig.extra === "object", "保留的每个 API 配置都应有独立 extra 对象");
      retainedExtras.push(retainedConfig.extra);
    }
  }
  assert(new Set(retainedExtras).size === retainedExtras.length, "不同 API 配置不得共享 extra 引用");

  const explicitV1 = migrateConfigFile({ ...legacy, configSchemaVersion: 1 }, () => "v1-vision", () => defaultApiConfig("vision"));
  assert(explicitV1.migrated && explicitV1.config.presets[0].active.vision === "v1-vision", "显式 schema v1 应执行同一迁移");

  assertThrows(
    () => migrateConfigFile({ ...legacy, configSchemaVersion: 3 }, () => "never", () => defaultApiConfig("vision")),
    "未来 schema 版本必须明确拒绝，不能降级改写",
  );
  const futureWrites: string[] = [];
  await assertRejects(
    () => loadConfigFile(JSON.stringify({ ...legacy, configSchemaVersion: 3 }), {
      createId: () => "never",
      createVisionDefault: () => defaultApiConfig("vision"),
      writeConfig: async (content) => { futureWrites.push(content); },
    }),
    "未来 schema 加载必须失败",
  );
  assert(futureWrites.length === 0, "未来 schema 被拒绝时不得写回配置");

  const persistedWrites: string[] = [];
  const persistenceOptions = {
    createId: () => "persisted-vision",
    createVisionDefault: () => defaultApiConfig("vision"),
    writeConfig: async (content: string) => { persistedWrites.push(content); },
  };
  const loadedLegacy = await loadConfigFile(JSON.stringify(legacy), persistenceOptions);
  assert(loadedLegacy.config.configSchemaVersion === 2 && persistedWrites.length === 1, "首次加载旧配置应立即持久化一次 v2");
  assert(!loadedLegacy.migrationSaveError, "成功迁移不应返回保存错误");
  await loadConfigFile(persistedWrites[0], persistenceOptions);
  assert(persistedWrites.length === 1, "重新加载已持久化 v2 不得再次写入或克隆");

  const rejectedPersistence = await loadConfigFile(JSON.stringify(legacy), {
    createId: () => "recovered-vision",
    createVisionDefault: () => defaultApiConfig("vision"),
    writeConfig: async () => { throw new Error("disk is read-only"); },
  });
  assert(rejectedPersistence.config.presets[0].active.vision === "recovered-vision", "保存失败时仍应返回并应用已恢复的迁移配置");
  assert(rejectedPersistence.migrationPending && rejectedPersistence.migrationSaveError?.message.includes("read-only"), "保存失败必须显式返回待持久化状态和错误");

  let partialId = 0;
  const partialMigration = migrateConfigFile({
    configSchemaVersion: 1,
    presets: [{
      id: "partial",
      name: "部分配置",
      channels: {
        llm: [{ id: "selected", baseUrl: "https://partial.example/v1", model: "partial-model" }],
        image: [{ baseUrl: "https://image.example/v1", model: "image-model", apiKey: "" }],
        tts: [],
      },
      active: { llm: "selected" },
    }],
  }, () => `generated-${++partialId}`, () => defaultApiConfig("vision"));
  const partialPreset = partialMigration.config.presets[0];
  assert(partialPreset.channels.llm[0].id === "selected" && partialPreset.active.llm === "selected", "可恢复配置必须维持活动选择");
  assert(partialPreset.channels.llm[0].apiKey === "" && partialPreset.channels.llm[0].name.length > 0, "缺少 name/apiKey 时应补齐而不是丢弃配置");
  assert(partialPreset.channels.image[0].id.startsWith("generated-") && partialPreset.channels.image[0].name.length > 0, "缺少 id/name 时应生成稳定运行时值");

  const visionDefault = defaultApiConfig("vision");
  const imageDefault = defaultApiConfig("image");
  assert(visionDefault.baseUrl === "https://api.siliconflow.cn/v1", "视觉默认服务应为硅基流动");
  assert(visionDefault.model === "zai-org/GLM-4.6V", "视觉默认模型错误");
  assert(imageDefault.model === "Qwen/Qwen-Image-Edit-2509", "图片默认模型应支持参考图编辑");
  assert(protocolForConfig(visionDefault, "vision") === "openai-chat", "视觉通道应使用 OpenAI 兼容聊天协议");
  const siliconFlow = PROVIDERS.find((provider) => provider.id === "siliconflow");
  assert(siliconFlow?.supports.vision && siliconFlow.defaults.vision === "zai-org/GLM-4.6V", "供应商能力应公开视觉通道及默认模型");
  const newPreset = createApiPreset("新配置");
  for (const kind of ["llm", "vision", "image", "tts"] as const) {
    assert(newPreset.active[kind] === newPreset.channels[kind][0].id, `新配置组应设置有效的 ${kind} active ID`);
  }

  const originalHttp = tauri.http;
  let requestBody: Record<string, any> | undefined;
  try {
    tauri.http = async (request) => {
      requestBody = JSON.parse(request.body ?? "{}") as Record<string, any>;
      return {
        status: 200,
        contentType: "application/json",
        bodyBase64: encodedJson({ choices: [{ message: { content: "A solid magenta square." } }] }),
      };
    };
    const description = await testVision(config());
    assert(description === "A solid magenta square.", "视觉探针应返回正确的洋红色描述");
    assert(requestBody?.model === "vision-model", "视觉探针应使用独立视觉模型");
    assert(requestBody?.temperature === 0, "视觉请求必须保留显式 temperature=0");
    const userContent = requestBody?.messages?.[1]?.content;
    assert(Array.isArray(userContent), "视觉探针应发送多模态用户消息");
    assert(userContent.some((part: any) => part.type === "image_url" && /^data:image\/png;base64,/.test(part.image_url?.url)), "视觉探针必须包含 PNG data URL");
    assertOpaqueMagentaPng(userContent.find((part: any) => part.type === "image_url").image_url.url);

    tauri.http = async () => ({
      status: 200,
      contentType: "application/json",
      bodyBase64: encodedJson({ choices: [{ message: { content: "The square is sky blue." } }] }),
    });
    const blueDescription = await testVision(config());
    assert(blueDescription.includes("sky blue"), "颜色命名不同（如 sky blue）也应视为已识别图片");

    tauri.http = async () => ({
      status: 200,
      contentType: "application/json",
      bodyBase64: encodedJson({ choices: [{ message: { content: "This is an image." } }] }),
    });
    await assertRejects(() => testVision(config()), "不包含可验证视觉内容的泛化响应必须失败");

    tauri.http = async () => ({
      status: 200,
      contentType: "application/json",
      bodyBase64: encodedJson({ choices: [{ message: { content: "I cannot determine the color." } }] }),
    });
    await assertRejects(() => testVision(config()), "明确表示看不清颜色的回答必须失败");

    tauri.http = async () => ({
      status: 200,
      contentType: "application/json",
      bodyBase64: encodedJson({ choices: [{ message: { content: "I am a text-only model and cannot view images." } }] }),
    });
    await assertRejects(() => testVision(config()), "文本模型拒绝看图时视觉测试必须失败");

    tauri.http = async () => ({
      status: 400,
      contentType: "application/json",
      bodyBase64: encodedJson({ error: { message: "This text-only model does not accept image_url content." } }),
    });
    await assertRejects(() => testVision(config()), "不接受 image_url 的模型错误必须失败");

    tauri.http = async () => ({
      status: 200,
      contentType: "application/json",
      bodyBase64: encodedJson({ choices: [{ message: { content: "   " } }] }),
    });
    await assertRejects(() => testVision(config()), "空视觉描述必须失败");

    tauri.http = async (request) => {
      requestBody = JSON.parse(request.body ?? "{}") as Record<string, any>;
      return { status: 200, contentType: "application/json", bodyBase64: encodedJson({ choices: [{ message: { content: "visible" } }] }) };
    };
    await chatVision(config(), "system", "user", "/9j/AA==", { imageMime: "image/jpeg" });
    assert(requestBody?.messages[1].content[1].image_url.url === "data:image/jpeg;base64,/9j/AA==", "JPEG 上传应保留 MIME");
    const webpDataUrl = "data:image/webp;base64,UklGRg==";
    await chatVision(config(), "system", "user", webpDataUrl);
    assert(requestBody?.messages[1].content[1].image_url.url === webpDataUrl, "已有 data URL 不得重复添加 PNG 前缀");

    tauri.http = async () => ({
      status: 200,
      contentType: "application/json",
      bodyBase64: encodedJson({ choices: [{ message: { content: "   " } }] }),
    });
    await assertVisionError(
      () => chatVision(config(), "system", "user", "raw-image"),
      "VISION_RESPONSE_INVALID",
      "chatVision 必须在中心拒绝空白内容",
    );

    tauri.http = async () => ({
      status: 200,
      contentType: "application/json",
      bodyBase64: encodedJson({ choices: [{ message: { content: "不符合：人物服装与要求不同。" } }] }),
    });
    const qualityJudgment = await verifyImage(config(), "raw-image", "角色应穿蓝色外套");
    assert(!qualityJudgment.ok, "模型作出的质量不通过判断应作为普通结果返回");

    tauri.http = async () => ({
      status: 400,
      contentType: "application/json",
      bodyBase64: encodedJson({ error: { message: "text-only model cannot accept image_url" } }),
    });
    await assertVisionError(
      () => verifyImage(config(), "raw-image", "角色要求"),
      "VISION_CAPABILITY_UNSUPPORTED",
      "自检不得吞掉文本模型/视觉能力错误",
    );

    const retryDelays = [...RETRY_DELAYS];
    RETRY_DELAYS.splice(0, RETRY_DELAYS.length, 0, 0);
    try {
      tauri.http = async () => ({
        status: 503,
        contentType: "application/json",
        bodyBase64: encodedJson({ error: "unavailable" }),
      });
      await assertVisionError(
        () => verifyImage(config(), "raw-image", "角色要求"),
        "VISION_UNAVAILABLE",
        "服务端重试耗尽后自检必须返回明确不可用错误",
      );
    } finally {
      RETRY_DELAYS.splice(0, RETRY_DELAYS.length, ...retryDelays);
    }
  } finally {
    tauri.http = originalHttp;
  }

  console.log("=== 独立视觉 API 配置测试通过 ===");
}

async function assertRejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
}

function assertThrows(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(message);
}

async function assertVisionError(operation: () => Promise<unknown>, code: string, message: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof VisionApiError && error.code === code, message);
    return;
  }
  throw new Error(message);
}

function assertOpaqueMagentaPng(dataUrl: string): void {
  const png = Buffer.from(dataUrl.split(",")[1], "base64");
  assert(png[25] === 2, "视觉探针 PNG 必须使用不带 alpha 的 RGB 色彩类型");
  const idatParts: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idatParts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(idatParts));
  assert(pixels.length >= 13, "视觉探针 PNG 像素数据必须完整");
  const size = Math.floor(Math.sqrt((pixels.length - 1) / 3));
  assert(size >= 16, `视觉探针应使用足够大的测试图（当前边长 ${size}）`);
  const stride = size * 3 + 1;
  for (let y = 0; y < size; y++) {
    const rowOffset = y * stride;
    assert(pixels[rowOffset] === 0, "视觉探针 PNG 行过滤器必须为 0");
    for (let x = 0; x < size; x++) {
      const p = rowOffset + 1 + x * 3;
      const r = pixels[p];
      const g = pixels[p + 1];
      const b = pixels[p + 2];
      assert(r === 255 && g === 0 && b === 255, `视觉探针像素必须全部为不透明品红，实际 (${r},${g},${b})`);
    }
  }
}

main().catch((error) => {
  console.error("失败:", error);
  process.exit(1);
});
