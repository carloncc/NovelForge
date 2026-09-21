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
  settingsOpen,
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
  imagePlanText,
  appendInput,
  pickAppendFile,
  onAppendFile,
  stop,
  stopping,
} = useGenerateController();

/* 页面结构（重构后）：任务区在前（范围 + 该范围的主操作），配置/日志/产物各收一行。
   默认视野 = 页头 → 状态横幅 → 进度（运行时）→ 范围切换 → 任务卡 → 设置/日志/产物折叠行 */

/* UI15：日志时间按界面语言本地化；函数在渲染时读取 currentLang，切语言后自动重渲染 */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(currentLang.value === "zh-CN" ? "zh-CN" : currentLang.value);
}
/** 设置摘要：项目（目录尾名/未载入）+ 关键开关；展开状态跨重启记忆（stores/generate.settingsOpen） */
const settingsSummary = computed(() => {
  const o = projectState.options;
  const tail = (projectState.outputDir || "").split(/[\\/]/).filter(Boolean).pop();
  const project = projectState.novel ? (tail || t("已载入小说")) : t("未载入小说");
  return [
    project,
    `${t("图像")}${o.useImage ? "✓" : "×"}`,
    `${t("配音")}${o.useTts ? "✓" : "×"}`,
    `${t("旁白")}${o.compressNarration ? t("精简") : t("忠实")}`,
  ].join(" · ");
});

/* 有失败记录的章节（novel index）：章节列表据此显示「失败」并优先保留可见 */
const failedChapterIndexes = computed(() =>
  failedTasks.value
    .filter((f) => f.kind === "script" && /^chapter_\d+$/.test(f.id))
    .map((f) => Number(f.id.replace("chapter_", "")) - 1),
);

const scriptDoneCount = computed(
  () => Object.values(chapterStatus.lights).filter((l) => l.script).length,
);

/** 一个横幅原则：失败项 > 视觉守门 > 续跑计划，只显示最高优先级的一条（旧实现三条可同时堆叠） */
const notice = computed<{ kind: string; title: string; text: string; action: string; run: () => void } | null>(() => {
  if (failedTasks.value.length) {
    return {
      kind: "fail-banner",
      title: `${t("有失败任务待处理：")}${failedTasks.value.length} ${t("项")}`,
      text: t("失败项已按原因分类；可逐项查看并重试，或一键按失败原因自动重跑（限流/超时会自动等待）。"),
      action: `${t("处理失败项")}（${failedTasks.value.length}）`,
      run: () => {
        tab.value = "run";
        resultsOpen.value = true;
      },
    };
  }
  if (visualBibleReviewNeeded.value) {
    return {
      kind: "vb-banner",
      title: t("图像生成前需要确认视觉守门"),
      text: t("统一风格与角色三视图尚未批准，图像阶段会先停在这里。"),
      action: t("去确认"),
      run: () => {
        tab.value = "bible";
      },
    };
  }
  if (pendingResumeStages.value.length) {
    return {
      kind: "vb-banner",
      title: t("已排队的续跑计划（等视觉守门批准后自动执行）"),
      text: `${t("阶段：")}${pendingResumeStages.value.map((s) => t(STAGE_LABELS[s])).join(" → ")}`,
      action: t("取消计划"),
      run: () => clearPendingResume(),
    };
  }
  return null;
});
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

/** 日志卡只在有日志或运行中出现：空闲 + 无日志时不再常驻一张空卡片 */
const showLogs = computed(() => busy.value || projectState.logs.length > 0);
/** 运行中自动把日志面板滚到底由 logPanelRef 处理；这里只保证运行时卡片存在 */
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

    <!-- 状态横幅：同一时刻最多一条（失败 > 守门 > 续跑），每个最多一个入口 -->
    <div v-if="notice" class="vb-banner" :class="notice.kind">
      <div>
        <strong>{{ notice.title }}</strong>
        <p>{{ notice.text }}</p>
      </div>
      <button class="btn secondary small" @click="notice.run()">{{ notice.action }}</button>
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

    <!-- 任务区：先生成范围，再是该范围的唯一主操作 -->
    <ScopeTabs v-model="runMode" :disabled="queueRunning" />

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
        :image-summary-text="imagePlanText"
        :failed-chapters="failedChapterIndexes"
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

    <!-- 设置抽屉：项目目录 + 生成内容与高级项；展开状态跨重启记忆 -->
    <details
      class="card gen-settings"
      :open="settingsOpen"
      @toggle="settingsOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary class="gen-summary">
        <strong>{{ t("设置") }}</strong>
        <span class="hint">{{ settingsSummary }}</span>
      </summary>
      <div class="mt-3">
        <ProjectBar />
        <OptionsPanel />
      </div>
    </details>

    <!-- 运行日志：运行时自动展开，空闲时可折叠成一行；有日志才出现 -->
    <details v-if="showLogs" class="card" :open="busy">
      <summary class="gen-summary">
        <strong>{{ t("运行日志") }}</strong>
        <span class="hint">{{ t("最近 {n} 条", { n: visibleLogs.length }) }}</span>
      </summary>
      <div class="card-head mt-3">
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
    </details>

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
