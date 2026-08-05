<script setup lang="ts">
import { computed, ref } from "vue";
import {
  activePreset,
  addConfig,
  removeConfig,
  addPreset,
  removePreset,
  configState,
  applyTemplate,
} from "../stores/config";
import { testLlm, testTts, testImage } from "../api/openaiCompatible";
import { templatesForCapability } from "../api/templates";
import type { ApiConfig, ChannelKey } from "../core/types";

const channels: { key: ChannelKey; label: string; desc: string; icon: string }[] = [
  { key: "llm", label: "文本 LLM", desc: "角色/场景/物品提取与剧本生成", icon: "M12 5v14M5 12h14" },
  { key: "image", label: "图像 API", desc: "立绘 / 背景 / CG / 物品图生成", icon: "M4 17L9 12L13 16L17 12L20 15M4 5H20V19H4V5Z" },
  { key: "tts", label: "TTS 配音", desc: "逐句配音（可选），音色可控", icon: "M12 6V18M8 9V15M16 9V15M5 11V13M19 11V13" },
];

const testing = ref<{ key: ChannelKey; id: string } | null>(null);
const testResult = ref<{ key: ChannelKey; id: string; ok: boolean; msg: string } | null>(null);
const customOpen = ref<Record<string, boolean>>({});

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
  globalThis.alert("模板 JSON 格式错误");
}

