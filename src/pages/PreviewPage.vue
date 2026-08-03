<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { projectState } from "../stores/project";
import { tauri } from "../utils/tauri";

const url = ref("");
const starting = ref(false);
const error = ref("");
const reloadKey = ref(0);

const previewDir = computed(() => {
  if (!projectState.lastResult) return "";
  return projectState.lastResult.meta.outputDir;
});

async function startPreview(): Promise<void> {
  error.value = "";
  const dir = previewDir.value;
  if (!dir) {
    error.value = "请先在「生成项目」页生成项目";
    return;
  }
  starting.value = true;
  try {
    await tauri.stopPreviewServer();
    const res = await tauri.startPreviewServer(dir);
    url.value = res.url;
    reloadKey.value++;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    starting.value = false;
  }
}

async function stopPreview(): Promise<void> {
  await tauri.stopPreviewServer();
  url.value = "";
}

async function openInBrowser(): Promise<void> {
  if (!url.value) return;
  await tauri.openUrl(url.value);
}

onMounted(() => {
  if (projectState.lastResult) {
    void startPreview();
  }
});

onBeforeUnmount(() => {
  void tauri.stopPreviewServer();
});
</script>

<template>
  <div class="page-title">预览</div>
  <div class="page-sub">内嵌 WebGAL 引擎实时试玩（本地服务器，所见即所得）</div>

  <div class="card">
    <div class="row">
      <span>项目目录：</span>
      <code style="color: var(--accent-2)">{{ previewDir || "（未生成）" }}</code>
      <button class="btn secondary small" @click="startPreview">启动/刷新预览</button>
      <button class="btn secondary small" :disabled="!url" @click="openInBrowser">在系统浏览器打开</button>
      <button class="btn danger small" @click="stopPreview">停止</button>
    </div>
    <p v-if="error" style="color: var(--err); margin-top: 8px">{{ error }}</p>
  </div>

  <div v-if="url" style="margin-top: 12px">
    <iframe :key="reloadKey" class="preview-frame" :src="url" />
  </div>
  <div v-else class="card empty">启动预览后在此显示游戏画面</div>
</template>
