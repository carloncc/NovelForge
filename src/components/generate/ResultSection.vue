<script setup lang="ts">
import { nextTick } from "vue";
import { currentLang, t } from "../../i18n";
import { projectState } from "../../stores/project";
import EditCards from "../EditCards.vue";
import VisualBiblePanel from "../VisualBiblePanel.vue";
import AssetPanel from "./result/AssetPanel.vue";
import VideoPanel from "./result/VideoPanel.vue";
import ScriptPanel from "./result/ScriptPanel.vue";
import FailedPanel from "./result/FailedPanel.vue";
import LogPanel from "./result/LogPanel.vue";
import { useGenerateController } from "../../stores/generate";

/** UI15：用户可见数字按当前界面语言本地化；渲染时读取 currentLang，切语言后自动重渲染 */
function fmtNumber(n: number): string {
  return n.toLocaleString(currentLang.value);
}

// 结果区：错误提示 + 4 个一级 tab（运行 / 产物 / 设定 / 日志）；相关面板在各自 tab 内堆叠直出。
const {
  tab,
  runMode,
  error,
  busy,
  copiedMsg,
  copiedMsgLevel,
  failedTasks,
  liveProgress,
  livePct,
  scriptPartProgress,
  costText,
  visualBibleReviewNeeded,
  loadAssetMapNow,
  prepareVisualBible,
  resumeAfterVisualApproval,
  onVisualBibleChanged,
  checkVideos,
  loadScripts,
  onCardsSaved,
} = useGenerateController();

/** 空态「去整书生成」必须给反馈：切 runMode 后把任务区滚进视野，否则视口零变化像死按钮 */
function goEmptyFull(): void {
  runMode.value = "full";
  void nextTick(() => {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      /* 忽略 */
    }
  });
}
</script>

<template>
  <p v-if="error" class="muted mt-3" style="color: var(--err)">{{ error }}</p>

  <div class="tabs">
    <button class="tab" :class="{ active: tab === 'run' }" @click="tab = 'run'">{{ t("运行") }}</button>
    <button class="tab" :class="{ active: tab === 'products' }" @click="tab = 'products'; loadScripts(); loadAssetMapNow(); checkVideos()">{{ t("产物") }}</button>
    <button class="tab" :class="{ active: tab === 'settings' }" @click="tab = 'settings'">
      {{ t("设定") }}
      <span v-if="visualBibleReviewNeeded" class="tab-badge">{{ t("待确认") }}</span>
    </button>
    <button class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">{{ t("日志") }}</button>
  </div>

  <div v-if="tab === 'run'">
    <div class="stat-grid">
      <div class="stat">
        <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg></span>
        <div class="stat-body"><div class="label">{{ t("章节") }}</div><div class="value">{{ projectState.novel?.chapters.filter((c) => c.enabled !== false).length ?? 0 }}</div></div>
      </div>
      <div class="stat">
        <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg></span>
        <div class="stat-body"><div class="label">{{ t("总字数") }}</div><div class="value">{{ fmtNumber(projectState.novel?.fullText.length ?? 0) }}</div></div>
      </div>
      <div class="stat">
        <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg></span>
        <div class="stat-body"><div class="label">{{ t("素材") }}</div><div class="value">{{ projectState.materials.length }}</div></div>
      </div>
      <div class="stat">
        <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg></span>
        <div class="stat-body">
          <div class="label">{{ t("状态") }}</div>
          <!-- 有失败任务时不能再显示绿色「已完成」：失败项需要用户处理，状态必须如实 -->
          <div class="value" :style="busy ? 'color: var(--warn)' : failedTasks.length ? 'color: var(--err)' : projectState.lastResult ? 'color: var(--ok)' : ''">{{ busy ? t("运行中") : failedTasks.length ? t("有失败项") : projectState.lastResult ? t("已完成") : t("未开始") }}</div>
        </div>
      </div>
    </div>
    <div class="card mt-4 mb-0" v-if="liveProgress && busy">
      <div class="card-head">
        <h3>{{ t("实时进度") }}</h3>
        <span style="color: var(--text-faint); font-size: 12px">{{ liveProgress.done }}/{{ liveProgress.total }} · {{ livePct }}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill" :style="{ width: livePct + '%' }"></div></div>
      <p style="color: var(--text-dim); font-size: 12px; margin-top: var(--space-2)">
        {{ liveProgress.step }} · {{ t("当前：") }}{{ liveProgress.label }}
      </p>
      <p v-if="scriptPartProgress && scriptPartProgress.total > 1" style="color: var(--text-dim); font-size: 12px; margin-top: 2px">
        {{ t("第 {ch} 章第 {part}/{total} 段", { ch: scriptPartProgress.chapter + 1, part: scriptPartProgress.part, total: scriptPartProgress.total }) }}
      </p>
    </div>
    <div class="card mt-4 mb-0" v-if="costText">
      <div class="card-head"><h3>{{ t("用量统计（本次运行）") }}</h3></div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg></span><div class="stat-body"><div class="label">LLM</div><div class="value" style="font-size: 15px">{{ costText.llm }}</div></div></div>
        <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg></span><div class="stat-body"><div class="label">{{ t("图像") }}</div><div class="value" style="font-size: 15px">{{ costText.image }}</div></div></div>
        <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6V18M8 9V15M16 9V15M5 11V13M19 11V13" /></svg></span><div class="stat-body"><div class="label">{{ t("配音") }}</div><div class="value" style="font-size: 15px">{{ costText.tts }}</div></div></div>
      </div>
    </div>

    <!-- 失败项并入「运行」：出问题时只在一个地方处理；日志已独立为「日志」tab -->
    <div id="failed-anchor" class="fail-anchor">
      <FailedPanel />
    </div>
  </div>

  <div v-else-if="tab === 'products'">
    <!-- 剧本 → 素材 → 视频：三块直出堆叠，各自的卡头就是小节标题 -->
    <ScriptPanel />
    <AssetPanel />
    <VideoPanel />
  </div>

  <div v-else-if="tab === 'settings'">
    <EditCards v-if="projectState.lastResult" :cards="projectState.lastResult.cards" @saved="onCardsSaved" />
    <div v-else class="empty">
      <img src="/src/assets/empty-generate.png" alt="" style="width: 240px; opacity: 0.9; margin-bottom: 12px" />
      <p>{{ t("尚无生成结果，先运行一次生成") }}</p>
      <button class="btn small" @click="goEmptyFull">{{ t("去整书生成") }}</button>
    </div>
    <div id="visual-bible-anchor" class="vb-anchor">
      <VisualBiblePanel class="mt-4" @approve="resumeAfterVisualApproval" @changed="onVisualBibleChanged" @prepare="prepareVisualBible" />
    </div>
  </div>

  <LogPanel v-else-if="tab === 'log'" />

  <p v-if="copiedMsg" :style="{ color: copiedMsgLevel === 'err' ? 'var(--err)' : 'var(--ok)', fontSize: '12px', marginTop: '6px' }">{{ copiedMsg }}</p>
</template>

<style scoped>
/* 横幅滚动锚点：顶部留出吸顶进度卡高度，避免被遮住 */
.fail-anchor,
.vb-anchor {
  scroll-margin-top: 200px;
}
</style>
