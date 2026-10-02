<script setup lang="ts">
/**
 * 分章工作面板（#1510）：把「AI 分章 / 核对 / 追加新章节 / 分章意见」做成可复用的一块，
 * 由生成页与设置页共同渲染——此前这些入口只存在于「生成设置 → 分章」tab，
 * 用户在生成页找不到「分章」，得翻半天。
 */
import { computed } from "vue";
import { t } from "../../i18n";
import { useGenerateController } from "../../stores/generate";

const {
  splitOpinion,
  splitConfirmed,
  previewSplit,
  confirmSplit,
  pickAppendFile,
  onAppendFile,
  appendInput,
  busy,
  assetBusy,
  queueRunning,
  error,
} = useGenerateController();

/** 管线/素材/队列任一在途即视为忙；按钮禁用并给出原因，避免静默无反应 */
const splitBusy = computed(() => busy.value || queueRunning.value || !!assetBusy.value);
const splitBusyReason = computed(() =>
  splitBusy.value ? t("有生成/素材任务正在运行，请等它完成或先点侧栏「停止」再试") : "",
);
</script>

<template>
  <div class="split-panel">
    <div class="row split-row">
      <input
        class="grow"
        type="text"
        v-model="splitOpinion"
        :placeholder="t('分章意见（可选）：如“第×章太长请拆分”…')"
      />
      <button class="btn small" :disabled="splitBusy" :title="splitBusyReason" @click="previewSplit">{{ t("AI 分章") }}</button>
    </div>
    <p v-if="error" class="notice danger mt-2">{{ error }}</p>
    <p class="hint mt-2">{{ t("填了意见会强制全书 AI 重新分章（计费），并作废下游剧本/图像/配音缓存") }}</p>

    <div class="row mt-3 split-actions">
      <button class="btn secondary small" :disabled="splitConfirmed" @click="confirmSplit">
        {{ splitConfirmed ? t("分章已核对") : t("标记为已核对") }}
      </button>
      <button class="btn secondary small" :disabled="splitBusy" :title="splitBusyReason" @click="pickAppendFile">{{ t("追加新章节") }}</button>
      <input ref="appendInput" type="file" accept=".txt,text/plain" style="display: none" @change="onAppendFile" />
    </div>
    <p class="hint mt-2">{{ t("核对章节边界无误后标记；改动分章选项会让标记自动失效") }}</p>
  </div>
</template>

<style scoped>
/* 全局 .row > * 会把按钮/输入拉成等宽：这两行只按内容宽排布 */
.split-row > *,
.split-actions > * {
  flex: none;
  min-width: 0;
}
/* 全局输入框 width:100% 会把按钮挤到下一行：给输入框可收缩的基准宽度，保持同一行 */
.split-row input {
  flex: 1 1 220px;
  width: auto;
}
</style>
