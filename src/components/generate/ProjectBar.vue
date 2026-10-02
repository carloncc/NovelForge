<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../i18n";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const { outputDirDraft, busy, assetBusy, queueRunning, browseOutputDir, loadProjectState } =
  useGenerateController();

const locked = computed(() => busy.value || !!assetBusy.value || queueRunning.value);
/** 目录是否已真正载入（输入框内容与已加载项目不同 → 提示需要点「加载该项目」） */
const notLoaded = computed(
  () => !!outputDirDraft.value.trim() && outputDirDraft.value.trim() !== projectState.outputDir,
);
</script>

<template>
  <!-- #1510：目录选择器从「生成设置 → 项目」搬到这里直出。
       此前它只存在于设置页的一个 tab 里，用户在生成页找不到「项目」，得翻半天。 -->
  <div class="wb-project">
    <div class="wb-project-row">
      <input
        type="text"
        v-model="outputDirDraft"
        class="grow"
        :disabled="locked"
        :placeholder="t('输出目录')"
        :title="projectState.outputDir || t('未设置输出目录')"
      />
      <button class="btn secondary small" :disabled="locked" @click="browseOutputDir">{{ t("浏览…") }}</button>
      <button
        class="btn small"
        :class="{ primary: notLoaded }"
        :disabled="locked"
        @click="loadProjectState"
      >
        {{ t("加载该项目") }}
      </button>
    </div>
    <p v-if="notLoaded" class="hint mt-2 wb-hint">
      {{ t("目录已改动：点「加载该项目」才会切过去（当前已加载的是另一个项目）") }}
    </p>
  </div>
</template>

<style scoped>
.wb-project-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* 全局输入框 width:100% 会把按钮挤到下一行：给输入框可收缩基准宽度，保持同一行 */
.wb-project-row input {
  flex: 1 1 260px;
  width: auto;
}
.wb-project-row > button {
  flex: none;
}
.wb-hint {
  margin-bottom: 0;
}
</style>
