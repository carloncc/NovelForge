<script setup lang="ts">
import { computed, ref, watch } from "vue";
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
import { errMsg } from "../utils/errors";
import { log } from "../utils/logger";
import { t } from "../i18n";
import { knownImageModelCapabilities } from "../api/providers";
import { resolveContextLength, inputCharBudget } from "../api/providers";
import type { ApiConfig, ChannelKey, ImageModelCapabilities } from "../core/types";
import type { DiscoveredModel } from "../api/providers";

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

const concurrencyInput = computed<number>({
  get: () => configState.concurrency ?? 30,
  set: (value: number) => {
    configState.concurrency = Math.max(1, Math.min(100, Number(value) || 30));
  },
});

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
        ? t("正常（已消耗 1 张额度）；已自动探测：支持参考图/图生图")
        : `正常（已消耗 1 张额度）；已自动探测：不支持参考图${result.detail ? `（${result.detail.slice(0, 80)}）` : ""}`;
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
    <div v-if="configPersistenceError" class="notice danger" style="margin-bottom: var(--space-4)">
      {{ configPersistenceError }}。{{ t("为保护原配置，问题解决前不会自动覆盖配置文件。") }}
    </div>
    <div class="page-head">
      <div>
        <div class="page-title">{{ t("API 配置") }}</div>
        <p class="page-sub">{{ t("文本、图片识别、图片生成、语音四通道独立配置，可保存多套配置切换") }}</p>
      </div>
      <div class="page-actions">
        <button class="btn secondary" @click="addPreset">{{ t("＋ 新建配置组") }}</button>
      </div>
    </div>

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
      <button v-if="configState.presets.length > 1" class="btn danger small" style="margin-left: auto" @click="removePreset(configState.activePresetId)">{{ t("删除该组") }}</button>
    </div>

    <div class="card" style="margin-top: var(--space-4)">
      <div class="card-head">
        <h3>全局并发数</h3>
        <div class="card-actions"></div>
      </div>
      <div style="display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap">
        <label class="field" style="max-width: 220px" :title="'所有批量生成任务（图像/配音/分章/视觉圣经/多选重生成）同时执行的任务数。调大可显著提速，但会同时消耗更多 API 额度；默认 30'">
          <span>批量生成并发数（默认 30）</span>
          <input type="number" v-model.number="concurrencyInput" min="1" max="100" />
        </label>
        <div class="hint" style="font-size: 12px; color: var(--text-dim); padding-bottom: 8px">
          作用于图像、配音、分章、视觉圣经及素材多选批量重生成；项目级设置（生成页）可单独覆盖。
        </div>
      </div>
    </div>

    <div class="cfg-grid">
      <div v-for="ch in channels" :key="ch.key" class="card cfg-channel" style="margin-bottom: 0">
        <div class="card-head cfg-channel-head">
          <div style="display: flex; align-items: center; gap: 10px">
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
            <button class="btn ghost small cfg-del" @click="removeConfig(ch.key, cfg.id)">{{ t("删除") }}</button>
          </div>

          <div v-if="ch.key === 'image' || ch.key === 'tts'" class="cfg-row">
            <label class="field" style="flex: 1; margin-bottom: 0">
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
            <button class="btn ghost small" style="align-self: flex-end" @click="toggleCustom(ch.key + ':' + cfg.id)">
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
            <label class="field" style="margin-top: 8px">
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
                placeholder="alloy&#10;echo&#10;fable&#10;onyx&#10;nova&#10;shimmer"
              />
            </label>
          </details>
          <details v-if="ch.key === 'image'" class="cfg-details">
            <summary>{{ t("图片模型能力") }}</summary>
            <div v-if="knownImageModelCapabilities(cfg.model)" class="notice" style="margin-top: 8px">
              {{ t("已知模型能力：最多") }} {{ knownImageModelCapabilities(cfg.model)!.maxReferenceImages }} {{ t("张参考图，编码") }} {{ knownImageModelCapabilities(cfg.model)!.referenceEncoding }}
            </div>
            <div v-else class="cfg-row" style="margin-top: 8px">
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
            <label class="field" style="margin-top: 8px">
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
  </div>
</template>
