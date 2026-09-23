<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { save, open } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog, scheduleSave, exportSettings, setExportUiLanguage, loadExportUiLanguage } from "../stores/project";
import { tauri, isTauri, downloadZipWeb, isPathInsideDir, blessParentDir } from "../utils/tauri";
import { lintProject, buildExportOverridePrompt, type LintReport } from "../core/lint";
import { errMsg } from "../utils/errors";
import { log } from "../utils/logger";
import { t } from "../i18n";
import { useGenerateController } from "../stores/generate";
import PageHead from "../components/PageHead.vue";
import { goPage } from "../stores/nav";
import type { ExportSettings } from "../core/types";

const message = ref("");
// 通知成败分色：此前成功/失败/进行中统一渲染成绿色，失败信息看起来也像成功
const messageOk = ref(true);
// #1348：消息清除 timer id（不清旧 timer 会提前抹掉后一条消息）
let msgTimer: ReturnType<typeof setTimeout> | null = null;
const linting = ref(false);
const packing = ref(false);
const lintReport = ref<LintReport | null>(null);
// UI78：自动检查失败时必须区别于「从未检查」空态，显示红色失败信息
const lintError = ref("");
const settings = ref<ExportSettings>({
  title: "",
  gameKey: "",
  language: "zh_CN",
});

// 从项目选项/最近结果初始化导出设置（含界面语言）。
// #1320/#1346：settingsInitial 记录回填快照；settingsDirty 为 true 时 watch 不再整体覆盖正在编辑的内容。
// 界面语言已与翻译目标彻底解耦：下拉绑定独立的 exportSettings.uiLanguage，保存写入
// options.uiLanguage（组装 Default_Language 用它），永不触碰 options.language（翻译开关，空=不翻译）。
const settingsInitial = ref({ title: "", gameKey: "", language: "zh_CN" as ExportSettings["language"] });
const settingsDirty = ref(false);
function markSettingsDirty(): void {
  settingsDirty.value = true;
}
function initSettings(): void {
  if (settingsDirty.value) return;
  const meta = projectState.lastResult?.meta;
  const o = projectState.options;
  loadExportUiLanguage();
  // 界面语言：独立字段（localStorage 按项目存，缺省从旧 options 迁移，保证老项目行为不变）
  const uiLang = exportSettings.uiLanguage;
  settingsInitial.value = {
    title: o.exportTitle ?? meta?.title ?? "",
    gameKey: o.exportGameKey ?? meta?.gameKey ?? "",
    language: uiLang,
  };
  settings.value = { ...settingsInitial.value };
}
watch(() => projectState.lastResult?.meta.generatedAt, initSettings, { immediate: true });

const outputDir = computed(() => projectState.lastResult?.meta.outputDir ?? projectState.outputDir);

const { busy: pipelineBusy, assetBusy: genAssetBusy, queueRunning: genQueueRunning, execute } = useGenerateController();
/** 生成/素材任务运行中禁止打包与写配置：会把写到一半的文件打进包里 */
const runBusy = computed(() => pipelineBusy.value || !!genAssetBusy.value || genQueueRunning.value);

function setMsg(m: string, ok = true): void {
  // #1348：连续调用时旧 timer 会提前抹掉新消息（成败反馈 0.x 秒消失）：先清旧 timer
  if (msgTimer !== null) clearTimeout(msgTimer);
  message.value = m;
  messageOk.value = ok;
  msgTimer = setTimeout(() => {
    msgTimer = null;
    message.value = "";
  }, 4000);
}

async function openFolder(): Promise<void> {
  if (!outputDir.value) return;
  if (!isTauri()) {
    setMsg(t("网页版无法打开本地文件夹：请用上方「复制路径」手动打开"), false);
    return;
  }
  try {
    await tauri.openInExplorer(outputDir.value);
  } catch (e) {
    setMsg(t("打开文件夹失败：{error}", { error: errMsg(e) }), false);
  }
}

async function copyPath(): Promise<void> {
  if (!outputDir.value) return;
  try {
    await navigator.clipboard.writeText(outputDir.value);
    setMsg(t("路径已复制到剪贴板"));
  } catch {
    setMsg(t("复制失败（浏览器可能限制了剪贴板权限）：请手动复制上方路径"), false);
  }
}

/** 导出检查：可等待（并发时复用同一 Promise，避免自动检查在途时打包拿到空报告放行） */
let lintInFlight: Promise<LintReport | null> | null = null;

