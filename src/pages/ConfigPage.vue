<script setup lang="ts">
import { ref } from "vue";
import {
  activePreset,
  addConfig,
  removeConfig,
  addPreset,
  removePreset,
  configState,
  activeConfig,
} from "../stores/config";
import { testLlm, testTts, testImage } from "../api/openaiCompatible";
import type { ApiConfig, ChannelKey } from "../core/types";

const channels: { key: ChannelKey; label: string; desc: string }[] = [
  { key: "llm", label: "文本 LLM", desc: "角色/场景/物品提取与剧本生成" },
  { key: "image", label: "图像 API", desc: "立绘 / 背景 / CG / 物品图生成" },
  { key: "tts", label: "TTS 配音", desc: "逐句配音（可选）" },
];

const testing = ref<{ key: ChannelKey; id: string; state: string } | null>(null);
const testResult = ref<{ key: ChannelKey; id: string; ok: boolean; msg: string } | null>(null);

async function runTest(kind: ChannelKey, cfg: ApiConfig): Promise<void> {
  testing.value = { key: kind, id: cfg.id, state: "测试中…" };
  testResult.value = null;
  try {
    if (kind === "llm") {
      const reply = await testLlm(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: `连接正常，模型回复：${reply.slice(0, 60)}` };
    } else if (kind === "tts") {
      await testTts(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: "连接正常，语音合成可用" };
    } else {
      await testImage(cfg);
      testResult.value = { key: kind, id: cfg.id, ok: true, msg: "连接正常，图片生成可用（已消耗 1 张额度）" };
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
  <div class="page-title">API 配置</div>
  <div class="page-sub">
    三通道全部自定义（OpenAI 兼容协议）：base_url + api_key + model。支持 DeepSeek / 通义 /
    硅基流动 / Kimi / OpenAI / Ollama 等任意兼容服务，可保存多套配置切换。
  </div>

  <div class="card">
    <div class="row" style="justify-content: space-between">
      <div class="row" style="flex: 1">
        <label class="field" style="margin-bottom: 0; flex: 2">
          <span>当前配置组</span>
          <select
            :value="configState.activePresetId"
            @change="configState.activePresetId = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="p in configState.presets" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <button class="btn secondary" style="align-self: flex-end" @click="addPreset">＋ 新建配置组</button>
        <button
          v-if="configState.presets.length > 1"
          class="btn danger"
          style="align-self: flex-end"
          @click="removePreset(configState.activePresetId)"
        >删除该组</button>
      </div>
    </div>
  </div>

  <div v-for="ch in channels" :key="ch.key" class="card">
    <div class="row" style="justify-content: space-between">
      <div>
        <h3>{{ ch.label }}</h3>
        <p style="color: var(--text-dim); font-size: 12px">{{ ch.desc }}</p>
      </div>
      <div class="row" style="flex: none">
        <button class="btn secondary small" @click="addConfig(ch.key)">＋ 添加配置</button>
      </div>
    </div>

    <div v-for="cfg in activePreset().channels[ch.key]" :key="cfg.id" style="margin-top: 14px; border-top: 1px solid var(--border); padding-top: 14px">
      <div class="row" style="margin-bottom: 8px; align-items: flex-end">
        <label class="field" style="flex: 1; margin-bottom: 0">
          <span>配置名</span>
          <input type="text" v-model="cfg.name" />
        </label>
        <button
          class="btn small"
          :class="cfgActive(ch.key, cfg.id) ? '' : 'secondary'"
          @click="setActive(ch.key, cfg.id)"
        >
          {{ cfgActive(ch.key, cfg.id) ? "✓ 当前使用" : "设为当前" }}
        </button>
        <button class="btn danger small" @click="removeConfig(ch.key, cfg.id)">删除</button>
      </div>
      <div class="row">
        <label class="field grow-2">
          <span>Base URL</span>
          <input type="text" v-model="cfg.baseUrl" placeholder="https://api.deepseek.com 或 …/v1" />
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
          <input type="text" v-model="cfg.extra!.pathPrefix" placeholder="留空自动补 /v1" />
        </label>
      </div>
      <div class="row" style="margin-top: 4px">
        <button class="btn small" :disabled="!!testing" @click="runTest(ch.key, cfg)">
          {{ testing?.key === ch.key && testing?.id === cfg.id ? testing.state : "测试连接" }}
        </button>
        <span v-if="testResult && testResult.key === ch.key && testResult.id === cfg.id"
          style="font-size: 12px; color: var(--ok)"
          :style="{ color: testResult.ok ? 'var(--ok)' : 'var(--err)' }">
          {{ testResult.msg }}
        </span>
      </div>
      <div v-if="ch.key === 'tts'" style="margin-top: 8px">
        <label class="field">
          <span>可用音色列表（每行一个；AI 提取角色时从中挑选，TTS 失败自动回退第一个）</span>
          <textarea
            :value="(cfg.extra!.voiceLibrary as string[] | undefined)?.join('\n') ?? ''"
            rows="4"
            @change="
              (e: any) => {
                const list = (e.target as HTMLTextAreaElement).value
                  .split('\n')
                  .map((s: string) => s.trim())
                  .filter(Boolean);
                if (list.length) cfg.extra!.voiceLibrary = list;
              }
            "
            placeholder="alloy&#10;echo&#10;fable&#10;onyx&#10;nova&#10;shimmer"
          />
        </label>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>使用提示</h3>
    <ul style="color: var(--text-dim); font-size: 13px; line-height: 2; padding-left: 18px">
      <li>文本 LLM 必填（DeepSeek 约 ¥1-2/百万 token 最便宜）；图像 / TTS 可后补。</li>
      <li>图像通道如支持参考图（如硅基流动部分模型），会自动用人物参考图保持角色一致性；不支持则自动降级为文生图。</li>
      <li>TTS 的「音色」取角色卡 voiceName 字段，可在生成后于角色卡中调整。</li>
      <li>配置自动保存到系统应用配置目录，可导入导出迁移。</li>
    </ul>
  </div>
</template>
