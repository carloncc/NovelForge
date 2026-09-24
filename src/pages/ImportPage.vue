<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, addMaterial, removeMaterial, restoreProject } from "../stores/project";
import { upsertProject, removeProjectEntry, readDirNovelIdentity, decideNovelImport, suggestProjectSubdirName } from "../stores/projects";
import { configState, addRecentOutputDir, removeRecentOutputDir } from "../stores/config";
import { importNovelFile, importNovelFiles } from "../core/chapters";
import { tauri, isTauri, blessParentDir } from "../utils/tauri";
import { vfsWriteTextFile, vfsWriteFileBase64, vfsListDir, decodeNovelBytes, uniqueImportPath } from "../utils/vfsWeb";
import { DEMO_NOVEL } from "../core/demoNovel";
import type { MaterialAsset, NovelDoc } from "../core/types";
import { splitChapters } from "../core/chapters";
import { errMsg } from "../utils/errors";
import { fileToBase64 } from "../utils/file";
import { log } from "../utils/logger";
import { classifyMaterial } from "../utils/materials";
import { currentLang, t } from "../i18n";
import PageHead from "../components/PageHead.vue";
import LazyThumb from "../components/LazyThumb.vue";
import AssetPreview from "../components/AssetPreview.vue";
import { goPage } from "../stores/nav";
// 轻量运行状态：避免把 generate store（含管线核心）拉进主包
import { runIsBusy, runAssetLabel, runIsQueue } from "../stores/runStatus";

/** 运行中守卫：导入/加载示例/换项目会替换 novel 或输出目录，与运行中的管线并发会互相覆盖 */
function guardRunning(action: string): boolean {
  if (!runBusy.value) return true;
  error.value = t("已有生成任务在运行：{action}未执行，请等它完成（或先到生成页点「停止」）后再试", { action });
  return false;
}

/** 移除素材引用（只删引用关系，不删磁盘文件），二次确认防点错 */
function confirmRemoveMaterial(path: string, name: string): void {
  if (!guardRunning(t("移除素材"))) return;
  if (!window.confirm(t("从素材库移除「{name}」？只删除引用关系，磁盘文件保留。", { name }))) return;
  removeMaterial(path);
}

const error = ref("");
const importing = ref(false);
// 非错误提示（网页版编码识别结果等，成功导入后保留展示）
const notice = ref("");
// 素材大图预览（点击缩略图打开，复用现有 AssetPreview）
const previewMaterial = ref<MaterialAsset | null>(null);
const novelInput = ref<HTMLInputElement | null>(null);
const materialInput = ref<HTMLInputElement | null>(null);

const runBusy = computed(() => runIsBusy.value || !!runAssetLabel.value || runIsQueue.value);

/** UI15：用户可见数字按当前界面语言本地化；渲染时读取 currentLang，切语言后自动重渲染 */
function fmtNumber(n: number): string {
  return n.toLocaleString(currentLang.value);
}

onMounted(async () => {
  if (!projectState.outputDir) {
    projectState.outputDir = await tauri.getDefaultOutputDir();
  }
});

