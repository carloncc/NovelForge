<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { open, save } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog, clearLogs, scheduleSave, restoreProject } from "../stores/project";
import { activeConfig, configState, addRecentOutputDir } from "../stores/config";
import { Pipeline } from "../core/pipeline";
import { resolveTemplateDir } from "../utils/template";
import { tauri, isTauri } from "../utils/tauri";
import { sanitizeId } from "../core/render";
import { errMsg } from "../utils/errors";
import { log as logger, dumpLogHistory } from "../utils/logger";
import EditCards from "../components/EditCards.vue";
import StepIndicator from "../components/StepIndicator.vue";
import type { FailedTask, PipelineEvent, VideoSuggestion } from "../core/types";

const tab = ref<"run" | "cards" | "video" | "script" | "log" | "failed">("run");
const error = ref("");
const busy = ref(false);
const pipelineRef = ref<Pipeline | null>(null);
const scriptFiles = ref<{ name: string; text: string }[]>([]);
const currentScript = ref("");
const videoStatus = ref<Record<string, boolean>>({});
const copiedMsg = ref("");
const logPanelRef = ref<HTMLElement | null>(null);

const PIPELINE_STEPS = ["提取", "剧本", "图像", "配音", "组装"];
const currentStep = ref(-1);
const failedSteps = ref<number[]>([]);

watch(
  () => projectState.logs.length,
  async () => {
    const last = projectState.logs[projectState.logs.length - 1];
    if (last) {
      const idx = PIPELINE_STEPS.indexOf(last.step);
      if (idx >= 0 && last.level !== "error") currentStep.value = Math.max(currentStep.value, idx);
      if (last.level === "error" && idx >= 0 && !failedSteps.value.includes(idx)) failedSteps.value.push(idx);
    }
    await nextTick();
    if (logPanelRef.value) logPanelRef.value.scrollTop = logPanelRef.value.scrollHeight;
  },
);

const costText = computed(() => {
  const r = projectState.lastResult;
  if (!r) return null;
  const c = r.cost;
  return {
    llm: `${c.llmTokens.toLocaleString()} tokens · ¥${c.llmCostYuan.toFixed(3)}`,
    image: `${c.imageCount} 张 · ¥${c.imageCostYuan.toFixed(2)}`,
    tts: `${c.ttsChars.toLocaleString()} 字符 · ¥${c.ttsCostYuan.toFixed(3)}`,
    total: (c.llmCostYuan + c.imageCostYuan + c.ttsCostYuan).toFixed(2),
  };
});

const failedTasks = computed<FailedTask[]>(() => projectState.lastResult?.failedTasks ?? []);

const videoPoints = computed<(VideoSuggestion & { chapter: number; location: string; enabled: boolean })[]>(() => {
  const r = projectState.lastResult;
  if (!r) return [];
  return r.chapters.flatMap((c) =>
    c.scenes.flatMap((s) =>
      (s.videoPoints || []).map((vp) => ({
        ...vp,
        chapter: c.chapter + 1,
        location: s.location,
        enabled: !!videoStatus.value[sanitizeId(vp.id)],
      })),
    ),
  );
});

async function browseOutputDir(): Promise<void> {
  if (!isTauri()) {
    projectState.outputDir = await tauri.getDefaultOutputDir();
    configState.outputDir = projectState.outputDir;
    pushLog({ step: "项目", message: "Web 版输出目录固定为虚拟目录 /app/exports", level: "info", at: Date.now() });
    return;
  }
  const dir = await open({ directory: true, multiple: false });
  if (dir && typeof dir === "string") {
    projectState.outputDir = dir;
    configState.outputDir = dir;
  }
}

async function loadProjectState(): Promise<void> {
  if (!projectState.outputDir) return;
  await restoreProject(projectState.outputDir);
  addRecentOutputDir(projectState.outputDir);
  pushLog({ step: "项目", message: `已加载项目状态：${projectState.outputDir}`, level: "success", at: Date.now() });
}

