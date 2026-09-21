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
  <!-- 扁平一行（不再嵌套折叠）：状态标签 + 目录输入 + 浏览/加载；目录信息在外层「设置」摘要也有 -->
  <div class="wb-project">
    <div class="wb-project-row">
      <strong>{{ t("项目") }}</strong>
      <span class="tag" :class="projectState.novel ? 'ok' : 'warn'">
        {{ projectState.novel ? t("已载入小说") : t("未载入小说") }}
      </span>
      <span v-if="projectState.lastResult" class="tag ok">{{ t("已有生成结果") }}</span>
      <input
        type="text"
        v-model="outputDirDraft"
        class="grow"
        :disabled="locked"
        :placeholder="t('输出目录')"
        :title="projectState.outputDir || t('未设置输出目录')"
      />
      <button class="link-btn" :disabled="locked" @click="browseOutputDir">{{ t("浏览…") }}</button>
      <button class="link-btn" :disabled="locked" @click="loadProjectState">{{ t("加载该项目") }}</button>
    </div>
  </div>
</template>

<style scoped>
.wb-project-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
</style>
