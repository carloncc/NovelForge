<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import PageHead from "../components/PageHead.vue";
import { t, formatLogTime } from "../i18n";
import { clearRunLog, runActivity, runLogLines } from "../stores/runLog";
import { requestRunStop, runIsBusy } from "../stores/runStatus";
import { projectState } from "../stores/project";
import { tauri } from "../utils/tauri";
import { dumpLogHistory } from "../utils/logger";
import { errMsg } from "../utils/errors";

/**
 * 运行日志页（内容显示在右侧主区，与「导入小说」「生成项目」等页面同构）。
 *
 * 日志与进度都读 stores/runLog 的全局状态：App.vue 的页面组件没有 KeepAlive，
 * 切页会销毁组件，但状态在 store 里，切回来照旧（包括「仍在后台运行」的判定）。
 */

const listRef = ref<HTMLElement | null>(null);
const onlyProblems = ref(false);
const autoScroll = ref(true);
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;

function stopTicker(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

const lines = computed(() =>
  onlyProblems.value
    ? runLogLines.value.filter((l) => l.level === "warn" || l.level === "error")
    : runLogLines.value,
);
const active = computed(() => runActivity.value);
const elapsedSec = computed(() => {
  const a = active.value;
  return a ? Math.max(0, Math.round((now.value - a.startedAt) / 1000)) : 0;
});
const percent = computed(() => {
  const a = active.value;
  if (!a || a.total <= 0) return null;
  return Math.min(100, Math.round((a.done / a.total) * 100));
});

// 秒表只在有任务时走：空闲时留一个每秒唤醒渲染的定时器纯属浪费
watch(
  active,
  (a) => {
    stopTicker();
    if (!a) return;
    now.value = Date.now();
    ticker = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  },
  { immediate: true },
);
onBeforeUnmount(stopTicker);

function scrollToBottom(): void {
  const el = listRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}
// 新日志到达时跟随滚动；关掉自动滚动后不再打扰（否则没法往上翻着看）
watch(
  () => lines.value.length,
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    scrollToBottom();
  },
);
watch(autoScroll, async (on) => {
  if (!on) return;
  await nextTick();
  scrollToBottom();
});

const flash = ref("");
const flashErr = ref(false);
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function setFlash(text: string, err = false): void {
  flash.value = text;
  flashErr.value = err;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash.value = "";
  }, 3000);
}
onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
});

/** 与屏幕同格式：【源头】时间 [级别] 描述 */
function asText(): string {
  return lines.value
    .map((l) => `【${l.scope}】${formatLogTime(l.at)} [${l.level.toUpperCase()}] ${l.message}${l.detail ? ` ${l.detail}` : ""}`)
    .join("\n");
}

async function copyLogs(): Promise<void> {
  try {
    await navigator.clipboard.writeText(asText());
    setFlash(t("日志已复制"));
  } catch {
    setFlash(t("日志复制失败（浏览器限制了剪贴板权限）"), true);
  }
}