async function checkVideos(): Promise<void> {
  const out = projectState.outputDir;
  if (!out) return;
  videoStatus.value = {};
  try {
    const entries = await tauri.listDir(`${out}/game/video`);
    for (const e of entries) {
      const m = e.name.match(/^video_(.+)\.(mp4|webm|ogg)$/i);
      if (m) videoStatus.value[m[1]] = true;
    }
  } catch {
    /* 目录不存在 */
  }
}

async function loadScripts(): Promise<void> {
  const out = projectState.outputDir;
  if (!out) return;
  try {
    const entries = await tauri.listDir(`${out}/game/scene`);
    const files: { name: string; text: string }[] = [];
    for (const e of entries) {
      if (!e.name.endsWith(".txt")) continue;
      const { text } = await tauri.readTextFile(e.path);
      files.push({ name: e.name, text });
    }
    scriptFiles.value = files.sort((a, b) => a.name.localeCompare(b.name));
    if (files.length && !currentScript.value) currentScript.value = files[0].name;
  } catch {
    scriptFiles.value = [];
  }
}

async function copyText(text: string, label: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  copiedMsg.value = `${label}已复制`;
  setTimeout(() => (copiedMsg.value = ""), 2000);
}

async function copyLogs(): Promise<void> {
  const text = projectState.logs
    .map((l) => `[${new Date(l.at).toLocaleTimeString()}] [${l.step}] ${l.message}`)
    .join("\n");
  await navigator.clipboard.writeText(text);
  copiedMsg.value = "日志已复制";
  setTimeout(() => (copiedMsg.value = ""), 2000);
}

async function saveLogs(): Promise<void> {
  const out = projectState.outputDir;
  if (!out) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = `${out}/.novel2vn/logs/${stamp}.log`;
  const text = [
    `NovelForge 生成日志 ${stamp}`,
    `项目：${out}`,
    `失败项：${failedTasks.value.length} 个`,
    "",
    "== 界面日志 ==",
    ...projectState.logs.map((l) => `[${new Date(l.at).toLocaleTimeString()}] [${l.step}] ${l.message}`),
    "",
    "== 详细诊断日志 ==",
    dumpLogHistory(),
  ].join("\n");
  try {
    await tauri.writeTextFile(path, text);
    logger.info("page", "日志已保存", { path });
    copiedMsg.value = `日志已保存：${path}`;
  } catch (e) {
    copiedMsg.value = `保存失败：${errMsg(e)}`;
  }
  setTimeout(() => (copiedMsg.value = ""), 3000);
}

async function retryFailed(): Promise<void> {
  const failed = failedTasks.value;
  if (!failed.length) return;
  // 剧本失败 → 定位章节重跑；图像失败 → 清除对应缓存文件
  const chapterIds = new Set<number>();
  for (const f of failed) {
    if (f.kind === "script" && f.id.startsWith("chapter_")) {
      chapterIds.add(parseInt(f.id.replace("chapter_", ""), 10) - 1);
    }
  }
  if (chapterIds.size) {
    rerunChapters.value = Array.from(chapterIds);
    copiedMsg.value = "已定位失败章节，点击「开始生成」重试（其余章节复用缓存）";
  } else {
    copiedMsg.value = "无章节级失败；请勾选「跳过缓存」后重跑以重试图像任务";
  }
  setTimeout(() => (copiedMsg.value = ""), 4000);
}

const rerunChapters = ref<number[] | null>(null);

function toggleAllRerun(on: boolean): void {
  if (!projectState.novel) return;
  rerunChapters.value = on ? null : [];
}

function toggleChapterRerun(index: number, checked: boolean): void {
  if (checked) {
    if (!rerunChapters.value) rerunChapters.value = [];
    if (!rerunChapters.value.includes(index)) rerunChapters.value.push(index);
  } else {
    if (rerunChapters.value) {
      rerunChapters.value = rerunChapters.value.filter((n) => n !== index);
    } else {
      rerunChapters.value = projectState.novel?.chapters.map((c) => c.index).filter((n) => n !== index) ?? [];
    }
  }
}

