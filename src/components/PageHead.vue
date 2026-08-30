<script setup lang="ts">
defineProps<{ title: string; sub?: string }>();
</script>

<template>
  <div class="page-head">
    <div>
      <div class="page-title">{{ title }}</div>
      <p v-if="sub" class="page-sub">{{ sub }}</p>
    </div>
    <div class="page-actions">
      <slot />
    </div>
  </div>
</template>
