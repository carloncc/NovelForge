<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  activePreset,
  addConfig,
  removeConfig,
  addPreset,
  removePreset,
  configState,
  configPersistenceError,
  applyTemplate,
} from "../stores/config";
import { testLlm, testVision, testTts, testImage, fetchModelsForChannel } from "../api/openaiCompatible";
import { templatesForCapability } from "../api/templates";
import { fetchMiniMaxVoices } from "../core/voiceProfiles";
import { errMsg } from "../utils/errors";
import { log } from "../utils/logger";
import { t } from "../i18n";
import PageHead from "../components/PageHead.vue";
import { knownImageModelCapabilities } from "../api/providers";
import { resolveContextLength, inputCharBudget } from "../api/providers";
import { DEFAULT_CONCURRENCY_BY_CHANNEL, type CutoutMode } from "../stores/configMigration";
import type { ApiConfig, ChannelKey, ImageModelCapabilities } from "../core/types";
import type { DiscoveredModel } from "../api/providers";
import { CUTOUT_MODELS, findCutoutModel, type CutoutModel } from "../core/cutout/models";
import { cutoutModelStatus, downloadCutoutModelAndWait, removeCutoutModel, type CutoutModelStatus } from "../core/cutout/download";
import { tauri, isTauri } from "../utils/tauri";

const cutoutModels = CUTOUT_MODELS;
const cutoutStatus = ref<CutoutModelStatus | null>(null);
const cutoutBusy = ref(false);
const cutoutError = ref("");
const cutoutModelDir = ref("");
let cutoutPollTimer: number | undefined;

const currentCutoutModel = computed<CutoutModel>(() => findCutoutModel(configState.cutout?.modelId ?? "isnet-anime"));
const cutoutMode = computed<CutoutMode>(() => configState.cutout?.mode ?? "ai");

const cutoutStatusText = computed(() => {
  const status = cutoutStatus.value;
  const model = currentCutoutModel.value;
  if (!status) return t("查询模型状态…");
  if (status.state === "downloading") {
    const progress = status.total
      ? `${(status.bytes / 1048576).toFixed(1)} / ${(status.total / 1048576).toFixed(1)} MB（${Math.min(100, Math.round((status.bytes / status.total) * 100))}%）`
      : t("准备中…");
    return t("正在下载模型「{name}」… {progress}", { name: model.label, progress });
  }
  if (status.state === "error") return t("模型「{name}」下载失败：{error}", { name: model.label, error: status.error ?? "" });
  if (status.installed) return t("模型「{name}」（{size} MB）已安装，可直接用于 AI 抠图", { name: model.label, size: model.sizeMB });
  return t("模型「{name}」（{size} MB）未安装，手动下载后可启用 AI 抠图", { name: model.label, size: model.sizeMB });
});

const cutoutStatusClass = computed(() => {
  const status = cutoutStatus.value;
  if (!status) return "";
  if (status.state === "downloading") return "working";
  if (status.state === "error") return "err";
  if (status.installed) return "ok";
  return "";
});

async function refreshCutoutStatus(): Promise<void> {
  const status = await cutoutModelStatus(currentCutoutModel.value);
  cutoutStatus.value = status;
  if (status.state === "downloading") scheduleCutoutPoll();
  else stopCutoutPoll();
}

function scheduleCutoutPoll(): void {
  if (cutoutPollTimer !== undefined) return;
  cutoutPollTimer = window.setInterval(() => { void refreshCutoutStatus(); }, 1000);
}

function stopCutoutPoll(): void {
  if (cutoutPollTimer !== undefined) {
    window.clearInterval(cutoutPollTimer);
    cutoutPollTimer = undefined;
  }
}

async function downloadCurrentModel(): Promise<void> {
  const model = currentCutoutModel.value;
  cutoutBusy.value = true;
  cutoutError.value = "";
  log.info("page", "开始下载 AI 抠图模型", { modelId: model.id, sizeMB: model.sizeMB });
  try {
    await downloadCutoutModelAndWait(model, (status) => { cutoutStatus.value = status; });
    cutoutStatus.value = await cutoutModelStatus(model);
    log.info("page", "AI 抠图模型下载完成", { modelId: model.id });
  } catch (error) {
    cutoutError.value = errMsg(error);
    log.error("page", "AI 抠图模型下载失败", { modelId: model.id, error: errMsg(error) });
  } finally {
    cutoutBusy.value = false;
    stopCutoutPoll();
    await refreshCutoutStatus();
  }
}

