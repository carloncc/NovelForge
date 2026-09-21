<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, type Component } from "vue";
import ImportPage from "./pages/ImportPage.vue";
import AboutDialog from "./components/AboutDialog.vue";
import { configReady, configState } from "./stores/config";
import { projectState, restoreProject } from "./stores/project";
import { tauri } from "./utils/tauri";
import { installLogFileSink } from "./utils/logFile";
import { log } from "./utils/logger";
import { version } from "../package.json";
import { t, LANGS, currentLang, setLang } from "./i18n";
import { currentPage, type PageId } from "./stores/nav";
// 轻量运行状态模块：避免把 generate store（含管线核心）拉进主包
import { runIsBusy, runAssetLabel, runIsQueue, runIsStopping, runFailedCount, requestRunStop } from "./stores/runStatus";

const pages: { id: PageId; labelKey: string; comp: Component }[] = [
  { id: "import", labelKey: "导入小说", comp: ImportPage },
  { id: "config", labelKey: "API 配置", comp: defineAsyncComponent(() => import("./pages/ConfigPage.vue")) },
  { id: "generate", labelKey: "生成项目", comp: defineAsyncComponent(() => import("./pages/GeneratePage.vue")) },
  { id: "imageStory", labelKey: "图片小说", comp: defineAsyncComponent(() => import("./pages/ImageStoryPage.vue")) },
  { id: "preview", labelKey: "预览", comp: defineAsyncComponent(() => import("./pages/PreviewPage.vue")) },
  { id: "export", labelKey: "导出", comp: defineAsyncComponent(() => import("./pages/ExportPage.vue")) },
];
const current = currentPage;
const aboutOpen = ref(false);

// 静默失败面：自动保存失败（saveError）/ 启动恢复失败（visualBibleWarnings）此前只写进状态却无人渲染，
// 用户会以为一切正常（甚至以为项目是空的）——这里统一在顶部横幅呈现，可一键消除。
const noticeText = computed(() => {
  const parts: string[] = [];
  if (projectState.saveError) parts.push(`${t("自动保存失败")}：${projectState.saveError}`);
  parts.push(...projectState.visualBibleWarnings);
  return parts.join("；");
});
function dismissNotices(): void {
  projectState.saveError = null;
  projectState.visualBibleWarnings = [];
}

// 全局运行态（G1/G2/G12）：离开生成页后管线仍在跑——侧栏常驻显示运行中 + 停止入口，并由导航徽标提示失败项
const runActive = computed(() => runIsBusy.value || !!runAssetLabel.value || runIsQueue.value);

const icons: Record<string, string> = {
  import: "M13.5 6H10C8.89543 6 8 6.89543 8 8V18C8 19.1046 8.89543 20 10 20H18C19.1046 20 20 19.1046 20 18V11.5M13.5 6L20 11.5M13.5 6V11.5H20M7 16H6C4.89543 16 4 15.1046 4 14V6C4 4.89543 4.89543 4 6 4H14C15.1046 4 16 4.89543 16 6V7",
  config: "M9 3H5C4.44772 3 4 3.44772 4 4V8C4 8.55228 4.44772 9 5 9H9C9.55228 9 10 8.55228 10 8V4C10 3.44772 9.55228 3 9 3ZM15 3H19C19.5523 3 20 3.44772 20 4V8C20 8.55228 19.5523 9 19 9H15C14.4477 9 14 8.55228 14 8V4C14 3.44772 14.4477 3 15 3ZM9 15H5C4.44772 15 4 15.4477 4 16V20C4 20.5523 4.44772 21 5 21H9C9.55228 21 10 20.5523 10 20V16C10 15.4477 9.55228 15 9 15ZM19 15H15C14.4477 15 14 15.4477 14 16V20C14 20.5523 14.4477 21 15 21H19C19.5523 21 20 20.5523 20 20V16C20 15.4477 19.5523 15 19 15Z",
  generate: "M10.325 4.31707C10.751 2.56098 13.249 2.56098 13.675 4.31707L14.7286 8.54307C14.8558 9.05518 15.3236 9.41421 15.8537 9.41421H20.2445C22.0843 9.41421 22.8458 11.7627 21.3633 12.8743L17.7737 15.5198C17.3353 15.8413 17.1479 16.3998 17.2751 16.9119L18.3287 21.1379C18.7547 22.8939 16.7434 24.3523 15.2609 23.2407L11.6713 20.5952C11.2329 20.2737 10.6453 20.2737 10.2069 20.5952L6.61727 23.2407C5.13478 24.3523 3.12348 22.8939 3.54947 21.1379L4.60308 16.9119C4.73027 16.3998 4.54288 15.8413 4.10448 15.5198L0.514859 12.8743C-0.967631 11.7627 -0.206114 9.41421 1.63365 9.41421H6.02444C6.55455 9.41421 7.02239 9.05518 7.14958 8.54307L8.20319 4.31707Z",
  imageStory: "M4 5C4 4.44772 4.44772 4 5 4H9.5C10.0523 4 10.5 4.44772 10.5 5V5.5C10.5 6.05228 10.9477 6.5 11.5 6.5H12.5C13.0523 6.5 13.5 6.05228 13.5 5.5V5C13.5 4.44772 13.9477 4 14.5 4H19C19.5523 4 20 4.44772 20 5V9.5C20 10.0523 19.5523 10.5 19 10.5H18.5C17.9477 10.5 17.5 10.9477 17.5 11.5V12.5C17.5 13.0523 17.9477 13.5 18.5 13.5H19C19.5523 13.5 20 13.9477 20 14.5V19C20 19.5523 19.5523 20 19 20H14.5C13.9477 20 13.5 19.5523 13.5 19V18.5C13.5 17.9477 13.0523 17.5 12.5 17.5H11.5C10.9477 17.5 10.5 17.9477 10.5 18.5V19C10.5 19.5523 10.0523 20 9.5 20H5C4.44772 20 4 19.5523 4 19V14.5C4 13.9477 4.44772 13.5 5 13.5H5.5C6.05228 13.5 6.5 13.0523 6.5 12.5V11.5C6.5 10.9477 6.05228 10.5 5.5 10.5H5C4.44772 10.5 4 10.0523 4 9.5V5Z",
  preview: "M8 5.14V19L19 12L8 5.14Z",
  export: "M20 13V19C20 20.1046 19.1046 21 18 21H6C4.89543 21 4 20.1046 4 19V13M12 15V3M12 3L8 7M12 3L16 7",
};

