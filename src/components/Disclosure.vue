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
    <div class="disclosure-head" @click="emit('update:open', !open)">
      <span class="disclosure-title">
        <span class="disclosure-name">{{ title }}</span>
        <span v-if="badge" class="tag">{{ badge }}</span>
        <span v-if="subtitle" class="disclosure-sub">{{ subtitle }}</span>
      </span>
      <span class="disclosure-arrow">{{ open ? "▲" : "▼" }}</span>
    </div>
    <div v-if="open" class="disclosure-body">
      <slot />
    </div>
  </div>
</template>
