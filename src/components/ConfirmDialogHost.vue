<script setup lang="ts">
/**
 * 应用级确认弹层宿主（配 useConfirmDialog）：全局仅挂一份，避免每个调用点各自注册 Esc 监听。
 * 由 App.vue 常驻渲染；open() 返回的 Promise 在用户选择后 resolve，语义等价于 window.confirm 的返回值。
 */
import AppDialog from "./AppDialog.vue";
import { t } from "../i18n";
import { useConfirmDialog } from "../composables/useConfirmDialog";

const { visible, options, settle, cancel, submitInput, setInputValue } = useConfirmDialog();
</script>

<template>
  <AppDialog
    :open="visible"
    :title="options.title"
    :description="options.message"
    :close-label="t('关闭')"
    max-width="440px"
    @close="cancel()"
  >
    <p v-if="options.detail" class="cf-detail">{{ options.detail }}</p>
    <!-- 输入弹层（替代 window.prompt，后者在 Tauri 的 WKWebView 上未实现、点了没反应） -->
    <label v-if="options.kind === 'prompt'" class="cf-field">
      <span class="cf-label">{{ options.title }}</span>
      <input
        type="text"
        :value="options.inputValue"
        :placeholder="options.placeholder"
        @input="setInputValue(($event.target as HTMLInputElement).value)"
        @keydown.enter.prevent="submitInput()"
      />
    </label>
    <template #actions>
      <button type="button" class="btn ghost" @click="settle(false)">{{ options.cancelLabel }}</button>
      <button
        type="button"
        class="btn"
        :class="options.tone === 'danger' ? 'danger' : 'primary'"
        @click="options.kind === 'prompt' ? submitInput() : settle(true)"
      >
        {{ options.confirmLabel }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
.cf-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: var(--space-3);
}
.cf-label {
  font-size: 12px;
  color: var(--text-dim);
}
.cf-detail {
  margin: var(--space-3) 0 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
</style>
