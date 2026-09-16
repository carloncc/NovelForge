<script setup lang="ts">
import { t } from "../../i18n";
import { STAGE_LABELS, STAGE_ORDER } from "../../core/types";
import { goPage } from "../../stores/nav";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const {
  selectedStages,
  stageHint,
  start,
  busy,
  assetBusy,
  queueRunning,
  rerunChapters,
  toggleAllRerun,
  toggleChapterRerun,
} = useGenerateController();
</script>

<template>
    <div class="card">
      <div class="card-head">
        <h3>{{ t("本次执行阶段") }}</h3>
        <div class="card-actions">
          <button class="btn ghost small" @click="selectedStages = { split: true, translate: true, extract: true, script: true, image: true, voice: true, assemble: true }">{{ t("全选") }}</button>
          <button class="btn ghost small" @click="selectedStages = { split: false, translate: false, extract: false, script: false, image: false, voice: false, assemble: false }">{{ t("全不选") }}</button>
        </div>
      </div>
      <div class="opt-grid">
        <label v-for="s in STAGE_ORDER" :key="s" class="opt-item" :title="stageHint(s)">
          <input type="checkbox" v-model="selectedStages[s]" />
          {{ t(STAGE_LABELS[s]) }}
        </label>
      </div>
      <label class="opt-item mt-3">
        <input type="checkbox" v-model="projectState.options.extractAgent" />
        {{ t("Agent 模式（多步自主扫描 + 工具调用，超长小说更稳）") }}
      </label>
      <label class="opt-item mt-2" :title="t('单次请求塞太多字容易撞网关超时/500；0=自动（按语种估算，上限15万字）。已出现 500 时调小，如 40000')">
        <span>{{ t("提取分段") }}</span>
        <input type="number" v-model.number="projectState.options.extractChunkChars" min="0" step="5000" style="width: 90px" />
        <span class="hint">{{ t("字（0=自动）") }}</span>
      </label>
      <p class="hint mt-3">
        {{ t("未勾选的阶段会复用已有结果（卡片/剧本/素材），不会重新计费；若某阶段从未运行过则会提示需先运行。") }}
      </p>
      <div class="row mt-3">
        <button class="btn" :disabled="busy || !!assetBusy || queueRunning" @click="start">
          <span v-if="busy" class="spinner" />
          {{ busy ? t("生成中…") : t("开始生成（整书）") }}
        </button>
        <span class="hint">{{ t("按上方勾选的阶段与下方勾选的章节运行") }}</span>
      </div>
    </div>
    <div v-if="projectState.novel" class="card">
      <div class="card-head">
        <h3>{{ t("本次重跑 / 分章节生成章节") }}</h3>
        <div class="card-actions">
          <button class="btn ghost small" @click="toggleAllRerun(true)">{{ t("全选") }}</button>
          <button class="btn ghost small" @click="toggleAllRerun(false)">{{ t("全不选") }}</button>
        </div>
      </div>
      <p class="hint mb-3">{{ t("未勾选章节复用已有缓存；只勾选部分章节时，配音阶段仅生成这些章节的台词（适合分章节批量配音，避免一次性撞限流）。无缓存则跳过") }}</p>
      <div class="opt-grid">
        <label v-for="(ch, i) in projectState.novel.chapters" :key="i" class="opt-item">
          <input
            type="checkbox"
            :checked="rerunChapters === null || rerunChapters.includes(ch.index)"
            @change="toggleChapterRerun(ch.index, ($event.target as HTMLInputElement).checked)"
          />
          <span class="text-ellipsis">{{ ch.title }}</span>
        </label>
      </div>
    </div>
    <div v-else class="card empty-next">
      <p class="hint">{{ t("还没有小说：导入小说（或加载示例小说）后再整书生成。") }}</p>
      <button class="btn small" @click="goPage('import')">{{ t("去导入小说") }}</button>
    </div>
</template>
