<script setup lang="ts">
import { t, formatLogTime } from "../../../i18n";
import { projectState } from "../../../stores/project";
import { useGenerateController } from "../../../stores/generate";

// 日志 tab：直出运行日志（原「运行日志」折叠卡内容），不再折叠。
const {
  visibleLogs,
  logPanelRef,
  copyLogs,
  saveLogs,
  copiedMsg,
  copiedMsgLevel,
  LOG_RENDER_LIMIT,
} = useGenerateController();

/** #1525：统一走 i18n 层的 formatLogTime，与三处日志导出同口径（面板与导出不再各写一份） */
function formatTime(ms: number): string {
  return formatLogTime(ms);
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("运行日志") }}</h3>
      <div class="card-actions">
        <span class="hint" style="align-self: center">{{ t("最近 {n} 条", { n: visibleLogs.length }) }}</span>
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
    <div class="log-panel" ref="logPanelRef">
      <div v-for="(l, i) in visibleLogs" :key="`${i}:${l.at}:${l.step}`" class="log-line" :class="l.level">
        <!-- 格式：【源头】时间 描述（与运行日志页 LogsPage 同口径） -->
        <!-- UI10：阶段名接入词典；t() 缺键自动回退中文原文，安全 -->
        <span class="step-badge">【{{ t(l.step) }}】</span>
        <span class="time">{{ formatTime(l.at) }}</span>
        <span>{{ l.message }}</span>
      </div>
      <p v-if="!visibleLogs.length" class="faint small">{{ t("暂无日志：开始生成后会在这里实时滚动显示") }}</p>
    </div>
    <p v-if="copiedMsg" class="hint mt-2" :style="{ color: copiedMsgLevel === 'err' ? 'var(--err)' : 'var(--ok)' }">{{ copiedMsg }}</p>
  </div>
</template>

<style scoped>
.log-panel {
  max-height: 420px;
}
</style>