async function removeCurrentModel(): Promise<void> {
  const model = currentCutoutModel.value;
  cutoutBusy.value = true;
  cutoutError.value = "";
  try {
    await removeCutoutModel(model);
    log.info("page", "已删除 AI 抠图模型", { modelId: model.id });
  } catch (error) {
    cutoutError.value = errMsg(error);
  } finally {
    cutoutBusy.value = false;
    await refreshCutoutStatus();
  }
}

watch(
  () => configState.cutout?.modelId,
  () => {
    cutoutError.value = "";
    void refreshCutoutStatus();
  },
);

onMounted(async () => {
  await refreshCutoutStatus();
  if (isTauri()) {
    cutoutModelDir.value = `${(await tauri.resourceDir().catch(() => ""))}/models`;
  }
});
onUnmounted(stopCutoutPoll);

function defaultConcurrency(kind: ChannelKey): number {
  return DEFAULT_CONCURRENCY_BY_CHANNEL[kind] ?? 3;
}

/** 格式化 MiniMax 滑块参数的显示值（保留最多 1 位小数） */
function fmtTtsParam(value: unknown, fallback: number): string {
  const n = typeof value === "number" ? value : fallback;
  return String(Math.round(n * 10) / 10);
}

const voiceFetching = ref<string | null>(null);
const voiceFetchMsg = ref<Record<string, string>>({});

/** 从 MiniMax 拉取系统音色 + 用户克隆/设计音色，填入该 TTS 配置的音色库 */
async function fetchVoicesFor(cfg: ApiConfig): Promise<void> {
  voiceFetching.value = cfg.id;
  voiceFetchMsg.value[cfg.id] = "";
  try {
    const remote = await fetchMiniMaxVoices(cfg, "all");
    if (!remote.length) throw new Error("MiniMax 未返回任何音色");
    cfg.extra ??= {};
    const current = Array.isArray(cfg.extra.voiceLibrary) ? (cfg.extra.voiceLibrary as string[]) : [];
    const ids = remote.map((v) => v.voice_id);
    cfg.extra.voiceLibrary = Array.from(new Set([...current, ...ids]));
    const kinds: Record<string, string> = {
      system: t("系统音色"),
      clone: t("克隆音色"),
      design: t("设计音色"),
    };
    const count = (kind: string) => remote.filter((v) => v.kind === kind).length;
    voiceFetchMsg.value[cfg.id] = t("已获取音色：系统 {sys} 个，克隆 {clone} 个，设计 {design} 个", {
      sys: String(count("system")),
      clone: String(count("clone")),
      design: String(count("design")),
    });
    void kinds;
  } catch (error) {
    voiceFetchMsg.value[cfg.id] = t("获取音色失败：{error}", { error: errMsg(error) });
  } finally {
    voiceFetching.value = null;
  }
}

