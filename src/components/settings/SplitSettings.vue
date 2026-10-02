<script setup lang="ts">
import { t } from "../../i18n";
import { projectState } from "../../stores/project";
import { goPage } from "../../stores/nav";
import SplitPanel from "../generate/SplitPanel.vue";

/** #1362：碎章阈值与预算同口径，负数钳到 0（下游按 0 = 不合并处理） */
function onSplitMinCharsChange(e: Event): void {
  const el = e.target as HTMLInputElement;
  const n = Number(el.value.trim());
  const clamped = !Number.isFinite(n) ? 0 : Math.max(0, Math.floor(n));
  projectState.options.splitMinChapterChars = clamped;
  if (el.value.trim() !== String(clamped)) el.value = String(clamped);
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("分章设置") }}</h3>
      <span class="hint">{{ t("碎章合并与特殊章节保留") }}</span>
    </div>

    <div class="field-grid">
      <div class="field">
        <span>{{ t("碎章（短章）合并阈值") }}</span>
        <div class="row num-row">
          <input type="number" min="0" :value="projectState.options.splitMinChapterChars" @change="onSplitMinCharsChange" />
          <span>{{ t("字") }}</span>
        </div>
        <span class="hint">{{ t("小于该字数的碎章（短章）并入相邻章；0 = 不合并") }}</span>
      </div>
      <label class="opt-item opt-stack">
        <input type="checkbox" v-model="projectState.options.splitKeepSpecials" />
        <span class="opt-text">
          {{ t("保留特殊章节") }}
          <span class="hint">{{ t("后记/番外/特典/插图不被当杂项丢弃") }}</span>
        </span>
      </label>
    </div>
  </div>

  <!-- #1510：分章动作按钮已随分章面板搬到生成页直出；这里只留设置项并给出明确去处，
       避免「两个地方都能分章、但都找不到」。 -->
  <div class="card mt-3">
    <div class="card-head">
      <h3>{{ t("分章操作") }}</h3>
      <span class="hint">{{ t("已移到生成页顶部，随时可用") }}</span>
    </div>
    <SplitPanel />
    <button class="btn secondary small mt-3" @click="goPage('generate')">{{ t("去生成页") }}</button>
  </div>
</template>

<style scoped>
.opt-stack {
  align-items: flex-start;
}
.opt-stack input[type="checkbox"] {
  margin-top: 2px;
}
.opt-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* div.field 不在全局 `label.field > span` 覆盖内，这里统一字段标题样式 */
.field > span {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 5px;
  font-weight: 500;
}
/* 全局 label.field > span 会命中尾部的 hint：还原为普通提示字重与间距 */
.field > .hint {
  display: block;
  font-weight: 400;
  margin-bottom: 0;
}
.num-row > * {
  flex: none;
  min-width: 0;
}
.num-row input[type="number"] {
  width: 110px;
}
</style>