async function start(): Promise<void> {
  error.value = "";
  const novel = projectState.novel;
  if (!novel) {
    error.value = "请先在「导入小说」页导入小说（或加载示例小说）";
    return;
  }
  logger.info("page", "用户点击开始生成", {
    hasNovel: true,
    chapterCount: novel.chapters.length,
    outputDir: projectState.outputDir,
    options: { ...projectState.options, rerunChapters: rerunChapters.value ?? undefined },
  });
  const llm = activeConfig("llm");
  const image = activeConfig("image");
  const tts = activeConfig("tts");
  if (!llm?.apiKey) {
    pushLog({
      step: "提示",
      message: "未配置文本 LLM API Key，将以演示模式运行（可完整验证剧本/渲染/组装流程）",
      level: "warn",
      at: Date.now(),
    });
  }
  if (!projectState.outputDir) {
    projectState.outputDir = await tauri.getDefaultOutputDir().catch(() => "");
  }
  clearLogs();
  currentStep.value = -1;
  failedSteps.value = [];
  busy.value = true;
  projectState.running = true;
  const log = (ev: PipelineEvent) => pushLog(ev);
  try {
    const templateDir = await resolveTemplateDir();
    const pipeline = new Pipeline({
      novel,
      materials: projectState.materials,
      llm: llm?.apiKey ? llm : undefined,
      image: projectState.options.useImage && image?.apiKey ? image : undefined,
      tts: projectState.options.useTts && tts?.apiKey ? tts : undefined,
      outputDir: projectState.outputDir,
      templateDir,
      options: {
        ...projectState.options,
        rerunChapters: rerunChapters.value ?? undefined,
      },
      log,
    });
    pipelineRef.value = pipeline;

    log({ step: "开始", message: "管线启动", level: "info", at: Date.now() });
    const result = await pipeline.run();
    projectState.lastResult = result;
    addRecentOutputDir(result.meta.outputDir);
    tab.value = "cards";
    await checkVideos();
    log({ step: "完成", message: `全部完成！项目输出到 ${result.meta.outputDir}，可前往「预览」页试玩`, level: "success", at: Date.now() });
  } catch (e) {
    const msg = errMsg(e);
    logger.error("page", "生成失败", { message: msg });
    if (msg === "已中止") {
      logger.warn("page", "生成被用户中止");
      log({ step: "中止", message: "已停止生成，进度已保存（缓存命中部分不会重复计费）", level: "warn", at: Date.now() });
    } else {
      error.value = msg;
      log({ step: "错误", message: msg, level: "error", at: Date.now() });
    }
  } finally {
    busy.value = false;
    projectState.running = false;
    pipelineRef.value = null;
  }
}

function stop(): void {
  pipelineRef.value?.abort();
  error.value = "";
  pushLog({ step: "中止", message: "用户请求中止，当前任务完成后将停止", level: "warn", at: Date.now() });
}

function onCardsSaved(cards: unknown): void {
  if (projectState.lastResult) {
    projectState.lastResult.cards = cards as never;
  }
  scheduleSave();
}
</script>

