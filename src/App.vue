<script setup lang="ts">
import { onMounted, ref } from "vue";
import ImportPage from "./pages/ImportPage.vue";
import ConfigPage from "./pages/ConfigPage.vue";
import GeneratePage from "./pages/GeneratePage.vue";
import PreviewPage from "./pages/PreviewPage.vue";
import ExportPage from "./pages/ExportPage.vue";
import { configState } from "./stores/config";
import { projectState, restoreProject } from "./stores/project";
import { tauri } from "./utils/tauri";

const pages = [
  { id: "import", label: "导入小说", comp: ImportPage },
  { id: "config", label: "API 配置", comp: ConfigPage },
  { id: "generate", label: "生成项目", comp: GeneratePage },
  { id: "preview", label: "预览", comp: PreviewPage },
  { id: "export", label: "导出", comp: ExportPage },
];
const current = ref("import");

const icons: Record<string, string> = {
  import: "📖",
  config: "🔌",
  generate: "⚙️",
  preview: "▶️",
  export: "📦",
};

onMounted(async () => {
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
    <div class="logo">NovelForge</div>
    <button
      v-for="p in pages"
      :key="p.id"
      class="nav-item"
      :class="{ active: current === p.id }"
      @click="current = p.id"
    >
      <span>{{ icons[p.id] }}</span>
      <span>{{ p.label }}</span>
    </button>
  </div>
  <div class="main">
    <component :is="pages.find((p) => p.id === current)!.comp" />
  </div>
</template>
