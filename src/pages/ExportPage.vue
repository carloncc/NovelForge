<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { save, open } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog } from "../stores/project";
import { configState, addRecentOutputDir } from "../stores/config";
import { tauri, isTauri } from "../utils/tauri";
import { vfsDownloadFile } from "../utils/vfsWeb";
import { lintProject, type LintReport } from "../core/lint";
import { renderConfig, type WebgalLanguage } from "../core/render";
import { errMsg } from "../utils/errors";
import { log } from "../utils/logger";
import { t } from "../i18n";
import type { ExportSettings } from "../core/types";

const message = ref("");
const linting = ref(false);
const packing = ref(false);
const lintReport = ref<LintReport | null>(null);
const settings = ref<ExportSettings>({
  title: "",
  gameKey: "",
  language: "zh_CN",
});

// 从最近结果初始化导出设置
watch(
  () => projectState.lastResult?.meta.generatedAt,
  () => {
    const meta = projectState.lastResult?.meta;
    if (meta) {
      settings.value.title = meta.title;
      settings.value.gameKey = meta.gameKey;
    }
  },
  { immediate: true },
);

const outputDir = computed(() => projectState.lastResult?.meta.outputDir ?? projectState.outputDir);

function setMsg(m: string, ok = true): void {
  message.value = m;
  setTimeout(() => (message.value = ""), 4000);
}

async function openFolder(): Promise<void> {
  if (!outputDir.value) return;
  await tauri.openInExplorer(outputDir.value);
}

async function copyPath(): Promise<void> {
  if (!outputDir.value) return;
  await navigator.clipboard.writeText(outputDir.value);
  setMsg(t("路径已复制到剪贴板"));
}

async function runLint(): Promise<void> {
  linting.value = true;
  lintReport.value = null;
  try {
    if (!outputDir.value) throw new Error(t("尚未生成项目"));
    lintReport.value = await lintProject(outputDir.value);
    log.info("page", "项目检查完成", {
      dir: outputDir.value,
      errors: lintReport.value.errors.length,
      warnings: lintReport.value.warnings.length,
    });
  } catch (e) {
    log.error("page", "项目检查失败", { error: errMsg(e) });
    setMsg(`检查失败：${errMsg(e)}`, false);
  } finally {
    linting.value = false;
  }
}

async function applySettings(): Promise<void> {
  const dir = outputDir.value;
  if (!dir) {
    setMsg(t("尚未生成项目"), false);
    return;
  }
  const key = settings.value.gameKey.trim();
  if (key.length < 6 || key.length > 10 || !/^[a-zA-Z0-9]+$/.test(key)) {
    setMsg(t("Game_key 需 6-10 位字母数字"), false);
    return;
  }
  const title = settings.value.title.trim();
  if (!title) {
    setMsg(t("游戏标题不能为空"), false);
    return;
  }
  try {
    await tauri.writeTextFile(`${dir}/game/config.txt`, renderConfig(title, key, settings.value.language));
    setMsg(t("游戏配置已应用（标题 / Game_key / 界面语言）"));
    pushLog({ step: "导出", message: `已应用导出设置：${title} / ${key} / ${settings.value.language}`, level: "success", at: Date.now() });
  } catch (e) {
    setMsg(`应用失败：${errMsg(e)}`, false);
  }
}

async function packZip(): Promise<void> {
  const dir = outputDir.value;
  if (!dir) {
    setMsg(t("尚未生成项目"), false);
    return;
  }
  if (lintReport.value?.errors.length) {
    setMsg(t("存在导出检查错误，请先修复（见上方检查结果）"), false);
    return;
  }
  const base = dir.split(/[\\/]/).filter(Boolean).pop() || "novelforge";
  const defaultPath = dir.replace(/[\\/]?$/, "") + `_${base}_web.zip`;

  let target: string;
  if (isTauri()) {
    const picked = await save({
      defaultPath,
      filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
    });
    if (!picked) return;
    target = picked;
  } else {
    target = defaultPath;
  }

  packing.value = true;
  try {
    const stats = await tauri.buildZip(dir, target, [".novel2vn"]);
    if (!isTauri()) {
      await vfsDownloadFile(target, `${base}_web.zip`);
    }
    log.info("page", "打包 zip 完成", { dir, target, fileCount: stats.fileCount, sizeBytes: stats.sizeBytes });
    setMsg(
      `打包完成：${stats.fileCount} 个文件，${(stats.sizeBytes / 1024 / 1024).toFixed(1)}MB${isTauri() ? "" : "（已下载）"}`,
    );
    pushLog({
      step: "导出",
      message: `已打包网页版 zip：${target}（${stats.fileCount} 文件 / ${(stats.sizeBytes / 1024 / 1024).toFixed(1)}MB）`,
      level: "success",
      at: Date.now(),
    });
  } catch (e) {
    log.error("page", "打包 zip 失败", { dir, target, error: errMsg(e) });
    setMsg(`打包失败：${errMsg(e)}`, false);
  } finally {
    packing.value = false;
  }
}

const lintSummary = computed(() => {
  const r = lintReport.value;
  if (!r) return null;
  return { errors: r.errors.length, warnings: r.warnings.length };
});
</script>