async function runTest(kind: ChannelKey, cfg: ApiConfig): Promise<void> {
  testing.value = { key: kind, id: cfg.id };
  testResult.value = null;
  try {
    if (kind === "llm") {
      const reply = await testLlm(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: `正常：${reply.slice(0, 40)}` };
    } else if (kind === "tts") {
      await testTts(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: "正常，语音合成可用" };
    } else {
      await testImage(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: "正常（已消耗 1 张额度）" };
    }
  } catch (e) {
    testResult.value = { key: kind, id: cfg.id, ok: false, msg: (e as Error).message };
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
</script>

<template>
  <div class="inner">
    <div class="page-head">
      <div>
        <div class="page-title">API 配置</div>
        <p class="page-sub">三通道全部自定义（OpenAI 兼容协议），可保存多套配置切换；DeepSeek / 通义 / 硅基流动 / Kimi / OpenAI / Ollama 均可</p>
      </div>
      <div class="page-actions">
        <button class="btn secondary" @click="addPreset">＋ 新建配置组</button>
      </div>
    </div>

    <div class="card" style="padding: var(--space-4)">
      <div class="row" style="justify-content: space-between">
        <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center">
          <span style="font-size: 12.5px; color: var(--text-dim); margin-right: 4px">配置组：</span>
          <button
            v-for="p in configState.presets"
            :key="p.id"
            class="btn small"
            :class="configState.activePresetId === p.id ? '' : 'ghost'"
            @click="configState.activePresetId = p.id"
          >
            {{ p.name }}
          </button>
        </div>
        <button v-if="configState.presets.length > 1" class="btn danger small" @click="removePreset(configState.activePresetId)">删除该组</button>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: var(--space-4)">
      <div v-for="ch in channels" :key="ch.key" class="card" style="margin-bottom: 0">
        <div class="card-head">
          <div style="display: flex; align-items: center; gap: 10px">
            <span style="width: 34px; height: 34px; border-radius: 9px; background: var(--gradient); display: flex; align-items: center; justify-content: center">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="ch.icon" /></svg>
            </span>
            <div>
              <div style="font-weight: 600; font-size: 14px">{{ ch.label }}</div>
              <div style="font-size: 11.5px; color: var(--text-dim)">{{ ch.desc }}</div>
            </div>
          </div>
          <div class="card-actions">
            <button class="btn secondary small" @click="addConfig(ch.key)">＋</button>
          </div>
        </div>

        <div v-for="cfg in activePreset().channels[ch.key]" :key="cfg.id" style="border-top: 1px solid var(--border); padding-top: var(--space-3); margin-top: var(--space-2)">
          <template v-if="ch.key !== 'llm'">
            <div class="row" style="margin-bottom: 8px">
              <label class="field" style="margin-bottom: 0; flex: 1">
                <span>服务商模板（通用适配器，可选）</span>
                <select
                  :value="cfg.adapter ?? ''"
                  @change="(e: any) => onTemplateChange(ch.key, cfg, (e.target as HTMLSelectElement).value)"
                >
                  <option value="">（手动配置 / OpenAI 兼容）</option>
                  <option v-for="t in templatesByChannel[ch.key]" :key="t.id" :value="t.id">{{ t.name }}</option>
                  <option value="__custom__" disabled>── 自定义模板见下方高级选项 ──</option>
                </select>
              </label>
              <button class="btn ghost small" style="align-self: flex-end" @click="toggleCustom(ch.key + ':' + cfg.id)">高级</button>
            </div>
          </template>
          <div class="row" style="margin-bottom: 8px; align-items: flex-end">
            <label class="field" style="flex: 1; margin-bottom: 0">
              <span>配置名</span>
              <input type="text" v-model="cfg.name" />
            </label>
            <button class="btn small" :class="cfgActive(ch.key, cfg.id) ? '' : 'ghost'" @click="setActive(ch.key, cfg.id)">
              {{ cfgActive(ch.key, cfg.id) ? "✓ 使用中" : "设为当前" }}
            </button>
            <button class="btn danger small" @click="removeConfig(ch.key, cfg.id)">删</button>
          </div>
          <div class="row">
            <label class="field grow-2">
              <span>Base URL</span>
              <input type="text" v-model="cfg.baseUrl" placeholder="https://api.deepseek.com" />
            </label>
            <label class="field">
              <span>Model</span>
              <input type="text" v-model="cfg.model" placeholder="deepseek-chat" />
            </label>
          </div>
          <div class="row">
            <label class="field grow-2">
              <span>API Key</span>
              <input type="password" v-model="cfg.apiKey" placeholder="sk-…" />
            </label>
            <label class="field">
              <span>路径前缀（可选）</span>
              <input type="text" v-model="cfg.extra!.pathPrefix" placeholder="留空自动 /v1" />
            </label>
          </div>
          <div class="row" style="margin-top: 2px">
            <button class="btn small" :class="testing?.key === ch.key && testing?.id === cfg.id ? 'is-loading' : 'ghost'" :disabled="!!testing" @click="runTest(ch.key, cfg)">
              <span v-if="testing?.key === ch.key && testing?.id === cfg.id" class="spinner" />
              {{ testing?.key === ch.key && testing?.id === cfg.id ? "测试中" : "测试连接" }}
            </button>
            <span
              v-if="testResult && testResult.key === ch.key && testResult.id === cfg.id"
              style="font-size: 12px"
              :class="testResult.ok ? 'tag ok' : 'tag err'"
            >
              {{ testResult.msg }}
            </span>
          </div>
          <details v-if="ch.key === 'tts'" style="margin-top: 8px">
            <summary style="font-size: 12px; color: var(--text-dim); cursor: pointer">高级选项：音色列表</summary>
            <label class="field" style="margin-top: 8px">
              <span>可用音色（每行一个；AI 提取时从中挑选，失败自动回退第一个）</span>
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
          <details v-if="customOpen[ch.key + ':' + cfg.id]" style="margin-top: 8px">
            <summary style="font-size: 12px; color: var(--text-dim); cursor: pointer">自定义适配器模板（JSON，优先级高于服务商模板）</summary>
            <label class="field" style="margin-top: 8px">
              <span>适配器模板（字段：id/name/capability/mode/endpoint/requestMap/response/poll/voices/rawResponse，见项目文档）</span>
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
      </div>
    </div>
  </div>
</template>