async function saveLogs(): Promise<void> {
  const out = projectState.outputDir;
  if (!out) {
    setFlash(t("没有可保存的输出目录：请先导入小说或加载项目"), true);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = `${out}/.novel2vn/logs/${stamp}.log`;
  const text = [
    `NovelForge 运行日志 ${stamp}`,
    `项目：${out}`,
    "",
    "== 界面日志 ==",
    asText(),
    "",
    "== 详细诊断日志 ==",
    dumpLogHistory(),
  ].join("\n");
  try {
    await tauri.writeTextFile(path, text);
    setFlash(`${t("日志已保存")}：${path}`);
  } catch (e) {
    setFlash(`${t("保存失败")}：${errMsg(e)}`, true);
  }
}
</script>

<template>
  <div>
    <PageHead :title="t('运行日志')" :sub="t('日志内容为运行记录，暂未全部本地化')">
      <span v-if="runLogLines.length" class="hint" style="align-self: center">{{ t("最近 {n} 条", { n: lines.length }) }}</span>
      <button class="btn secondary small" @click="saveLogs">{{ t("保存日志") }}</button>
      <button class="btn secondary small" @click="copyLogs">{{ t("复制") }}</button>
      <button class="btn ghost small" @click="clearRunLog">{{ t("清空") }}</button>
    </PageHead>

    <!-- 当前长任务：任务名 / 阶段 / 进度 / 耗时。切页后这里照旧（状态在 store 里） -->
    <div v-if="active" class="card run-card">
      <div class="run-top">
        <span class="spinner" style="width: 12px; height: 12px" />
        <span class="run-label">{{ active.label }}</span>
        <span v-if="active.detail" class="run-detail">{{ active.detail }}</span>
        <button v-if="runIsBusy" class="btn danger small" @click="requestRunStop">{{ t("停止") }}</button>
      </div>
      <div v-if="active.total > 0" class="run-bar">
        <div class="run-bar-fill" :style="{ width: (percent ?? 0) + '%' }" />
      </div>
      <div class="run-meta">
        <span v-if="active.total > 0">{{ active.done }} / {{ active.total }}（{{ percent }}%）</span>
        <span v-else>{{ t("进度") }}…</span>
        <span>{{ t("已运行 {s} 秒", { s: elapsedSec }) }}</span>
      </div>
      <!-- 任务发起页 ≠ 当前页：后台仍在跑，明确告知，避免误以为「切页就停了」 -->
      <p v-if="active.page" class="run-bg">{{ t("仍在后台运行（切换页面不会中断）") }}</p>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>{{ t("运行日志") }}</h3>
        <div class="card-actions">
          <label class="toggle">
            <input v-model="autoScroll" type="checkbox" />
            {{ t("自动滚动") }}
          </label>
          <label class="toggle">
            <input v-model="onlyProblems" type="checkbox" />
            {{ t("仅警告与错误") }}
          </label>
        </div>
      </div>
      <div ref="listRef" class="log-view">
        <div v-for="(l, i) in lines" :key="`${i}:${l.at}:${l.scope}`" class="log-row" :class="l.level">
          <!-- 格式：【源头】时间 描述 -->
          <span class="log-src">【{{ t(l.scope) }}】</span>
          <span class="log-time">{{ formatLogTime(l.at) }}</span>
          <span class="log-msg">{{ l.message }}</span>
          <!-- 失败路径/错误文本：没有它，「调用 readTextFile 失败」看不出是哪个文件 -->
          <span v-if="l.detail" class="log-detail">{{ l.detail }}</span>
        </div>
        <p v-if="!lines.length" class="faint small" style="padding: 8px">{{ t("暂无运行日志") }}</p>
      </div>
      <p v-if="flash" class="hint mt-2" :style="{ color: flashErr ? 'var(--err)' : 'var(--ok)' }">{{ flash }}</p>
    </div>
  </div>
</template>

<style scoped>
.run-card {
  margin-bottom: 12px;
}
.run-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.run-label {
  font-weight: 600;
}
.run-detail {
  color: var(--text-dim);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-bar {
  margin-top: 8px;
  height: 6px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
}
.run-bar-fill {
  height: 100%;
  background: var(--primary, var(--accent));
  transition: width 0.2s linear;
}
.run-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 5px;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.run-bg {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--warn);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
/* 右侧空间充足：日志区给足高度，避免仍像侧栏那样只能看几行 */
.log-view {
  min-height: 320px;
  max-height: calc(100vh - 340px);
  overflow-y: auto;
  padding: 6px 8px;
  background: var(--bg-log);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
}
.log-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 4px;
  border-radius: 4px;
  word-break: break-all;
}
.log-row.success {
  color: var(--ok);
}
.log-row.warn {
  color: var(--warn);
}
.log-row.error {
  color: var(--err);
  background: var(--err-soft);
  box-shadow: inset 3px 0 0 var(--err);
}
.log-src {
  flex: none;
  color: var(--accent);
}
.log-time {
  flex: none;
  color: var(--text-dim);
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
.log-msg {
  flex: none;
}
.log-detail {
  flex: 1;
  min-width: 0;
  color: var(--text-dim);
  opacity: 0.7;
  font-size: 11px;
}
</style>
