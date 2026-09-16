<script setup lang="ts">

import { t } from "../i18n";
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
// 解构后名字与模板保持一致，模板 ref（appendInput / styleRefInput / logPanelRef / videoInput）照常生效。
const {
  tab,
  RUN_MODE_KEY,
  initialRunMode,
  runMode,
  runModeHint,
  goFullMode,
  error,
  busy,
  pendingResumeStages,
  pendingResumeScope,
  clearPendingResume,
  STAGE_LABELS,
  pipelineRef,
  lastRunFailedTasks,
  scriptFiles,
  currentScript,
  videoStatus,
  videoInput,
  videoImportTarget,
  copiedMsg,
  logPanelRef,
  LOG_RENDER_LIMIT,
  visibleLogs,
  PIPELINE_STEPS,
  pipelineSteps,
  currentStep,
  failedSteps,
  liveProgress,
  activeRunLabels,
  activeStepIndexes,
  livePct,
  costText,
  failedTasks,
  failedTaskSummary,
  videoPoints,
  selectedStages,
  stageFeedback,
  stageForce,
  outputDirDraft,
  stageStatus,
  failedCounts,
  chapterStatus,
  enabledNovelChapters,
  disabledNovelChapters,
  toggleNovelChapter,
  splitMeta,
  loadSplitMeta,
  splitMetaText,
  splitOpinion,
  splitConfirmed,
  splitConfirmKey,
  loadSplitConfirmed,
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
  runChapterBatch,
  runChapterQueue,
  stopChapterQueue,
  logFailedStages,
  runningStages,
  styleRefSrc,
  styleRecognizing,
  styleRefInput,
  fileToBase64,
  pickStyleRef,
  onStyleRefFile,
  recognizeStyleAndApply,
  selectedStagesList,
  visualBibleReviewNeeded,
  autoCascadeDownstream,
  CASCADE_TRIGGERS,
  scriptChapterFeedback,
  chapterForce,
  assetMap,
  assetTab,
  assetBusy,
  assetFeedback,
  voiceChapterFilter,
  voiceCharFilter,
  preview,
  regenAbort,
  regenProgress,
  openPreview,
  regenCtl,
  resetRegenState,
  regenPct,
  selected,
  selectedCount,
  toggleSelect,
  clearSelected,
  selectAllInTab,
  regenSelected,
  regenMissingImages,
  FIGURE_EMOTIONS,
  EMOTION_LABELS,
  reCutout,
  loadAssetDataUrl,
  mimeOf,
  loadAssetMapNow,
  diffAssetPaths,
  assetLiveTimer,
  assetLiveFingerprint,
  startAssetLiveRefresh,
  stopAssetLiveRefresh,
  figureRows,
  itemRows,
  bgRows,
  cgRows,
  charNameOf,
  voiceRows,
  voiceChapterOptions,
  voiceChapterMismatch,
  failedVocalKeys,
  voiceCharOptions,
  voiceLimit,
  voiceRowsShown,
  showNarrationVoice,
  ttsReady,
  execute,
  persistRunLog,
  start,
  stageHint,
  prepareVisualBible,
  resumeAfterVisualApproval,
  onVisualBibleChanged,
  runStageRegen,
  runChapterFullRegen,
  runChapterPartRegen,
  confirmStageOpinion,
  appendInput,
  pickAppendFile,
  onAppendFile,
  runAppend,
  syncAppendedCharactersToBible,
  regenChapter,
  regenCtx,
  afterAssetRegen,
  logAssetStart,
  regenFigureEmotion,
  regenAllFigure,
  regenThreeView,
  regenAction,
  regenCostume,
  regenItem,
  regenBg,
  regenCgRow,
  audioRef,
  playingVoiceKey,
  playVoice,
  regenVoice,
  regenCharVoice,
  regenMissingVoices,
  cleanupInvalidAssets,
  restoreAssetBackupNow,
  browseOutputDir,
  loadProjectState,
  ensureLiveResultShape,
  lastShapeSyncAt,
  syncLiveResultShape,
  checkVideos,
  importVideo,
  onVideoImportFile,
  loadScripts,
  verifyReports,
  showTrivialVerify,
  verifyBusy,
  verifyReasonLabel,
  isTrivialVerifyIssue,
  loadVerifyReports,
  visibleVerifyIssues,
  trivialVerifyCount,
  charNameOfId,
  verifyScriptCacheTarget,
  invalidateSceneVocal,
  reverifyChapter,
  acceptVerifySpeaker,
  deleteVerifyLine,
  ignoreVerifyIssue,
  copyText,
  copyLogs,
  saveLogs,
  retryFailed,
  rerunChapters,
  toggleAllRerun,
  toggleChapterRerun,
  stop,
  stopping,
  onCardsSaved,
  fileExistsLabel,
} = useGenerateController();</script>

<template>
  <div class="inner">
    <PageHead :title="t('生成项目')" :sub="t('四段式：项目 → 生成内容 → 生成 → 结果。范围切换只替换「生成」这一段。')">
      <button
        v-if="busy || !!assetBusy || queueRunning"
        class="btn danger"
        :disabled="stopping"
        @click="stop"
      >{{ stopping ? t("正在停止…") : t("停止") }}</button>
    </PageHead>

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

    <div v-if="busy || currentStep >= 0" class="mb-4">
      <StepIndicator
        :steps="pipelineSteps"
        :current="currentStep"
        :failed="failedSteps"
        :active="busy ? activeStepIndexes : undefined"
      />
    </div>

    <!-- (1) 项目栏 -->
    <ProjectBar />

    <OptionsPanel />

    <!-- (3) 生成：范围切换 + 当前范围面板（切换只替换本段） -->
    <ScopeTabs v-model="runMode" :disabled="queueRunning" />
    <p class="hint scope-hint">{{ runModeHint }}</p>

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

    <ResultSection />
  </div>

  <AssetPreview
    v-if="preview"
    :path="preview.path"
    :label="preview.label"
    @close="preview = null"
  />
</template>