const versionText = `v${version}`;

function onLangChange(e: Event): void {
  setLang((e.target as HTMLSelectElement).value as typeof currentLang.value);
  // 同步 <html lang>（屏幕阅读器/拼写检查依赖）：i18n 模块不在本次修改范围，故在这里跟随切换更新
  document.documentElement.lang = currentLang.value;
}

onMounted(async () => {
  document.documentElement.lang = currentLang.value;
  const logPath = await installLogFileSink();
  log.info("app", "应用启动，日志已落盘", { logPath });
  await configReady;
  if (configState.outputDir) {
    projectState.outputDir = configState.outputDir;
    // 启动恢复失败必须留痕：以前这里不接异常，状态读不出来时 projectState.novel 会一直是 null，
    // 生成页的「单章节生成 / 本次重跑」整块静默消失，用户只看到「还没有小说」，以为功能被删了。
    try {
      await restoreProject(configState.outputDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("app", `启动恢复项目状态失败：${message}`, { outputDir: configState.outputDir });
      projectState.visualBibleWarnings = [
        ...projectState.visualBibleWarnings,
        `项目状态恢复失败：${message}（可到生成页点「加载该项目」重试）`,
      ];
    }
  } else {
    projectState.outputDir = await tauri.getDefaultOutputDir();
    configState.outputDir = projectState.outputDir;
  }
  // 崩溃残留清理（#783）：上次被强退/OOM 时可能留下 .tmp / .replace-backup，静默清理不阻塞启动
  if (projectState.outputDir) {
    void tauri
      .cleanupStaleFiles(projectState.outputDir)
      .then(({ removed, restored }) => {
        if (removed || restored) {
          log.warn("app", `已清理崩溃残留文件：删除 ${removed} 个临时/备份文件，恢复 ${restored} 个备份`, {
            outputDir: projectState.outputDir,
          });
        }
      })
      .catch(() => undefined);
  }
});
</script>

<template>
  <div class="sidebar">
    <div class="logo">
      <img src="/src/assets/logo.png" alt="NovelForge" />
      <div class="name-wrap">
        <span class="name">NovelForge</span>
        <span class="tagline">{{ t("AI 视觉小说工坊") }}</span>
      </div>
    </div>
    <div class="nav-group-label">{{ t("导航") }}</div>
    <button
      v-for="p in pages"
      :key="p.id"
      class="nav-item"
      :class="{ active: current === p.id }"
      @click="current = p.id"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path :d="icons[p.id]" />
      </svg>
      <span>{{ t(p.labelKey) }}</span>
      <span v-if="p.id === 'generate' && runFailedCount" class="nav-badge" :title="t('有失败任务未处理（点开生成页 → 失败项）')">{{ runFailedCount }}</span>
    </button>
    <div v-if="runActive" class="run-indicator">
      <span class="spinner" style="width: 12px; height: 12px" />
      <span class="run-text">{{ runAssetLabel ? `${t("素材")}：${runAssetLabel}` : t("生成中…") }}</span>
      <button class="btn danger small" :disabled="runIsStopping" @click="requestRunStop()">{{ runIsStopping ? t("正在停止…") : t("停止") }}</button>
    </div>
    <div class="sidebar-footer">
      <select :value="currentLang" class="lang-select" @change="onLangChange">
        <option v-for="l in LANGS" :key="l.code" :value="l.code">{{ l.label }}</option>
      </select>
      <span class="version">{{ versionText }}</span>
      <button class="about-btn" @click="aboutOpen = true">{{ t("关于") }}</button>
    </div>
  </div>
  <div class="main">
    <div v-if="noticeText" class="notice-bar" role="alert">
      <span class="notice-text">{{ noticeText }}</span>
      <button class="btn ghost small" @click="dismissNotices">{{ t("知道了") }}</button>
    </div>
    <component :is="pages.find((p) => p.id === current)!.comp" />
  </div>
  <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
</template>

<style scoped>
.notice-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  /* 不再额外加左右 16px：.main 已有 32px 内边距，之前横幅比页面内容多缩进 16px 不对齐 */
  margin: 12px 0 0;
  padding: 8px 12px;
  border: 1px solid var(--err);
  background: var(--err-soft);
  color: var(--err);
  border-radius: 8px;
  font-size: 13px;
}
.notice-text {
  flex: 1;
  min-width: 0;
}
.nav-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--err);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.run-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 底部固定吸在页脚上方；margin-top 不用 auto（会与 .sidebar-footer 的 auto 平分空白，位置漂移） */
  margin: 0 0 6px;
  padding: 8px 10px;
  border: 1px solid var(--warn);
  background: var(--err-soft);
  border-radius: 8px;
  font-size: 12px;
}
.run-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
