<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, addMaterial, removeMaterial, restoreProject } from "../stores/project";
import { upsertProject, removeProjectEntry, readDirNovelIdentity, decideNovelImport, suggestProjectSubdirName } from "../stores/projects";
import { configState, addRecentOutputDir, removeRecentOutputDir } from "../stores/config";
import { importNovelFile, importNovelFiles } from "../core/chapters";
import { tauri, isTauri } from "../utils/tauri";
import { vfsWriteTextFile, vfsWriteFileBase64 } from "../utils/vfsWeb";
import { DEMO_NOVEL } from "../core/demoNovel";
import type { MaterialAsset, NovelDoc } from "../core/types";
import { splitChapters } from "../core/chapters";
import { errMsg } from "../utils/errors";
import { log } from "../utils/logger";
import { t } from "../i18n";
import PageHead from "../components/PageHead.vue";

/** 移除素材引用（只删引用关系，不删磁盘文件），二次确认防点错 */
function confirmRemoveMaterial(path: string, name: string): void {
  if (!window.confirm(`从素材库移除「${name}」？只删除引用关系，磁盘文件保留。`)) return;
  removeMaterial(path);
}

const error = ref("");
const importing = ref(false);
const novelInput = ref<HTMLInputElement | null>(null);
const materialInput = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  if (!projectState.outputDir) {
    projectState.outputDir = await tauri.getDefaultOutputDir();
  }
});

async function pickNovel(): Promise<void> {
  if (!isTauri()) {
    novelInput.value?.click();
    return;
  }
  error.value = "";
  importing.value = true;
  try {
    const picked = await open({
      multiple: true,
      filters: [{ name: "文本文件", extensions: ["txt", "TXT"] }],
    });
    if (!picked) return;
    const paths = (Array.isArray(picked) ? picked : [picked]).filter((p): p is string => typeof p === "string");
    if (!paths.length) return;
    if (projectState.novel && !window.confirm(`将覆盖当前已导入的「${projectState.novel.fileName}」。继续吗？`)) return;
    const doc = paths.length > 1 ? await importNovelFiles(paths) : await importNovelFile(paths[0]);
    await guardNovelDir(doc);
    projectState.novel = doc;
    log.info("page", "导入小说成功", { fileCount: paths.length, chapters: doc.chapters.length, charCount: doc.fullText.length });
  } catch (e) {
    log.error("page", "导入小说失败", { error: errMsg(e) });
    error.value = errMsg(e);
  } finally {
    importing.value = false;
  }
}

async function onNovelFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = input.files ? [...input.files] : [];
  input.value = "";
  if (!files.length) return;
  if (projectState.novel && !window.confirm(`将覆盖当前已导入的「${projectState.novel.fileName}」。继续吗？`)) return;
  error.value = "";
  importing.value = true;
  try {
    const vPaths: string[] = [];
    for (const file of files) {
      const text = await file.text();
      const vPath = `/app/novel/${file.name}`;
      await vfsWriteTextFile(vPath, text);
      vPaths.push(vPath);
    }
    projectState.novel = vPaths.length > 1 ? await importNovelFiles(vPaths) : await importNovelFile(vPaths[0]);
    await guardNovelDir(projectState.novel);
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    importing.value = false;
  }
}

async function loadDemo(): Promise<void> {
  if (projectState.novel && !window.confirm("加载示例小说将覆盖当前已导入的小说（标题修改/章节停用一并丢失）。继续吗？")) return;
  const doc: NovelDoc = {
    fileName: "星陨之城的守夜人.txt",
    sourcePath: "",
    encoding: "UTF-8",
    fullText: DEMO_NOVEL,
    chapters: splitChapters(DEMO_NOVEL, "星陨之城的守夜人"),
  };
  await guardNovelDir(doc);
  projectState.novel = doc;
  log.info("page", "加载示例小说", { chapters: doc.chapters.length, charCount: doc.fullText.length });
}

async function pickMaterials(): Promise<void> {
  if (!isTauri()) {
    materialInput.value?.click();
    return;
  }
  const paths = await open({
    multiple: true,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (!paths) return;
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    await addMaterialAsset(p);
  }
}

async function onMaterialFiles(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = input.files ? [...input.files] : [];
  input.value = "";
  if (!files.length) return;
  error.value = "";
  importing.value = true;
  try {
    for (const file of files) {
      const b64 = await fileToBase64(file);
      const vPath = `/app/materials/${file.name}`;
      await vfsWriteFileBase64(vPath, b64);
      addMaterial({
        name: file.name,
        path: vPath,
        kind: classifyMaterial(file.name),
        mime: file.type || "image/png",
      });
    }
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    importing.value = false;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error(t("文件读取失败")));
    reader.readAsDataURL(file);
  });
}