<template>
  <div class="inner">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t("导出") }}</div>
        <p class="page-sub">{{ t("标准 WebGAL 项目三端分发：网页版 zip / PC exe / 手机 APK") }}</p>
      </div>
      <div class="page-actions">
        <button class="btn secondary" @click="openFolder">{{ t("打开项目文件夹") }}</button>
        <button class="btn" :disabled="packing" @click="packZip">
          <span v-if="packing" class="spinner" />
          {{ packing ? t("打包中…") : t("打包网页版 zip") }}
        </button>
      </div>
    </div>

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
      <p style="color: var(--text-dim); font-size: 12.5px; margin-top: 4px"><code>{{ projectState.lastResult.meta.outputDir }}</code></p>
    </div>
    <div v-else class="card">
      <p style="color: var(--text-faint)">{{ t("尚未生成项目") }}</p>
    </div>

    <div class="card">
      <div class="card-head"><h3>{{ t("导出设置") }}</h3></div>
      <div class="row">
        <label class="field grow-2">
          <span>{{ t("游戏标题") }}</span>
          <input type="text" v-model="settings.title" />
        </label>
        <label class="field">
          <span>{{ t("Game Key（6-10 位字母数字）") }}</span>
          <input type="text" v-model="settings.gameKey" />
        </label>
        <label class="field">
          <span>{{ t("界面语言") }}</span>
          <select v-model="settings.language">
            <option value="zh_CN">{{ t("简体中文") }}</option>
            <option value="zh_TW">{{ t("繁體中文") }}</option>
            <option value="en">English</option>
            <option value="ja">{{ t("日本語") }}</option>
          </select>
        </label>
        <div>
          <button class="btn secondary" @click="applySettings">{{ t("应用设置") }}</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>{{ t("导出前检查") }}</h3>
        <div class="card-actions">
          <button class="btn secondary small" :disabled="linting" @click="runLint">
            <span v-if="linting" class="spinner" />
            {{ linting ? t("检查中…") : t("运行检查") }}
          </button>
        </div>
      </div>
      <template v-if="lintReport">
        <p style="font-size: 13px; margin-bottom: var(--space-3)">
          <span v-if="!lintReport.errors.length" class="tag ok">{{ t("✓ 通过") }}</span>
          <span v-if="lintReport.warnings.length" class="tag warn">{{ t("警告") }} {{ lintReport.warnings.length }}</span>
          <span v-if="lintReport.errors.length" class="tag err">{{ t("错误") }} {{ lintReport.errors.length }}</span>
          <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">
            {{ lintReport.summary.scenes }} {{ t("场景") }} / {{ lintReport.summary.lines }} {{ t("句") }} / {{ t("缺失素材") }} {{ lintReport.summary.missingAssets }}
          </span>
        </p>
        <div v-if="lintReport.errors.length || lintReport.warnings.length" style="display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow: auto">
          <div v-for="(iss, i) in [...lintReport.errors, ...lintReport.warnings]" :key="i" style="font-size: 12.5px; padding: 7px 10px; border-radius: 6px" :style="iss.level === 'error' ? 'background: var(--err-soft); color: var(--err)' : 'background: var(--warn-soft); color: var(--warn)'">
            <b>{{ iss.scope }}</b>：{{ iss.message }}
          </div>
        </div>
      </template>
      <p v-else style="color: var(--text-faint); font-size: 12.5px">{{ t("检查剧本语法、素材引用完整性、空章节与流程图可达性") }}</p>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-4)">
      <div class="card" style="margin-bottom: 0">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px">
          <span style="width: 36px; height: 36px; border-radius: 9px; background: var(--gradient); display: flex; align-items: center; justify-content: center">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15V19C21 20.1 20.1 21 19 21H5C3.9 21 3 20.1 3 19V15M7 10L12 15L17 10M12 15V3" /></svg>
          </span>
          <div>
            <div style="font-weight: 600">{{ t("网页版 zip") }}</div>
            <div style="font-size: 11.5px; color: var(--text-dim)">{{ t("手机/PC 浏览器即玩 · 自动排除缓存") }}</div>
          </div>
        </div>
        <button class="btn" style="width: 100%" :disabled="packing || !projectState.lastResult" @click="packZip">
          <span v-if="packing" class="spinner" /> {{ t("打包 zip") }}
        </button>
      </div>

      <div class="card" style="margin-bottom: 0">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px">
          <span style="width: 36px; height: 36px; border-radius: 9px; background: linear-gradient(135deg, #2563eb, #60a5fa); display: flex; align-items: center; justify-content: center">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
          </span>
          <div>
            <div style="font-weight: 600">{{ t("PC 端 exe") }}</div>
            <div style="font-size: 11.5px; color: var(--text-dim)">{{ t("WebGAL Terre 一键导出") }}</div>
          </div>
        </div>
        <a href="https://www.openwebgal.com/zh-cn/download/" target="_blank" class="btn secondary" style="width: 100%; text-decoration: none">{{ t("下载 Terre 编辑器") }}</a>
      </div>

      <div class="card" style="margin-bottom: 0">
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px">
          <span style="width: 36px; height: 36px; border-radius: 9px; background: linear-gradient(135deg, #059669, #34d399); display: flex; align-items: center; justify-content: center">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></svg>
          </span>
          <div>
            <div style="font-weight: 600">{{ t("手机端 APK") }}</div>
            <div style="font-size: 11.5px; color: var(--text-dim)">{{ t("官方 APK 构建工具") }}</div>
          </div>
        </div>
        <a href="https://github.com/OpenWebGAL/webgal-apk-build-tool" target="_blank" class="btn secondary" style="width: 100%; text-decoration: none">{{ t("APK 构建指引") }}</a>
      </div>
    </div>

    <p v-if="message" style="color: var(--ok); font-size: 12.5px; margin-top: var(--space-3)">{{ message }}</p>
  </div>
</template>
