<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { clearThumbCache, ensureAssetLoaded } from "../composables/useAssetThumbs";
import { t } from "../i18n";

const props = defineProps<{
  path: string;
  label: string;
}>();

const emit = defineEmits<{ (e: "close"): void }>();

const src = ref("");
/** 三态：加载中 / 成功 / 失败。旧实现只有「加载中/有值」两态，文件缺失时永久显示「加载中…」 */
const status = ref<"loading" | "ready" | "failed">("loading");
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
let dragging = false;
let startX = 0;
let startY = 0;
let ox = 0;
let oy = 0;
let loadAbort: AbortController | null = null;

function load(): void {
  loadAbort?.abort();
  loadAbort = null;
  const p = props.path;
  src.value = "";
  if (!p) {
    status.value = "failed";
    return;
  }
  status.value = "loading";
  const controller = new AbortController();
  loadAbort = controller;
  void ensureAssetLoaded(p, controller.signal).then((s) => {
    if (controller.signal.aborted) return;
    src.value = s;
    status.value = s ? "ready" : "failed";
  });
}

/** 失败重试：先清掉该路径的失败退避状态，否则点击后会被 5s 退避直接拒绝、看起来没反应 */
function retry(): void {
  if (props.path) clearThumbCache([props.path]);
  load();
}

watch(() => props.path, load, { immediate: true });

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
onBeforeUnmount(() => {
  loadAbort?.abort();
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="asset-preview" @click.self="emit('close')" @pointerup="onPointerUp" @pointerleave="onPointerUp">
    <div class="asset-preview-bar">
      <span class="asset-preview-label">{{ label }}</span>
      <div class="asset-preview-actions">
        <button class="btn ghost small" :title="t('放大')" @click="scale = Math.min(8, scale * 1.25)">＋</button>
        <button class="btn ghost small" :title="t('缩小')" @click="scale = Math.max(0.5, scale / 1.25)">－</button>
        <button class="btn ghost small" :title="t('重置（100%）')" @click="reset">100%</button>
        <button class="btn secondary small" @click="emit('close')">{{ t("关闭") }}</button>
      </div>
    </div>
    <div class="asset-preview-stage" @wheel.prevent="onWheel">
      <img
        v-if="status === 'ready'"
        :src="src"
        :alt="label"
        class="asset-preview-img"
        :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
        draggable="false"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
      />
      <button v-else-if="status === 'failed'" class="btn secondary small" @click="retry">
        {{ t("加载失败，点击重试") }}
      </button>
      <div v-else class="asset-preview-loading">{{ t("加载中…") }}</div>
    </div>
  </div>
</template>
