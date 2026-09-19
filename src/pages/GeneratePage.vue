<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { currentLang, t } from "../i18n";
import { projectState } from "../stores/project";
import PageHead from "../components/PageHead.vue";
import StepIndicator from "../components/StepIndicator.vue";
import ScopeTabs from "../components/generate/ScopeTabs.vue";
import ChapterWorkbench from "../components/generate/ChapterWorkbench.vue";
import ProjectBar from "../components/generate/ProjectBar.vue";
import OptionsPanel from "../components/generate/OptionsPanel.vue";
import FullRunPanel from "../components/generate/FullRunPanel.vue";
import StageRunPanel from "../components/generate/StageRunPanel.vue";
import ResultSection from "../components/generate/ResultSection.vue";
import { goPage } from "../stores/nav";
import AssetPreview from "../components/AssetPreview.vue";
import { useGenerateController } from "../stores/generate";

// 全部状态与行为集中在 useGenerateController：本页只做编排与模板映射。
const {
  tab,
  runMode,
  busy,
  liveProgress,
  livePct,
  visibleLogs,
  logPanelRef,
  copyLogs,
  saveLogs,
  copiedMsg,
  copiedMsgLevel,
  LOG_RENDER_LIMIT,
  pendingResumeStages,
  pendingResumeScope,
  clearPendingResume,
  STAGE_LABELS,
  pipelineSteps,
  currentStep,
  failedSteps,
  activeStepIndexes,
  failedTasks,
  chapterStatus,
  enabledNovelChapters,
  disabledNovelChapters,
  toggleNovelChapter,
  splitMeta,
  splitMetaText,
  splitOpinion,
  splitConfirmed,
  previewSplit,
  confirmSplit,
  queueRunning,
  selectedChapters,
  chapterIncludeVoice,
  chapterHasCards,
  toggleChapterSelected,
  selectIncompleteChapters,
  clearChapterSelection,
  runSelectedChapters,
  prepareChapterCards,
  runChapterQueue,
  stopChapterQueue,
  visualBibleReviewNeeded,
  scriptChapterFeedback,
  chapterForce,
  assetBusy,
  preview,
  runChapterFullRegen,
  runChapterPartRegen,
  appendInput,
  pickAppendFile,
  onAppendFile,
  stop,
  stopping,
} = useGenerateController();

/* 主页面只保留：状态 → 章节列表 → 唯一主按钮；设置与产物各收进一行折叠入口 */

/* UI13：原先在 setup 期一次性 t()，切换界面语言后摘要仍停留在旧语言；
   改为 computed 后随 currentLang 响应式重算，使用处需通过 .value 访问 */
const RUN_MODE_LABEL = computed<Record<string, string>>(() => ({
  chapter: t("逐章补全"),
  full: t("整书生成"),
  stage: t("单阶段重跑"),
}));
/* UI15：日志时间按界面语言本地化；函数在渲染时读取 currentLang，切语言后自动重渲染 */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(currentLang.value === "zh-CN" ? "zh-CN" : currentLang.value);
}
const settingsSummary = computed(() => {
  const o = projectState.options;
  const parts = [
    projectState.novel?.fileName ?? t("未选择小说"),
    RUN_MODE_LABEL.value[runMode.value] ?? runMode.value,
    `${t("图像")}${o.useImage ? "✓" : "×"}`,
    `${t("配音")}${o.useTts ? "✓" : "×"}`,
  ];
  return parts.join(" · ");
});

const scriptDoneCount = computed(
  () => Object.values(chapterStatus.lights).filter((l) => l.script).length,
);
const resultsSummary = computed(() => {
  const total = enabledNovelChapters.value.length;
  const fail = failedTasks.value.length;
  return [
    `${t("剧本")} ${scriptDoneCount.value}/${total}`,
    fail ? `${t("失败")} ${fail}` : t("无失败"),
    projectState.lastResult ? t("产物已就绪") : t("尚未组装"),
  ].join(" · ");
});
/** 产物区默认收起；任何程序性跳转（视觉守门/失败/卡片）都会自动展开 */
const resultsOpen = ref(false);
watch(tab, (v) => {
  // tab 已经是 run 时 watch 不触发，所以点击「处理失败项」这类跳转必须自己把抽屉打开，否则点击无反应
  if (v !== "run") resultsOpen.value = true;
});
</script>