async function runLintNow(): Promise<LintReport | null> {
  if (lintInFlight) return lintInFlight;
  linting.value = true;
  lintError.value = "";
  lintInFlight = (async () => {
    try {
      if (!outputDir.value) return null;
      const report = await lintProject(outputDir.value);
      lintReport.value = report;
      log.info("page", "项目检查完成", {
        dir: outputDir.value,
        errors: report.errors.length,
        warnings: report.warnings.length,
      });
      return report;
    } catch (e) {
      log.error("page", "项目检查失败", { error: errMsg(e) });
      lintReport.value = null;
      lintError.value = errMsg(e);
      return null;
    } finally {
      linting.value = false;
      lintInFlight = null;
    }
  })();
  return lintInFlight;
}

/** 手动「运行检查」入口（保持原按钮） */
async function runLint(): Promise<void> {
  const report = await runLintNow();
  if (!report) setMsg(t("检查失败：请查看日志"), false);
}

// ---- 标题画面（封面/Logo/标题曲/菜单开关/主题取色）：保存到项目选项并重新组装（组装免费、不调用任何 API） ----
const titleForm = ref({
  coverMode: "auto" as "auto" | "none" | "custom",
  coverPath: "",
  logoMode: "auto" as "auto" | "none" | "custom",
  logoPath: "",
  bgmFile: "",
  enableContinue: true,
  enableFlowchart: true,
  enableAppreciation: true,
  themeFromArtwork: true,
});
const bgmOptions = ref<string[]>([]);
// #1346：标题表单脏标志（任一控件改动即置位；保存成功或切换项目时清除）
const titleDirty = ref(false);
function markTitleDirty(): void {
  titleDirty.value = true;
}

const fileNameOf = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;

function initTitleForm(): void {
  // #1346：与 initSettings 同策略——有未保存改动时不整体覆盖（输出目录切换除外，见 outputDir watch）
  if (titleDirty.value) return;
  const o = projectState.options;
  titleForm.value = {
    coverMode: o.titleCoverMode ?? "auto",
    coverPath: o.titleCoverPath ?? "",
    logoMode: o.titleLogoMode ?? "auto",
    logoPath: o.titleLogoPath ?? "",
    bgmFile: o.titleBgmFile ?? "",
    enableContinue: o.titleEnableContinue !== false,
    enableFlowchart: o.titleEnableFlowchart !== false,
    enableAppreciation: o.titleEnableAppreciation !== false,
    themeFromArtwork: o.themeFromArtwork !== false,
  };
}

