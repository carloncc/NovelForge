<script setup lang="ts">
/**
 * 通用无障碍弹层（#a11y）：应用此前所有确认框都走 `window.confirm`，
 * 浏览器原生弹层无法主题化、不可键盘焦点约束、部分 WebView 里还会被静默拦截，
 * 且没有 role="dialog" / aria-modal / 焦点陷阱——屏幕阅读器与纯键盘用户会迷失在背景页。
 * 这里提供统一的弹层外壳：role=dialog + aria-modal + 标题关联 + 焦点陷阱 + Esc 关闭 + 焦点归还。
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  /** 是否打开（常驻挂载，靠 open 控制显隐） */
  open: boolean;
  /** 标题（可访问名称来源） */
  title: string;
  /** 辅助描述，关联 aria-describedby */
  description?: string;
  /** 关闭按钮的可访问名 */
  closeLabel: string;
  /** 最大宽度，默认 420px（与 .modal 一致） */
  maxWidth?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const maskEl = ref<HTMLElement | null>(null);
const titleId = `nf-dialog-title-${Math.random().toString(36).slice(2, 9)}`;
let lastFocused: HTMLElement | null = null;

/** 可聚焦元素集合（过滤不可见/禁用项） */
function focusables(): HTMLElement[] {
  const root = maskEl.value;
  if (!root) return [];
  const selector =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    emit("close");
    return;
  }
  if (e.key !== "Tab") return;
  // 焦点陷阱：Tab 在弹层内循环，不允许跑到背景页（背景页此时已 aria-hidden 语义上不可用）
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

watch(
  () => props.open,
  async (open) => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement | null;
      await nextTick();
      const items = focusables();
      // 焦点优先落在弹层容器上（避免直接落在「危险」按钮上被误触），无内容再回退到首个可聚焦项
      (maskEl.value ?? items[0])?.focus?.();
    } else {
      // 焦点归还：关闭后回到触发元素，键盘用户不会掉回页面顶部
      lastFocused?.focus?.();
      lastFocused = null;
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  lastFocused?.focus?.();
  lastFocused = null;
});
</script>

<template>
  <div
    v-if="open"
    ref="maskEl"
    class="modal-mask"
    tabindex="-1"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    :aria-describedby="description ? `${titleId}-desc` : undefined"
    @click.self="emit('close')"
    @keydown="onKeydown"
  >
    <div class="modal" :style="maxWidth ? { maxWidth } : undefined">
      <div class="modal-head nf-dialog-head">
        <h3 :id="titleId" class="m-title nf-dialog-title">{{ title }}</h3>
        <button type="button" class="nf-dialog-close" :aria-label="closeLabel" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <p v-if="description" :id="`${titleId}-desc`" class="nf-dialog-desc">{{ description }}</p>
        <slot />
      </div>
      <div class="nf-dialog-actions">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.nf-dialog-head {
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}
.nf-dialog-title {
  font-size: 15px;
  font-weight: 700;
  line-height: 1.5;
  /* 标题可能较长（确认文案常带文件名），允许换行不撑破弹层 */
  overflow-wrap: anywhere;
}
.nf-dialog-close {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.nf-dialog-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.nf-dialog-close:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.nf-dialog-desc {
  /* #1486：确认文案里常带 `\n` 分段（如「…。\n\n注意：…」）。默认 white-space 会把换行
     折成空格，整段挤成一大块；pre-line 保留换行同时仍允许自动折行。 */
  white-space: pre-line;
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.nf-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-5);
  flex-wrap: wrap;
}
</style>
