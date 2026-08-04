<script setup lang="ts">
import { onMounted, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, addMaterial, removeMaterial, restoreProject } from "../stores/project";
import { configState, addRecentOutputDir, removeRecentOutputDir } from "../stores/config";
import { importNovelFile } from "../core/chapters";
import { tauri } from "../utils/tauri";
import { DEMO_NOVEL } from "../core/demoNovel";
import type { MaterialAsset, NovelDoc } from "../core/types";
import { splitChapters } from "../core/chapters";

const error = ref("");
const importing = ref(false);

onMounted(async () => {
  if (!projectState.outputDir) {
    projectState.outputDir = await tauri.getDefaultOutputDir();
  }
});

async function pickNovel(): Promise<void> {
  error.value = "";
  importing.value = true;
  try {
    const path = await open({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt", "TXT"] }],
    });
    if (!path || typeof path !== "string") return;
    const doc = await importNovelFile(path);
    projectState.novel = doc;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    importing.value = false;
  }
}

async function loadDemo(): Promise<void> {
  const doc: NovelDoc = {
    fileName: "星陨之城的守夜人.txt",
    sourcePath: "",
    encoding: "UTF-8",
    fullText: DEMO_NOVEL,
    chapters: splitChapters(DEMO_NOVEL, "星陨之城的守夜人"),
  };
  projectState.novel = doc;
}

async function pickMaterials(): Promise<void> {
  const paths = await open({
    multiple: true,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (!paths) return;
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    const name = p.split(/[\\/]/).pop() || "asset";
    const lower = name.toLowerCase();
    let kind: MaterialAsset["kind"] = "background";
    if (/人|角色|char|figure|hero/.test(name)) kind = "character";
    else if (/物|item|道具|sword|weapon|jade/.test(name)) kind = "item";
    addMaterial({ name, path: p, kind, mime: lower.endsWith(".jpg") ? "image/jpeg" : "image/png" });
  }
}

function updateChapterTitle(i: number, title: string): void {
  if (projectState.novel) {
    projectState.novel.chapters[i].title = title;
  }
}

function toggleChapter(i: number): void {
  const doc = projectState.novel;
  if (!doc) return;
  doc.chapters[i].enabled = !(doc.chapters[i].enabled !== false);
}

// 最近项目
async function openRecent(dir: string): Promise<void> {
  projectState.outputDir = dir;
  configState.outputDir = dir;
  await restoreProject(dir);
}

function loadRecentTitles(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() || dir;
}
</script>

<template>
  <div class="inner">
    <div class="page-head">
      <div>
        <div class="page-title">导入小说</div>
        <p class="page-sub">选择 txt 小说文件，自动识别编码并按章节切分；可导入自定义素材（AI 优先使用）</p>
      </div>
      <div class="page-actions">
        <button class="btn secondary" @click="loadDemo">加载示例</button>
        <button class="btn" :disabled="importing" @click="pickNovel">
          <span v-if="importing" class="spinner" />
          {{ importing ? "读取中…" : "选择小说 txt" }}
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>小说文件</h3>
        <div class="card-actions">
          <button v-if="projectState.novel" class="btn secondary small" @click="pickNovel">重新导入</button>
        </div>
      </div>
      <p v-if="error" style="color: var(--err); margin-top: 10px">{{ error }}</p>
      <p v-if="projectState.novel" style="color: var(--text-dim)">
        {{ projectState.novel.fileName }} · 编码 {{ projectState.novel.encoding }} · 共
        {{ projectState.novel.fullText.length.toLocaleString() }} 字
      </p>
      <p v-else style="color: var(--text-faint)">尚未导入小说</p>
    </div>

    <div class="card" v-if="projectState.novel">
      <div class="card-head">
        <h3>章节（可勾选参与生成、修改标题）</h3>
      </div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 50px">启用</th>
              <th>标题</th>
              <th style="width: 90px">字数</th>
              <th style="width: 90px">段落数</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(ch, i) in projectState.novel.chapters" :key="i" :style="ch.enabled === false ? 'opacity: .5' : ''">
              <td>
                <input type="checkbox" :checked="ch.enabled !== false" @change="toggleChapter(i)" />
              </td>
              <td>
                <input
                  type="text"
                  :value="ch.title"
                  style="background: transparent; border: none; padding: 2px 0"
                  @change="(e: any) => updateChapterTitle(i, (e.target as HTMLInputElement).value)"
                />
              </td>
              <td>{{ ch.charCount }}</td>
              <td>{{ ch.text.split(/\n{2,}/).length }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>自定义素材库（可选）</h3>
        <div class="card-actions">
          <button class="btn secondary small" @click="pickMaterials">＋ 导入图片素材</button>
        </div>
      </div>
      <p style="color: var(--text-dim); font-size: 12.5px; margin-bottom: var(--space-4)">
        人物参考图 / 物品图 / 背景图。文件名含「人/角色/char」归人物、「物/item/剑」归物品、其余归背景。
        管线优先使用你的素材，缺失才由 AI 生成；可在下方手动改类型与映射。
      </p>
      <div v-if="projectState.materials.length" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3)">
        <div
          v-for="m in projectState.materials"
          :key="m.path"
          style="border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-3); background: var(--bg-hover)"
        >
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px">
            <span style="font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ m.name }}</span>
            <button class="btn danger small" @click="removeMaterial(m.path)">移除</button>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 8px">
            <select :value="m.kind" @change="(e: any) => (m.kind = (e.target as HTMLSelectElement).value as any)" style="padding: 4px 8px; font-size: 12px; flex: 1">
              <option value="character">人物</option>
              <option value="item">物品</option>
              <option value="background">背景</option>
            </select>
            <input
              type="text"
              :value="m.extra?.mapTo ?? ''"
              style="padding: 4px 8px; font-size: 12px; flex: 1.4"
              placeholder="映射到（角色/物品 id）"
              @change="
                (e: any) => {
                  if (!m.extra) m.extra = {};
                  m.extra.mapTo = (e.target as HTMLInputElement).value.trim() || undefined;
                }
              "
            />
          </div>
        </div>
      </div>
      <p v-else style="color: var(--text-faint); font-size: 12.5px">暂无素材</p>
      <p v-if="projectState.lastResult" style="color: var(--text-dim); font-size: 12px; margin-top: var(--space-3)">
        可映射 id：角色 {{ projectState.lastResult.cards.characters.map((c) => c.id).join("、") }} · 物品 {{ projectState.lastResult.cards.items.map((c) => c.id).join("、") }}
      </p>
    </div>

    <div class="card" v-if="configState.recentOutputDirs?.length">
      <div class="card-head">
        <h3>最近项目</h3>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px">
        <div
          v-for="dir in configState.recentOutputDirs"
          :key="dir"
          style="display: flex; align-items: center; gap: var(--space-3); padding: 8px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; transition: background var(--dur) var(--ease)"
          @mouseenter="($event.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'"
          @mouseleave="($event.currentTarget as HTMLElement).style.background = ''"
        >
          <span style="flex: 1; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" @click="openRecent(dir)">
            <span style="font-weight: 600; color: var(--primary)">{{ loadRecentTitles(dir) }}</span>
            <span style="color: var(--text-faint); margin-left: 8px">{{ dir }}</span>
          </span>
          <button class="btn secondary small" @click="openRecent(dir)">打开</button>
          <button class="btn ghost small" @click="removeRecentOutputDir(dir)">移除</button>
        </div>
      </div>
    </div>
  </div>
</template>
