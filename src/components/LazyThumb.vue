<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAssetThumbs } from "../composables/useAssetThumbs";

const props = defineProps<{
  path: string;
  alt?: string;
}>();

const { thumbCache, loadAssetDataUrl } = useAssetThumbs();
const containerEl = ref<HTMLElement | null>(null);
const inView = ref(false);
let observer: IntersectionObserver | null = null;

const src = computed(() => (inView.value ? thumbCache.value[props.path] || "" : ""));

function tryLoad(): void {
  loadAssetDataUrl(props.path);
}

watch(() => props.path, () => {
  if (inView.value) tryLoad();
});

// 缩略图缓存条目被清除（素材覆盖重生成/映射刷新）→ 自动重新加载，
// 避免出现「图生成了却全是占位符，必须点击才显示」。
watch(() => thumbCache.value[props.path], (value) => {
  if (!value && inView.value) tryLoad();
});

onMounted(() => {
  if (typeof IntersectionObserver === "undefined") {
    inView.value = true;
    tryLoad();
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        inView.value = entry.isIntersecting;
        if (entry.isIntersecting) tryLoad();
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
