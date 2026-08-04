<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  steps: string[];
  current: number;
  failed?: number[];
}>();

const failedSet = computed(() => new Set(props.failed ?? []));

function stateOf(i: number): "done" | "active" | "failed" | "todo" {
  if (failedSet.value.has(i)) return "failed";
  if (i < props.current) return "done";
  if (i === props.current) return "active";
  return "todo";
}
</script>

<template>
  <div class="steps">
    <template v-for="(s, i) in steps" :key="i">
      <div v-if="i > 0" class="step-connector" :class="{ done: stateOf(i - 1) === 'done' || stateOf(i - 1) === 'active' }" />
      <div class="step-item" :class="stateOf(i)">
        <span class="step-dot">
          <span v-if="stateOf(i) === 'done'">✓</span>
          <span v-else-if="stateOf(i) === 'failed'">✕</span>
          <span v-else>{{ i + 1 }}</span>
        </span>
        <span>{{ s }}</span>
      </div>
    </template>
  </div>
</template>
