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

/* ---- 对话框语义与焦点管理（对齐 AppDialog.vue 的做法）----
 * 本弹层是自建模态：只有 Esc + 点遮罩关闭，没有 role="dialog"/aria-modal，也没有把焦点
 * 收进弹层或限制 Tab 循环——读屏用户点开大图后焦点仍停留在背景页的缩略图上，Tab 会继续
 * 在背景控件之间游走（WCAG 2.4.3 / 4.1.2）。这里补齐：role/aria-modal + 名称关联（用
 * label 作可访问名称，读屏据此宣告「对话框：<文件名>」）+ 挂载时收拢焦点 + Tab 陷阱 +
 * 卸载时焦点归还。组件由父级 v-if 控制挂载，因此不需要再判断 open。 */
const maskEl = ref<HTMLElement | null>(null);
const labelId = `nf-preview-label-${Math.random().toString(36).slice(2, 9)}`;
let lastFocused: HTMLElement | null = null;

/** 可聚焦元素集合（过滤不可见/禁用项），焦点陷阱只在本弹层内循环 */
function focusables(): HTMLElement[] {
  const root = maskEl.value;
  if (!root) return [];
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

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

/** Esc 关闭 + Tab 焦点陷阱（组件挂载期间始终可见，无需判断 open） */
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    emit("close");
    return;
  }
  if (e.key !== "Tab") return;
  const items = focusables();
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !maskEl.value?.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  // 打开即把焦点收进弹层：否则键盘/读屏用户还在背景页的缩略图上，Tab 会跑到背景控件
  lastFocused = document.activeElement as HTMLElement | null;
  maskEl.value?.focus?.();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  loadAbort?.abort();
  window.removeEventListener("keydown", onKey);
  // 焦点归还：关闭后回到打开大图的触发元素，键盘用户不会掉回页面顶部
  lastFocused?.focus?.();
  lastFocused = null;
});
</script>

<template>
  <div
    ref="maskEl"
    class="asset-preview"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="labelId"
    @click.self="emit('close')"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
  >
    <div class="asset-preview-bar">
      <span :id="labelId" class="asset-preview-label">{{ label }}</span>
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