function classifyMaterial(name: string): MaterialAsset["kind"] {
  if (/人|角色|char|figure|hero/.test(name)) return "character";
  if (/物|item|道具|sword|weapon|jade/.test(name)) return "item";
  return "background";
}

/** 本地素材 mime 判定：与 Web 路径的 file.type 对齐（之前 webp 会被错标成 png） */
function materialMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

async function addMaterialAsset(p: string): Promise<void> {
  const name = p.split(/[\\/]/).pop() || "asset";
  try {
    addMaterial({
      name,
      path: p,
      kind: classifyMaterial(name),
      mime: materialMime(name),
    });
  } catch (err) {
    error.value = `导入素材失败「${name}」：${(err as Error).message}`;
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

// 项目（小说×输出目录）：注册表＋最近目录合并展示
const projectRows = computed(() => {
  const entries = configState.projects ?? [];
  const rows = entries.map((p) => ({ key: p.id, id: p.id, name: p.name, novelFileName: p.novelFileName, dir: p.outputDir }));
  const known = new Set(entries.map((p) => p.outputDir));
  for (const dir of configState.recentOutputDirs ?? []) {
    if (!known.has(dir)) {
      rows.push({ key: `recent:${dir}`, id: "", name: dir.split(/[\\/]/).filter(Boolean).pop() || dir, novelFileName: "", dir });
    }
  }
  return rows;
});

async function openProject(dir: string): Promise<void> {
  error.value = "";
  if (projectState.running) {
    error.value = t("有任务正在生成中，请等待完成或中止后再切换项目");
    return;
  }
  try {
    await restoreProject(dir);
    configState.outputDir = dir;
    addRecentOutputDir(dir);
    upsertProject(dir);
  } catch (e) {
    error.value = `打开项目失败（目录可能已被删除或损坏）：${errMsg(e)}`;
  }
}

function removeProject(id: string): void {
  const target = (configState.projects ?? []).find((p) => p.id === id);
  if (!window.confirm(`将「${target?.name ?? id}」从项目列表移除？只删记录，磁盘文件保留。`)) return;
  removeProjectEntry(id);
}

async function newProject(): Promise<void> {
  error.value = "";
  if (!isTauri()) {
    error.value = t("Web 版输出目录固定，暂不支持新建项目目录");
    return;
  }
  if (projectState.running) {
    error.value = t("有任务正在生成中，请等待完成或中止后再切换项目");
    return;
  }
  const picked = await open({ directory: true, multiple: false });
  if (!picked || typeof picked !== "string") return;
  const snap = await readDirNovelIdentity(picked);
  if (snap && !window.confirm(`该目录已有「${snap.fileName}」的项目缓存。点「确定」打开它，点「取消」换个目录。`)) return;
  try {
    await restoreProject(picked);
    configState.outputDir = picked;
    addRecentOutputDir(picked);
    upsertProject(picked);
  } catch (e) {
    error.value = `打开项目失败：${errMsg(e)}`;
  }
}

/** 导入保护：新小说与当前目录快照不是同一本时，建议独立目录防串味。
 * 确定=自动建「小说名」子目录并切换；取消=留在当前目录（会覆盖旧缓存）。 */
async function guardNovelDir(doc: { fileName: string; chapters: { title: string }[] }): Promise<void> {
  const dir = projectState.outputDir;
  if (!dir || !isTauri()) return;
  const snap = await readDirNovelIdentity(dir);
  const decision = decideNovelImport(snap, { fileName: doc.fileName, titleSig: doc.chapters.map((c) => c.title).join("|") });
  if (decision !== "different") return;
  if (!window.confirm(
    `当前输出目录属于「${snap?.fileName}」的项目，继续导入会覆盖它的缓存。\n\n点「确定」为「${doc.fileName}」新建独立项目目录，点「取消」留在当前目录（覆盖旧缓存）。`,
  )) return;
  const target = `${dir.replace(/[\\/]+$/, "")}/${suggestProjectSubdirName(doc.fileName)}`;
  await tauri.mkdirAll(target);
  await restoreProject(target);
  configState.outputDir = target;
  addRecentOutputDir(target);
  upsertProject(target, { fileName: doc.fileName, title: doc.chapters[0]?.title ?? "" });
}
</script>

<template>
  <div class="inner">
    <PageHead :title="t('导入小说')" :sub="t('选择 txt 小说文件（可多选，自动合并；导入时不分章，生成时由 AI 分章）；可导入自定义素材（AI 优先使用）')">
      <button class="btn secondary" @click="loadDemo">{{ t("加载示例") }}</button>
      <button class="btn" :disabled="importing" @click="pickNovel">
        <span v-if="importing" class="spinner" />
        {{ importing ? t("读取中…") : t("选择小说 txt（可多选）") }}
      </button>
      <input v-if="!isTauri()" ref="novelInput" type="file" accept=".txt,text/plain" multiple style="display: none" @change="onNovelFile" />
    </PageHead>

    <div class="card">
      <div class="card-head">
        <h3>{{ t("小说文件") }}</h3>
        <div class="card-actions">
          <button v-if="projectState.novel" class="btn secondary small" @click="pickNovel">{{ t("重新导入") }}</button>
        </div>
      </div>
      <p v-if="error" class="err-text mt-2">{{ error }}</p>
      <p v-if="projectState.novel" class="muted">
        {{ projectState.novel.fileName }} · {{ t("编码") }} {{ projectState.novel.encoding }} · {{ t("共") }}
        {{ projectState.novel.fullText.length.toLocaleString() }} {{ t("字") }}
      </p>
      <p v-else class="faint">{{ t("尚未导入小说") }}</p>
    </div>

    <div class="card" v-if="projectState.novel">
      <div class="card-head">
        <h3>{{ t("章节（导入时不切章；生成时由 AI 分章，可在生成页查看/勾选重跑）") }}</h3>
      </div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width: 50px">{{ t("启用") }}</th>
              <th>{{ t("标题") }}</th>
              <th style="width: 90px">{{ t("字数") }}</th>
              <th style="width: 90px">{{ t("段落数") }}</th>
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
                  class="title-input"
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
        <h3>{{ t("自定义素材库（可选）") }}</h3>
        <div class="card-actions">
          <button class="btn secondary small" @click="pickMaterials">{{ t("＋ 导入图片素材") }}</button>
          <input v-if="!isTauri()" ref="materialInput" type="file" accept="image/*" multiple style="display: none" @change="onMaterialFiles" />
        </div>
      </div>
      <p class="hint mb-4">
        {{ t("人物参考图 / 物品图 / 背景图。文件名含「人/角色/char」归人物、「物/item/剑」归物品、其余归背景。") }}
        {{ t("管线优先使用你的素材，缺失才由 AI 生成；可在下方手动改类型与映射。") }}
      </p>
      <div v-if="projectState.materials.length" class="mat-grid">
        <div v-for="m in projectState.materials" :key="m.path" class="mat-card">
          <div class="mat-head">
            <span class="mat-name">{{ m.name }}</span>
            <button class="btn danger small" @click="confirmRemoveMaterial(m.path, m.name)">{{ t("移除") }}</button>
          </div>
          <div class="mat-row">
            <select :value="m.kind" @change="(e: any) => (m.kind = (e.target as HTMLSelectElement).value as any)" style="flex: 1">
              <option value="character">{{ t("人物") }}</option>
              <option value="item">{{ t("物品") }}</option>
              <option value="background">{{ t("背景") }}</option>
            </select>
            <input
              type="text"
              :value="m.extra?.mapTo ?? ''"
              style="flex: 1.4"
              :placeholder="t('映射到（角色/物品 id）')"
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
      <p v-else class="faint small">{{ t("暂无素材") }}</p>
      <p v-if="projectState.lastResult" class="hint mt-3">
        {{ t("可映射 id：角色") }} {{ projectState.lastResult.cards.characters.map((c) => c.id).join("、") }} · {{ t("物品") }} {{ projectState.lastResult.cards.items.map((c) => c.id).join("、") }}
      </p>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>{{ t("项目（小说×输出目录）") }}</h3>
        <div class="card-actions">
          <button class="btn secondary small" @click="newProject">{{ t("新建项目…") }}</button>
        </div>
      </div>
      <p class="hint">{{ t("每个项目独立输出目录：切换项目自动换目录和全部状态；导入不同小说会提示分目录，避免缓存串味。") }}</p>
      <div class="flex-col gap-2" v-if="projectRows.length">
        <div v-for="row in projectRows" :key="row.key" class="recent-item">
          <span class="grow small text-ellipsis" @click="openProject(row.dir)">
            <span style="font-weight: 600; color: var(--primary)">{{ row.name }}</span>
            <span v-if="row.novelFileName" class="faint ml-2">{{ row.novelFileName }}</span>
            <span class="faint ml-2">{{ row.dir }}</span>
            <span v-if="row.dir === projectState.outputDir" class="tag ok ml-2">{{ t("当前") }}</span>
          </span>
          <button class="btn secondary small" @click="openProject(row.dir)">{{ t("打开") }}</button>
          <button v-if="row.id" class="btn ghost small" :title="t('只从列表移除记录，不删除磁盘文件')" @click="removeProject(row.id)">{{ t("移除记录") }}</button>
          <button v-else class="btn ghost small" :title="t('只从列表移除记录，不删除磁盘文件')" @click="removeRecentOutputDir(row.dir)">{{ t("移除记录") }}</button>
        </div>
      </div>
      <p v-else class="faint small">{{ t("暂无项目：导入小说后点生成即自动建档，或点右上新建项目") }}</p>
    </div>
  </div>
</template>
