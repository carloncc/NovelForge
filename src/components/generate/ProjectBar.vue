<script setup lang="ts">
import { t } from "../../i18n";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const { outputDirDraft, busy, assetBusy, queueRunning, browseOutputDir, loadProjectState } =
  useGenerateController();
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("项目") }}</h3>
      <div class="card-actions">
        <span class="tag" :class="projectState.novel ? 'ok' : 'warn'">
          {{ projectState.novel ? t("已载入小说") : t("未载入小说") }}
        </span>
        <span v-if="projectState.lastResult" class="tag ok">{{ t("已有生成结果") }}</span>
      </div>
    </div>
    <label class="field mb-0">
      <span>{{ t("输出目录") }}</span>
      <div class="row">
        <input type="text" v-model="outputDirDraft" class="grow" />
        <button class="btn secondary small shrink-0" :disabled="busy || !!assetBusy || queueRunning" @click="browseOutputDir">{{ t("浏览…") }}</button>
        <button class="btn ghost small shrink-0" :disabled="busy || !!assetBusy || queueRunning" @click="loadProjectState">{{ t("加载该项目") }}</button>
      </div>
    </label>
  </div>
</template>