async function pickNovel(): Promise<void> {
  if (!guardRunning(t("导入小说"))) return;
  if (!isTauri()) {
    novelInput.value?.click();
    return;
  }
  error.value = "";
  importing.value = true;
  try {
    const picked = await open({
      multiple: true,
      filters: [{ name: t("文本文件"), extensions: ["txt", "TXT"] }],
    });
    if (!picked) return;
    const paths = (Array.isArray(picked) ? picked : [picked]).filter((p): p is string => typeof p === "string");
    if (!paths.length) return;
    // #1292：登记选中文件所在目录（用户经系统对话框明示授权），否则后续读取被白名单拒绝
    for (const p of paths) await blessParentDir(p);
    if (projectState.novel && !window.confirm(t("将覆盖当前已导入的「{name}」。继续吗？", { name: projectState.novel.fileName }))) return;
    const doc = paths.length > 1 ? await importNovelFiles(paths) : await importNovelFile(paths[0]);
    if (!(await guardNovelDir(doc))) return;
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
  if (!guardRunning(t("导入小说"))) return;
  if (projectState.novel && !window.confirm(t("将覆盖当前已导入的「{name}」。继续吗？", { name: projectState.novel.fileName }))) return;
  error.value = "";
  notice.value = "";
  importing.value = true;
  try {
    // #1138：VFS 以路径为键，同名文件会互相覆盖。预填本批已用 + 目录已有路径，去重追加 _2/_3…
    const used = new Set<string>();
    try {
      for (const e of await vfsListDir("/app/novel")) used.add(e.path);
    } catch {
      /* 目录尚不存在时视为空 */
    }
    const vPaths: string[] = [];
    const detected: string[] = [];
    for (const file of files) {
      // #1117：读 ArrayBuffer 后嗅探编码（UTF-8 非法时按 GBK/BIG5 解码），不用 file.text()
      const { text, encoding } = decodeNovelBytes(await file.arrayBuffer());
      detected.push(encoding);
      const vPath = uniqueImportPath(used, "/app/novel", file.name);
      await vfsWriteTextFile(vPath, text);
      vPaths.push(vPath);
    }
    const doc = vPaths.length > 1 ? await importNovelFiles(vPaths) : await importNovelFile(vPaths[0]);
    // 网页版 readTextFile 恒报 UTF-8：用嗅探到的真实编码覆盖展示
    doc.encoding = [...new Set(detected)].join("/");
    if (detected.some((e) => e !== "UTF-8")) {
      notice.value = t("检测到文件编码为 {encoding}，已自动转换", { encoding: doc.encoding });
    }
    if (!(await guardNovelDir(doc))) return;
    projectState.novel = doc;
    log.info("page", "导入小说成功", { fileCount: vPaths.length, chapters: doc.chapters.length, charCount: doc.fullText.length, encoding: doc.encoding });
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    importing.value = false;
  }
}

async function loadDemo(): Promise<void> {
  if (!guardRunning(t("加载示例"))) return;
  // #1415：与其它导入入口同口径——先清旧 error/notice，避免残留上一次失败提示；
  // guardNovelDir 内含 mkdirAll/restoreProject 可能抛错，必须 catch 写入 error（异步点击处理器裸 rejection 只进 console）。
  error.value = "";
  notice.value = "";
  if (projectState.novel && !window.confirm(t("加载示例小说将覆盖当前已导入的小说（标题修改/章节停用一并丢失）。继续吗？"))) return;
  const doc: NovelDoc = {
    fileName: "星陨之城的守夜人.txt",
    sourcePath: "",
    encoding: "UTF-8",
    fullText: DEMO_NOVEL,
    chapters: splitChapters(DEMO_NOVEL, "星陨之城的守夜人"),
  };
  try {
    if (!(await guardNovelDir(doc))) return;
    projectState.novel = doc;
    log.info("page", "加载示例小说", { chapters: doc.chapters.length, charCount: doc.fullText.length });
  } catch (e) {
    log.error("page", "加载示例小说失败", { error: errMsg(e) });
    error.value = t("加载示例失败：{error}", { error: errMsg(e) });
  }
}

async function pickMaterials(): Promise<void> {
  if (!guardRunning(t("导入素材"))) return;
  if (!isTauri()) {
    materialInput.value?.click();
    return;
  }
  const paths = await open({
    multiple: true,
    filters: [{ name: t("图片"), extensions: ["png", "jpg", "jpeg", "webp"] }],
  });
  if (!paths) return;
  // #1292：登记选中文件所在目录（同导入小说）
  for (const p of Array.isArray(paths) ? paths : [paths]) {
    if (typeof p === "string") await blessParentDir(p);
  }
  importing.value = true;
  try {
    for (const p of Array.isArray(paths) ? paths : [paths]) {
      await addMaterialAsset(p);
    }
  } finally {
    importing.value = false;
  }
}

async function onMaterialFiles(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const files = input.files ? [...input.files] : [];
  input.value = "";
  if (!files.length) return;
  if (!guardRunning(t("导入素材"))) return;
  error.value = "";
  importing.value = true;
  try {
    for (const file of files) {
      const b64 = await fileToBase64(file, t("文件读取失败"));
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

/** 素材自动分类见 src/utils/materials.ts（纯函数，#1288/#1367）：
 *  <script setup> 内不允许 export，函数体必须在外部模块，页面只 import。 */

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
    error.value = t("导入素材失败「{name}」：{error}", { name, error: (err as Error).message });
  }
}

function updateChapterTitle(i: number, title: string, e?: Event): void {
  // #1366：运行中改章名会改掉项目身份 titleSig 与快照指纹，与章节启停守卫保持一致
  if (!guardRunning(t("修改章节标题"))) {
    const input = e?.target as HTMLInputElement | undefined;
    if (input) input.value = projectState.novel?.chapters[i].title ?? input.value;
    return;
  }
  if (projectState.novel) {
    projectState.novel.chapters[i].title = title;
  }
}

/** 素材类型/映射在运行中同样与管线读素材并发：统一走守卫并回滚 DOM */
function onMaterialKindChange(m: MaterialAsset, e: Event): void {
  const sel = e.target as HTMLSelectElement;
  if (!guardRunning(t("修改素材类型"))) {
    sel.value = m.kind;
    return;
  }
  m.kind = sel.value as MaterialAsset["kind"];
}

function onMaterialMapToChange(m: MaterialAsset, e: Event): void {
  const input = e.target as HTMLInputElement;
  if (!guardRunning(t("修改素材映射"))) {
    input.value = m.extra?.mapTo ?? "";
    return;
  }
  if (!m.extra) m.extra = {};
  m.extra.mapTo = input.value.trim() || undefined;
}

function toggleChapter(i: number, e?: Event): void {
  // 守卫拦截时数据不变，必须把 DOM 勾选状态回滚，否则复选框视觉与实际数据不一致
  if (!guardRunning(t("章节启停"))) {
    const input = e?.target as HTMLInputElement | undefined;
    if (input) input.checked = projectState.novel?.chapters[i].enabled !== false;
    return;
  }
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
  if (!guardRunning(t("打开项目"))) return;
  try {
    await restoreProject(dir);
    configState.outputDir = dir;
    addRecentOutputDir(dir);
    upsertProject(dir);
  } catch (e) {
    error.value = t("打开项目失败（目录可能已被删除或损坏）：{error}", { error: errMsg(e) });
  }
}

function removeProject(id: string): void {
  const target = (configState.projects ?? []).find((p) => p.id === id);
  if (!window.confirm(t("将「{name}」从项目列表移除？只删记录，磁盘文件保留。", { name: target?.name ?? id }))) return;
  removeProjectEntry(id);
}

/** 最近目录的「移除记录」此前没有确认，与注册项目的同名按钮行为不一致 */
function removeRecent(dir: string): void {
  if (!window.confirm(t("将从最近列表移除「{dir}」？只删记录，磁盘文件保留。", { dir }))) return;
  removeRecentOutputDir(dir);
}

async function newProject(): Promise<void> {
  error.value = "";
  if (!isTauri()) {
    error.value = t("Web 版输出目录固定，暂不支持新建项目目录");
    return;
  }
  if (!guardRunning(t("新建项目"))) return;
  const picked = await open({ directory: true, multiple: false });
  if (!picked || typeof picked !== "string") return;
  // #1414：先登记用户自选目录再读快照，否则白名单外路径恒返回 null，「已有项目缓存」确认守卫静默失效
  await blessParentDir(picked);
  const snap = await readDirNovelIdentity(picked);
  if (snap && !window.confirm(t("该目录已有「{name}」的项目缓存。点「确定」打开它，点「取消」换个目录。", { name: snap.fileName }))) return;
  try {
    await restoreProject(picked);
    configState.outputDir = picked;
    addRecentOutputDir(picked);
    upsertProject(picked);
  } catch (e) {
    error.value = t("打开项目失败：{error}", { error: errMsg(e) });
  }
}

/** 导入保护：新小说与当前目录快照不是同一本时，建议独立目录防串味。
 *  确定=自动建「小说名」子目录并切换；取消=留在当前目录（会覆盖旧缓存）。
 *  #1118：网页版同样执行（VFS 快照 + VFS 建目录），默认 /app/exports 下每本书一个子目录。 */
async function guardNovelDir(doc: { fileName: string; chapters: { title: string }[] }): Promise<boolean> {
  const dir = projectState.outputDir;
  if (!dir) return true;
  const snap = await readDirNovelIdentity(dir);
  const decision = decideNovelImport(snap, { fileName: doc.fileName, titleSig: doc.chapters.map((c) => c.title).join("|") });
  if (decision !== "different") return true;
  // #1364：decideNovelImport 已改为同文件名即判 same（titleSig 含 AI 分章后标题，同书重导必然不一致）。
  // 这里保留同名覆盖确认作双保险（换文件重名的极端情况），不再建子目录。
  if (snap && snap.fileName === doc.fileName) {
    return window.confirm(
      t("重新导入「{name}」将覆盖当前分章/改名结果（含 AI 分章标题与章节启停）。\n\n点「确定」继续覆盖，点「取消」中止导入。", { name: doc.fileName }),
    );
  }
  if (!window.confirm(
    t("当前输出目录属于「{oldName}」的项目，继续导入会覆盖它的缓存。\n\n点「确定」为「{newName}」新建独立项目目录，点「取消」留在当前目录（覆盖旧缓存）。", { oldName: snap?.fileName ?? "", newName: doc.fileName }),
  )) return true;
  const target = `${dir.replace(/[\\/]+$/, "")}/${suggestProjectSubdirName(doc.fileName)}`;
  await tauri.mkdirAll(target);
  await restoreProject(target);
  configState.outputDir = target;
  addRecentOutputDir(target);
  upsertProject(target, { fileName: doc.fileName, title: doc.chapters[0]?.title ?? "" });
  return true;
}
</script>

<template>
  <div class="inner">
    <PageHead :title="t('导入小说')" :sub="t('选择 txt 小说文件（可多选，自动合并；单文件按标题规则初切，多文件合并为单章，生成时由 AI 重新分章）；可导入自定义素材（AI 优先使用）')">
      <button class="btn secondary" @click="loadDemo">{{ t("加载示例") }}</button>
      <button class="btn" :disabled="importing" @click="pickNovel">
        <span v-if="importing" class="spinner" />
        {{ importing ? t("读取中…") : t("选择小说 txt（可多选）") }}
      </button>
      <input v-if="!isTauri()" ref="novelInput" type="file" accept=".txt,text/plain" multiple style="display: none" @change="onNovelFile" />
    </PageHead>

    <p v-if="error" class="err-text mt-2">{{ error }}</p>
    <p v-if="notice" class="hint mt-2">{{ notice }}</p>

    <div class="card">
      <div class="card-head">
        <h3>{{ t("小说文件") }}</h3>
        <div class="card-actions">
          <button v-if="projectState.novel" class="btn secondary small" @click="pickNovel">{{ t("重新导入") }}</button>
          <button v-if="projectState.novel" class="btn small" @click="goPage('generate')">{{ t("去生成项目") }}</button>
        </div>
      </div>
      <p v-if="projectState.novel" class="muted">
        {{ projectState.novel.fileName }} · {{ t("编码") }} {{ projectState.novel.encoding }} · {{ t("共") }}
        {{ fmtNumber(projectState.novel.fullText.length) }} {{ t("字") }}
      </p>
      <p v-else class="faint">{{ t("尚未导入小说") }}</p>
    </div>

    <div class="card" v-if="projectState.novel">
      <div class="card-head">
        <h3>{{ t("章节（单文件按标题规则初切，多文件合并为单章；生成时由 AI 重新分章，可在生成页查看/勾选重跑）") }}</h3>
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
                <input type="checkbox" :checked="ch.enabled !== false" @change="(e: any) => toggleChapter(i, e)" />
              </td>
              <td>
                <input
                  type="text"
                  :value="ch.title"
                  class="title-input"
                  @change="(e: any) => updateChapterTitle(i, (e.target as HTMLInputElement).value, e)"
                />
              </td>
              <td>{{ fmtNumber(ch.charCount) }}</td>
              <td>{{ fmtNumber(ch.text.split(/\n{2,}/).length) }}</td>
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
        {{ t("人物参考图 / 物品图 / 背景图。文件名含「人/角色/char/figure/hero」归人物、「物/item/道具/剑/sword/weapon/jade」归物品、其余归背景（英文大小写不限）。") }}
        {{ t("管线优先使用你的素材，缺失才由 AI 生成；可在下方手动改类型与映射。") }}
      </p>
      <div v-if="projectState.materials.length" class="mat-grid">
        <div v-for="m in projectState.materials" :key="m.path" class="mat-card">
          <div class="mat-head">
            <span class="mat-name" :title="m.name">{{ m.name }}</span>
            <button class="btn danger small" @click="confirmRemoveMaterial(m.path, m.name)">{{ t("移除") }}</button>
          </div>
          <div class="mat-thumb" :title="m.name" @click="previewMaterial = m">
            <LazyThumb :path="m.path" :alt="m.name" />
          </div>
          <div class="mat-row">
            <select :value="m.kind" @change="(e: any) => onMaterialKindChange(m, e)" style="flex: 1">
              <option value="character">{{ t("人物") }}</option>
              <option value="item">{{ t("物品") }}</option>
              <option value="background">{{ t("背景") }}</option>
            </select>
            <input
              type="text"
              :value="m.extra?.mapTo ?? ''"
              style="flex: 1.4"
              :placeholder="t('映射到（角色/物品 id）')"
              @change="(e: any) => onMaterialMapToChange(m, e)"
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
          <span class="grow small text-ellipsis" @click="openProject(row.dir)" :title="row.dir">
            <span style="font-weight: 600; color: var(--primary)">{{ row.name }}</span>
            <span v-if="row.novelFileName" class="faint ml-2">{{ row.novelFileName }}</span>
            <span class="faint ml-2">{{ row.dir }}</span>
            <span v-if="row.dir === projectState.outputDir" class="tag ok ml-2">{{ t("当前") }}</span>
          </span>
          <button class="btn secondary small" @click="openProject(row.dir)">{{ t("打开") }}</button>
          <button v-if="row.id" class="btn ghost small" :title="t('只从列表移除记录，不删除磁盘文件')" @click="removeProject(row.id)">{{ t("移除记录") }}</button>
          <button v-else class="btn ghost small" :title="t('只从列表移除记录，不删除磁盘文件')" @click="removeRecent(row.dir)">{{ t("移除记录") }}</button>
        </div>
      </div>
      <p v-else class="faint small">{{ t("暂无项目：导入小说后点生成即自动建档，或点右上新建项目") }}</p>
    </div>

    <AssetPreview
      v-if="previewMaterial"
      :path="previewMaterial.path"
      :label="previewMaterial.name"
      @close="previewMaterial = null"
    />
  </div>
</template>

<style scoped>
/* 素材缩略图容器：LazyThumb 自带 120px 高度与失败占位，这里只负责卡片内的观感 */
.mat-thumb {
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-card);
  cursor: zoom-in;
}
</style>
