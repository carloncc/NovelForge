<script setup lang="ts">
import { onMounted, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, addMaterial, removeMaterial } from "../stores/project";
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
</script>

<template>
  <div class="page-title">导入小说</div>
  <div class="page-sub">选择 txt 小说文件，自动识别编码并按章节切分；可导入自定义素材（AI 优先使用）</div>

  <div class="card">
    <h3>小说文件</h3>
    <div class="row">
      <button class="btn" :disabled="importing" @click="pickNovel">
        {{ importing ? "读取中…" : "选择小说 txt 文件" }}
      </button>
      <button class="btn secondary" @click="loadDemo">加载示例小说（演示）</button>
      <button
        class="btn secondary"
        :disabled="!projectState.novel"
        @click="pickNovel"
      >重新导入</button>
    </div>
    <p v-if="error" style="color: var(--err); margin-top: 10px">{{ error }}</p>
    <p v-if="projectState.novel" style="margin-top: 10px; color: var(--text-dim)">
      {{ projectState.novel.fileName }} · 编码 {{ projectState.novel.encoding }} · 共
      {{ projectState.novel.fullText.length.toLocaleString() }} 字
    </p>
  </div>

  <div class="card" v-if="projectState.novel">
    <h3>章节（可勾选参与生成、修改标题）</h3>
    <table class="tbl">
      <thead>
        <tr>
          <th style="width: 40px">启用</th>
          <th>标题</th>
          <th style="width: 100px">字数</th>
          <th style="width: 90px">段落数</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(ch, i) in projectState.novel.chapters" :key="i">
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

  <div class="card">
    <h3>自定义素材库（可选）</h3>
    <p class="page-sub" style="margin-bottom: 10px">
      上传人物参考图 / 物品图 / 背景图。文件名含「人/角色/char」归为人物、「物/item/剑」归为物品、其余归为背景。
      管线会按名称自动匹配角色卡 / 物品卡 / 场景，优先使用你的素材，缺失的才由 AI 生成。
    </p>
    <button class="btn secondary" @click="pickMaterials">选择图片导入素材库</button>
    <table class="tbl" v-if="projectState.materials.length" style="margin-top: 12px">
      <thead>
        <tr>
          <th>文件名</th>
          <th style="width: 110px">类型</th>
          <th style="width: 180px">映射到（可选）</th>
          <th style="width: 90px"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in projectState.materials" :key="m.path">
          <td>{{ m.name }}</td>
          <td>
            <select :value="m.kind" @change="(e: any) => (m.kind = (e.target as HTMLSelectElement).value as any)" style="padding: 4px 8px; font-size: 12px">
              <option value="character">人物</option>
              <option value="item">物品</option>
              <option value="background">背景</option>
            </select>
          </td>
          <td>
            <input
              type="text"
              :value="m.extra?.mapTo ?? ''"
              style="padding: 4px 8px; font-size: 12px"
              placeholder="如 linche（角色/物品 id）"
              @change="
                (e: any) => {
                  if (!m.extra) m.extra = {};
                  m.extra.mapTo = (e.target as HTMLInputElement).value.trim() || undefined;
                }
              "
            />
          </td>
          <td>
            <button class="btn danger small" @click="removeMaterial(m.path)">移除</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="projectState.lastResult" style="color: var(--text-dim); font-size: 12px; margin-top: 8px">
      可映射的角色 id：{{ projectState.lastResult.cards.characters.map((c) => c.id).join("、") }} · 物品 id：{{ projectState.lastResult.cards.items.map((c) => c.id).join("、") }}
    </p>
  </div>
</template>
