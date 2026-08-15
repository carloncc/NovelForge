<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAssetThumbs } from "../composables/useAssetThumbs";

const props = defineProps<{
  path: string;
  alt?: string;
}>();

const { thumbCache, loadAssetDataUrl } = useAssetThumbs();
const el = ref<HTMLImageElement | null>(null);
const inView = ref(false);
let observer: IntersectionObserver | null = null;
let retryTimer: number | undefined;
let retryCount = 0;
const MAX_RETRY = 30; // 上限 36s，避免文件永久缺失时无限轮询

const src = computed(() => (inView.value ? thumbCache.value[props.path] || "" : ""));

function tryLoad(): void {
  loadAssetDataUrl(props.path);
  // 文件可能在生成中/刚写入导致首次读取失败（failed 有 5s 退避）。
  // 持续重试直到加载成功，避免「必须点一下才显示」；达到上限则停止轮询。
  if (!thumbCache.value[props.path] && inView.value && retryCount < MAX_RETRY) {
    retryCount++;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      tryLoad();
    }, 1200);
  }
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
        if (entry.isIntersecting) {
          inView.value = true;
          tryLoad();
          observer?.disconnect();
          break;
        }
      }
    },
    { rootMargin: "300px" },
  );
  if (el.value) observer.observe(el.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
});
</script>

<template>
  <div class="lazy-thumb" :class="{ empty: !src }">
    <img v-if="src" ref="el" :src="src" :alt="alt || ''" loading="lazy" />
    <div v-else ref="el" class="lazy-thumb-placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
    </div>
  </div>
</template>

<style scoped>
.lazy-thumb {
  width: 100%;
  height: 100%;
  min-height: 120px;
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
  min-height: 120px;
}
</style>
