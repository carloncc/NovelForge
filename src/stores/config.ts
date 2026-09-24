import { reactive, ref, watch } from "vue";
import type { ApiConfig, ApiPreset, ChannelKey, VoiceProfile } from "../core/types";
import { t } from "../i18n";
import { isTauri, tauri } from "../utils/tauri";
import {
  initWebSecrets,
  readWebSecrets,
  webKeysPersistError,
  writeWebSecretsAsync,
} from "../utils/webKeys";
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
  // #1420：VOICE_LIBRARY_EMPTY_MESSAGE 本身即 i18n key（文案即 key），此处经 t() 抛出——
  // 中文界面行为不变，外语界面待 en/ja/ko/zh-TW 词典补齐该 key 后自动显示译文（词典由专人补，不在此改）。
  if (!lib.length) throw new Error(t(VOICE_LIBRARY_EMPTY_MESSAGE));
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
/* #1296：旧明文迁移警告（供另一路的 ConfigPage 复选框横幅消费；本文件只做存储核心+迁移） */
export const webSecretsMigrationWarning = ref("");

/* ==================== #1296 Web 密钥读写接线（仅接线：桌面端原样走 OS keyring） ==================== */

/** Web 密钥模式：浏览器环境且非 Tauri（Node 单测走桌面分支，原行为不变） */
function useWebKeyStore(): boolean {
  return typeof window !== "undefined" && !isTauri();
}

/** 稳态写（全量合并语义：空串删键；opt-in 时加密落盘并透出失败横幅） */
async function writeSecretsEntry(secrets: Record<string, string>): Promise<void> {
  if (useWebKeyStore()) {
    await writeWebSecretsAsync(secrets);
    const err = webKeysPersistError();
    if (err) configPersistenceError.value = err;
    return;
  }
  return tauri.writeApiSecrets(secrets);
}

async function readSecretsEntry(ids: string[]): Promise<Record<string, string>> {
  if (useWebKeyStore()) return readWebSecrets(ids);
  return tauri.readApiSecrets(ids);
}

/** 初始加载期写（只加不删：迁移回写全是空值时不得冲掉刚迁入内存的旧明文密钥） */
async function writeSecretsLoadPhase(secrets: Record<string, string>): Promise<void> {
  if (useWebKeyStore()) {
    const nonEmpty = Object.fromEntries(Object.entries(secrets).filter(([, v]) => !!v));
    if (Object.keys(nonEmpty).length) await writeWebSecretsAsync(nonEmpty);
    return;
  }
  return tauri.writeApiSecrets(secrets);
}

export const configReady = loadPersisted();

