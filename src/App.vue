<script setup lang="ts">
import { onMounted, ref } from "vue";
import ImportPage from "./pages/ImportPage.vue";
import ConfigPage from "./pages/ConfigPage.vue";
import GeneratePage from "./pages/GeneratePage.vue";
import PreviewPage from "./pages/PreviewPage.vue";
import ExportPage from "./pages/ExportPage.vue";
import AboutDialog from "./components/AboutDialog.vue";
import { configState } from "./stores/config";
import { projectState, restoreProject } from "./stores/project";
import { tauri } from "./utils/tauri";
import { installLogFileSink } from "./utils/logFile";
import { log } from "./utils/logger";
import { version } from "../package.json";

const pages = [
  { id: "import", label: "导入小说", comp: ImportPage },
  { id: "config", label: "API 配置", comp: ConfigPage },
  { id: "generate", label: "生成项目", comp: GeneratePage },
  { id: "preview", label: "预览", comp: PreviewPage },
  { id: "export", label: "导出", comp: ExportPage },
];
const current = ref("import");
const aboutOpen = ref(false);

const icons: Record<string, string> = {
  import: "M13.5 6H10C8.89543 6 8 6.89543 8 8V18C8 19.1046 8.89543 20 10 20H18C19.1046 20 20 19.1046 20 18V11.5M13.5 6L20 11.5M13.5 6V11.5H20M7 16H6C4.89543 16 4 15.1046 4 14V6C4 4.89543 4.89543 4 6 4H14C15.1046 4 16 4.89543 16 6V7",
  config: "M9 3H5C4.44772 3 4 3.44772 4 4V8C4 8.55228 4.44772 9 5 9H9C9.55228 9 10 8.55228 10 8V4C10 3.44772 9.55228 3 9 3ZM15 3H19C19.5523 3 20 3.44772 20 4V8C20 8.55228 19.5523 9 19 9H15C14.4477 9 14 8.55228 14 8V4C14 3.44772 14.4477 3 15 3ZM9 15H5C4.44772 15 4 15.4477 4 16V20C4 20.5523 4.44772 21 5 21H9C9.55228 21 10 20.5523 10 20V16C10 15.4477 9.55228 15 9 15ZM19 15H15C14.4477 15 14 15.4477 14 16V20C14 20.5523 14.4477 21 15 21H19C19.5523 21 20 20.5523 20 20V16C20 15.4477 19.5523 15 19 15Z",
  generate: "M10.325 4.31707C10.751 2.56098 13.249 2.56098 13.675 4.31707L14.7286 8.54307C14.8558 9.05518 15.3236 9.41421 15.8537 9.41421H20.2445C22.0843 9.41421 22.8458 11.7627 21.3633 12.8743L17.7737 15.5198C17.3353 15.8413 17.1479 16.3998 17.2751 16.9119L18.3287 21.1379C18.7547 22.8939 16.7434 24.3523 15.2609 23.2407L11.6713 20.5952C11.2329 20.2737 10.6453 20.2737 10.2069 20.5952L6.61727 23.2407C5.13478 24.3523 3.12348 22.8939 3.54947 21.1379L4.60308 16.9119C4.73027 16.3998 4.54288 15.8413 4.10448 15.5198L0.514859 12.8743C-0.967631 11.7627 -0.206114 9.41421 1.63365 9.41421H6.02444C6.55455 9.41421 7.02239 9.05518 7.14958 8.54307L8.20319 4.31707Z",
  preview: "M8 5.14V19L19 12L8 5.14Z",
  export: "M20 13V19C20 20.1046 19.1046 21 18 21H6C4.89543 21 4 20.1046 4 19V13M12 15V3M12 3L8 7M12 3L16 7",
};

const versionText = `v${version}`;

onMounted(async () => {
  const logPath = await installLogFileSink();
  log.info("app", "应用启动，日志已落盘", { logPath });
  if (configState.outputDir) {
    projectState.outputDir = configState.outputDir;
    await restoreProject(configState.outputDir);
  } else {
    projectState.outputDir = await tauri.getDefaultOutputDir();
    configState.outputDir = projectState.outputDir;
  }
});
</script>

<template>
  <div class="sidebar">
    <div class="logo">
      <img src="/src/assets/logo.png" alt="NovelForge" />
      <div class="name-wrap">
        <span class="name">NovelForge</span>
        <span class="tagline">AI 视觉小说工坊</span>
      </div>
    </div>
    <div class="nav-group-label">导航</div>
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
      <span>{{ p.label }}</span>
    </button>
    <div class="sidebar-footer">
      <span class="version">{{ versionText }}</span>
      <button class="about-btn" @click="aboutOpen = true">关于</button>
    </div>
  </div>
  <div class="main">
    <component :is="pages.find((p) => p.id === current)!.comp" />
  </div>
  <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
</template>
