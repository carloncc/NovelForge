<script setup lang="ts">
import { t } from "../../i18n";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const {
  splitOpinion,
  splitConfirmed,
  previewSplit,
  confirmSplit,
  appendInput,
  pickAppendFile,
  onAppendFile,
} = useGenerateController();
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("分章") }}</h3>
      <span class="hint">{{ t("章节边界与追加导入") }}</span>
    </div>

    <div class="row split-row">
      <input
        class="grow"
        type="text"
        v-model="splitOpinion"
        :placeholder="t('分章意见（可选）：如“第×章太长请拆分”…')"
      />
      <button class="btn secondary small" @click="previewSplit">{{ t("AI 分章") }}</button>
    </div>
    <p class="hint mt-2">{{ t("填了意见会强制全书 AI 重新分章（计费），并作废下游剧本/图像/配音缓存") }}</p>

    <div class="field-grid mt-3">
      <div class="field">
        <span>{{ t("碎章合并阈值") }}</span>
        <div class="row num-row">
          <input type="number" min="0" v-model.number="projectState.options.splitMinChapterChars" />
          <span>{{ t("字") }}</span>
        </div>
        <span class="hint">{{ t("小于该字数的碎章并入相邻章；0 = 不合并") }}</span>
      </div>
      <label class="opt-item opt-stack">
        <input type="checkbox" v-model="projectState.options.splitKeepSpecials" />
        <span class="opt-text">
          {{ t("保留特殊章节") }}
          <span class="hint">{{ t("后记/番外/特典/插图不被当杂项丢弃") }}</span>
        </span>
      </label>
    </div>

    <div class="row mt-3 split-actions">
      <button class="btn secondary small" :disabled="splitConfirmed" @click="confirmSplit">
        {{ splitConfirmed ? t("分章已核对") : t("标记为已核对") }}
      </button>
      <span v-if="splitConfirmed" class="tag ok">{{ t("已核对") }}</span>
      <button class="btn secondary small" @click="pickAppendFile">{{ t("追加新章节") }}</button>
      <input ref="appendInput" type="file" accept=".txt,text/plain" style="display: none" @change="onAppendFile" />
    </div>
    <p class="hint mt-2">{{ t("核对章节边界无误后标记；改动分章选项会让标记自动失效") }}</p>
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
/* 全局 .row > * 会把按钮/单位拉成等宽：这两行只按内容宽排布 */
.split-row > *,
.num-row > *,
.split-actions > * {
  flex: none;
  min-width: 0;
}
/* 全局输入框 width:100% 会把按钮挤到下一行：给输入框一个可收缩的基准宽度，保持同一行 */
.split-row input {
  flex: 1 1 240px;
  width: auto;
}
.num-row input[type="number"] {
  width: 110px;
}
</style>
