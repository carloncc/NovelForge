import type { ApiConfig, ApiPreset, ChannelKey, VoiceProfile } from "../core/types";
import { t } from "../i18n";

export const CONFIG_SCHEMA_VERSION = 3 as const;

/** 各通道默认并发数：文本/图像批量生成（各自独立）；识别默认串行；配音受 TTS 服务 RPM 限制（尤其 MiniMax），默认 1 最稳 */
export const DEFAULT_CONCURRENCY_BY_CHANNEL: Record<ChannelKey, number> = {
  llm: 3,
  vision: 1,
  image: 3,
  tts: 1,
};

/** 取某个 API 配置的并发数：配置了用配置值，否则用通道默认值 */
export function concurrencyFor(cfg: ApiConfig | undefined, kind: ChannelKey): number {
  const n = cfg?.concurrency;
  if (typeof n === "number" && Number.isFinite(n) && n >= 1) return Math.floor(n);
  return DEFAULT_CONCURRENCY_BY_CHANNEL[kind];
}

/** AI 抠图设置：抠图方式 + 所选模型（模型列表见 core/cutout/models.ts） */
export type CutoutMode = "ai" | "chroma" | "off";
export interface CutoutSettings {
  mode: CutoutMode;
  modelId: string;
}

export const DEFAULT_CUTOUT_SETTINGS: CutoutSettings = {
  mode: "ai",
  modelId: "isnet-anime",
};

export interface ConfigFile {
  configSchemaVersion: typeof CONFIG_SCHEMA_VERSION;
  presets: ApiPreset[];
  activePresetId: string;
  outputDir?: string;
  recentOutputDirs?: string[];
  /** 项目注册表：每个项目绑定小说＋输出目录，切换项目即切换目录和整套状态 */
  projects?: ProjectEntry[];
  voiceProfiles: VoiceProfile[];
  cutout?: CutoutSettings;
}

/** 已知项目（输出目录即项目键，快照里存着小说/素材/选项全套状态） */
export interface ProjectEntry {
  id: string;
  /** 显示名（默认取小说文件名去后缀） */
  name: string;
  outputDir: string;
  novelFileName: string;
  novelTitle: string;
  updatedAt: string;
}

export interface ConfigMigrationResult {
  config: ConfigFile;
  migrated: boolean;
  /** #1308：丢弃/改名/回填项的人类可读警告（UI 侧用 t key 占位展示，见下方 t() 调用） */
  warnings: string[];
  /** #1308：重复 id 改名映射（oldId→newId），用于密钥跟随 */
  renames: Array<{ oldId: string; newId: string }>;
}

type ConfigFactory = () => ApiConfig;

export interface ConfigLoadOptions {
  createId: () => string;
  createVisionDefault: ConfigFactory;
  writeConfig: (content: string) => Promise<void>;
  readSecrets: (ids: string[]) => Promise<Record<string, string>>;
  writeSecrets: (secrets: Record<string, string>) => Promise<void>;
}

export interface ConfigLoadResult {
  config: ConfigFile;
  migrationPending: boolean;
  migrationSaveError?: Error;
  secretStoreError?: Error;
  /** #1308：迁移警告透给 UI 横幅 */
  migrationWarnings?: string[];
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
  warnings?: string[],
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
    // #1308：回填需可见（尤其 v2 升级路径）
    warnings?.push(t("已自动补齐图片识别通道（沿用文本模型配置）"));
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
  if (version !== undefined && version !== 1 && version !== 2 && version !== 3 && version !== CONFIG_SCHEMA_VERSION) {
    throw new UnsupportedConfigVersionError(version);
  }
  // #1308：v2 无 vision 永不补——放宽到 version<3（undefined/1/2 均回填）
  const shouldAddVision = version === undefined || (typeof version === "number" && version < 3);
  const shouldMigrate = version !== CONFIG_SCHEMA_VERSION;
  const warnings: string[] = [];
  const presets = Array.isArray(root.presets)
    ? root.presets.map((preset) => normalizePreset(preset, shouldAddVision, createId, createVisionDefault, warnings))
    : [];
  const { repaired, renames } = repairDuplicateConfigIds(presets, createId);
  for (const r of renames) {
    warnings.push(t("配置 id 重复已自动改名：{old} → {new}（密钥已跟随）", { old: r.oldId, new: r.newId }));
  }

