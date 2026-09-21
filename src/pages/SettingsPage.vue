<script setup lang="ts">
import { ref } from "vue";
import { t } from "../i18n";
import PageHead from "../components/PageHead.vue";
import ContentSettings from "../components/settings/ContentSettings.vue";
import FigureSettings from "../components/settings/FigureSettings.vue";
import QualitySettings from "../components/settings/QualitySettings.vue";
import SplitSettings from "../components/settings/SplitSettings.vue";
import ProjectSettings from "../components/settings/ProjectSettings.vue";

type SettingsTab = "content" | "figure" | "output" | "split" | "project";
/** 五个一级 tab 全部直出：没有折叠；扩展输出并入「输出与质量」，各区含 tab 在内常驻控件都 ≤15 */
const tab = ref<SettingsTab>("content");
</script>

<template>
  <div class="inner">
    <PageHead :title="t('生成设置')" :sub="t('配置一次即可；生成页只保留一个主按钮，其余设置都在这里')" />

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'content' }" @click="tab = 'content'">{{ t("内容") }}</button>
      <button class="tab" :class="{ active: tab === 'figure' }" @click="tab = 'figure'">{{ t("立绘") }}</button>
      <button class="tab" :class="{ active: tab === 'output' }" @click="tab = 'output'">{{ t("输出与质量") }}</button>
      <button class="tab" :class="{ active: tab === 'split' }" @click="tab = 'split'">{{ t("分章") }}</button>
      <button class="tab" :class="{ active: tab === 'project' }" @click="tab = 'project'">{{ t("项目") }}</button>
    </div>

    <template v-if="tab === 'content'">
      <ContentSettings />
    </template>
    <FigureSettings v-else-if="tab === 'figure'" />
    <QualitySettings v-else-if="tab === 'output'" />
    <SplitSettings v-else-if="tab === 'split'" />
    <ProjectSettings v-else />
  </div>
</template>
