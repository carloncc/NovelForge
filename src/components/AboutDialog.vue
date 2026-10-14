<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t } from "../i18n";
import { tauri } from "../utils/tauri";
import { brandDomain, brandName, brandUrl } from "../utils/branding";
import { version } from "../../package.json";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const linkError = ref("");
async function openExternal(url: string): Promise<void> {
  linkError.value = "";
  try {
    await tauri.openUrl(url);
  } catch (e) {
    // 此前静默吞错：外链失败用户完全无感知（看起来像点了没反应）
    linkError.value = `打开链接失败：${e instanceof Error ? e.message : String(e)}（可手动复制：${url}）`;
  }
}

/* ---- 对话框语义与焦点管理（对齐 AppDialog.vue 的做法）----
 * 本弹层是自建模态：只有 Esc + 点遮罩关闭，没有 role="dialog"/aria-modal，也没有把焦点
 * 收进弹层或限制 Tab 循环。读屏用户打开「关于」后焦点仍在背景侧栏的触发按钮上，Tab 会
 * 继续在背景控件之间游走，且读屏不会宣告「对话框」（WCAG 2.4.3 / 4.1.2）。
 * 这里补齐：role/aria-modal + 标题关联 + 打开时收拢焦点 + Tab 陷阱 + 关闭后焦点归还。 */
const maskEl = ref<HTMLElement | null>(null);
const titleId = `nf-about-title-${Math.random().toString(36).slice(2, 9)}`;
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

watch(
  () => props.open,
  async (open) => {
    if (open) {
      lastFocused = document.activeElement as HTMLElement | null;
      await nextTick();
      // 焦点优先落在弹层容器（避免直接落在「关闭」按钮上被误触）
      (maskEl.value ?? focusables()[0])?.focus?.();
    } else {
      lastFocused?.focus?.();
      lastFocused = null;
    }
  },
);

/** Esc 关闭 + Tab 焦点陷阱：组件常驻挂载，必须判断 open，避免关闭状态下也响应 */
function onKey(e: KeyboardEvent): void {
  if (!props.open) return;
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
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  // 焦点归还：卸载时也要还，避免焦点留在已消失的弹层里
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
    @click.self="emit('close')"
  >
    <div class="modal">
      <div class="modal-head">
        <img src="/src/assets/logo.png" alt="NovelForge" />
        <div>
          <div :id="titleId" class="m-title">{{ brandName() }}</div>
          <div class="m-sub">v{{ version }}</div>
        </div>
      </div>
      <div class="modal-body">
        <p>{{ t("导入小说，AI 全自动转换为可玩的视觉小说（WebGAL 项目），支持 PC / 手机 / 网页三端导出。") }}</p>

        <div class="about-section">
          <h4>{{ t("关于我们") }}</h4>
          <p>{{ t("NovelForge 是一站式 AI 视觉小说工坊：导入小说，AI 分章、提取角色、撰写剧本、绘制立绘与背景、生成配音，一键产出可发布的视觉小说。") }}</p>
        </div>

        <div class="about-section">
          <h4>{{ t("官网与下载") }}</h4>
          <p class="about-links">
            <a :href="brandUrl()" @click.prevent="openExternal(brandUrl())">{{ brandDomain() }}</a>
            <span class="faint"> · </span>
            <a href="https://github.com/carloncc/NovelForge" @click.prevent="openExternal('https://github.com/carloncc/NovelForge')">GitHub</a>
          </p>
          <p class="faint small">{{ t("更多作品、更新与 PC/手机版下载请访问官网。") }}</p>
          <p v-if="linkError" class="link-error">{{ linkError }}</p>
        </div>

        <div class="about-section">
          <h4>{{ t("技术") }}</h4>
          <p class="small">
            GPL-3.0 ·
            <a href="https://github.com/carloncc/NovelForge/blob/main/LICENSE" @click.prevent="openExternal('https://github.com/carloncc/NovelForge/blob/main/LICENSE')">License</a>
            · {{ t("引擎致谢") }}：
            <a href="https://github.com/OpenWebGAL/WebGAL" @click.prevent="openExternal('https://github.com/OpenWebGAL/WebGAL')">WebGAL</a>（MPL-2.0）
          </p>
        </div>

        <div style="margin-top: var(--space-4); text-align: right">
          <button class="btn secondary small" @click="emit('close')">{{ t("关闭") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.about-section {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border, #e5e7eb);
}
.about-section h4 {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}
.about-section p {
  margin: 0 0 4px;
  font-size: 13px;
  line-height: 1.6;
}
.about-links a {
  color: var(--primary, #087f73);
  text-decoration: none;
}
/* 外链失败提示：红色强调，让「点了没反应」变成可见反馈 */
.link-error {
  color: var(--err, #b91c1c);
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
