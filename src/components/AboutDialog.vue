<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
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

/** Esc 关闭：组件常驻挂载，必须判断 open，避免关闭状态下也响应 */
function onKey(e: KeyboardEvent): void {
  if (props.open && e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <img src="/src/assets/logo.png" alt="NovelForge" />
        <div>
          <div class="m-title">{{ brandName() }}</div>
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