<template>
  <div class="inner">
    <div class="page-head">
      <div>
        <div class="page-title">生成项目</div>
        <p class="page-sub">AI 管线：提取 → 剧本 → 图像 → 配音 → 组装。全部可缓存、断点续跑。</p>
      </div>
      <div class="page-actions">
        <button class="btn" :disabled="busy" @click="start">
          <span v-if="busy" class="spinner" />
          {{ busy ? "生成中…" : "开始生成" }}
        </button>
        <button v-if="busy" class="btn danger" @click="stop">停止</button>
      </div>
    </div>

    <div v-if="busy || currentStep >= 0" style="margin-bottom: var(--space-4)">
      <StepIndicator :steps="PIPELINE_STEPS" :current="currentStep" :failed="failedSteps" />
    </div>

    <div class="card" style="padding: var(--space-4)">
      <div style="display: flex; flex-wrap: wrap; gap: var(--space-3)">
        <label class="field" style="flex: 2 1 340px; margin-bottom: 0">
          <span>输出目录</span>
          <div class="row">
            <input type="text" v-model="projectState.outputDir" style="flex: 3" />
            <button class="btn secondary small" @click="browseOutputDir">浏览…</button>
            <button class="btn ghost small" @click="loadProjectState">加载该项目</button>
          </div>
        </label>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: var(--space-4)">
      <div class="card" style="margin-bottom: 0">
        <div class="card-head"><h3>生成内容</h3></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px">
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.useImage" /> 图像（立绘/背景/CG/物品）
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.figureEmotions" /> 表情差分（5 表情/角色）
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.useTts" /> 配音（TTS）
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.useVideoPoints" /> 视频推荐位
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.useBgm" /> BGM 匹配
          </label>
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px">
            <input type="checkbox" v-model="projectState.options.characterIntroCard" /> 角色登场资料卡
          </label>
        </div>
      </div>

      <div class="card" style="margin-bottom: 0">
        <div class="card-head"><h3>预算与范围</h3></div>
        <div class="row">
          <label class="field">
            <span>每章 CG 数上限</span>
            <input type="number" v-model.number="projectState.options.cgPerChapter" min="0" max="10" />
          </label>
          <label class="field">
            <span>每章图像数上限</span>
            <input type="number" v-model.number="projectState.options.imageBudgetPerChapter" min="0" max="50" />
          </label>
          <label class="field">
            <span>视频推荐点数上限</span>
            <input type="number" v-model.number="projectState.options.videoPointsPerChapter" min="0" max="5" />
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span>预算上限（¥，0 = 不限）</span>
            <input type="number" v-model.number="projectState.options.budgetYuan" min="0" step="0.5" />
          </label>
          <label class="field">
            <span>跳过缓存（全量重跑）</span>
            <div style="padding-top: 6px"><input type="checkbox" v-model="projectState.options.skipCache" /></div>
          </label>
        </div>
      </div>
    </div>

    <div class="card" v-if="projectState.novel" style="margin-top: var(--space-4)">
      <div class="card-head">
        <h3>本次重跑章节</h3>
        <div class="card-actions">
          <button class="btn ghost small" @click="toggleAllRerun(true)">全选</button>
          <button class="btn ghost small" @click="toggleAllRerun(false)">全不选</button>
        </div>
      </div>
      <p style="font-size: 12px; color: var(--text-dim); margin-bottom: var(--space-3)">未勾选章节复用已有缓存；无缓存则跳过</p>
      <div style="display: flex; flex-wrap: wrap; gap: 6px 18px">
        <label v-for="(ch, i) in projectState.novel.chapters" :key="i" style="display: flex; align-items: center; gap: 5px; font-size: 12.5px">
          <input
            type="checkbox"
            :checked="rerunChapters === null || rerunChapters.includes(ch.index)"
            @change="(e: any) => toggleChapterRerun(ch.index, (e.target as HTMLInputElement).checked)"
          />
          {{ ch.title }}
        </label>
      </div>
    </div>

    <p v-if="error" style="color: var(--err); margin: var(--space-3) 0">{{ error }}</p>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'run' }" @click="tab = 'run'">状态与费用</button>
      <button class="tab" :class="{ active: tab === 'cards' }" @click="tab = 'cards'">卡片编辑</button>
      <button class="tab" :class="{ active: tab === 'video' }" @click="tab = 'video'; checkVideos()">视频推荐位</button>
      <button class="tab" :class="{ active: tab === 'script' }" @click="tab = 'script'; loadScripts()">剧本</button>
      <button class="tab" :class="{ active: tab === 'failed' }" @click="tab = 'failed'">
        失败项<template v-if="failedTasks.length">（{{ failedTasks.length }}）</template>
      </button>
      <button class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">日志</button>
    </div>

    <div v-if="tab === 'run'">
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg></span>
          <div class="stat-body"><div class="label">章节</div><div class="value">{{ projectState.novel?.chapters.filter((c) => c.enabled !== false).length ?? 0 }}</div></div>
        </div>
        <div class="stat">
          <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg></span>
          <div class="stat-body"><div class="label">总字数</div><div class="value">{{ (projectState.novel?.fullText.length ?? 0).toLocaleString() }}</div></div>
        </div>
        <div class="stat">
          <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg></span>
          <div class="stat-body"><div class="label">素材</div><div class="value">{{ projectState.materials.length }}</div></div>
        </div>
        <div class="stat">
          <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg></span>
          <div class="stat-body">
            <div class="label">状态</div>
            <div class="value" :style="busy ? 'color: var(--warn)' : projectState.lastResult ? 'color: var(--ok)' : ''">{{ busy ? "运行中" : projectState.lastResult ? "已完成" : "未开始" }}</div>
          </div>
        </div>
      </div>
      <div class="card" v-if="costText" style="margin-top: var(--space-4)">
        <div class="card-head"><h3>费用统计（估算）</h3></div>
        <div class="stat-grid">
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg></span><div class="stat-body"><div class="label">LLM</div><div class="value" style="font-size: 15px">{{ costText.llm }}</div></div></div>
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg></span><div class="stat-body"><div class="label">图像</div><div class="value" style="font-size: 15px">{{ costText.image }}</div></div></div>
          <div class="stat"><span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6V18M8 9V15M16 9V15M5 11V13M19 11V13" /></svg></span><div class="stat-body"><div class="label">配音</div><div class="value" style="font-size: 15px">{{ costText.tts }}</div></div></div>
          <div class="stat"><span class="stat-icon" style="background: var(--gradient-hot)"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg></span><div class="stat-body"><div class="label">合计</div><div class="value" style="font-size: 16px">¥{{ costText.total }}</div></div></div>
        </div>
        <p style="color: var(--text-dim); font-size: 12px; margin-top: var(--space-3)">图像按 ¥0.3/张、文本按 ¥2+8/百万 token 估算；视频由你人工生成不计费；缓存命中不重复计费。</p>
      </div>
    </div>

    <div v-else-if="tab === 'cards'">
      <EditCards v-if="projectState.lastResult" :cards="projectState.lastResult.cards" @saved="onCardsSaved" />
      <div v-else class="empty">
        <img src="/src/assets/empty-generate.png" alt="" style="width: 240px; opacity: 0.9; margin-bottom: 12px" />
        <p>尚无生成结果，先运行一次生成</p>
      </div>
    </div>

    <div v-else-if="tab === 'video'">
      <div class="card" v-if="videoPoints.length">
        <div class="card-head">
          <h3>AI 推荐的视频演出位（{{ videoPoints.length }} 个）</h3>
          <div class="card-actions"><button class="btn secondary small" @click="checkVideos">刷新状态</button></div>
        </div>
        <p style="color: var(--text-dim); font-size: 12px; margin-bottom: var(--space-4)">提示词粘贴到即梦/可灵生成，mp4 命名为 <code>video_&lt;id&gt;.mp4</code> 放入 <code>game/video/</code> 刷新后自动启用，零 API 费用。</p>
        <div v-for="vp in videoPoints" :key="vp.id" style="border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; margin-bottom: 10px">
          <div class="row" style="justify-content: space-between">
            <span>
              <span class="tag" :class="vp.enabled ? 'ok' : ''">{{ vp.enabled ? "已启用" : "未生成" }}</span>
              <span style="font-weight: 600">{{ vp.title }}</span>
              <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">第 {{ vp.chapter }} 章 · {{ vp.location }} · {{ vp.durationSecs }}s</span>
            </span>
            <button class="btn small" @click="copyText(vp.videoPrompt, '视频提示词')">复制提示词</button>
          </div>
          <p style="color: var(--text-dim); font-size: 12px; margin-top: 6px">{{ vp.description }}</p>
          <p style="font-size: 12px; margin-top: 6px; color: var(--text-dim)">文件名：<code>video_{{ sanitizeId(vp.id) }}.mp4</code></p>
        </div>
      </div>
      <div v-else class="empty">
        <img src="/src/assets/empty-generate.png" alt="" style="width: 220px; opacity: 0.9; margin-bottom: 12px" />
        <p>暂无视频推荐位（重新生成后出现）</p>
      </div>
    </div>

    <div v-else-if="tab === 'script'">
      <div class="card" v-if="scriptFiles.length">
        <div class="row" style="justify-content: space-between">
          <select v-model="currentScript" style="flex: 1; max-width: 260px">
            <option v-for="f in scriptFiles" :key="f.name" :value="f.name">{{ f.name }}</option>
          </select>
          <button class="btn secondary small" @click="tauri.openInExplorer(projectState.outputDir + '/game/scene')">打开剧本文件夹</button>
        </div>
        <pre style="background: #fbf9ff; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; margin-top: 10px; max-height: 420px; overflow: auto; font-size: 12px; line-height: 1.7; white-space: pre-wrap">{{ scriptFiles.find((f) => f.name === currentScript)?.text }}</pre>
      </div>
      <div v-else class="empty">
        <img src="/src/assets/empty-generate.png" alt="" style="width: 220px; opacity: 0.9; margin-bottom: 12px" />
        <p>暂无剧本文件（生成后出现）</p>
      </div>
    </div>

    <div v-else-if="tab === 'failed'">
      <div class="card" v-if="failedTasks.length">
        <div class="card-head">
          <h3>失败任务（{{ failedTasks.length }} 个）</h3>
          <div class="card-actions"><button class="btn small" @click="retryFailed">定位重试</button></div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px">
          <div v-for="(f, i) in failedTasks" :key="i" style="border: 1px solid var(--err-soft); background: var(--err-soft); border-radius: var(--radius-sm); padding: 10px 12px">
            <div style="display: flex; align-items: center; gap: 8px">
              <span class="tag err">{{ f.kind === "image" ? "图像" : f.kind === "script" ? "剧本" : f.kind === "llm" ? "LLM" : "配音" }}</span>
              <span style="font-weight: 600; font-size: 13px">{{ f.id }}</span>
              <span style="color: var(--text-faint); font-size: 11px; margin-left: auto">{{ new Date(f.at).toLocaleTimeString() }}</span>
            </div>
            <p style="font-size: 12px; color: var(--text-dim); margin-top: 4px; word-break: break-all">{{ f.message }}</p>
          </div>
        </div>
      </div>
      <div v-else class="empty">暂无失败任务</div>
    </div>

    <div v-else>
      <div class="card">
        <div class="card-head">
          <h3>运行日志</h3>
          <div class="card-actions">
            <button class="btn secondary small" @click="saveLogs">保存日志</button>
            <button class="btn ghost small" @click="copyLogs">复制</button>
          </div>
        </div>
        <div class="log-panel" ref="logPanelRef">
          <div v-for="(l, i) in projectState.logs" :key="i" class="log-line" :class="l.level">
            <span class="time">{{ new Date(l.at).toLocaleTimeString() }}</span>
            <span class="step-badge">{{ l.step }}</span>
            <span>{{ l.message }}</span>
          </div>
        </div>
      </div>
    </div>
    <p v-if="copiedMsg" style="color: var(--ok); font-size: 12px; margin-top: 6px">{{ copiedMsg }}</p>
  </div>
</template>
