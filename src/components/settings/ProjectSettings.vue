<script setup lang="ts">
import { t } from "../../i18n";
import ProjectBar from "../generate/ProjectBar.vue";
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("项目目录") }}</h3>
    </div>
    <ProjectBar />
    <p class="hint mt-2">{{ t("生成设置随项目保存；切换项目后请重新加载") }}</p>
  </div>
</template>
