<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { projectState, pushLog, clearLogs, scheduleSave, restoreProject } from "../stores/project";
import { activeConfig, configState } from "../stores/config";
import { Pipeline } from "../core/pipeline";
import { resolveTemplateDir } from "../utils/template";
import { tauri } from "../utils/tauri";
import { sanitizeId } from "../core/render";
import EditCards from "../components/EditCards.vue";
import type { PipelineEvent, VideoSuggestion } from "../core/types";

const tab = ref<"run" | "cards" | "video" | "script" | "log">("run");
const error = ref("");
const busy = ref(false);
const pipelineRef = ref<Pipeline | null>(null);
const scriptFiles = ref<{ name: string; text: string }[]>([]);
const currentScript = ref("");
const videoStatus = ref<Record<string, boolean>>({});
const copiedMsg = ref("");
const logPanelRef = ref<HTMLElement | null>(null);

// 日志自动滚动到底部
watch(
  () => projectState.logs.length,
  async () => {
    await nextTick();
    if (logPanelRef.value) {
      logPanelRef.value.scrollTop = logPanelRef.value.scrollHeight;
    }
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
  };
});

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
  const dir = await open({ directory: true, multiple: false });
  if (dir && typeof dir === "string") {
    projectState.outputDir = dir;
    configState.outputDir = dir;
  }
}