async function loadPersisted() {
  // #1296：Web 先迁旧明文进内存（后出现的 readSecretsEntry 才能读到迁入值）
  let webInitWarnings: string[] = [];
  if (useWebKeyStore()) {
    try {
      const init = await initWebSecrets();
      webInitWarnings = init.warnings;
    } catch {
      /* 迁移失败不挡配置加载 */
    }
  }
  try {
    const raw = await tauri.readConfig();
    if (!raw || raw === "{}") {
      if (webInitWarnings.length) {
        for (const w of webInitWarnings) log.warn("config", w, {});
        webSecretsMigrationWarning.value = webInitWarnings.join("\n");
      }
      return;
    }
    const loaded = await loadConfigFile(raw, {
      createId: makeId,
      createVisionDefault: () => defaultApiConfig("vision"),
      writeConfig: (content) => tauri.writeConfig(content),
      readSecrets: (ids) => readSecretsEntry(ids),
      writeSecrets: (secrets) => writeSecretsLoadPhase(secrets),
    });
    const parsed = loaded.config;
    // #1308：迁移丢弃/改名不再静默——打日志并在横幅透出（UI 文案均为 t() key）
    if (loaded.migrationWarnings?.length) {
      for (const w of loaded.migrationWarnings) log.warn("config", w, {});
    }
    // #1296：旧明文迁移警告同样打日志并透给另一路横幅
    if (webInitWarnings.length) {
      for (const w of webInitWarnings) log.warn("config", w, {});
      webSecretsMigrationWarning.value = webInitWarnings.join("\n");
    }
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

/**
 * #1315：有序事务写盘（先密钥后配置）。两步都成功才更新“已落盘”标记；
 * 任一步失败不更新标记（下次自动保存会重试），并透出横幅。调用方不得在失败后清横幅。
 */
async function writeConfigAndSecrets(content: string, secrets: Record<string, string>, secretsSig: string): Promise<boolean> {
  try {
    await writeSecretsEntry(secrets);
    await tauri.writeConfig(content);
  } catch (error) {
    configPersistenceError.value = t("配置自动保存失败：{error}", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  lastPersistedContent = content;
  lastPersistedSecrets = secretsSig;
  // UI81：自动保存恢复正常后清掉上次的失败横幅；迁移/凭据阻塞态由 configPersistenceBlocked 保留
  if (!configPersistenceBlocked) configPersistenceError.value = "";
  return true;
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
  const migratedSecretsSig = JSON.stringify(pendingMigrationSecrets);
  const ok = await writeConfigAndSecrets(migratedContent, pendingMigrationSecrets, migratedSecretsSig);
  // writeConfigAndSecrets 已写横幅；此处只处理重试调度（成功才清 pending）
  if (!ok) {
    configPersistenceError.value = t("配置迁移仍无法保存：{error}", { error: configPersistenceError.value || t("未知错误") });
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
    await writeSecretsEntry(configSecrets(configState));
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
      void writeConfigAndSecrets(content, secrets, secretsSig);
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

export async function removeConfig(kind: ChannelKey, id: string): Promise<boolean> {
  const preset = activePreset();
  const list = preset.channels[kind];
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  // #1315：先 await 删密钥，失败则不改 UI（此前先 splice 再 void 删，失败时 UI 已删但密钥仍在）
  try {
    await writeSecretsEntry({ [id]: "" });
  } catch (error) {
    configPersistenceError.value = t("删除系统凭据失败：{error}", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  list.splice(idx, 1);
  if (preset.active[kind] === id) {
    preset.active[kind] = list[0]?.id ?? "";
  }
  return true;
}

export function addPreset(): void {
  const preset = createApiPreset(t("配置组 {n}", { n: configState.presets.length + 1 }));
  configState.presets.push(preset);
  configState.activePresetId = preset.id;
}

export async function removePreset(id: string): Promise<boolean> {
  if (configState.presets.length <= 1) return false;
  const idx = configState.presets.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  const removedSecrets = Object.fromEntries(
    Object.values(configState.presets[idx].channels).flat().map((config) => [config.id, ""]),
  );
  // #1315：同 removeConfig，先落密钥删除再改 UI
  try {
    await writeSecretsEntry(removedSecrets);
  } catch (error) {
    configPersistenceError.value = t("删除系统凭据失败：{error}", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
  configState.presets.splice(idx, 1);
  if (configState.activePresetId === id) {
    configState.activePresetId = configState.presets[0].id;
  }
  return true;
}

/* ==================== #1333 模型列表拉取策略（store 侧纯函数，UI 侧由 ConfigPage 消费） ==================== */

/** 轻量字符串哈希（djb2，hex），用于签名中的 Key 指纹：不存明文，只记“内容是否变了” */
export function hashKeyFragment(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * #1333 签名：纳入 apiKey 实际值指纹（末 4 位 + 长度 + 哈希），K→K 但内容变了也能触发重拉；
 * 明文 Key 不进签名（避免日志/持久化泄露）。
 */
export function modelFetchSignature(cfg: { id: string; baseUrl: string; apiKey?: string; extra?: { pathPrefix?: unknown } }): string {
  const key = cfg.apiKey ?? "";
  const tail = key.slice(-4);
  const fp = key ? `${key.length}:${tail}:${hashKeyFragment(key)}` : "-";
  const prefix = typeof cfg.extra?.pathPrefix === "string" ? cfg.extra.pathPrefix : "";
  return `${cfg.id}|${cfg.baseUrl}|${prefix}|${fp}`;
}

/** 纯函数：签名变化才需重拉 */
export function shouldRefetchModels(prevSig: string | undefined, nextSig: string): boolean {
  if (!prevSig) return true;
  return prevSig !== nextSig;
}

/**
 * #1333 合并策略（纯函数）：
 * - 成功：用新列表整体替换；
 * - 失败（next 为 undefined）：保留旧列表（不再先清空后失败即丢）；
 * - 仅当 baseUrl/前缀真正变化且调用方要求时才清空（clearOnEndpointChange）。
 */
export function mergeDiscoveredModels(
  prev: unknown,
  next: unknown,
  opts?: { baseUrlChanged?: boolean; clearOnEndpointChange?: boolean },
): unknown[] {
  const prevList = Array.isArray(prev) ? prev : [];
  if (next === undefined) {
    if (opts?.baseUrlChanged && opts?.clearOnEndpointChange) return [];
    return prevList;
  }
  return Array.isArray(next) ? next : prevList;
}

/** 纯函数：endpoint（baseUrl/前缀）是否变化——变化才允许清空旧列表 */
export function isModelEndpointChanged(
  prev: { baseUrl: string; pathPrefix?: string },
  next: { baseUrl: string; pathPrefix?: string },
): boolean {
  return prev.baseUrl !== next.baseUrl || (prev.pathPrefix ?? "") !== (next.pathPrefix ?? "");
}

/**
 * #1333 store 侧写入口径：成功才替换、失败保留旧列表。
 * 返回最终列表（调用方直接赋给 cfg.extra.discoveredModels）。
 */
export function applyDiscoveredModelsSuccess(prev: unknown, models: unknown[]): unknown[] {
  return mergeDiscoveredModels(prev, models);
}
export function applyDiscoveredModelsFailure(prev: unknown, opts?: { baseUrlChanged?: boolean }): unknown[] {
  return mergeDiscoveredModels(prev, undefined, opts);
}