  return {
    migrated: shouldMigrate || repaired,
    warnings,
    renames,
    config: {
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      presets,
      activePresetId: typeof root.activePresetId === "string" ? root.activePresetId : presets[0]?.id ?? "",
      outputDir: typeof root.outputDir === "string" ? root.outputDir : "",
      recentOutputDirs: Array.isArray(root.recentOutputDirs)
        ? root.recentOutputDirs.filter((dir): dir is string => typeof dir === "string")
        : [],
      projects: normalizeProjects(root.projects, createId, warnings),
      voiceProfiles: normalizeVoiceProfiles(root.voiceProfiles, warnings),
      cutout: normalizeCutoutSettings(root.cutout),
    },
  };
}

function normalizeProjects(input: unknown, createId: () => string, warnings?: string[]): ProjectEntry[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.flatMap((candidate) => {
    const record = recordOrEmpty(candidate);
    const outputDir = typeof record.outputDir === "string" ? record.outputDir : "";
    if (!outputDir) {
      warnings?.push(t("项目条目缺少输出目录已跳过"));
      return [];
    }
    // #1308：重复 outputDir 不再静默丢弃——保留首条并警告（含名称供定位）
    if (seen.has(outputDir)) {
      const dupName = typeof record.name === "string" && record.name ? record.name : outputDir;
      warnings?.push(t("重复项目目录已保留首条并跳过：{dir}（跳过“{name}”）", { dir: outputDir, name: dupName }));
      return [];
    }
    seen.add(outputDir);
    const novelFileName = typeof record.novelFileName === "string" ? record.novelFileName : "";
    return [{
      id: typeof record.id === "string" && record.id ? record.id : createId(),
      name: typeof record.name === "string" && record.name.trim() ? record.name : novelFileName.replace(/\.[^.]+$/, "") || outputDir,
      outputDir,
      novelFileName,
      novelTitle: typeof record.novelTitle === "string" ? record.novelTitle : "",
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
    } satisfies ProjectEntry];
  });
}

function normalizeCutoutSettings(input: unknown): CutoutSettings {
  const record = recordOrEmpty(input);
  const modelId = typeof record.modelId === "string" && record.modelId.trim()
    ? record.modelId
    : DEFAULT_CUTOUT_SETTINGS.modelId;
  // 新版三档开关；兼容老版 enabled 布尔值（true=AI 优先，false=只用色度键，保持老行为）
  let mode: CutoutMode = DEFAULT_CUTOUT_SETTINGS.mode;
  if (record.mode === "ai" || record.mode === "chroma" || record.mode === "off") {
    mode = record.mode;
  } else if (typeof record.enabled === "boolean") {
    mode = record.enabled ? "ai" : "chroma";
  }
  return { mode, modelId };
}

function normalizeVoiceProfiles(input: unknown, warnings?: string[]): VoiceProfile[] {
  if (!Array.isArray(input)) return [];
  // #1308：逐条校验、只丢坏条并警告（此前审计称整库丢弃；现逐条保留好条）
  return input.flatMap((candidate, idx) => {
    const profile = recordOrEmpty(candidate);
    if (
      typeof profile.id !== "string" || !profile.id ||
      typeof profile.name !== "string" || !profile.name ||
      typeof profile.ttsConfigId !== "string" || !profile.ttsConfigId ||
      typeof profile.voiceId !== "string" || !profile.voiceId
    ) {
      warnings?.push(t("音色库第 {n} 条缺少必填字段已跳过（id/name/ttsConfigId/voiceId 任一缺失）", { n: idx + 1 }));
      return [];
    }
    return [{
      id: profile.id,
      name: profile.name,
      provider: "minimax",
      ttsConfigId: profile.ttsConfigId,
      voiceId: profile.voiceId,
      status: profile.status === "creating" || profile.status === "error" ? profile.status : "ready",
      referenceAudioPath: typeof profile.referenceAudioPath === "string" ? profile.referenceAudioPath : undefined,
      consentConfirmedAt: typeof profile.consentConfirmedAt === "string" ? profile.consentConfirmedAt : undefined,
      error: typeof profile.error === "string" ? profile.error : undefined,
      revision: typeof profile.revision === "number" && profile.revision >= 1 ? Math.floor(profile.revision) : 1,
      createdAt: typeof profile.createdAt === "string" ? profile.createdAt : new Date(0).toISOString(),
    } satisfies VoiceProfile];
  });
}

