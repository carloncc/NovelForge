import { reactive, ref, watch } from "vue";
import type { ApiConfig, ApiPreset, ChannelKey, VoiceProfile } from "../core/types";
import { t } from "../i18n";
import { tauri } from "../utils/tauri";
import { getTemplate } from "../api/templates";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONCURRENCY_BY_CHANNEL,
  DEFAULT_CUTOUT_SETTINGS,
  loadConfigFile,
  configSecrets,
  serializeConfigFile,
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
    name: kind === "llm" ? t("文本模型") : kind === "vision" ? t("图片识别模型") : kind === "image" ? t("图像模型") : t("语音模型"),
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
  if (Array.isArray(lib)) {
    // 显式列表（含被用户清空成 []）以用户为准，不再回填 17 个默认音色（此前清空无效）；
    // #1139：清空后配音不可用（各 TTS 服务均无名为 "default" 的音色），调用方须先校验
    // 空库并提示用户补充音色，禁止再静默回退字面量 "default" 逐句失败重试。
    return Array.from(new Set((lib as string[]).map((v) => String(v)).filter(Boolean)));
  }
  // 未设置过（undefined）：默认音色 + 适配器模板音色
  const tplVoices = cfg?.adapter ? (getTemplate(cfg.adapter)?.voices ?? []) : [];
  return Array.from(new Set([...DEFAULT_VOICE_LIBRARY, ...tplVoices]));
}

/** 音色库为空时的可读错误（#1139）：配音阶段直接抛它，而不是逐句请求假音色 "default" */
export const VOICE_LIBRARY_EMPTY_MESSAGE =
  "音色库为空：配音不可用，请先在「API 配置 > TTS 配音 > 音色列表」中填写至少一个可用音色（每行一个）。";

/** 音色库是否为空（显式清空的 [] 才算空；undefined 回退默认表，不算空） */
export function isVoiceLibraryEmpty(cfg: ApiConfig | undefined): boolean {
  return voiceLibraryFor(cfg).length === 0;
}