const channels = computed<{ key: ChannelKey; label: string; desc: string; icon: string }[]>(() => [
  { key: "llm", label: t("文本 LLM"), desc: t("角色/场景/物品提取与剧本生成"), icon: "M12 5v14M5 12h14" },
  { key: "vision", label: t("图片识别 API"), desc: t("参考图分析、角色识别与生成图自检"), icon: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" },
  { key: "image", label: t("图像 API"), desc: t("立绘 / 背景 / CG / 物品图生成"), icon: "M4 17L9 12L13 16L17 12L20 15M4 5H20V19H4V5Z" },
  { key: "tts", label: t("TTS 配音"), desc: t("逐句配音（可选），音色可控"), icon: "M12 6V18M8 9V15M16 9V15M5 11V13M19 11V13" },
]);

const testing = ref<{ key: ChannelKey; id: string } | null>(null);
const testResult = ref<{ key: ChannelKey; id: string; ok: boolean; msg: string } | null>(null);
const customOpen = ref<Record<string, boolean>>({});

const modelFetching = ref<string | null>(null);
const modelFetchError = ref<Record<string, string>>({});
const customModelOpen = ref<Record<string, boolean>>({});

const templatesByChannel = computed(() => ({
  image: templatesForCapability("image"),
  tts: templatesForCapability("tts"),
}));

function onTemplateChange(kind: ChannelKey, cfg: ApiConfig, templateId: string): void {
  if (!templateId) {
    cfg.adapter = undefined;
    return;
  }
  applyTemplate(cfg, templateId);
}

function toggleCustom(key: string): void {
  customOpen.value[key] = !customOpen.value[key];
}

function showTemplateError(): void {
  globalThis.alert(t("模板 JSON 格式错误"));
}

async function runTest(kind: ChannelKey, cfg: ApiConfig): Promise<void> {
  // 测试是真实调用（扣费）：图像通道含文生图＋图生图探测共 2 张，先确认
  const costHint = kind === "image"
    ? "将真实调用图像 API（含文生图 1 张＋图生图探测 1 张，共约 2 张额度）"
    : kind === "tts"
      ? "将真实合成一句测试语音（扣少量字符额度）"
      : "将真实调用一次（扣少量 token 额度）";
  if (!window.confirm(`测试连接将${costHint}。继续吗？`)) return;
  testing.value = { key: kind, id: cfg.id };
  testResult.value = null;
  log.info("page", `测试连接 ${kind}`, { model: cfg.model, baseUrl: cfg.baseUrl });
  try {
    if (kind === "llm") {
      const reply = await testLlm(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: `正常：${reply.slice(0, 40)}` };
    } else if (kind === "vision") {
      const description = await testVision(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: `视觉识别正常：${description.slice(0, 60)}` };
    } else if (kind === "tts") {
      await testTts(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: t("正常，语音合成可用") };
    } else {
      const result = await testImage(cfg);
      const editMsg = result.editOk
        ? t("正常（已消耗约 2 张额度：文生图＋图生图探测）；已自动探测：支持参考图/图生图")
        : `正常（已消耗约 2 张额度：文生图＋图生图探测）；已自动探测：不支持参考图${result.detail ? `（${result.detail.slice(0, 80)}）` : ""}`;
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: editMsg };
    }
    log.info("page", `测试连接 ${kind} 成功`);
  } catch (e) {
    log.error("page", `测试连接 ${kind} 失败`, { model: cfg.model, baseUrl: cfg.baseUrl, error: errMsg(e) });
    testResult.value = { key: kind, id: cfg.id, ok: false, msg: errMsg(e) };
  } finally {
    testing.value = null;
  }
}

function cfgActive(kind: ChannelKey, id: string): boolean {
  return activePreset().active[kind] === id;
}

/** 删除整组配置：不可恢复，二次确认 */
function confirmRemovePreset(id: string): void {
  const preset = configState.presets.find((p) => p.id === id);
  const n = preset ? Object.values(preset.channels).flat().length : 0;
  if (!window.confirm(`删除配置组「${preset?.name ?? id}」（含 ${n} 个 API 配置，不可恢复）？`)) return;
  removePreset(id);
}

/** 删除单个 API 配置：切走正在用的通道，二次确认 */
function confirmRemoveConfig(kind: ChannelKey, id: string, label: string): void {
  const inUse = activePreset().active[kind] === id;
  if (!window.confirm(`删除${inUse ? "（正在使用，将自动切换到同通道第一个）" : ""}「${label}」？不可恢复。`)) return;
  removeConfig(kind, id);
}

function setActive(kind: ChannelKey, id: string): void {
  activePreset().active[kind] = id;
}

const EMPTY_IMAGE_CAPABILITIES: ImageModelCapabilities = {
  maxReferenceImages: 0,
  supportsSeed: false,
  supportsImageEdit: false,
  referenceEncoding: "raw-base64",
};

function editableImageCapabilities(cfg: ApiConfig): ImageModelCapabilities {
  const raw = cfg.extra?.imageCapabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_IMAGE_CAPABILITIES };
  return { ...EMPTY_IMAGE_CAPABILITIES, ...raw as Partial<ImageModelCapabilities> };
}

function setImageCapability<K extends keyof ImageModelCapabilities>(
  cfg: ApiConfig,
  key: K,
  value: ImageModelCapabilities[K],
): void {
  cfg.extra ??= {};
  cfg.extra.imageCapabilities = { ...editableImageCapabilities(cfg), [key]: value };
}

function imageCapabilityConflict(cfg: ApiConfig): boolean {
  const capabilities = editableImageCapabilities(cfg);
  return capabilities.maxReferenceImages > 0 && !capabilities.supportsImageEdit;
}

/** 模型下拉可选项：仅来自自动拉取的 /models 列表（按通道过滤），不内置默认模型 */
function modelOptionsFor(kind: ChannelKey, cfg: ApiConfig): string[] {
  const discovered = Array.isArray(cfg.extra?.discoveredModels)
    ? (cfg.extra!.discoveredModels as DiscoveredModel[])
    : [];
  return discovered
    .filter((model) => model.capabilities.length === 0 || model.capabilities.includes(kind))
    .map((model) => model.id);
}

