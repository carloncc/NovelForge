<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../i18n";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const { outputDirDraft, busy, assetBusy, queueRunning, browseOutputDir, loadProjectState } =
  useGenerateController();

const locked = computed(() => busy.value || !!assetBusy.value || queueRunning.value);
</script>

<template>
  <details class="card wb-project" :open="!projectState.novel">
    <summary>
      <strong>{{ t("项目") }}</strong>
      <span class="tag" :class="projectState.novel ? 'ok' : 'warn'">
        {{ projectState.novel ? t("已载入小说") : t("未载入小说") }}
      </span>
      <span v-if="projectState.lastResult" class="tag ok">{{ t("已有生成结果") }}</span>
      <code class="hint text-ellipsis" style="margin-left: auto; max-width: 46%" :title="projectState.outputDir || t('未设置输出目录')">{{ projectState.outputDir || t("未设置输出目录") }}</code>
    </summary>
    <div class="row mt-3">
      <input type="text" v-model="outputDirDraft" class="grow" :disabled="locked" />
      <button class="link-btn" :disabled="locked" @click="browseOutputDir">{{ t("浏览…") }}</button>
      <button class="link-btn" :disabled="locked" @click="loadProjectState">{{ t("加载该项目") }}</button>
    </div>
  </details>
</template>

<style scoped>
.wb-project summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  list-style: none;
}
.wb-project summary::-webkit-details-marker {
  display: none;
}
</style>