/** 取出可用音色库：为空时抛可读错误（#1139），调用方据此阻止配音阶段 */
export function requireVoiceLibrary(cfg: ApiConfig | undefined): string[] {
  const lib = voiceLibraryFor(cfg);
  if (!lib.length) throw new Error(VOICE_LIBRARY_EMPTY_MESSAGE);
  return lib;
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

const initialPreset = createApiPreset(t("默认配置"));

export const configState = reactive<ConfigFile>({
  configSchemaVersion: CONFIG_SCHEMA_VERSION,
  presets: [initialPreset],
  activePresetId: initialPreset.id,
  outputDir: "",
  recentOutputDirs: [],
  projects: [],
  voiceProfiles: [],
  cutout: { ...DEFAULT_CUTOUT_SETTINGS },
});
let configPersistenceBlocked = false;
let lastPersistedContent = "";
/** 上次成功落盘的密钥签名：仅改/清空 apiKey 时脱敏 content 不变，必须靠它识别"真有变化" */
let lastPersistedSecrets = "";
function secretsSignature(): string {
  return JSON.stringify(configSecrets(configState));
}
let pendingMigrationContent = "";
let pendingMigrationSecrets: Record<string, string> = {};
let migrationRetryTimer: number | undefined;
let secretStoreUnavailable = false;
export const configPersistenceError = ref("");
export const configReady = loadPersisted();

async function loadPersisted() {
  try {
    const raw = await tauri.readConfig();
    if (!raw || raw === "{}") return;
    const loaded = await loadConfigFile(raw, {
      createId: makeId,
      createVisionDefault: () => defaultApiConfig("vision"),
      writeConfig: (content) => tauri.writeConfig(content),
      readSecrets: (ids) => tauri.readApiSecrets(ids),
      writeSecrets: (secrets) => tauri.writeApiSecrets(secrets),
    });
    const parsed = loaded.config;
    if (loaded.migrationPending) {
      configPersistenceBlocked = true;
      pendingMigrationContent = serializeConfigFile(parsed);
      pendingMigrationSecrets = configSecrets(parsed);
      configPersistenceError.value = t("旧配置已恢复，但迁移结果暂时无法保存：{error}", { error: loaded.migrationSaveError?.message ?? t("未知错误") });
      scheduleMigrationRetry();
    } else {
      lastPersistedContent = serializeConfigFile(parsed);
      lastPersistedSecrets = JSON.stringify(configSecrets(parsed));
    }
    if (loaded.secretStoreError) {
      secretStoreUnavailable = true;
      configPersistenceBlocked = true;
      configPersistenceError.value = t("系统凭据库暂时不可用：{error}", { error: loaded.secretStoreError.message });
    }
    if (parsed.presets.length) {
      configState.presets = parsed.presets;
      configState.activePresetId = parsed.activePresetId || parsed.presets[0].id;
    }
    configState.configSchemaVersion = CONFIG_SCHEMA_VERSION;
    configState.outputDir = parsed.outputDir || "";
    configState.recentOutputDirs = parsed.recentOutputDirs ?? [];
    configState.projects = parsed.projects ?? [];
    configState.voiceProfiles = parsed.voiceProfiles ?? [];
    configState.cutout = parsed.cutout ?? { ...DEFAULT_CUTOUT_SETTINGS };
  } catch (error) {
    configPersistenceBlocked = true;
    if (error instanceof UnsupportedConfigVersionError) {
      configPersistenceError.value = error.message;
      log.error("config", "配置文件来自更高版本，已停止写入以保护原配置", { error: error.message });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      configPersistenceError.value = t("配置文件读取失败，已停止写入以保护原配置：{message}", { message });
      log.error("config", "配置文件读取失败，已停止写入以保护原配置", { error: message });
    }
  }
}

let saveTimer: number | undefined;

function persistedConfigContent(): string {
  return serializeConfigFile({
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    presets: configState.presets,
    activePresetId: configState.activePresetId,
    outputDir: configState.outputDir,
    recentOutputDirs: configState.recentOutputDirs,
    projects: configState.projects,
    voiceProfiles: configState.voiceProfiles,
    cutout: configState.cutout,
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
    await tauri.writeApiSecrets(pendingMigrationSecrets);
    await tauri.writeConfig(migratedContent);
  } catch (error) {
    configPersistenceError.value = t("配置迁移仍无法保存：{error}", { error: error instanceof Error ? error.message : String(error) });
    scheduleMigrationRetry();
    return;
  }

  pendingMigrationContent = "";
  pendingMigrationSecrets = {};
  lastPersistedContent = migratedContent;
  lastPersistedSecrets = JSON.stringify(configSecrets(configState));
  configPersistenceBlocked = secretStoreUnavailable;
  configPersistenceError.value = secretStoreUnavailable ? configPersistenceError.value : "";
  const currentContent = persistedConfigContent();
  if (currentContent === lastPersistedContent) return;
  try {
    await tauri.writeApiSecrets(configSecrets(configState));
    await tauri.writeConfig(currentContent);
    lastPersistedContent = currentContent;
  } catch (error) {
    configPersistenceError.value = t("配置自动保存失败：{error}", { error: error instanceof Error ? error.message : String(error) });
  }
}

watch(
  () =>
    JSON.stringify({
      presets: configState.presets,
      activePresetId: configState.activePresetId,
      outputDir: configState.outputDir,
      recentOutputDirs: configState.recentOutputDirs,
      projects: configState.projects,
      voiceProfiles: configState.voiceProfiles,
      cutout: configState.cutout,
    }),
  () => {
    if (configPersistenceBlocked) return;
    // 密钥也参与比较：仅改/清空 apiKey 时脱敏 content 不变，此前会被误判为"无变化"而不落盘
    if (persistedConfigContent() === lastPersistedContent && secretsSignature() === lastPersistedSecrets) return;
    if (saveTimer) return;
    saveTimer = (typeof window === "undefined" ? globalThis.setTimeout : window.setTimeout)(() => {
      saveTimer = undefined;
      const content = persistedConfigContent();
      const secrets = configSecrets(configState);
      const secretsSig = JSON.stringify(secrets);
      if (content === lastPersistedContent && secretsSig === lastPersistedSecrets) return;
      void tauri
        .writeApiSecrets(secrets)
        .then(() => tauri.writeConfig(content))
        .then(() => {
          lastPersistedContent = content;
          lastPersistedSecrets = secretsSig;
          // UI81：自动保存恢复正常后清掉上次的失败横幅；迁移/凭据阻塞态由 configPersistenceBlocked 保留
          if (!configPersistenceBlocked) configPersistenceError.value = "";
        })
        .catch((error) => {
          configPersistenceError.value = t("配置自动保存失败：{error}", { error: error instanceof Error ? error.message : String(error) });
        });
    }, 500) as unknown as number;
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

export function ttsConfigById(id: string): ApiConfig | undefined {
  return configState.presets.flatMap((preset) => preset.channels.tts).find((config) => config.id === id);
}

export function voiceProfileById(id: string | undefined): VoiceProfile | undefined {
  return id ? configState.voiceProfiles.find((profile) => profile.id === id) : undefined;
}

export function upsertVoiceProfile(profile: VoiceProfile): void {
  const index = configState.voiceProfiles.findIndex((current) => current.id === profile.id);
  if (index < 0) configState.voiceProfiles.push(profile);
  else configState.voiceProfiles[index] = profile;
}

export function removeVoiceProfile(id: string): VoiceProfile | undefined {
  const index = configState.voiceProfiles.findIndex((profile) => profile.id === id);
  return index < 0 ? undefined : configState.voiceProfiles.splice(index, 1)[0];
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
  void tauri.writeApiSecrets({ [id]: "" }).catch((error) => {
    configPersistenceError.value = t("删除系统凭据失败：{error}", { error: error instanceof Error ? error.message : String(error) });
  });
  if (preset.active[kind] === id) {
    preset.active[kind] = list[0]?.id ?? "";
  }
}

export function addPreset(): void {
  const preset = createApiPreset(t("配置组 {n}", { n: configState.presets.length + 1 }));
  configState.presets.push(preset);
  configState.activePresetId = preset.id;
}

export function removePreset(id: string): void {
  if (configState.presets.length <= 1) return;
  const idx = configState.presets.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const removedSecrets = Object.fromEntries(
    Object.values(configState.presets[idx].channels).flat().map((config) => [config.id, ""]),
  );
  configState.presets.splice(idx, 1);
  void tauri.writeApiSecrets(removedSecrets).catch((error) => {
    configPersistenceError.value = t("删除系统凭据失败：{error}", { error: error instanceof Error ? error.message : String(error) });
  });
  if (configState.activePresetId === id) {
    configState.activePresetId = configState.presets[0].id;
  }
}
