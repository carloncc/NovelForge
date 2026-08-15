import { reactive, ref, watch } from "vue";
import type { ApiConfig, ApiPreset, ChannelKey } from "../core/types";
import { tauri } from "../utils/tauri";
import { getTemplate } from "../api/templates";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONCURRENCY_BY_CHANNEL,
  loadConfigFile,
  UnsupportedConfigVersionError,
  type ConfigFile,
} from "./configMigration";
import { log } from "../utils/logger";

export function addRecentOutputDir(dir: string): void {
  if (!dir) return;
  configState.recentOutputDirs = [dir, ...(configState.recentOutputDirs ?? []).filter((d) => d !== dir)].slice(0, 8);
}

export function removeRecentOutputDir(dir: string): void {
  configState.recentOutputDirs = (configState.recentOutputDirs ?? []).filter((d) => d !== dir);
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const DEFAULT_VOICE_LIBRARY = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
  "anna",
  "bella",
  "harry",
  "jack",
  "jim",
  "lily",
  "marvin",
  "meimei",
  "roger",
  "sarah",
  "xuanxuan",
];

export function defaultApiConfig(kind: ChannelKey): ApiConfig {
  const defaults: Partial<Record<ChannelKey, { baseUrl: string; model: string }>> = {
    llm: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
    vision: { baseUrl: "https://api.siliconflow.cn/v1", model: "zai-org/GLM-4.6V" },
    image: { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen-Image-Edit-2509" },
    tts: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/CosyVoice2-0.5B" },
  };
  const d = defaults[kind]!;
  return {
    id: makeId(),
    name: kind === "llm" ? "文本模型" : kind === "vision" ? "图片识别模型" : kind === "image" ? "图像模型" : "语音模型",
    baseUrl: d.baseUrl,
    apiKey: "",
    model: d.model,
    concurrency: DEFAULT_CONCURRENCY_BY_CHANNEL[kind],
    extra: kind === "tts"
      ? { voiceLibrary: [...DEFAULT_VOICE_LIBRARY] }
      : kind === "image"
        ? { provider: "siliconflow", protocol: "siliconflow-image" }
        : {},
  };
}

export function voiceLibraryFor(cfg: ApiConfig | undefined): string[] {
  const lib = cfg?.extra?.voiceLibrary;
  const base = Array.isArray(lib) && lib.length ? (lib as string[]) : DEFAULT_VOICE_LIBRARY;
  // 合并模板自带音色
  const tplVoices = cfg?.adapter ? (getTemplate(cfg.adapter)?.voices ?? []) : [];
  return Array.from(new Set([...base, ...tplVoices]));
}

/** 应用服务商模板：填入 base_url / model / adapter / 音色库 */
export function applyTemplate(cfg: ApiConfig, templateId: string): void {
  const tpl = getTemplate(templateId);
  if (!tpl) return;
  cfg.adapter = templateId;
  const defaults: Record<string, { baseUrl: string; model: string }> = {
    "openai-image": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-3-flash" },
    "openai-tts": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-voice" },
    "minimax-image": { baseUrl: "https://api.minimaxi.com", model: "image-01" },
    "minimax-tts": { baseUrl: "https://api.minimaxi.com", model: "speech-2.8-hd" },
    "dashscope-image": { baseUrl: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com", model: "wanx-v1" },
    "dashscope-tts": { baseUrl: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com", model: "cosyvoice-v2" },
  };
  const d = defaults[templateId];
  if (d) {
    cfg.baseUrl = d.baseUrl;
    cfg.model = d.model;
  }
  if (tpl.voices?.length) {
    cfg.extra!.voiceLibrary = tpl.voices;
  }
}

export function createApiPreset(name: string): ApiPreset {
  const llm = defaultApiConfig("llm");
  const vision = defaultApiConfig("vision");
  const image = defaultApiConfig("image");
  const tts = defaultApiConfig("tts");
  return {
    id: makeId(),
    name,
    channels: { llm: [llm], vision: [vision], image: [image], tts: [tts] },
    active: { llm: llm.id, vision: vision.id, image: image.id, tts: tts.id },
  };
}

const initialPreset = createApiPreset("默认配置");

export const configState = reactive<ConfigFile>({
  configSchemaVersion: CONFIG_SCHEMA_VERSION,
  presets: [initialPreset],
  activePresetId: initialPreset.id,
  outputDir: "",
  recentOutputDirs: [],
});
let configPersistenceBlocked = false;
let lastPersistedContent = "";
let pendingMigrationContent = "";
let migrationRetryTimer: number | undefined;
export const configPersistenceError = ref("");
void loadPersisted();

async function loadPersisted() {
  try {
    const raw = await tauri.readConfig();
    if (!raw || raw === "{}") return;
    const loaded = await loadConfigFile(raw, {
      createId: makeId,
      createVisionDefault: () => defaultApiConfig("vision"),
      writeConfig: (content) => tauri.writeConfig(content),
    });
    const parsed = loaded.config;
    if (loaded.migrationPending) {
      configPersistenceBlocked = true;
      pendingMigrationContent = JSON.stringify(parsed);
      configPersistenceError.value = `旧配置已恢复，但迁移结果暂时无法保存：${loaded.migrationSaveError?.message ?? "未知错误"}`;
      scheduleMigrationRetry();
    } else {
      lastPersistedContent = JSON.stringify(parsed);
    }
    if (parsed.presets.length) {
      configState.presets = parsed.presets;
      configState.activePresetId = parsed.activePresetId || parsed.presets[0].id;
    }
    configState.configSchemaVersion = CONFIG_SCHEMA_VERSION;
    configState.outputDir = parsed.outputDir || "";
    configState.recentOutputDirs = parsed.recentOutputDirs ?? [];
  } catch (error) {
    if (error instanceof UnsupportedConfigVersionError) {
      configPersistenceBlocked = true;
      configPersistenceError.value = error.message;
      log.error("config", "配置文件来自更高版本，已停止写入以保护原配置", { error: error.message });
    }
  }
}

let saveTimer: number | undefined;

function persistedConfigContent(): string {
  return JSON.stringify({
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    presets: configState.presets,
    activePresetId: configState.activePresetId,
    outputDir: configState.outputDir,
    recentOutputDirs: configState.recentOutputDirs,
  });
}

function scheduleMigrationRetry(): void {
  if (!pendingMigrationContent || migrationRetryTimer !== undefined) return;
  migrationRetryTimer = window.setTimeout(() => {
    migrationRetryTimer = undefined;
    void retryMigrationPersistence();
  }, 3000);
}

async function retryMigrationPersistence(): Promise<void> {
  const migratedContent = pendingMigrationContent;
  if (!migratedContent) return;
  try {
    await tauri.writeConfig(migratedContent);
  } catch (error) {
    configPersistenceError.value = `配置迁移仍无法保存：${error instanceof Error ? error.message : String(error)}`;
    scheduleMigrationRetry();
    return;
  }

  pendingMigrationContent = "";
  lastPersistedContent = migratedContent;
  configPersistenceBlocked = false;
  configPersistenceError.value = "";
  const currentContent = persistedConfigContent();
  if (currentContent === lastPersistedContent) return;
  try {
    await tauri.writeConfig(currentContent);
    lastPersistedContent = currentContent;
  } catch (error) {
    configPersistenceError.value = `配置自动保存失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

watch(
  () =>
    JSON.stringify({
      presets: configState.presets,
      activePresetId: configState.activePresetId,
      outputDir: configState.outputDir,
      recentOutputDirs: configState.recentOutputDirs,
    }),
  () => {
    if (configPersistenceBlocked) return;
    if (persistedConfigContent() === lastPersistedContent) return;
    if (saveTimer) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      const content = persistedConfigContent();
      if (content === lastPersistedContent) return;
      void tauri
        .writeConfig(content)
        .then(() => { lastPersistedContent = content; })
        .catch(() => {});
    }, 500);
  },
  { deep: true },
);

export function activePreset(): ApiPreset {
  const p = configState.presets.find((p) => p.id === configState.activePresetId);
  return p || configState.presets[0];
}

export function activeConfig(kind: ChannelKey): ApiConfig | undefined {
  const preset = activePreset();
  const id = preset.active[kind];
  if (id) {
    const found = preset.channels[kind].find((c) => c.id === id);
    if (found) return found;
  }
  return preset.channels[kind][0];
}

export function addConfig(kind: ChannelKey): void {
  const preset = activePreset();
  const cfg = defaultApiConfig(kind);
  preset.channels[kind].push(cfg);
  preset.active[kind] = cfg.id;
}

export function removeConfig(kind: ChannelKey, id: string): void {
  const preset = activePreset();
  const list = preset.channels[kind];
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  list.splice(idx, 1);
  if (preset.active[kind] === id) {
    preset.active[kind] = list[0]?.id ?? "";
  }
}

export function addPreset(): void {
  const preset = createApiPreset(`配置组 ${configState.presets.length + 1}`);
  configState.presets.push(preset);
  configState.activePresetId = preset.id;
}

export function removePreset(id: string): void {
  if (configState.presets.length <= 1) return;
  const idx = configState.presets.findIndex((p) => p.id === id);
  if (idx < 0) return;
  configState.presets.splice(idx, 1);
  if (configState.activePresetId === id) {
    configState.activePresetId = configState.presets[0].id;
  }
}
