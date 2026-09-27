<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { requestThumbLoad, thumbInvalidationOf, useAssetThumbs } from "../composables/useAssetThumbs";

const props = defineProps<{
  path: string;
  alt?: string;
}>();

const { thumbCache } = useAssetThumbs();
const containerEl = ref<HTMLElement | null>(null);
const inView = ref(false);
let observer: IntersectionObserver | null = null;

const src = computed(() => (inView.value ? thumbCache.value[props.path] || "" : ""));

// 显式作废（素材覆盖重生成/映射刷新）→ 自动重新加载，
// 避免出现「图生成了却全是占位符，必须点击才显示」。
watch(() => thumbInvalidationOf(props.path), () => {
  requestThumbLoad(props.path, "explicit", inView.value);
});

watch(() => props.path, () => {
  requestThumbLoad(props.path, "path-change", inView.value);
});

// LRU 淘汰（条目变空但未显式作废）→ 绝不自动重读：否则「加载新图→淘汰旧图→旧图重读→再淘汰」
// 会形成无限环路，表现为所有图片狂闪。淘汰的图只在重新进入视口时按节流恢复。
watch(() => thumbCache.value[props.path], (value) => {
  if (!value) requestThumbLoad(props.path, "evicted", inView.value);
});

onMounted(() => {
  if (typeof IntersectionObserver === "undefined") {
    inView.value = true;
    requestThumbLoad(props.path, "entered-view", true);
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        inView.value = entry.isIntersecting;
        if (entry.isIntersecting) requestThumbLoad(props.path, "entered-view", true);
      }
    },
    { rootMargin: "300px" },
  );
  if (containerEl.value) observer.observe(containerEl.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
});
</script>

<template>
  <div ref="containerEl" class="lazy-thumb" :class="{ empty: !src }">
    <img v-if="src" :src="src" :alt="alt || ''" loading="lazy" decoding="async" />
    <div v-else class="lazy-thumb-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
    </div>
  </div>
</template>

<style scoped>
.lazy-thumb {
  width: 100%;
  height: 120px;
  flex: 0 0 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.lazy-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.lazy-thumb-placeholder {
  color: var(--text-faint, #999);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
</style>
