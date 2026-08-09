<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ensureAssetLoaded } from "../composables/useAssetThumbs";

const props = defineProps<{
  path: string;
  label: string;
}>();

const emit = defineEmits<{ (e: "close"): void }>();

const src = ref("");
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
let dragging = false;
let startX = 0;
let startY = 0;
let ox = 0;
let oy = 0;

watch(
  () => props.path,
  (p) => {
    if (p) void ensureAssetLoaded(p).then((s) => (src.value = s));
  },
  { immediate: true },
);

function onWheel(e: WheelEvent): void {
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  scale.value = Math.min(8, Math.max(0.5, scale.value * factor));
}

function onPointerDown(e: PointerEvent): void {
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  ox = tx.value;
  oy = ty.value;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging) return;
  tx.value = ox + (e.clientX - startX);
  ty.value = oy + (e.clientY - startY);
}

function onPointerUp(): void {
  dragging = false;
}

function reset(): void {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="asset-preview" @click.self="emit('close')" @pointerup="onPointerUp" @pointerleave="onPointerUp">
    <div class="asset-preview-bar">
      <span class="asset-preview-label">{{ label }}</span>
      <div class="asset-preview-actions">
        <button class="btn ghost small" title="放大" @click="scale = Math.min(8, scale * 1.25)">＋</button>
        <button class="btn ghost small" title="缩小" @click="scale = Math.max(0.5, scale / 1.25)">－</button>
        <button class="btn ghost small" title="重置（100%）" @click="reset">100%</button>
        <button class="btn secondary small" @click="emit('close')">关闭</button>
      </div>
    </div>
    <div class="asset-preview-stage" @wheel.prevent="onWheel">
      <img
        v-if="src"
        :src="src"
        :alt="label"
        class="asset-preview-img"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        draggable="false"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
      />
      <div v-else class="asset-preview-loading">加载中…</div>
    </div>
  </div>
</template>