/** 下拉当前值：自定义输入模式下返回 __custom__，否则返回当前模型名 */
function modelValueFor(cfg: ApiConfig): string {
  if (customModelOpen.value[cfg.id]) return "__custom__";
  return cfg.model ?? "";
}

function onModelSelect(kind: ChannelKey, cfg: ApiConfig, e: Event): void {
  const value = (e.target as HTMLSelectElement).value;
  if (value === "__custom__") {
    customModelOpen.value[cfg.id] = true;
    return;
  }
  customModelOpen.value[cfg.id] = false;
  cfg.model = value;
}

/** 自动拉取模型：跟随 baseUrl / 路径前缀 / API Key 变化（600ms 防抖） */
const modelFetchSignatures = new Map<string, string>();
const modelFetchTimers = new Map<string, number>();

function isLocalBaseUrl(url: string): boolean {
  return /localhost|127\.0\.0\.1|::1/i.test(url);
}

async function fetchModels(kind: ChannelKey, cfg: ApiConfig): Promise<void> {
  modelFetching.value = cfg.id;
  try {
    const models = await fetchModelsForChannel(cfg, kind);
    cfg.extra ??= {};
    cfg.extra.discoveredModels = models;
    modelFetchError.value[cfg.id] = "";
  } catch (error) {
    modelFetchError.value[cfg.id] = errMsg(error);
  } finally {
    if (modelFetching.value === cfg.id) modelFetching.value = null;
  }
}

function autoFetchModels(kind: ChannelKey, cfg: ApiConfig): void {
  const url = cfg.baseUrl?.trim() ?? "";
  const timer = modelFetchTimers.get(cfg.id);
  if (timer) window.clearTimeout(timer);
  modelFetchTimers.delete(cfg.id);
  cfg.extra ??= {};
  cfg.extra.discoveredModels = [];
  if (!url) {
    modelFetchError.value[cfg.id] = "";
    return;
  }
  if (!cfg.apiKey?.trim() && !isLocalBaseUrl(url)) {
    modelFetchError.value[cfg.id] = "";
    return;
  }
  modelFetchTimers.set(cfg.id, window.setTimeout(() => {
    modelFetchTimers.delete(cfg.id);
    void fetchModels(kind, cfg);
  }, 600));
}

