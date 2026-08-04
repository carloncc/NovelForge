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
  <div class="inner">
    <div class="page-head">
      <div>
        <div class="page-title">预览</div>
        <p class="page-sub">内嵌 WebGAL 引擎实时试玩（本地服务器，所见即所得）</p>
      </div>
      <div class="page-actions">
        <button class="btn" :disabled="starting" @click="startPreview">
          <span v-if="starting" class="spinner" />
          启动/刷新
        </button>
        <button class="btn secondary" :disabled="!url" @click="openInBrowser">系统浏览器打开</button>
        <button class="btn danger" :disabled="!url" @click="stopPreview">停止</button>
      </div>
    </div>

    <div class="card" style="padding: var(--space-3)">
      <div style="display: flex; align-items: center; gap: var(--space-3); font-size: 12.5px">
        <span style="color: var(--text-dim); flex-shrink: 0">项目：</span>
        <code style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ previewDir || "（未生成）" }}</code>
      </div>
      <p v-if="error" style="color: var(--err); margin-top: 8px">{{ error }}</p>
    </div>

    <div v-if="url" style="margin-top: var(--space-4)">
      <iframe :key="reloadKey" class="preview-frame" :src="url" />
    </div>
    <div v-else class="card empty">
      <img src="/src/assets/empty-preview.png" alt="" style="width: 280px; opacity: 0.9; margin-bottom: 12px" />
      <p>启动预览后在此显示游戏画面</p>
    </div>
  </div>
</template>
