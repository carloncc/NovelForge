<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { t } from "../i18n";
import { projectState } from "../stores/project";
import PageHead from "../components/PageHead.vue";
import StepIndicator from "../components/StepIndicator.vue";
import ScopeTabs from "../components/generate/ScopeTabs.vue";
import ChapterWorkbench from "../components/generate/ChapterWorkbench.vue";
import FullRunPanel from "../components/generate/FullRunPanel.vue";
import StageRunPanel from "../components/generate/StageRunPanel.vue";
import ResultSection from "../components/generate/ResultSection.vue";
import { goPage } from "../stores/nav";
import { useGenerateController } from "../stores/generate";

// 全部状态与行为集中在 useGenerateController：本页只做编排与模板映射。
const {
  tab,
  runMode,
  busy,
  liveProgress,
  livePct,
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
  splitConfirmed,
  previewSplit,
  queueRunning,
  selectedChapters,
  chapterIncludeVoice,
  chapterHasCards,
  toggleChapterSelected,
  runSelectedChapters,
  prepareChapterCards,
  runChapterQueue,
  stopChapterQueue,
  visualBibleReviewNeeded,
  scriptChapterFeedback,
  chapterForce,
  assetBusy,
  runChapterFullRegen,
  runChapterPartRegen,
  imagePlanText,
} = useGenerateController();

/* 页面结构：页头（无动作）→ 状态横幅 → 进度（运行时）→ 范围切换 → 任务区 → 本页结果区（运行/产物/设置/日志） */

const resultRef = ref<HTMLElement | null>(null);
/** 横幅动作只切结果区 tab 并把它滚进视野：不再有独立结果页可跳 */
function focusResults(): void {
  void nextTick(() => {
    resultRef.value?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
}

/* 有失败记录的章节（novel index）：章节列表据此显示「失败」并优先保留可见 */
const failedChapterIndexes = computed(() =>
  failedTasks.value
    .filter((f) => f.kind === "script" && /^chapter_\d+$/.test(f.id))
    .map((f) => Number(f.id.replace("chapter_", "")) - 1),
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
        focusResults();
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
        tab.value = "settings";
        focusResults();
      },
    };
  }
  if (pendingResumeStages.value.length) {
    return {
      kind: "vb-banner",
      title: t("已排队的续跑计划（等视觉守门批准后自动执行）"),
      text: `${t("阶段：")}${pendingResumeStages.value.map((s) => t(STAGE_LABELS[s])).join(" → ")}`,
      action: t("取消计划"),
      run: () => {
        clearPendingResume();
        focusResults();
      },
    };
  }
  return null;
});
</script>

<template>
  <div class="inner">
    <PageHead :title="t('生成项目')" :sub="t('选范围 → 生成 → 试玩 → 导出：每章状态一眼可见，主按钮只做下一步')" />

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
        :split-meta-text="splitMetaText"
        :split-ok="splitMeta.method === 'ai' && !splitMeta.stale"
        :split-confirmed="splitConfirmed"
        :image-summary-text="imagePlanText"
        :failed-chapters="failedChapterIndexes"
        @regen="runChapterFullRegen"
        @regen-part="runChapterPartRegen"
        @toggle="toggleNovelChapter"
        @select="toggleChapterSelected"
        @run-selected="runSelectedChapters"
        @run-queue="runChapterQueue"
        @stop-queue="stopChapterQueue"
        @preview-split="previewSplit"
        @prepare="prepareChapterCards"
        @update-include-voice="chapterIncludeVoice = $event"
        @update-feedback="(i, v) => (scriptChapterFeedback[i] = v)"
        @update-force="(i, v) => (chapterForce[i] = v)"
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

    <!-- 结果区直出在本页（运行 / 产物 / 设置 / 日志），不折叠、无摘要行、无需跳页 -->
    <div ref="resultRef" class="gen-results">
      <ResultSection />
    </div>
  </div>
</template>

<style scoped>
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
/* 结果区：scrollIntoView 的落点，顶部留出吸顶进度卡的余量 */
.gen-results {
  margin-top: 12px;
  scroll-margin-top: 12px;
}
</style>