watch(
  () => configState.presets.flatMap((preset) =>
    (["llm", "vision", "image", "tts"] as const).flatMap((kind) =>
      preset.channels[kind].map((cfg) =>
        `${cfg.id}|${cfg.baseUrl}|${cfg.extra?.pathPrefix ?? ""}|${cfg.apiKey ? "K" : "-"}`,
      ),
    ),
  ).join("~"),
  () => {
    for (const preset of configState.presets) {
      for (const kind of ["llm", "vision", "image", "tts"] as const) {
        for (const cfg of preset.channels[kind]) {
          const signature = `${cfg.id}|${cfg.baseUrl}|${cfg.extra?.pathPrefix ?? ""}|${cfg.apiKey ? "K" : "-"}`;
          if (modelFetchSignatures.get(cfg.id) !== signature) {
            modelFetchSignatures.set(cfg.id, signature);
            autoFetchModels(kind, cfg);
          }
        }
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="inner">
    <div v-if="configPersistenceError" class="notice danger mb-4">
      {{ configPersistenceError }}。{{ t("为保护原配置，问题解决前不会自动覆盖配置文件。") }}
    </div>
    <PageHead :title="t('API 配置')" :sub="t('文本、图片识别、图片生成、语音四通道独立配置，可保存多套配置切换')">
      <button class="btn secondary" @click="addPreset">{{ t("＋ 新建配置组") }}</button>
    </PageHead>

    <div class="card preset-bar">
      <span class="preset-bar-label">{{ t("配置组") }}</span>
      <div class="preset-pills">
        <button
          v-for="p in configState.presets"
          :key="p.id"
          class="preset-pill"
          :class="{ active: configState.activePresetId === p.id }"
          @click="configState.activePresetId = p.id"
        >
          <svg v-if="configState.activePresetId === p.id" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          {{ p.name }}
        </button>
      </div>
      <button v-if="configState.presets.length > 1" class="btn danger small ml-auto" @click="confirmRemovePreset(configState.activePresetId)">{{ t("删除该组") }}</button>
    </div>

    <div class="cfg-grid">
      <div v-for="ch in channels" :key="ch.key" class="card cfg-channel mb-0">
        <div class="card-head cfg-channel-head">
          <div class="flex items-center gap-2">
            <span class="cfg-channel-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ch.icon" /></svg>
            </span>
            <div>
              <div class="cfg-channel-title">{{ ch.label }}</div>
              <div class="cfg-channel-desc">{{ ch.desc }}</div>
            </div>
          </div>
          <button class="btn secondary small" @click="addConfig(ch.key)">{{ t("＋ 添加") }}</button>
        </div>

        <div v-for="cfg in activePreset().channels[ch.key]" :key="cfg.id" class="cfg-entry">
          <div class="cfg-entry-head">
            <input type="text" v-model="cfg.name" class="cfg-entry-name" :placeholder="t('配置名')" />
            <button class="btn small cfg-active" :class="cfgActive(ch.key, cfg.id) ? 'is-active' : ''" @click="setActive(ch.key, cfg.id)">
              <svg v-if="cfgActive(ch.key, cfg.id)" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              {{ cfgActive(ch.key, cfg.id) ? t("使用中") : t("设为当前") }}
            </button>
            <button class="btn ghost small cfg-del" @click="confirmRemoveConfig(ch.key, cfg.id, cfg.name || cfg.model)">{{ t("删除") }}</button>
          </div>

          <div v-if="ch.key === 'image' || ch.key === 'tts'" class="cfg-row">
            <label class="field grow mb-0">
              <span>{{ t("服务商模板（通用适配器，可选）") }}</span>
              <select
                :value="cfg.adapter ?? ''"
                @change="(e: any) => onTemplateChange(ch.key, cfg, (e.target as HTMLSelectElement).value)"
              >
                <option value="">{{ t("（手动配置 / OpenAI 兼容）") }}</option>
                <option v-for="t in templatesByChannel[ch.key]" :key="t.id" :value="t.id">{{ t.name }}</option>
                <option value="__custom__" disabled>{{ t("── 自定义模板见下方高级选项 ──") }}</option>
              </select>
            </label>
            <button class="btn ghost small" @click="toggleCustom(ch.key + ':' + cfg.id)">
              {{ customOpen[ch.key + ':' + cfg.id] ? t("收起高级") : t("高级") }}
            </button>
          </div>

          <div class="cfg-row">
            <label class="field">
              <span>Base URL</span>
              <input type="text" v-model="cfg.baseUrl" placeholder="https://api.deepseek.com" />
            </label>
          </div>
          <div class="cfg-row">
            <label class="field cfg-model-field">
              <span>Model<span v-if="modelFetching === cfg.id" class="cfg-model-loading"> {{ t("获取模型中…") }}</span></span>
              <div class="cfg-model-row">
                <select :value="modelValueFor(cfg)" @change="onModelSelect(ch.key, cfg, $event)">
                  <option v-if="!cfg.model" value="" disabled>{{ t("填写 Base URL 后自动加载模型…") }}</option>
                  <option v-if="cfg.model && !modelOptionsFor(ch.key, cfg).includes(cfg.model)" :value="cfg.model">{{ cfg.model }}{{ t("（当前）") }}</option>
                  <option v-for="m in modelOptionsFor(ch.key, cfg)" :key="m" :value="m">{{ m }}</option>
                  <option value="__custom__">{{ t("✏️ 自定义…") }}</option>
                </select>
              </div>
              <input v-if="customModelOpen[cfg.id]" type="text" v-model="cfg.model" :placeholder="t('输入模型名，例如 deepseek-chat')" />
              <span v-if="modelFetchError[cfg.id]" class="cfg-model-error">{{ modelFetchError[cfg.id] }}</span>
            </label>
          </div>
          <div class="cfg-row">
            <label class="field grow-2">
              <span>API Key</span>
              <input type="password" v-model="cfg.apiKey" placeholder="sk-…" />
            </label>
            <label class="field">
              <span>{{ t("路径前缀（可选）") }}</span>
              <input type="text" v-model="cfg.extra!.pathPrefix" :placeholder="t('留空自动 /v1')" />
            </label>
          </div>

          <details class="cfg-details">
            <summary>{{ t("高级参数") }}</summary>
            <div v-if="ch.key === 'llm' || ch.key === 'image' || ch.key === 'tts'" class="cfg-row mt-2">
              <label class="field cfg-narrow mb-0" :title="t('该 API 批量生成任务同时执行的请求数。每个 API 独立配置，互不影响。')">
                <span>{{ t("并发数（该 API 批量生成）") }}</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  :value="cfg.concurrency ?? defaultConcurrency(ch.key)"
                  @change="(e: any) => { cfg.concurrency = Math.max(1, Math.min(100, Number((e.target as HTMLInputElement).value) || 1)); }"
                />
              </label>
            </div>
            <div v-if="ch.key === 'llm' || ch.key === 'vision'" class="cfg-row">
              <label class="field grow-2">
                <span>{{ t("上下文长度 token（留空 = 自动探测，留空时填默认 128000）") }}</span>
                <input
                  type="number"
                  min="1024"
                  step="1024"
                  :value="(cfg.extra!.contextLength as number | string | undefined) ?? ''"
                  :placeholder="t('例如 128000；自动探测到时会显示当前值')"
                  @change="
                    (e: any) => {
                      const v = (e.target as HTMLInputElement).value.trim();
                      cfg.extra!.contextLength = v === '' ? undefined : Number(v);
                    }
                  "
                />
              </label>
              <label class="field">
                <span>{{ t("当前解析值") }}</span>
                <div class="cfg-context-resolved">
                  <code>{{ resolveContextLength(cfg).toLocaleString() }}</code>
                  <span class="cfg-context-budget">{{ t("输入预算") }}：{{ inputCharBudget(cfg).toLocaleString() }} {{ t("字符") }}</span>
                </div>
              </label>
            </div>
          </details>

          <div class="cfg-test-row">
            <button class="btn small cfg-test-btn" :class="testing?.key === ch.key && testing?.id === cfg.id ? 'is-loading' : 'ghost'" :disabled="!!testing" @click="runTest(ch.key, cfg)">
              <span v-if="testing?.key === ch.key && testing?.id === cfg.id" class="spinner" />
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
              {{ testing?.key === ch.key && testing?.id === cfg.id ? t("测试中") : t("测试连接") }}
            </button>
            <span
              v-if="testResult && testResult.key === ch.key && testResult.id === cfg.id"
              class="cfg-test-result"
              :class="testResult.ok ? 'ok' : 'err'"
            >
              {{ testResult.msg }}
            </span>
          </div>

          <details v-if="ch.key === 'tts'" class="cfg-details">
            <summary>{{ t("音色列表") }}</summary>
            <label class="field mt-2">
              <span>{{ t("可用音色（每行一个；AI 提取时从中挑选，失败自动回退第一个）") }}</span>
              <textarea
                :value="(cfg.extra!.voiceLibrary as string[] | undefined)?.join('\n') ?? ''"
                rows="4"
                @change="
                  (e: any) => {
                    const list = (e.target as HTMLTextAreaElement).value.split('\n').map((s: string) => s.trim()).filter(Boolean);
                    if (list.length) cfg.extra!.voiceLibrary = list;
                  }
                "
                placeholder="female-tianmei&#10;male-qn-qingse&#10;female-chengshu"
              />
            </label>
            <div v-if="cfg.adapter === 'minimax-tts' || /minimaxi?\.com/i.test(cfg.baseUrl)" class="row mt-2">
              <button class="btn secondary small" :disabled="voiceFetching === cfg.id || !cfg.apiKey" @click="fetchVoicesFor(cfg)">
                {{ voiceFetching === cfg.id ? t("获取中…") : t("从 MiniMax 获取音色") }}
              </button>
              <span v-if="voiceFetchMsg[cfg.id]" class="cfg-test-result" :class="voiceFetchMsg[cfg.id].includes('失败') ? 'err' : 'ok'">{{ voiceFetchMsg[cfg.id] }}</span>
            </div>
          </details>
          <details v-if="ch.key === 'tts' && cfg.adapter === 'minimax-tts'" class="cfg-details">
            <summary>{{ t("MiniMax 语音参数（参考官网：文本转语音）") }}</summary>
            <div class="cfg-row mt-2">
              <label class="field">
                <span>{{ t("模型") }}</span>
                <select
                  :value="cfg.model ?? 'speech-2.6-hd'"
                  @change="(e: any) => { cfg.model = (e.target as HTMLSelectElement).value; }"
                >
                  <option value="speech-2.8-hd">speech-2.8-hd（最新高质量）</option>
                  <option value="speech-2.8-turbo">speech-2.8-turbo（低延迟）</option>
                  <option value="speech-2.6-hd">speech-2.6-hd（默认）</option>
                  <option value="speech-2.6-turbo">speech-2.6-turbo</option>
                  <option value="speech-02-hd">speech-02-hd</option>
                  <option value="speech-02-turbo">speech-02-turbo</option>
                </select>
              </label>
              <label class="field">
                <span>{{ t("情感") }}</span>
                <select
                  :value="(cfg.extra!.emotion as string | undefined) ?? ''"
                  @change="(e: any) => { cfg.extra!.emotion = (e.target as HTMLSelectElement).value || undefined; }"
                >
                  <option value="">{{ t("自动（默认）") }}</option>
                  <option value="happy">{{ t("高兴") }}</option>
                  <option value="sad">{{ t("悲伤") }}</option>
                  <option value="angry">{{ t("愤怒") }}</option>
                  <option value="calm">{{ t("平静") }}</option>
                  <option value="whisper">{{ t("耳语") }}</option>
                  <option value="surprised">{{ t("惊讶") }}</option>
                </select>
              </label>
            </div>
            <div class="cfg-row">
              <label class="field cfg-narrow">
                <span>{{ t("语速") }}（{{ fmtTtsParam(cfg.extra!.speed, 1.1) }}×）</span>
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.05"
                  :value="cfg.extra!.speed ?? 1.1"
                  @input="(e: any) => { cfg.extra!.speed = Number((e.target as HTMLInputElement).value); }"
                />
              </label>
              <label class="field cfg-narrow">
                <span>{{ t("音量") }}（{{ fmtTtsParam(cfg.extra!.vol, 1) }}）</span>
                <input
                  type="range"
                  min="0.1"
                  max="10"
                  step="0.1"
                  :value="cfg.extra!.vol ?? 1"
                  @input="(e: any) => { cfg.extra!.vol = Number((e.target as HTMLInputElement).value); }"
                />
              </label>
              <label class="field cfg-narrow">
                <span>{{ t("音调") }}（{{ fmtTtsParam(cfg.extra!.pitch, 0) }}）</span>
                <input
                  type="range"
                  min="-12"
                  max="12"
                  step="1"
                  :value="cfg.extra!.pitch ?? 0"
                  @input="(e: any) => { cfg.extra!.pitch = Number((e.target as HTMLInputElement).value); }"
                />
              </label>
              <label class="field cfg-narrow">
                <span>{{ t("输出格式") }}</span>
                <select
                  :value="(cfg.extra!.ttsFormat as string | undefined) ?? 'mp3'"
                  @change="(e: any) => { cfg.extra!.ttsFormat = (e.target as HTMLSelectElement).value; }"
                >
                  <option value="mp3">mp3（推荐）</option>
                  <option value="wav">wav</option>
                  <option value="flac">flac</option>
                </select>
              </label>
            </div>
            <p class="hint">{{ t("这些参数会应用到所有使用该 TTS 配置生成的台词配音；模型列表与官网同步。") }}</p>
          </details>
          <details v-if="ch.key === 'image'" class="cfg-details">
            <summary>{{ t("图片模型能力") }}</summary>
            <div v-if="knownImageModelCapabilities(cfg.model)" class="notice mt-2">
              {{ t("已知模型能力：最多") }} {{ knownImageModelCapabilities(cfg.model)!.maxReferenceImages }} {{ t("张参考图，编码") }} {{ knownImageModelCapabilities(cfg.model)!.referenceEncoding }}
            </div>
            <div v-else class="cfg-row mt-2">
              <label class="field">
                <span>{{ t("参考图数量（0–3）") }}</span>
                <input
                  type="number"
                  min="0"
                  max="3"
                  :value="editableImageCapabilities(cfg).maxReferenceImages"
                  @change="(e: any) => setImageCapability(cfg, 'maxReferenceImages', Math.max(0, Math.min(3, Number((e.target as HTMLInputElement).value) || 0)))"
                />
              </label>
              <label class="field">
                <span>{{ t("参考图编码") }}</span>
                <select
                  :value="editableImageCapabilities(cfg).referenceEncoding"
                  @change="(e: any) => setImageCapability(cfg, 'referenceEncoding', (e.target as HTMLSelectElement).value as ImageModelCapabilities['referenceEncoding'])"
                >
                  <option value="raw-base64">raw-base64</option>
                  <option value="data-url">data-url</option>
                </select>
              </label>
            </div>
            <div v-if="!knownImageModelCapabilities(cfg.model)" class="cfg-row">
              <label class="check"><input type="checkbox" :checked="editableImageCapabilities(cfg).supportsImageEdit" @change="(e: any) => setImageCapability(cfg, 'supportsImageEdit', (e.target as HTMLInputElement).checked)" /> {{ t("图生图") }}</label>
              <label class="check"><input type="checkbox" :checked="editableImageCapabilities(cfg).supportsSeed" @change="(e: any) => setImageCapability(cfg, 'supportsSeed', (e.target as HTMLInputElement).checked)" /> {{ t("固定 seed") }}</label>
            </div>
            <div v-if="!knownImageModelCapabilities(cfg.model) && imageCapabilityConflict(cfg)" class="notice danger">
              {{ t("参考图数量大于 0 时必须启用图生图。") }}
            </div>
          </details>
          <details v-if="customOpen[ch.key + ':' + cfg.id]" class="cfg-details">
            <summary>{{ t("自定义适配器模板（JSON，优先级高于服务商模板）") }}</summary>
            <label class="field mt-2">
              <span>{{ t("适配器模板（字段：id/name/capability/mode/endpoint/requestMap/response/poll/voices/rawResponse，见项目文档）") }}</span>
              <textarea
                :value="(cfg.extra!.customTemplate as string | undefined) ?? ''"
                rows="10"
                style="font-family: var(--mono); font-size: 11.5px"
                placeholder='{
  "id": "my-image",
  "capability": "image",
  "mode": "sync",
  "endpoint": "/v1/images/generations",
  "requestMap": { "model": "$model", "prompt": "$prompt" },
  "response": { "path": "data", "encoding": "base64" }
}'
                @change="
                  (e: any) => {
                    const v = (e.target as HTMLTextAreaElement).value.trim();
                    cfg.extra!.customTemplate = v || undefined;
                    if (v) {
                      try { JSON.parse(v); } catch { showTemplateError(); }
                    }
                  }
                "
              />
            </label>
          </details>
        </div>

        <div v-if="!activePreset().channels[ch.key].length" class="empty" style="padding: var(--space-4) 0">
          <p>{{ t("暂无") }} {{ ch.label }} {{ t("配置，点击右上角「＋ 添加」") }}</p>
        </div>
      </div>
    </div>

    <div class="card mt-4">
      <div class="card-head">
        <div class="flex items-center gap-2">
          <span class="cfg-channel-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z M9 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z M14 5l1.5-2M11 19l-1.5 2M18 8l2-1M6 16l-2 1" /></svg>
          </span>
          <div>
            <div class="cfg-channel-title">{{ t("AI 抠图模型") }}</div>
            <div class="cfg-channel-desc">{{ t("按「抠图方式」把立绘/动作/物品抠出透明底；AI 模式未安装模型时降级色度键。模型在本机运行，需手动下载。") }}</div>
          </div>
        </div>
      </div>

      <div class="cfg-row">
        <label class="field grow-2 mb-0">
          <span>{{ t("抠图方式") }}</span>
          <select
            :value="cutoutMode"
            @change="(e: any) => { configState.cutout!.mode = (e.target as HTMLSelectElement).value as CutoutMode; }"
          >
            <option value="ai">{{ t("AI 抠图优先（失败自动降级色度键）") }}</option>
            <option value="chroma">{{ t("只用色度键（无需下载模型）") }}</option>
            <option value="off">{{ t("不抠图（保留原图）") }}</option>
          </select>
        </label>
      </div>
      <div class="cfg-row">
        <label class="field grow-2 mb-0">
          <span>{{ t("抠图模型") }}</span>
          <select
            :value="configState.cutout?.modelId ?? 'isnet-anime'"
            :disabled="cutoutMode !== 'ai'"
            @change="(e: any) => { configState.cutout!.modelId = (e.target as HTMLSelectElement).value; }"
          >
            <option v-for="m in cutoutModels" :key="m.id" :value="m.id">{{ m.label }}（{{ m.sizeMB }} MB）</option>
          </select>
          <span class="cutout-desc">{{ currentCutoutModel.description }}</span>
        </label>
      </div>
      <div class="cfg-row">
        <span class="cutout-status" :class="cutoutStatusClass">{{ cutoutStatusText }}</span>
      </div>
      <div class="cfg-row">
        <button class="btn secondary small" :disabled="cutoutBusy || cutoutStatus?.installed || cutoutMode !== 'ai'" @click="downloadCurrentModel">
          <span v-if="cutoutBusy" class="spinner" />
          {{ cutoutStatus?.installed ? t("已安装") : t("下载模型") }}
        </button>
        <button v-if="cutoutStatus?.installed" class="btn danger small" :disabled="cutoutBusy" @click="removeCurrentModel">{{ t("删除模型") }}</button>
        <span v-if="cutoutError" class="cfg-model-error">{{ cutoutError }}</span>
      </div>
      <div v-if="cutoutModelDir" class="cfg-row mb-0">
        <span class="cutout-dir" :title="cutoutModelDir">{{ t("模型目录") }}：<code>{{ cutoutModelDir }}</code></span>
      </div>
    </div>
  </div>
</template>
