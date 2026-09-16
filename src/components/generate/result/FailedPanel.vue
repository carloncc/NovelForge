<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../../i18n";
import { ERROR_CLASS_ICON, ERROR_CLASS_LABEL, classifyError } from "../../../utils/errorClassifier";
import { useGenerateController } from "../../../stores/generate";

// 结果区子面板：状态全部来自 generate store。
const {
  tab,
  goFullMode,
  failedTasks,
  failedTaskSummary,
  retryFailed,
  retryFailedTask,
  busy,
  assetBusy,
  queueRunning,
} = useGenerateController();

const runBusy = computed(() => busy.value || !!assetBusy.value || queueRunning.value);
const canRetryOne = (kind: string): boolean => kind === "image" || kind === "tts" || kind === "script";
</script>

<template>
<div v-if="tab === 'failed'">
  <div class="card" v-if="failedTasks.length">
    <div class="card-head">
      <h3>{{ t("失败任务（") }}{{ failedTasks.length }}{{ t(" 个）") }}</h3>
      <div class="card-actions"><button class="btn small" :disabled="runBusy" @click="retryFailed">{{ t("定位重试") }}</button><button class="btn secondary small" :disabled="runBusy" @click="goFullMode">{{ t("去整书生成") }}</button></div>
    </div>
    <div v-if="failedTaskSummary.length > 1" style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px">
      <span v-for="s in failedTaskSummary" :key="s.label" class="tag" style="background: var(--err-soft); color: var(--text)">{{ s.icon }} {{ s.label }} × {{ s.count }}</span>
    </div>
    <div style="display: flex; flex-direction: column; gap: 8px">
      <div v-for="f in failedTasks" :key="`${f.kind}:${f.id}:${f.at}`" style="border: 1px solid var(--err-soft); background: var(--err-soft); border-radius: var(--radius-sm); padding: 10px 12px">
        <div style="display: flex; align-items: center; gap: 8px">
          <span class="tag err">{{ f.kind === "image" ? t("图像") : f.kind === "script" ? t("剧本") : f.kind === "llm" ? "LLM" : t("配音") }}</span>
          <span>{{ ERROR_CLASS_ICON[classifyError({ message: f.message })] }} {{ ERROR_CLASS_LABEL[classifyError({ message: f.message })] }}</span>
          <span style="font-weight: 600; font-size: 13px">{{ f.id }}</span>
          <span style="color: var(--text-faint); font-size: 11px; margin-left: auto">{{ new Date(f.at).toLocaleTimeString() }}</span>
          <button
            v-if="canRetryOne(f.kind)"
            class="btn small"
            :disabled="runBusy"
            :title="t('只重试这一条失败项（最小范围，不整书重跑）')"
            @click="retryFailedTask(f)"
          >{{ t("重试") }}</button>
        </div>
        <p style="font-size: 12px; color: var(--text-dim); margin-top: 4px; word-break: break-all">{{ f.message }}</p>
      </div>
    </div>
  </div>
  <div v-else class="empty">{{ t("暂无失败任务") }}</div>
</div>
</template>
