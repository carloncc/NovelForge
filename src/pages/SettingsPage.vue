<script setup lang="ts">
import { computed, ref } from "vue";
import { t } from "../i18n";
import PageHead from "../components/PageHead.vue";
import ContentSettings from "../components/settings/ContentSettings.vue";
import FigureSettings from "../components/settings/FigureSettings.vue";
import QualitySettings from "../components/settings/QualitySettings.vue";
import SplitSettings from "../components/settings/SplitSettings.vue";
import ProjectSettings from "../components/settings/ProjectSettings.vue";
import { useGenerateController } from "../stores/generate";

type SettingsTab = "content" | "figure" | "output" | "split" | "project";
/** 五个一级 tab 全部直出：没有折叠；扩展输出并入「输出与质量」，各区含 tab 在内常驻控件都 ≤15 */
const tab = ref<SettingsTab>("content");

/** #1110/#1358：设置页可直接触发管线动作（AI 分章/追加），被 execute 忙守卫拦截时原因只写在生成页。
 *  此处渲染同一来源的 error，并在任务在途时给出运行中提示，避免「点了没反应」。只读 store，不改管线。 */
const gen = useGenerateController();
const settingsError = computed(() => gen.error.value);
const settingsRunning = computed(() => gen.busy.value || gen.queueRunning.value || !!gen.assetBusy.value);
</script>

<template>
  <div class="inner">
    <PageHead :title="t('生成设置')" :sub="t('配置一次即可；生成页只保留一个主按钮，其余设置都在这里')" />

    <div v-if="settingsError" class="notice danger mb-4">{{ settingsError }}</div>
    <div v-else-if="settingsRunning" class="notice mb-4">{{ t("有生成/素材任务正在运行，设置页的管线按钮暂时不可用（请等它完成或先点侧栏「停止」）") }}</div>

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
