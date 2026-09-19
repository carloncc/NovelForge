<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
  badge?: string;
  open: boolean;
}>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
</script>

<template>
  <div class="disclosure">
    <!-- UI35：头部用原生 button，自带键盘（回车/空格）与焦点能力；aria-expanded 表达展开态 -->
    <button
      type="button"
      class="disclosure-head"
      :aria-expanded="open"
      @click="emit('update:open', !open)"
    >
      <span class="disclosure-title">
        <span class="disclosure-name">{{ title }}</span>
        <span v-if="badge" class="tag">{{ badge }}</span>
        <span v-if="subtitle" class="disclosure-sub">{{ subtitle }}</span>
      </span>
      <!-- 展开态已由 aria-expanded 表达，箭头对读屏隐藏 -->
      <span class="disclosure-arrow" aria-hidden="true">{{ open ? "▲" : "▼" }}</span>
    </button>
    <div v-if="open" class="disclosure-body">
      <slot />
    </div>
  </div>
</template>