function repairDuplicateConfigIds(presets: ApiPreset[], createId: () => string): { repaired: boolean; renames: Array<{ oldId: string; newId: string }> } {
  const seen = new Set<string>();
  const renames: Array<{ oldId: string; newId: string }> = [];
  let repaired = false;
  for (const preset of presets) {
    for (const kind of ["llm", "vision", "image", "tts"] as const) {
      for (const apiConfig of preset.channels[kind]) {
        if (!seen.has(apiConfig.id)) {
          seen.add(apiConfig.id);
          continue;
        }
        const duplicateId = apiConfig.id;
        do apiConfig.id = createId(); while (seen.has(apiConfig.id));
        seen.add(apiConfig.id);
        renames.push({ oldId: duplicateId, newId: apiConfig.id });
        if (preset.active[kind] === duplicateId) preset.active[kind] = apiConfig.id;
        repaired = true;
      }
    }
  }
  return { repaired, renames };
}

function apiConfigs(config: ConfigFile): ApiConfig[] {
  return config.presets.flatMap((preset) => Object.values(preset.channels).flat());
}

export function serializeConfigFile(config: ConfigFile): string {
  const persisted = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const presets = persisted.presets as Array<{ channels: Record<string, Array<Record<string, unknown>>> }>;
  for (const preset of presets) {
    for (const configs of Object.values(preset.channels)) {
      for (const apiConfig of configs) delete apiConfig.apiKey;
    }
  }
  return JSON.stringify(persisted);
}

export function configSecrets(config: ConfigFile): Record<string, string> {
  return Object.fromEntries(apiConfigs(config).map((apiConfig) => [apiConfig.id, apiConfig.apiKey ?? ""]));
}

export async function loadConfigFile(raw: string, options: ConfigLoadOptions): Promise<ConfigLoadResult> {
  const parsed = JSON.parse(raw);
  const migration = migrateConfigFile(parsed, options.createId, options.createVisionDefault);
  let migrationSaveError: Error | undefined;
  if (migration.migrated || containsInlineApiKey(parsed)) {
    try {
      await options.writeSecrets(configSecrets(migration.config));
      await options.writeConfig(serializeConfigFile(migration.config));
    } catch (error) {
      migrationSaveError = error instanceof Error ? error : new Error(String(error));
    }
  }

  let secretStoreError: Error | undefined;
  try {
    const configs = apiConfigs(migration.config);
    const stored = await options.readSecrets(configs.map((apiConfig) => apiConfig.id));
    // #1308：改名即丢 key——新 id 缺失时从旧 id 跟随（文件内联 key 优先，store 回退跟随）
    for (const { oldId, newId } of migration.renames) {
      if (!Object.prototype.hasOwnProperty.call(stored, newId) && Object.prototype.hasOwnProperty.call(stored, oldId)) {
        stored[newId] = stored[oldId];
      }
    }
    for (const apiConfig of configs) {
      if (Object.prototype.hasOwnProperty.call(stored, apiConfig.id)) apiConfig.apiKey = stored[apiConfig.id];
    }
    // 跟随出的新密钥尽快落库，避免下次仍只有旧 key
    if (migration.renames.length) {
      const carry: Record<string, string> = {};
      for (const { newId } of migration.renames) {
        if (Object.prototype.hasOwnProperty.call(stored, newId)) carry[newId] = stored[newId];
      }
      if (Object.keys(carry).length) {
        await options.writeSecrets(carry).catch(() => undefined);
      }
    }
  } catch (error) {
    secretStoreError = error instanceof Error ? error : new Error(String(error));
  }

  return {
    config: migration.config,
    migrationPending: Boolean(migrationSaveError),
    migrationSaveError,
    secretStoreError,
    migrationWarnings: migration.warnings,
  };
}

function containsInlineApiKey(input: unknown): boolean {
  const root = recordOrEmpty(input);
  if (!Array.isArray(root.presets)) return false;
  return root.presets.some((presetInput) => {
    const channels = recordOrEmpty(recordOrEmpty(presetInput).channels);
    return Object.values(channels).some((configs) => Array.isArray(configs)
      && configs.some((apiConfig) => Object.prototype.hasOwnProperty.call(recordOrEmpty(apiConfig), "apiKey")));
  });
}