async function loadBgmOptions(): Promise<void> {
  const dir = outputDir.value;
  if (!dir) {
    bgmOptions.value = [];
    return;
  }
  try {
    const entries = await tauri.listDir(`${dir}/game/bgm`);
    bgmOptions.value = entries
      .filter((e) => !e.isDir && /\.(mp3|ogg|wav|m4a|opus)$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    bgmOptions.value = [];
  }
}

watch(
  outputDir,
  (dir) => {
    // 切项目时旧表单属于旧项目：清除脏标志后回填（页内 generatedAt 更新则不覆盖，见 initSettings/initTitleForm）
    settingsDirty.value = false;
    titleDirty.value = false;
    initSettings();
    initTitleForm();
    void loadBgmOptions();
    // 打开导出页自动检查一次（打包前还会再新鲜检查一次）
    if (dir && projectState.lastResult) void runLintNow();
  },
  { immediate: true },
);

async function pickTitleFile(kind: "cover" | "logo"): Promise<void> {
  if (!isTauri()) {
    setMsg(t("网页版无法浏览本地文件：请把图片放进项目文件夹后在桌面版选择"), false);
    return;
  }
  try {
    const picked = await open({
      multiple: false,
      filters: [{ name: t("图片"), extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    const p = Array.isArray(picked) ? picked[0] : picked;
    if (!p) return;
    if (kind === "cover") {
      titleForm.value.coverPath = p;
      titleForm.value.coverMode = "custom";
    } else {
      titleForm.value.logoPath = p;
      titleForm.value.logoMode = "custom";
    }
  } catch (e) {
    setMsg(t("选择图片失败：{error}", { error: errMsg(e) }), false);
  }
}

/**
 * 唯一的保存入口：导出设置（标题/GameKey/语言）+ 标题画面设置一次写入并本地重新组装。
 * 之前「应用设置」与「保存并重新组装」两个按钮语义重叠且会互相覆盖，这里合并为一个动作。
 */
async function saveAndAssemble(): Promise<void> {
  if (!projectState.lastResult) {
    setMsg(t("还没有生成结果：请先在「生成项目」页生成并组装后再应用设置"), false);
    return;
  }
  if (runBusy.value) {
    setMsg(t("生成任务正在运行：请等它完成后再保存，避免把配置写进正在写入的目录"), false);
    return;
  }
  const key = settings.value.gameKey.trim();
  if (!/^[a-zA-Z0-9]{6,10}$/.test(key)) {
    setMsg(t("Game_key 需 6-10 位字母数字"), false);
    return;
  }
  const title = settings.value.title.trim();
  if (!title) {
    setMsg(t("游戏标题不能为空"), false);
    return;
  }
  const f = titleForm.value;
  if (f.coverMode === "custom" && !f.coverPath) {
    setMsg(t("已选「自定义封面」但还没有选择图片（将暂时回退到第一章 CG）"), false);
  }
  // #1347：标题曲下拉是快照——保存前刷新，选中值已不存在则回退自动匹配并明示（此前静默写死文件名，删文件后标题静音）
  await loadBgmOptions();
  if (f.bgmFile && f.bgmFile !== "none" && !bgmOptions.value.includes(f.bgmFile)) {
    setMsg(t("所选标题曲「{file}」已不存在（被删除或移动），已回退为自动匹配", { file: f.bgmFile }), false);
    f.bgmFile = "";
  }
  const o = projectState.options;
  o.exportTitle = title;
  o.exportGameKey = key;
  // #1320：界面语言只写独立字段（组装 Default_Language 用它）；翻译目标 options.language 碰都不碰，
  // 空=不翻译语义永不被导出保存破坏。
  o.uiLanguage = setExportUiLanguage(settings.value.language);
  o.titleCoverMode = f.coverMode;
  o.titleLogoMode = f.logoMode;
  o.titleBgmFile = f.bgmFile.trim();
  o.titleEnableContinue = f.enableContinue;
  o.titleEnableFlowchart = f.enableFlowchart;
  o.titleEnableAppreciation = f.enableAppreciation;
  o.themeFromArtwork = f.themeFromArtwork;
  if (f.coverPath) o.titleCoverPath = f.coverPath; else delete o.titleCoverPath;
  if (f.logoPath) o.titleLogoPath = f.logoPath; else delete o.titleLogoPath;
  scheduleSave();
  setMsg(t("正在重新组装标题画面…"));
  const ok = await execute({ stages: ["assemble"] });
  if (ok) {
    // #1346：保存成功后快照与脏标志同步，避免后续 generatedAt 更新把刚保存的值又覆盖一遍
    settingsInitial.value = { ...settings.value };
    settingsDirty.value = false;
    titleDirty.value = false;
    setMsg(t("已保存并重新组装：可点「预览」查看效果"));
    pushLog({ step: "导出", message: t("导出设置与标题画面已保存并重新组装（标题/GameKey/封面/Logo/标题曲/菜单开关/主题取色）"), level: "success", at: Date.now() });
  } else {
    setMsg(t("重新组装未完成：请查看日志中的失败原因"), false);
  }
}

async function packZip(): Promise<void> {
  if (packing.value) return;
  const dir = outputDir.value;
  if (!dir) {
    setMsg(t("尚未生成项目"), false);
    return;
  }
  if (runBusy.value) {
    setMsg(t("生成任务正在运行：请等它完成再打包，避免把写到一半的文件打进压缩包"), false);
    return;
  }
  // 打包前必做一次新鲜检查：用旧报告会误拦（修完没重跑）或漏拦（新改坏了没检查）
  setMsg(t("正在重新检查项目…"));
  const report = await runLintNow();
  if (!report) {
    setMsg(t("导出检查执行失败，已中止打包：请查看日志"), false);
    return;
  }
  // #1107：检查错误不再硬拦截——素材缺失多为模板/环境回填问题，用户无法在生成页修复。
  // 允许二次确认后强制导出，并把放弃的错误数留痕（日志面板 + 文件日志）。
  if (report.errors.length) {
    if (!window.confirm(buildExportOverridePrompt(report))) {
      setMsg(t("存在导出检查错误，已取消打包（见上方检查结果）"), false);
      return;
    }
    log.warn("page", "用户确认忽略导出检查错误继续打包", {
      dir,
      errors: report.errors.length,
      missingAssets: report.summary.missingAssets,
    });
    pushLog({
      step: "导出",
      message: t("已确认风险：忽略 {n} 个导出检查错误继续打包（缺失素材 {m}）", {
        n: report.errors.length,
        m: report.summary.missingAssets,
      }),
      level: "warn",
      at: Date.now(),
    });
  }
  const base = dir.split(/[\\/]/).filter(Boolean).pop() || "novelforge";
  // UI79：目录名已在 dir 末尾，旧式 `dir + _${base}_web.zip` 会得到 A_A_web.zip；直接拼 _web.zip 即 A_web.zip
  const defaultPath = dir.replace(/[\\/]?$/, "") + "_web.zip";

  let target = defaultPath;
  if (isTauri()) {
    const picked = await save({
      defaultPath,
      filters: [{ name: t("ZIP 压缩包"), extensions: ["zip"] }],
    });
    if (!picked) return;
    // #1116：目标在项目目录内部时拒绝——Rust 先创建 zip 再递归打包，会把正在写入的自身半成品打进包里
    if (isPathInsideDir(dir, picked)) {
      setMsg(t("保存位置不能在项目目录内部（否则会把正在写入的 zip 自身打进包里）：请换一个目录"), false);
      return;
    }
    // #1292：登记保存位置所在目录（用户经保存对话框明示授权），否则写 zip 被白名单拒绝
    await blessParentDir(picked);
    target = picked;
  }

  packing.value = true;
  try {
    // 桌面版写文件；网页版在 Worker 中流式压缩并直接触发浏览器下载（大字节不经日志层）
    const stats = isTauri()
      ? await tauri.buildZip(dir, target, [".novel2vn"])
      : await downloadZipWeb(dir, [".novel2vn"], `${base}_web.zip`, (done, total) => {
          setMsg(t("正在读取并压缩文件 {done}/{total}…", { done, total }));
        });
    log.info("page", "打包 zip 完成", { dir, target, fileCount: stats.fileCount, sizeBytes: stats.sizeBytes });
    setMsg(
      t("打包完成：{count} 个文件，{size}MB{downloaded}", {
        count: stats.fileCount,
        size: (stats.sizeBytes / 1024 / 1024).toFixed(1),
        downloaded: isTauri() ? "" : t("（已下载）"),
      }),
    );
    pushLog({
      step: "导出",
      message: t("已打包网页版 zip：{path}（{count} 文件 / {size}MB）", {
        // #1350：Web 端产物是浏览器下载的 `<目录名>_web.zip`，target（VFS 虚拟路径）并不存在；
        // 日志按端取真实位置，避免用户照日志去路径里找扑空。
        path: isTauri() ? target : `${base}_web.zip（已下载到浏览器下载目录）`,
        count: stats.fileCount,
        size: (stats.sizeBytes / 1024 / 1024).toFixed(1),
      }),
      level: "success",
      at: Date.now(),
    });
  } catch (e) {
    log.error("page", "打包 zip 失败", { dir, target, error: errMsg(e) });
    setMsg(t("打包失败：{error}", { error: errMsg(e) }), false);
  } finally {
    packing.value = false;
  }
}

async function openExternal(url: string): Promise<void> {
  try {
    await tauri.openUrl(url);
  } catch (e) {
    setMsg(t("打开链接失败：{error}", { error: errMsg(e) }), false);
  }
}
</script>

<template>
  <div class="inner">
    <PageHead :title="t('导出')" :sub="t('标准 WebGAL 项目三端分发：网页版 zip / PC exe / 手机 APK')">
      <button
        class="btn secondary"
        :disabled="!outputDir"
        :title="!outputDir ? t('请先在「生成项目」页生成项目') : undefined"
        @click="openFolder"
      >{{ t("打开项目文件夹") }}</button>
      <button class="btn" :disabled="packing || !projectState.lastResult" @click="packZip">
        <span v-if="packing" class="spinner" />
        {{ packing ? t("打包中…") : t("打包网页版 zip") }}
      </button>
      <button
        class="btn secondary"
        :disabled="!projectState.lastResult"
        :title="!projectState.lastResult ? t('请先在「生成项目」页生成项目') : undefined"
        @click="goPage('preview')"
      >{{ t("预览") }}</button>
    </PageHead>

    <div class="card" v-if="projectState.lastResult">
      <div class="card-head">
        <h3>{{ t("当前项目") }}</h3>
        <div class="card-actions">
          <button class="btn ghost small" @click="copyPath">{{ t("复制路径") }}</button>
        </div>
      </div>
      <p>
        <span style="color: var(--primary); font-weight: 600">{{ projectState.lastResult.meta.title }}</span>
        · {{ projectState.lastResult.meta.chapterCount }} {{ t("章") }} · {{ projectState.lastResult.meta.sceneCount }} {{ t("场景") }} · {{ projectState.lastResult.meta.lineCount }} {{ t("句") }}
      </p>
      <p class="hint" style="margin-top: 4px"><code>{{ projectState.lastResult.meta.outputDir }}</code></p>
    </div>
    <div v-else class="card empty-next">
      <p class="hint">{{ t("还没有生成结果：先去生成页跑一次整书生成，再回来打包分发。") }}</p>
      <button class="btn small" @click="goPage('generate')">{{ t("去生成项目") }}</button>
    </div>

    <div class="card" v-if="projectState.lastResult">
      <div class="card-head">
        <h3>{{ t("导出设置") }}</h3>
        <div class="card-actions">
          <button class="btn" :disabled="runBusy" @click="saveAndAssemble">
            <span v-if="runBusy" class="spinner" />
            {{ runBusy ? t("组装中…") : t("保存并重新组装") }}
          </button>
        </div>
      </div>
      <div class="field-grid">
        <label class="field">
          <span>{{ t("游戏标题") }}</span>
          <input type="text" v-model="settings.title" @input="markSettingsDirty" />
        </label>
        <label class="field">
          <span>{{ t("Game Key（6-10 位字母数字）") }}</span>
          <input type="text" v-model="settings.gameKey" @input="markSettingsDirty" />
        </label>
        <label class="field">
          <span>{{ t("界面语言") }}</span>
          <select v-model="settings.language" @change="markSettingsDirty">
            <option value="zh_CN">{{ t("简体中文") }}</option>
            <option value="zh_TW">{{ t("繁體中文") }}</option>
            <option value="en">English</option>
            <option value="ja">{{ t("日本語") }}</option>
            <option value="ko">한국어</option>
          </select>
        </label>
      </div>
      <p v-if="settingsDirty" class="hint" style="margin-top: 6px">{{ t("导出设置有未保存的修改：切页或等待生成完成期间可能被重置，点「保存并重新组装」后再离开。") }}</p>

      <div class="card-section mt-3">
        <div class="field-grid">
          <label class="field">
            <span>{{ t("封面图") }}</span>
            <select v-model="titleForm.coverMode" @change="markTitleDirty">
              <option value="auto">{{ t("自动生成（按主题配色，推荐）") }}</option>
              <option value="none">{{ t("不使用封面") }}</option>
              <option value="custom">{{ t("自定义图片…") }}</option>
            </select>
          </label>
          <label class="field" v-if="titleForm.coverMode === 'custom'">
            <span>{{ t("封面文件") }}</span>
            <div class="flex items-center gap-2">
              <button class="btn ghost small" @click="pickTitleFile('cover')">{{ t("选择图片…") }}</button>
              <span class="hint" :title="titleForm.coverPath">{{ titleForm.coverPath ? fileNameOf(titleForm.coverPath) : t("未选择") }}</span>
            </div>
          </label>
          <label class="field">
            <span>{{ t("标题 Logo") }}</span>
            <select v-model="titleForm.logoMode" @change="markTitleDirty">
              <option value="auto">{{ t("自动生成文字 Logo（推荐）") }}</option>
              <option value="none">{{ t("不显示 Logo") }}</option>
              <option value="custom">{{ t("自定义图片…") }}</option>
            </select>
          </label>
          <label class="field" v-if="titleForm.logoMode === 'custom'">
            <span>{{ t("Logo 文件（建议透明底 PNG）") }}</span>
            <div class="flex items-center gap-2">
              <button class="btn ghost small" @click="pickTitleFile('logo')">{{ t("选择图片…") }}</button>
              <span class="hint" :title="titleForm.logoPath">{{ titleForm.logoPath ? fileNameOf(titleForm.logoPath) : t("未选择") }}</span>
            </div>
          </label>
          <label class="field">
            <span>{{ t("标题音乐") }}</span>
            <select v-model="titleForm.bgmFile" @change="markTitleDirty">
              <option value="">{{ t("自动匹配（推荐）") }}</option>
              <option value="none">{{ t("不播放") }}</option>
              <option v-for="b in bgmOptions" :key="b" :value="b">{{ b }}</option>
            </select>
          </label>
        </div>
        <div class="mt-3" style="display: flex; flex-wrap: wrap; gap: 14px">
          <label class="check"><input type="checkbox" v-model="titleForm.enableContinue" @change="markTitleDirty" /> {{ t("显示「继续游戏」") }}</label>
          <label class="check"><input type="checkbox" v-model="titleForm.enableFlowchart" @change="markTitleDirty" /> {{ t("显示「流程图」") }}</label>
          <label class="check"><input type="checkbox" v-model="titleForm.enableAppreciation" @change="markTitleDirty" /> {{ t("显示「鉴赏室」") }}</label>
          <label class="check"><input type="checkbox" v-model="titleForm.themeFromArtwork" @change="markTitleDirty" /> {{ t("主题色随画风") }}</label>
        </div>
      </div>
      <p class="hint" style="margin-top: 6px">
        {{ t("一次保存全部导出设置（标题 / GameKey / 界面语言 / 封面 / Logo / 标题曲 / 菜单开关 / 主题取色），本地重新组装生效，不消耗 API。") }}
      </p>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>{{ t("导出前检查") }}</h3>
        <div class="card-actions">
          <button class="btn secondary small" :disabled="linting" @click="runLint">
            <span v-if="linting" class="spinner" />
            {{ linting ? t("检查中…") : t("运行检查") }}
          </button>
          <button v-if="lintReport?.errors.length" class="btn ghost small" @click="goPage('generate')">{{ t("去生成页修复") }}</button>
        </div>
      </div>
      <template v-if="lintReport">
        <p class="mb-3">
          <span v-if="!lintReport.errors.length" class="tag ok">{{ t("✓ 通过") }}</span>
          <span v-if="lintReport.warnings.length" class="tag warn">{{ t("警告") }} {{ lintReport.warnings.length }}</span>
          <span v-if="lintReport.errors.length" class="tag err">{{ t("错误") }} {{ lintReport.errors.length }}</span>
          <span class="hint" style="margin-left: 8px">
            {{ lintReport.summary.scenes }} {{ t("场景") }} / {{ lintReport.summary.lines }} {{ t("句") }} / {{ t("缺失素材") }} {{ lintReport.summary.missingAssets }}
          </span>
        </p>
        <div v-if="lintReport.errors.length || lintReport.warnings.length" class="lint-list">
          <div v-for="(iss, i) in [...lintReport.errors, ...lintReport.warnings]" :key="i" class="lint-item" :class="iss.level === 'error' ? 'error' : 'warn'">
            <b>{{ iss.scope }}</b>：{{ iss.message }}
          </div>
        </div>
      </template>
      <p v-else-if="lintError" class="err-text small">{{ t("导出检查失败：{error}", { error: lintError }) }}</p>
      <p v-else class="faint small">{{ t("检查剧本语法、素材引用完整性、空章节与流程图可达性（打包前会自动重新检查一次）") }}</p>
    </div>

    <div class="dist-grid">
      <div class="card mb-0">
        <div class="dist-head">
          <span class="dist-icon web">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15M7 10L12 15L17 10M12 15V3" /></svg>
          </span>
          <div>
            <div class="dist-title">{{ t("网页版 zip") }}</div>
            <div class="dist-desc">{{ t("手机/PC 浏览器即玩 · 自动排除缓存") }}</div>
          </div>
        </div>
        <button class="btn w-full" :disabled="packing || !projectState.lastResult" @click="packZip">
          <span v-if="packing" class="spinner" /> {{ t("打包 zip") }}
        </button>
      </div>

      <div class="card mb-0">
        <div class="dist-head">
          <span class="dist-icon pc">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
          </span>
          <div>
            <div class="dist-title">{{ t("PC 端 exe") }}</div>
            <div class="dist-desc">{{ t("WebGAL Terre 一键导出") }}</div>
          </div>
        </div>
        <button class="btn secondary w-full" @click="openExternal('https://www.openwebgal.com/zh-cn/download/')">{{ t("下载 Terre 编辑器") }}</button>
      </div>

      <div class="card mb-0">
        <div class="dist-head">
          <span class="dist-icon apk">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></svg>
          </span>
          <div>
            <div class="dist-title">{{ t("手机端 APK") }}</div>
            <div class="dist-desc">{{ t("官方 APK 构建工具") }}</div>
          </div>
        </div>
        <button class="btn secondary w-full" @click="openExternal('https://github.com/OpenWebGAL/webgal-apk-build-tool')">{{ t("APK 构建指引") }}</button>
      </div>
    </div>

    <p v-if="message" class="mt-3" :style="{ color: messageOk ? 'var(--ok)' : 'var(--err)', fontSize: '12.5px' }">{{ message }}</p>
  </div>
</template>
