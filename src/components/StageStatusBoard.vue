<script setup lang="ts">
import { computed, ref } from "vue";
import type { StageKey } from "../core/types";
import { STAGE_LABELS, STAGE_ORDER } from "../core/types";
import type { StageState } from "../composables/useStageStatus";
import { t } from "../i18n";

const props = defineProps<{
  statuses: Record<StageKey, StageState>;
  failedCounts: Record<StageKey, number>;
  feedback: Partial<Record<StageKey, string>>;
  force: Partial<Record<StageKey, boolean>>;
  busy: boolean;
}>();

/** props 只读：意见/全量经事件回父组件写入（父侧持有 store ref），子组件不再 v-model 直改 prop */
const emit = defineEmits<{
  regen: [stage: StageKey];
  "update:feedback": [stage: StageKey, value: string];
  "update:force": [stage: StageKey, value: boolean];
}>();

// 语言切换后标签需实时更新：computed（setup 期一次性 t() 会停留在旧语言）
const STATE_LABELS = computed<Record<StageState, string>>(() => ({
  idle: t("未运行"),
  running: t("进行中"),
  done: t("完成"),
  failed: t("失败"),
}));

function stateText(s: StageState, key: StageKey): string {
  const label = STATE_LABELS.value[s] ?? s;
  if (s === "failed" && props.failedCounts[key]) return `${label}（${props.failedCounts[key]}）`;
  return label;
}

const showFeedback = (s: StageKey): boolean =>
  s === "split" || s === "translate" || s === "extract" || s === "script" || s === "image" || s === "voice";

// 全量开关：assemble 是本地免费操作，无需强制；其余阶段勾选后无视缓存全量重跑（计费，执行前二次确认）
const showForce = (s: StageKey): boolean => s !== "assemble";

const stageOrder = computed(() => STAGE_ORDER);

/** 意见/全量收进按行折叠：每行常驻只剩「意见」开关 + 「重新生成」2 个控件（含 assemble 共 13 + 上游复选框 1 = 14 ≤ 15） */
const expanded = ref<Partial<Record<StageKey, boolean>>>({});
function toggleExpanded(s: StageKey): void {
  expanded.value[s] = !expanded.value[s];
}
function hasOptions(s: StageKey): boolean {
  return showFeedback(s) || showForce(s);
}
function hasOpinion(s: StageKey): boolean {
  return !!(props.feedback[s]?.trim() || props.force[s]);
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 10px">
    <div
      v-for="s in stageOrder"
      :key="s"
      class="stage-row"
      :class="{ 'is-failed': statuses[s] === 'failed', 'is-done': statuses[s] === 'done' }"
    >
      <div class="stage-row-label">
        <span class="stage-state-dot" :class="statuses[s]">
          <span v-if="statuses[s] === 'done'" style="font-size: 12px">✓</span>
          <span v-else-if="statuses[s] === 'failed'" style="font-size: 12px">✕</span>
          <span v-else-if="statuses[s] === 'running'" class="spinner" style="width: 12px; height: 12px" />
        </span>
        <b>{{ t(STAGE_LABELS[s]) }}</b>
        <span class="stage-state-text" :class="statuses[s]">{{ stateText(statuses[s], s) }}</span>
      </div>
      <!-- 意见与全量收进折叠：常驻每行只剩「意见」开关 + 「重新生成」，避免 19 控件同屏堆叠填错行 -->
      <button
        v-if="hasOptions(s)"
        class="btn ghost small"
        :disabled="busy"
        :aria-expanded="!!expanded[s]"
        :title="t('展开填写本阶段意见 / 全量开关')"
        @click="toggleExpanded(s)"
      >{{ hasOpinion(s) ? t("意见●") : t("意见") }} {{ expanded[s] ? "▾" : "▸" }}</button>
      <button
        class="btn small"
        :disabled="busy"
        :title="s === 'split'
          ? t('点击即全书重新分章（有 LLM 时计费；章节边界变化会使下游剧本/图像/配音缓存作废重跑）')
          : t('无意见且未勾全量=只补缺失/失败项，不计费')"
        @click="emit('regen', s)"
      >
        {{ t("重新生成") }}
      </button>
      <div v-if="expanded[s] && hasOptions(s)" style="display: flex; gap: 8px; flex-wrap: wrap; flex-basis: 100%">
        <input
          v-if="showFeedback(s)"
          class="stage-feedback"
          type="text"
          :value="feedback[s] ?? ''"
          :disabled="busy"
          :placeholder="s === 'voice' ? t('意见（填了=全书重配，计费）') : t('意见（填了=全量重生成，计费）')"
          @input="emit('update:feedback', s, ($event.target as HTMLInputElement).value)"
        />
        <label v-if="showForce(s)" class="opt-item mb-0" :title="t('勾选后无视缓存全量重跑该阶段（计费），不需要填意见；执行前会二次确认')">
          <input
            type="checkbox"
            :checked="!!force[s]"
            :disabled="busy"
            @change="emit('update:force', s, ($event.target as HTMLInputElement).checked)"
          />
          {{ t("全量") }}
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stage-row.is-failed {
  border-color: var(--err);
  background: var(--err-soft);
}
.stage-row.is-done {
  /* UI43：完成态需要可见的描边；原先用 10% 透明度的 --ok-soft 当边框，几乎看不出 */
  border-color: var(--ok-border, rgba(5, 150, 105, 0.45));
}
.stage-state-dot {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: #fff;
  background: var(--text-dim);
  flex: none;
}
.stage-state-dot.done {
  background: var(--ok);
}
.stage-state-dot.failed {
  background: var(--err);
}
.stage-state-dot.running {
  background: var(--accent);
}
.stage-state-text {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}
.stage-state-text.done {
  color: var(--ok);
}
.stage-state-text.failed {
  color: var(--err);
  font-weight: 600;
}
.stage-state-text.running {
  color: var(--accent);
}
/* 行内意见框：比全局 .stage-row 规则更窄，给「全量 + 重新生成」留出同行空间 */
.stage-row > input.stage-feedback {
  min-width: 160px;
  flex: 1;
}
</style>