async function loadProjectState(): Promise<void> {
  if (!projectState.outputDir) return;
  await restoreProject(projectState.outputDir);
  pushLog({
    step: "项目",
    message: `已加载项目状态：${projectState.outputDir}`,
    level: "success",
    at: Date.now(),
  });
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
    if (files.length && !currentScript.value) {
      currentScript.value = files[0].name;
    }
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
    tab.value = "cards";
    await checkVideos();
    log({ step: "完成", message: `全部完成！项目输出到 ${result.meta.outputDir}，可前往「预览」页试玩`, level: "success", at: Date.now() });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "已中止") {
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
  <div class="page-title">生成项目</div>
  <div class="page-sub">AI 管线：提取 → 剧本 → 图像 → 配音 → 组装。全部可缓存、断点续跑。</div>

  <div class="card">
    <h3>生成选项</h3>
    <label class="field" style="margin-bottom: 12px">
      <span>输出目录（最终项目保存在这里；切换目录后可点「加载」恢复该项目的状态）</span>
      <div class="row">
        <input type="text" v-model="projectState.outputDir" style="flex: 3" />
        <button class="btn secondary" @click="browseOutputDir">浏览…</button>
        <button class="btn secondary" @click="loadProjectState">加载该项目状态</button>
      </div>
    </label>

    <div class="row" style="margin-bottom: 8px">
      <label style="display: flex; align-items: center; gap: 8px; flex: 1">
        <input type="checkbox" v-model="projectState.options.useImage" />
        <span>图像（立绘/背景/CG/物品）</span>
      </label>
      <label style="display: flex; align-items: center; gap: 8px; flex: 1">
        <input type="checkbox" v-model="projectState.options.useTts" />
        <span>配音（TTS，音色见角色卡）</span>
      </label>
      <label style="display: flex; align-items: center; gap: 8px; flex: 1">
        <input type="checkbox" v-model="projectState.options.characterIntroCard" />
        <span>角色登场资料卡</span>
      </label>
    </div>
    <div class="row" style="margin-bottom: 8px">
      <label style="display: flex; align-items: center; gap: 8px; flex: 1">
        <input type="checkbox" v-model="projectState.options.figureEmotions" />
        <span>表情差分（每角色 5 种表情立绘，对话按情绪切换）</span>
      </label>
      <label style="display: flex; align-items: center; gap: 8px; flex: 1">
        <input type="checkbox" v-model="projectState.options.useVideoPoints" />
        <span>视频推荐位（AI 标记+提示词，人工生成）</span>
      </label>
      <label style="display: flex; align-items: center; gap: 8px; flex: 1">
        <input type="checkbox" v-model="projectState.options.useBgm" />
        <span>BGM（匹配 game/bgm 文件夹音乐，按氛围自动播放）</span>
      </label>
    </div>
    <div class="row" style="margin-bottom: 8px">
      <label style="display: flex; align-items: center; gap: 8px; flex: 1">
        <input type="checkbox" v-model="projectState.options.skipCache" />
        <span>跳过缓存（全量重跑）</span>
      </label>
    </div>
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
        <span>每章视频推荐点数上限</span>
        <input type="number" v-model.number="projectState.options.videoPointsPerChapter" min="0" max="5" />
      </label>
    </div>

    <div v-if="projectState.novel" style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 4px">
      <div class="row" style="justify-content: space-between">
        <span style="font-size: 13px; color: var(--text-dim)">本次重跑章节（未勾选的章节复用已有缓存；无缓存则跳过）</span>
        <div class="row" style="flex: none">
          <button class="btn secondary small" @click="toggleAllRerun(true)">全选</button>
          <button class="btn secondary small" @click="toggleAllRerun(false)">全不选</button>
        </div>
      </div>
      <div class="row" style="margin-top: 8px; gap: 4px 14px">
        <label v-for="(ch, i) in projectState.novel.chapters" :key="i" style="display: flex; align-items: center; gap: 5px; font-size: 12px">
          <input
            type="checkbox"
            :checked="rerunChapters === null || rerunChapters.includes(ch.index)"
            @change="(e: any) => toggleChapterRerun(ch.index, (e.target as HTMLInputElement).checked)"
          />
          {{ ch.title }}
        </label>
      </div>
    </div>

    <div class="row" style="margin-top: 12px">
      <button class="btn" :disabled="busy" @click="start">
        {{ busy ? "生成中…" : "开始生成" }}
      </button>
      <button v-if="busy" class="btn danger" @click="stop">停止</button>
      <span v-if="error" style="color: var(--err)">{{ error }}</span>
    </div>
  </div>

  <div class="tabs">
    <button class="tab" :class="{ active: tab === 'run' }" @click="tab = 'run'">状态与费用</button>
    <button class="tab" :class="{ active: tab === 'cards' }" @click="tab = 'cards'">卡片编辑</button>
    <button class="tab" :class="{ active: tab === 'video' }" @click="tab = 'video'; checkVideos()">视频推荐位</button>
    <button class="tab" :class="{ active: tab === 'script' }" @click="tab = 'script'; loadScripts()">剧本</button>
    <button class="tab" :class="{ active: tab === 'log' }" @click="tab = 'log'">日志</button>
  </div>

  <div v-if="tab === 'run'">
    <div class="stat-grid">
      <div class="stat">
        <div class="label">章节</div>
        <div class="value">{{ projectState.novel?.chapters.filter((c) => c.enabled !== false).length ?? 0 }}</div>
      </div>
      <div class="stat">
        <div class="label">总字数</div>
        <div class="value">{{ (projectState.novel?.fullText.length ?? 0).toLocaleString() }}</div>
      </div>
      <div class="stat">
        <div class="label">素材</div>
        <div class="value">{{ projectState.materials.length }}</div>
      </div>
      <div class="stat">
        <div class="label">状态</div>
        <div class="value" :style="{ color: busy ? 'var(--warn)' : projectState.lastResult ? 'var(--ok)' : 'var(--text-dim)' }">
          {{ busy ? "运行中" : projectState.lastResult ? "已完成" : "未开始" }}
        </div>
      </div>
    </div>
    <div class="card" v-if="costText" style="margin-top: 16px">
      <h3>费用统计（估算）</h3>
      <div class="stat-grid">
        <div class="stat"><div class="label">LLM</div><div class="value" style="font-size: 15px">{{ costText.llm }}</div></div>
        <div class="stat"><div class="label">图像</div><div class="value" style="font-size: 15px">{{ costText.image }}</div></div>
        <div class="stat"><div class="label">配音</div><div class="value" style="font-size: 15px">{{ costText.tts }}</div></div>
        <div class="stat">
          <div class="label">合计</div>
          <div class="value" style="font-size: 15px; color: var(--accent-2)">
            ¥{{ ((projectState.lastResult?.cost.llmCostYuan ?? 0) + (projectState.lastResult?.cost.imageCostYuan ?? 0) + (projectState.lastResult?.cost.ttsCostYuan ?? 0)).toFixed(2) }}
          </div>
        </div>
      </div>
      <p style="color: var(--text-dim); font-size: 12px; margin-top: 10px">
        图像价格按 ¥0.3/张、文本按 ¥2+8/百万 token 估算。生成结果已磁盘缓存，重跑不重复计费。视频由你人工生成，不产生费用。
      </p>
    </div>
  </div>

  <div v-else-if="tab === 'cards'">
    <EditCards v-if="projectState.lastResult" :cards="projectState.lastResult.cards" @saved="onCardsSaved" />
    <div v-else class="empty">尚无生成结果，先运行一次生成</div>
  </div>

  <div v-else-if="tab === 'video'">
    <div class="card" v-if="videoPoints.length">
      <div class="row" style="justify-content: space-between; margin-bottom: 10px">
        <h3 style="margin-bottom: 0">AI 推荐的视频演出位（{{ videoPoints.length }} 个）</h3>
        <button class="btn secondary small" @click="checkVideos">刷新状态</button>
      </div>
      <p style="color: var(--text-dim); font-size: 12px; margin-bottom: 12px">
        提示词可粘贴到即梦/可灵等平台生成短视频，将 mp4 命名为
        <code>video_&lt;id&gt;.mp4</code> 放入 <code>game/video/</code> 后点击刷新，状态变为「已启用」即自动插入演出。零 API 费用。
      </p>
      <div v-for="vp in videoPoints" :key="vp.id" style="border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px">
        <div class="row" style="justify-content: space-between">
          <span>
            <span class="tag" :class="vp.enabled ? 'ok' : ''">{{ vp.enabled ? "已启用" : "未生成" }}</span>
            <span style="font-weight: 600">{{ vp.title }}</span>
            <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">第 {{ vp.chapter }} 章 · {{ vp.location }} · {{ vp.durationSecs }}s</span>
          </span>
          <button class="btn small" @click="copyText(vp.videoPrompt, '视频提示词')">复制提示词</button>
        </div>
        <p style="color: var(--text-dim); font-size: 12px; margin-top: 6px">{{ vp.description }}</p>
        <p style="font-size: 12px; margin-top: 6px; color: var(--text-dim)">
          文件名：<code>video_{{ sanitizeId(vp.id) }}.mp4</code> → <code>{{ projectState.outputDir }}/game/video/</code>
        </p>
      </div>
    </div>
    <div v-else class="empty">暂无视频推荐位（重新生成后出现）</div>
  </div>

  <div v-else-if="tab === 'script'">
    <div class="card" v-if="scriptFiles.length">
      <div class="row" style="justify-content: space-between">
        <div class="row" style="flex: 1">
          <select v-model="currentScript" style="flex: 1">
            <option v-for="f in scriptFiles" :key="f.name" :value="f.name">{{ f.name }}</option>
          </select>
          <button class="btn secondary small" @click="tauri.openInExplorer(projectState.outputDir + '/game/scene')">打开剧本文件夹</button>
        </div>
      </div>
      <pre style="background: #0b0e14; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-top: 10px; max-height: 420px; overflow: auto; font-size: 12px; line-height: 1.7; white-space: pre-wrap">{{ scriptFiles.find((f) => f.name === currentScript)?.text }}</pre>
    </div>
    <div v-else class="empty">暂无剧本文件（生成后出现）</div>
  </div>

  <div v-else>
    <div class="card">
      <div class="row" style="justify-content: flex-end; margin-bottom: 8px">
        <button class="btn secondary small" @click="copyLogs">复制全部日志</button>
      </div>
      <div class="log-panel" ref="logPanelRef">
        <div v-for="(l, i) in projectState.logs" :key="i" class="log-line" :class="l.level">
          <span class="time">{{ new Date(l.at).toLocaleTimeString() }}</span>
          <span>[{{ l.step }}] </span>{{ l.message }}
        </div>
      </div>
    </div>
  </div>
  <p v-if="copiedMsg" style="color: var(--ok); font-size: 12px; margin-top: 6px">{{ copiedMsg }}</p>
</template>

<script lang="ts">
export default { name: "GeneratePage" };
</script>
