<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useAssetThumbs } from "../composables/useAssetThumbs";

const props = defineProps<{
  path: string;
  alt?: string;
}>();

const { thumbCache, loadAssetDataUrl } = useAssetThumbs();
const el = ref<HTMLImageElement | null>(null);
const inView = ref(false);
let observer: IntersectionObserver | null = null;

const src = computed(() => (inView.value ? thumbCache.value[props.path] || "" : ""));

onMounted(() => {
  if (typeof IntersectionObserver === "undefined") {
    loadAssetDataUrl(props.path);
    inView.value = true;
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          inView.value = true;
          loadAssetDataUrl(props.path);
          observer?.disconnect();
          break;
        }
      }
    },
    { rootMargin: "300px" },
  );
  if (el.value) observer.observe(el.value);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <img ref="el" :src="src" :alt="alt || ''" loading="lazy" />
</template>