<template>
  <div class="inner">
    <PageHead :title="t('生成项目')" :sub="t('选范围 → 生成 → 试玩 → 导出：每章状态一眼可见，主按钮只做下一步')">
      <button
        v-if="busy || !!assetBusy || queueRunning"
        class="btn danger"
        :disabled="stopping"
        @click="stop"
      >{{ stopping ? t("正在停止…") : t("停止") }}</button>
    </PageHead>

    <!-- 只有需要用户决策时才出现的横幅，每个最多一个入口 -->
    <div v-if="failedTasks.length" class="vb-banner fail-banner">
      <div>
        <strong>{{ t("有失败任务待处理：") }}{{ failedTasks.length }} {{ t("项") }}</strong>
        <p>{{ t("失败项已按原因分类；可逐项查看并重试，或一键按失败原因自动重跑（限流/超时会自动等待）。") }}</p>
      </div>
      <!-- tab 已是 run 时 watch(tab) 不会触发，必须同时显式展开产物抽屉，否则按钮看起来没反应 -->
      <button class="btn secondary small" @click="tab = 'run'; resultsOpen = true">{{ t("处理失败项") }}（{{ failedTasks.length }}）</button>
    </div>

    <div v-if="visualBibleReviewNeeded" class="vb-banner">
      <div>
        <strong>{{ t("图像生成前需要确认视觉守门") }}</strong>
        <p>{{ t("统一风格与角色三视图尚未批准，图像阶段会先停在这里。") }}</p>
      </div>
      <button class="btn secondary small" @click="tab = 'bible'">{{ t("去确认") }}</button>
    </div>

    <div v-if="pendingResumeStages.length" class="vb-banner">
      <div>
        <strong>{{ t("已排队的续跑计划（等视觉守门批准后自动执行）") }}</strong>
        <p>
          {{ t("阶段：") }}{{ pendingResumeStages.map((s) => t(STAGE_LABELS[s])).join(" → ") }}
          <template v-if="pendingResumeScope?.rerunChapters?.length"> · {{ t("章节：第") }} {{ pendingResumeScope.rerunChapters.map((n) => n + 1).join("、") }} {{ t("章") }}</template>
          <template v-else-if="pendingResumeScope?.rerunChapters === null"> · {{ t("章节：全书") }}</template>
        </p>
      </div>
      <button class="btn ghost small" @click="clearPendingResume">{{ t("取消计划") }}</button>
    </div>

    <!-- 进度：运行中给醒目的百分比进度条 + 阶段名；结束后保留步骤条 -->
    <div v-if="busy || currentStep >= 0" class="card gen-progress">
      <div v-if="busy" class="row items-center gap-3 mb-2" style="flex-wrap: wrap">
        <strong style="font-size: 15px">{{ pipelineSteps[currentStep] || t("准备中") }}</strong>
        <span v-if="liveProgress" class="hint">{{ liveProgress.label }}</span>
        <span class="grow" />
        <strong v-if="liveProgress" style="font-size: 18px; color: var(--primary)">{{ livePct }}%</strong>
        <span v-else class="hint">{{ t("阶段") }} {{ Math.max(currentStep + 1, 1) }}/{{ pipelineSteps.length }}</span>
      </div>
      <div v-if="busy" class="progress-bar mb-3" :class="{ 'is-indeterminate': !liveProgress }">
        <div class="progress-fill" :style="{ width: liveProgress ? livePct + '%' : '100%' }" />
      </div>
      <p v-if="busy && liveProgress" class="hint mb-3">
        {{ t("进度：") }}{{ liveProgress.done }}/{{ liveProgress.total }} · {{ liveProgress.step }}
      </p>
      <StepIndicator
        :steps="pipelineSteps"
        :current="currentStep"
        :failed="failedSteps"
        :active="busy ? activeStepIndexes : undefined"
      />
    </div>

    <!-- 设置抽屉：生成方式 / 项目目录 / 生成内容与高级项（默认展开） -->
    <details class="card gen-settings" open>
      <summary class="gen-summary">
        <strong>{{ t("设置") }}</strong>
        <span class="hint">{{ settingsSummary }}</span>
      </summary>
      <div class="mt-3">
        <ScopeTabs v-model="runMode" :disabled="queueRunning" />
        <ProjectBar />
        <OptionsPanel />
      </div>
    </details>

    <!-- 主区域：章节列表 + 唯一主按钮 -->
    <template v-if="runMode === 'chapter'">
      <input ref="appendInput" type="file" accept=".txt,text/plain" style="display: none" @change="onAppendFile" />
      <ChapterWorkbench
        v-if="projectState.novel"
        :chapters="enabledNovelChapters"
        :disabled-chapters="disabledNovelChapters"
        :lights="chapterStatus.lights"
        :feedback="scriptChapterFeedback"
        :force="chapterForce"
        :selected="selectedChapters"
        :disabled="busy || !!assetBusy"
        :queue-running="queueRunning"
        :include-voice="chapterIncludeVoice"
        :has-cards="chapterHasCards"
        :opinion="splitOpinion"
        :split-meta-text="splitMetaText"
        :split-ok="splitMeta.method === 'ai' && !splitMeta.stale"
        :split-confirmed="splitConfirmed"
        :split-min-chapter-chars="projectState.options.splitMinChapterChars ?? 0"
        :split-keep-specials="projectState.options.splitKeepSpecials ?? false"
        @regen="runChapterFullRegen"
        @regen-part="runChapterPartRegen"
        @toggle="toggleNovelChapter"
        @select="toggleChapterSelected"
        @select-incomplete="selectIncompleteChapters"
        @select-none="clearChapterSelection"
        @run-selected="runSelectedChapters"
        @run-queue="runChapterQueue"
        @stop-queue="stopChapterQueue"
        @append="pickAppendFile"
        @preview-split="previewSplit"
        @confirm-split="confirmSplit"
        @prepare="prepareChapterCards"
        @update-include-voice="chapterIncludeVoice = $event"
        @update-opinion="splitOpinion = $event"
        @update-feedback="(i, v) => (scriptChapterFeedback[i] = v)"
        @update-force="(i, v) => (chapterForce[i] = v)"
        @update-split-min-chapter-chars="projectState.options.splitMinChapterChars = $event"
        @update-split-keep-specials="projectState.options.splitKeepSpecials = $event"
      />
      <div v-else class="card empty-next">
        <p class="hint">{{ t("还没有小说：导入小说（或加载示例小说）后即可逐章生成。") }}</p>
        <button class="btn small" @click="goPage('import')">{{ t("去导入小说") }}</button>
      </div>
    </template>

    <template v-else-if="runMode === 'full'">
      <FullRunPanel />
    </template>

    <template v-else>
      <StageRunPanel />
    </template>

    <!-- 运行日志：常驻主页面（生成时实时滚动），不再藏在产物抽屉里 -->
    <div class="card">
      <div class="card-head">
        <h3>{{ t("运行日志") }}</h3>
        <div class="card-actions">
          <!-- UI10：仅阶段名（step）接入词典；日志正文是运行时拼接的中文（含章节名/路径），无法逐条翻译，如实提示 -->
          <span class="hint" style="align-self: center">{{ t("日志内容为运行记录，暂未全部本地化") }}</span>
          <!-- 只渲染最近 LOG_RENDER_LIMIT 条：不提示的话用户会以为日志丢了 -->
          <span v-if="projectState.logs.length > LOG_RENDER_LIMIT" class="hint" style="align-self: center">
            {{ t("仅显示最近 {limit} 条（共 {total} 条）", { limit: LOG_RENDER_LIMIT, total: projectState.logs.length }) }}
          </span>
          <button class="btn secondary small" @click="saveLogs">{{ t("保存日志") }}</button>
          <button class="btn ghost small" @click="copyLogs">{{ t("复制") }}</button>
        </div>
      </div>
      <div class="log-panel" ref="logPanelRef" style="max-height: 260px">
        <div v-for="(l, i) in visibleLogs" :key="`${i}:${l.at}:${l.step}`" class="log-line" :class="l.level">
          <span class="time">{{ formatTime(l.at) }}</span>
          <!-- UI10：阶段名接入词典；t() 缺键自动回退中文原文，安全 -->
          <span class="step-badge">{{ t(l.step) }}</span>
          <span>{{ l.message }}</span>
        </div>
        <p v-if="!visibleLogs.length" class="faint small">{{ t("暂无日志：开始生成后会在这里实时滚动显示") }}</p>
      </div>
      <p v-if="copiedMsg" class="hint mt-2" :style="{ color: copiedMsgLevel === 'err' ? 'var(--err)' : 'var(--ok)' }">{{ copiedMsg }}</p>
    </div>

    <!-- 产物抽屉：整个结果区（运行/产物/设定）默认收起，跳转时自动展开 -->
    <details
      class="card"
      :open="resultsOpen"
      @toggle="resultsOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary class="gen-summary">
        <strong>{{ t("生成结果与产物") }}</strong>
        <span class="hint">{{ resultsSummary }}</span>
      </summary>
      <ResultSection />
    </details>
  </div>

  <AssetPreview
    v-if="preview"
    :path="preview.path"
    :label="preview.label"
    @close="preview = null"
  />
</template>

<style scoped>
.gen-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  list-style: none;
}
.gen-summary::-webkit-details-marker {
  display: none;
}
.gen-summary .hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 设置抽屉里的子面板去掉卡片外壳，只留小节行，避免「卡片套卡片」的仪表盘观感 */
.gen-settings :deep(.card) {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0;
  margin-bottom: 14px;
}
/* 进度卡吸顶：滚动查看章节时也能一直看到进度 */
.gen-progress {
  position: sticky;
  top: 0;
  z-index: 5;
}
/* 无细粒度进度的阶段（分章/提取/组装）：进度条呈呼吸态，避免显示成卡在 0% */
.gen-progress :deep(.progress-bar.is-indeterminate .progress-fill) {
  animation: gen-progress-pulse 1.2s ease-in-out infinite;
}
@keyframes gen-progress-pulse {
  50% {
    opacity: 0.35;
  }
}
</style>
