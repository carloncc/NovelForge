<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../i18n";
import { LANGUAGES } from "../../core/types";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const { styleRecognizing, pickStyleRef, styleRefSrc, onStyleRefFile, styleRefInput, cancelStyleRecognize } =
  useGenerateController();

type PresetId = "standard" | "save" | "custom";
type ToggleKey = "useImage" | "useTts" | "useVideoPoints" | "useBgm" | "useSe";

/** 预设只写 5 个总开关：语言/画风等由用户手填的字段不参与预设，避免选预设时被覆盖 */
const PRESETS: { id: Exclude<PresetId, "custom">; label: string; options: Record<ToggleKey, boolean> }[] = [
  {
    id: "standard",
    label: "标准（图像 + 配音 + 音效）",
    options: { useImage: true, useTts: true, useVideoPoints: true, useBgm: true, useSe: true },
  },
  {
    id: "save",
    label: "省钱（只生成图像）",
    options: { useImage: true, useTts: false, useVideoPoints: false, useBgm: false, useSe: false },
  },
];

/** 预设是派生值：开关匹配哪一组就显示哪一组，否则「自定义」——改任一开关自动落到自定义 */
const activePreset = computed<PresetId>(() => {
  const o = projectState.options;
  const hit = PRESETS.find((p) => (Object.keys(p.options) as ToggleKey[]).every((k) => !!o[k] === p.options[k]));
  return hit ? hit.id : "custom";
});

function onPresetChange(e: Event): void {
  const el = e.target as HTMLSelectElement;
  const preset = PRESETS.find((p) => p.id === el.value);
  if (!preset) {
    // 「自定义」没有对应的开关组合：把下拉回显到当前真实匹配的预设，不停留在假状态
    el.value = activePreset.value;
    return;
  }
  Object.assign(projectState.options, preset.options);
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("内容") }}</h3>
      <span class="hint">{{ t("预设一键写回下排开关；单项仍可单独覆盖") }}</span>
    </div>

    <div class="field-grid">
      <label class="field preset-field">
        <span>{{ t("预设") }}</span>
        <select :value="activePreset" @change="onPresetChange">
          <option v-for="p in PRESETS" :key="p.id" :value="p.id">{{ t(p.label) }}</option>
          <option value="custom">{{ t("自定义") }}</option>
        </select>
        <span class="hint">{{ t("标准 = 图像 + 配音 + 视频推荐位 + BGM + 音效；省钱 = 只生成图像") }}</span>
      </label>
    </div>

    <div class="opt-grid mt-3">
      <label class="opt-item opt-stack">
        <input type="checkbox" v-model="projectState.options.useImage" />
        <span class="opt-text">
          {{ t("图像（立绘/背景/CG/物品）") }}
          <span class="hint">{{ t("关闭后不生成任何图片") }}</span>
        </span>
      </label>
      <label class="opt-item opt-stack">
        <input type="checkbox" v-model="projectState.options.useTts" />
        <span class="opt-text">
          {{ t("配音（TTS）") }}
          <span class="hint">{{ t("关闭后没有台词语音") }}</span>
        </span>
      </label>
    </div>

    <div class="card-section">
      <div class="field-grid">
        <label class="field">
          <span>{{ t("目标语言（先把小说翻译成该语言再生成，留空 = 用原文）") }}</span>
          <select v-model="projectState.options.language">
            <option value="">{{ t("不翻译（使用原文）") }}</option>
            <option v-for="l in LANGUAGES" :key="l.code" :value="l.code">{{ l.label }}</option>
          </select>
          <span class="hint">{{ t("选了语言会多跑一次翻译阶段，之后全部阶段都用译文") }}</span>
        </label>
        <label class="field">
          <span>{{ t("统一画风（留空用默认画风，所有立绘/背景/CG 保持一致）") }}</span>
          <input
            type="text"
            v-model="projectState.options.imageStyle"
            :placeholder="t('例：unified Japanese anime style, cel shading, clean line art')"
          />
          <span class="hint">{{ t("中英文描述均可；只在改动后新生成的图片上生效") }}</span>
        </label>
        <label class="field">
          <span>{{ t("剧本风格（留空不调整。例：古风典雅 / 幽默风趣 / 冷峻克制）") }}</span>
          <input type="text" v-model="projectState.options.scriptStyle" :placeholder="t('例：古风典雅，多用对仗与典雅意象')" />
          <span class="hint">{{ t("只改台词与旁白的改写口吻，不改剧情") }}</span>
        </label>
      </div>

      <div class="field-grid mt-3">
        <div class="field">
          <span>{{ t("旁白处理") }}</span>
          <label class="opt-item">
            <input type="checkbox" v-model="projectState.options.compressNarration" />
            {{ t("压缩旁白（更短更快，会精简原文描写）") }}
          </label>
          <span class="hint">{{ t("关闭（默认）忠实保留原文旁白；开启后剧本更短、生成更快") }}</span>
        </div>

        <div class="field">
          <span>{{ t("风格参考图（上传图片 → AI 识别画风并自动填入上方）") }}</span>
          <div class="row style-row">
            <button class="btn secondary small" :disabled="styleRecognizing" @click="pickStyleRef">
              <span v-if="styleRecognizing" class="spinner" />
              {{ styleRecognizing ? t("AI 识别中…") : styleRefSrc ? t("更换图片并重新识别") : t("上传图片，AI 识别画风") }}
            </button>
            <button v-if="styleRecognizing" class="btn small" @click="cancelStyleRecognize">{{ t("取消") }}</button>
            <span v-if="styleRefSrc" class="tag ok">{{ t("已识别") }}</span>
            <button v-if="styleRefSrc" class="btn small" @click="styleRefSrc = ''">{{ t("清除") }}</button>
            <input ref="styleRefInput" type="file" accept="image/*" style="display: none" @change="onStyleRefFile" />
          </div>
          <span class="hint">{{ t("识别结果写入上方「统一画风」；识别失败请检查「API 配置」的视觉模型") }}</span>
        </div>
      </div>

      <img v-if="styleRefSrc" class="ref-thumb" :src="styleRefSrc" :alt="t('风格参考图')" />
    </div>
  </div>
</template>

<style scoped>
/* 预设是整页唯一的总开关，不给它拉满行宽 */
.preset-field {
  grid-column: 1 / -1;
  max-width: 460px;
}
.opt-stack {
  align-items: flex-start;
}
.opt-stack input[type="checkbox"] {
  margin-top: 2px;
}
.opt-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* div.field 不在全局 `label.field > span` 覆盖内，这里统一字段标题样式 */
.field > span {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 5px;
  font-weight: 500;
}
/* 全局 label.field > span 会命中尾部的 hint：还原为普通提示字重与间距 */
.field > .hint {
  display: block;
  font-weight: 400;
  margin-bottom: 0;
}
/* 全局 .row > * 会把 tag/按钮拉成等宽：这一行只按内容宽排布 */
.style-row > * {
  flex: none;
  min-width: 0;
}
.ref-thumb {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--border);
  margin-top: var(--space-3);
  display: block;
}
</style>
