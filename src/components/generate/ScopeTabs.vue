<script setup lang="ts">
import { t } from "../../i18n";

/** 生成范围：逐章 / 整书 / 单阶段（与 GeneratePage 的 runMode 同构） */
export type GenerateScope = "chapter" | "full" | "stage";

defineProps<{ modelValue: GenerateScope; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: GenerateScope] }>();

const TABS: { id: GenerateScope; label: string }[] = [
  { id: "chapter", label: "逐章生成" },
  { id: "full", label: "整书生成" },
  { id: "stage", label: "单阶段重跑" },
];
</script>

<template>
  <div class="scope-tabs" role="tablist">
    <button
      v-for="tab in TABS"
      :key="tab.id"
      type="button"
      role="tab"
      class="scope-tab"
      :class="{ active: modelValue === tab.id }"
      :aria-selected="modelValue === tab.id"
      :disabled="disabled"
      @click="emit('update:modelValue', tab.id)"
    >
      {{ t(tab.label) }}
    </button>
  </div>
</template>

<style scoped>
.scope-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
  width: fit-content;
  max-width: 100%;
}
.scope-tab {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  padding: 6px 16px;
  border-radius: calc(var(--radius-sm) - 2px);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.scope-tab:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-hover);
}
.scope-tab.active {
  background: var(--primary-soft);
  border-color: var(--primary);
  color: var(--primary);
  font-weight: 600;
}
.scope-tab:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
