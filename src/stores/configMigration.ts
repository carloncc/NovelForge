import type { ApiConfig, ApiPreset, ChannelKey } from "../core/types";

export const CONFIG_SCHEMA_VERSION = 2 as const;

export interface ConfigFile {
  configSchemaVersion: typeof CONFIG_SCHEMA_VERSION;
  presets: ApiPreset[];
  activePresetId: string;
  outputDir?: string;
  recentOutputDirs?: string[];
}

export interface ConfigMigrationResult {
  config: ConfigFile;
  migrated: boolean;
}

type ConfigFactory = () => ApiConfig;

export interface ConfigLoadOptions {
  createId: () => string;
  createVisionDefault: ConfigFactory;
  writeConfig: (content: string) => Promise<void>;
}

export interface ConfigLoadResult {
  config: ConfigFile;
  migrationPending: boolean;
  migrationSaveError?: Error;
}

export class UnsupportedConfigVersionError extends Error {
  constructor(version: unknown) {
    super(`不支持的配置版本：${String(version)}`);
    this.name = "UnsupportedConfigVersionError";
  }
}

function recordOrEmpty(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

function normalizedConfig(input: unknown, createId: () => string, defaultName: string): ApiConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const config = input as Record<string, unknown>;
  const cloned = JSON.parse(JSON.stringify(config)) as ApiConfig;
  cloned.id = typeof config.id === "string" && config.id.trim() ? config.id : createId();
  cloned.name = typeof config.name === "string" && config.name.trim() ? config.name : defaultName;
  cloned.apiKey = typeof config.apiKey === "string" ? config.apiKey : "";
  cloned.baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
  cloned.model = typeof config.model === "string" ? config.model : "";
  cloned.extra = config.extra && typeof config.extra === "object" && !Array.isArray(config.extra)
    ? JSON.parse(JSON.stringify(config.extra)) as Record<string, unknown>
    : {};
  return cloned;
}

function configArray(input: unknown, createId: () => string, defaultName: string): ApiConfig[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((config) => normalizedConfig(config, createId, defaultName))
    .filter((config): config is ApiConfig => Boolean(config));
}

function activeId(active: Record<string, unknown>, kind: ChannelKey): string {
  return typeof active[kind] === "string" ? active[kind] as string : "";
}

function cloneConfig(config: ApiConfig): ApiConfig {
  return JSON.parse(JSON.stringify(config)) as ApiConfig;
}

function migratedVisionConfig(
  llmConfigs: ApiConfig[],
  activeLlmId: string,
  createId: () => string,
  createVisionDefault: ConfigFactory,
): ApiConfig {
  const selectedLlm = llmConfigs.find((config) => config.id === activeLlmId && config.baseUrl.trim() && config.model.trim());
  const usableLlm = selectedLlm ?? llmConfigs.find((config) => config.baseUrl.trim() && config.model.trim());
  const vision = usableLlm
    ? cloneConfig(usableLlm)
    : normalizedConfig(createVisionDefault(), createId, "图片识别模型")!;
  vision.id = createId();
  vision.name = usableLlm ? `${usableLlm.name}（图片识别）` : vision.name;
  vision.extra ??= {};
  return vision;
}

function normalizePreset(
  input: unknown,
  shouldMigrate: boolean,
  createId: () => string,
  createVisionDefault: ConfigFactory,
): ApiPreset {
  const preset = recordOrEmpty(input);
  const channels = recordOrEmpty(preset.channels);
  const active = recordOrEmpty(preset.active);
  const llm = configArray(channels.llm, createId, "文本模型");
  let vision = configArray(channels.vision, createId, "图片识别模型");
  const image = configArray(channels.image, createId, "图像模型");
  const tts = configArray(channels.tts, createId, "语音模型");
  let visionId = activeId(active, "vision");

  if (shouldMigrate && vision.length === 0) {
    const migratedVision = migratedVisionConfig(llm, activeId(active, "llm"), createId, createVisionDefault);
    vision = [migratedVision];
    visionId = migratedVision.id;
  } else if (!vision.some((config) => config.id === visionId)) {
    visionId = vision[0]?.id ?? "";
  }

  return {
    id: typeof preset.id === "string" ? preset.id : createId(),
    name: typeof preset.name === "string" ? preset.name : "配置组",
    channels: {
      llm,
      vision,
      image,
      tts,
    },
    active: {
      llm: llm.some((config) => config.id === activeId(active, "llm")) ? activeId(active, "llm") : llm[0]?.id ?? "",
      vision: visionId,
      image: image.some((config) => config.id === activeId(active, "image")) ? activeId(active, "image") : image[0]?.id ?? "",
      tts: tts.some((config) => config.id === activeId(active, "tts")) ? activeId(active, "tts") : tts[0]?.id ?? "",
    },
  };
}

export function migrateConfigFile(
  input: unknown,
  createId: () => string,
  createVisionDefault: ConfigFactory,
): ConfigMigrationResult {
  const root = recordOrEmpty(input);
  const version = root.configSchemaVersion;
  if (version !== undefined && version !== 1 && version !== CONFIG_SCHEMA_VERSION) {
    throw new UnsupportedConfigVersionError(version);
  }
  const shouldMigrate = version === undefined || version === 1;
  const presets = Array.isArray(root.presets)
    ? root.presets.map((preset) => normalizePreset(preset, shouldMigrate, createId, createVisionDefault))
    : [];

  return {
    migrated: shouldMigrate,
    config: {
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      presets,
      activePresetId: typeof root.activePresetId === "string" ? root.activePresetId : presets[0]?.id ?? "",
      outputDir: typeof root.outputDir === "string" ? root.outputDir : "",
      recentOutputDirs: Array.isArray(root.recentOutputDirs)
        ? root.recentOutputDirs.filter((dir): dir is string => typeof dir === "string")
        : [],
    },
  };
}

export async function loadConfigFile(raw: string, options: ConfigLoadOptions): Promise<ConfigLoadResult> {
  const migration = migrateConfigFile(JSON.parse(raw), options.createId, options.createVisionDefault);
  if (!migration.migrated) return { config: migration.config, migrationPending: false };
  try {
    await options.writeConfig(JSON.stringify(migration.config));
    return { config: migration.config, migrationPending: false };
  } catch (error) {
    return {
      config: migration.config,
      migrationPending: true,
      migrationSaveError: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
