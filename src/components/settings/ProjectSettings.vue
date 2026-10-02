<script setup lang="ts">
import { t } from "../../i18n";
import { goPage } from "../../stores/nav";
import { projectState } from "../../stores/project";
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("项目目录") }}</h3>
      <span class="hint">{{ t("选择/切换项目的位置已移到生成页顶部") }}</span>
    </div>
    <p class="hint">{{ t("生成设置随项目保存；切换项目后请重新加载") }}</p>
    <p class="mb-0"><strong>{{ t("当前项目：") }}</strong>{{ projectState.outputDir || t("未设置输出目录") }}</p>
    <button class="btn secondary small mt-3" @click="goPage('generate')">{{ t("去生成页切换项目") }}</button>
  </div>
</template>
