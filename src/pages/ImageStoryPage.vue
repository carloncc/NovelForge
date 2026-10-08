<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { t, formatLogTime } from "../i18n";
import PageHead from "../components/PageHead.vue";
import LazyThumb from "../components/LazyThumb.vue";
import AssetPreview from "../components/AssetPreview.vue";
import { projectState } from "../stores/project";
import { LANGUAGES } from "../core/types";
import {
  imageStoryState,
  imageStoryDirForeign,
  imageStoryEstimate,
  imageStoryShots,
  imageStoryMissingShots,
  loadImageStoryState,
  runImageStory,
  stopImageStory,
  retryFailedImages,
  regenerateShot,
  startImageStoryPreview,
  stopImageStoryPreview,
  openImageStoryPreviewInBrowser,
  exportImageStoryZip,
  setImageStoryDir,
  followMainProjectDir,
  goImport,
} from "../stores/imageStory";
import { isTauri, blessParentDir } from "../utils/tauri";
import { errMsg } from "../utils/errors";

const preview = ref<{ path: string; label: string } | null>(null);
const busy = computed(() => imageStoryState.running);
const failed = computed(() => imageStoryState.failed);

const enabledChapterCount = computed(() => projectState.novel?.chapters.filter((c) => c.enabled !== false).length ?? 0);

/** 是否有可预览/可导出的产物：分镜图片已落盘 */
const hasProducts = computed(() => imageStoryShots.value.length > 0);

/** 计划分镜张数：优先用已生成剧本的计划，其次按剧本实际分镜数汇总 */
const plannedShots = computed(() => {
  const fromPlan = imageStoryState.plan?.shots ?? 0;
  if (fromPlan > 0) return fromPlan;
  let n = 0;
  for (const c of imageStoryState.chapters) for (const s of c.scenes) n += s.shots?.length ?? 0;
  return n;
});

/** 已产出分镜数：运行中取实时计数，重载后回落到实际分镜文件数（钳制不超过计划） */
const shotsDone = computed(() => {
  const raw = Math.max(imageStoryState.produced, imageStoryShots.value.length);
  return plannedShots.value > 0 ? Math.min(raw, plannedShots.value) : raw;
});

/** 阶段看板：显示当前进行到哪一步与各步计数（本页只做状态显示，不做单阶段重跑） */
const stageBoard = computed(() => {
  const s = imageStoryState.stage;
  const cards = imageStoryState.cards;
  const steps: { label: string; active: boolean; detail: string }[] = [
    {
      label: "提取",
      active: s === "提取",
      detail: cards ? t("{n} 角色 / {m} 场景", { n: cards.characters.length, m: cards.scenes?.length ?? 0 }) : "",
    },
    { label: "剧本", active: s === "剧本", detail: imageStoryState.chapters.length ? `${imageStoryState.chapters.length} ${t("章")}` : "" },
  ];
  if (imageStoryState.useVoice) steps.push({ label: "配音", active: s === "配音", detail: "" });
  steps.push({ label: "图片", active: s === "图片", detail: imageStoryShots.value.length ? `${imageStoryShots.value.length} ${t("张")}` : "" });
  steps.push({ label: "组装", active: s === "组装", detail: "" });
  return steps;
});

/* ---- 日志：常驻 + 自动滚底（用户上翻查看历史时不强制拽回，与主管线同口径） ---- */
const logPanelRef = ref<HTMLElement | null>(null);
/** 本地「清空」：按时间点过滤显示，不改 store 的日志数组语义 */
const logClearedAt = ref(0);
const visibleLogs = computed(() => imageStoryState.logs.filter((l) => l.at > logClearedAt.value));
const copiedMsg = ref("");
let copiedMsgTimer: number | undefined;

function flashCopied(msg: string): void {
  copiedMsg.value = msg;
  if (copiedMsgTimer !== undefined) window.clearTimeout(copiedMsgTimer);
  copiedMsgTimer = window.setTimeout(() => {
    copiedMsg.value = "";
    copiedMsgTimer = undefined;
  }, 2500);
}

function clearLogs(): void {
  logClearedAt.value = Date.now();
}

async function copyLogs(): Promise<void> {
  const text = visibleLogs.value.map((l) => `[${formatTime(l.at)}] [${t(l.step)}] ${l.message}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    flashCopied(t("日志已复制"));
  } catch {
    flashCopied(t("日志复制失败（浏览器限制了剪贴板权限）"));
  }
}

watch(
  () => imageStoryState.logs.length,
  async () => {
    // 追加前先记住用户是否在底部：向上翻阅历史日志时不能被新日志强行拽回底部
    const panel = logPanelRef.value;
    const wasAtBottom = !panel || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40;
    await nextTick();
    if (wasAtBottom && logPanelRef.value) logPanelRef.value.scrollTop = logPanelRef.value.scrollHeight;
  },
);

function formatTime(ms: number): string {
  return formatLogTime(ms);
}

async function pickDir(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, defaultPath: imageStoryState.outputDir || projectState.outputDir });
    if (typeof picked === "string" && picked) {
      // #1520：选定的输出目录会被后续读写；先登记，否则白名单外的目录一律拒绝
      await blessParentDir(picked);
      setImageStoryDir(picked.replace(/\\/g, "/"));
    }
  } catch (e) {
    imageStoryState.lastError = errMsg(e).slice(0, 200);
  }
}

onMounted(() => {
  void loadImageStoryState();
});
onBeforeUnmount(() => {
  if (copiedMsgTimer !== undefined) window.clearTimeout(copiedMsgTimer);
  // #1102：预览服务器是全局单例，只停自己启动的预览，避免把其他页面的预览一起停掉
  if (imageStoryState.previewRunning) {
    void stopImageStoryPreview();
  }
});
</script>

<template>
  <div class="inner">
    <PageHead :title="t('图片小说')" :sub="t('纯图片模式：全屏插画随对话切换，没有立绘与人物演出 UI')" />

    <div v-if="!projectState.novel" class="card empty-next">
      <p class="hint">{{ t("还没有小说：导入小说（或加载示例小说）后即可生成图片版。") }}</p>
      <button class="btn small" @click="goImport">{{ t("去导入小说") }}</button>
    </div>

    <template v-else>
      <!-- 核心操作：常驻显示；不可用时禁用并说明原因（不再整块藏起来） -->
      <div class="card">
        <div class="card-head">
          <h3>{{ t("运行") }}</h3>
          <div class="card-actions">
            <span v-if="imageStoryState.previewRunning" class="tag ok">{{ t("预览已启动") }}</span>
          </div>
        </div>
        <div class="row items-center gap-2" style="flex-wrap: wrap">
          <button class="btn" :disabled="busy" :title="busy ? t('生成中：请等待本次运行结束，或先点「停止」') : ''" @click="runImageStory">
            <span v-if="busy" class="spinner" />
            {{ busy ? t("生成中…") : t("开始生成") }}
          </button>
          <button
            class="btn danger"
            :disabled="!busy || imageStoryState.stopping"
            :title="busy ? t('停止') : t('没有正在进行的运行')"
            @click="stopImageStory"
          >
            {{ imageStoryState.stopping ? t("正在停止…") : t("停止") }}
          </button>
          <button
            class="btn secondary"
            :disabled="busy || !hasProducts"
            :title="busy ? t('生成中：请等待本次运行结束，或先点「停止」') : hasProducts ? t('预览') : t('预览不可用：还没有分镜产物，请先「开始生成」')"
            @click="startImageStoryPreview"
          >
            {{ t("预览") }}
          </button>
          <button
            class="btn secondary"
            :disabled="busy || imageStoryState.zipBusy || !hasProducts"
            :title="busy ? t('生成中：请等待本次运行结束，或先点「停止」') : hasProducts ? t('导出 zip') : t('导出不可用：还没有分镜产物，请先「开始生成」')"
            @click="exportImageStoryZip"
          >
            <span v-if="imageStoryState.zipBusy" class="spinner" />
            {{ imageStoryState.zipBusy ? t("打包中…") : t("导出 zip") }}
          </button>
          <button v-if="imageStoryState.previewRunning" class="btn ghost small" @click="openImageStoryPreviewInBrowser">{{ t("系统浏览器打开") }}</button>
          <button v-if="imageStoryState.previewRunning" class="btn ghost small" :disabled="busy" @click="stopImageStoryPreview">{{ t("停止预览") }}</button>
          <span class="grow" />
          <span v-if="plannedShots > 0" class="hint">{{ t("分镜进度 {done}/{total}", { done: shotsDone, total: plannedShots }) }}</span>
          <span v-else class="hint">{{ t("已生成 {n} 张", { n: imageStoryState.produced }) }}</span>
          <span v-if="failed.length" class="tag warn">{{ t("失败 {n} 张", { n: failed.length }) }}</span>
        </div>
        <p class="hint mt-2">
          {{ t("阶段") }}：{{
            imageStoryState.stage
              ? t(imageStoryState.stage)
              : imageStoryState.useVoice
                ? t("提取 → 分镜剧本 → 图片 → 配音 → 组装（复用缓存，只补缺失）")
                : t("提取 → 分镜剧本 → 图片 → 组装（复用缓存，只补缺失）")
          }}
        </p>
        <div class="steps mt-2 stage-steps">
          <template v-for="(st, i) in stageBoard" :key="st.label">
            <div v-if="i > 0" class="step-connector" />
            <div class="step-item" :class="{ active: st.active }">
              <span class="step-dot">{{ i + 1 }}</span>
              <span>{{ t(st.label) }}<span v-if="st.detail" class="faint small"> · {{ st.detail }}</span></span>
            </div>
          </template>
        </div>
        <div v-if="imageStoryState.progress" class="progress-bar mt-2">
          <div
            class="progress-fill"
            :style="{ width: `${Math.round((imageStoryState.progress.done / Math.max(1, imageStoryState.progress.total)) * 100)}%` }"
          />
        </div>
        <p v-if="imageStoryState.progress" class="hint mt-1">{{ imageStoryState.progress.done }}/{{ imageStoryState.progress.total }}</p>
        <p v-if="imageStoryState.lastError" class="hint mt-2" style="color: var(--err)">{{ imageStoryState.lastError }}</p>
        <div v-if="failed.length" class="vb-banner mt-2">
          <div>
            <strong>{{ t("失败 {n} 张", { n: failed.length }) }}</strong>
            <p class="hint">{{ failed.slice(0, 3).map((f) => `${f.label}：${f.message}`).join("；") }}</p>
          </div>
          <button class="btn secondary small" :disabled="busy" @click="retryFailedImages">{{ t("重试失败项") }}</button>
        </div>
      </div>

      <!-- 项目与输出目录 -->
      <div class="card">
        <div class="card-head">
          <h3>{{ t("项目") }}</h3>
          <div class="card-actions">
            <span class="tag ok">{{ t("沿用主项目分章") }}（{{ enabledChapterCount }} {{ t("章") }}）</span>
            <span v-if="imageStoryState.cards" class="tag ok" :title="imageStoryState.cards.title || ''">
              {{ t("卡片已就绪") }}（{{ imageStoryState.cards.title || projectState.novel?.fileName || "" }}）
            </span>
            <span v-if="imageStoryState.chapters.length" class="tag ok">{{ t("剧本") }} {{ imageStoryState.chapters.length }}</span>
          </div>
        </div>
        <div class="row items-center gap-2" style="flex-wrap: wrap">
          <input
            type="text"
            class="grow"
            :value="imageStoryState.outputDir"
            :title="imageStoryState.outputDir"
            :disabled="busy"
            @change="setImageStoryDir(($event.target as HTMLInputElement).value)"
          />
          <button v-if="isTauri()" class="link-btn" :disabled="busy" @click="pickDir">{{ t("选择目录") }}</button>
          <button class="link-btn" :disabled="busy" @click="followMainProjectDir">{{ t("按当前作品重算目录") }}</button>
        </div>
        <p class="hint mt-2">{{ t("独立输出目录：与立绘版产物互不覆盖；缓存与状态各自独立。") }}</p>
        <p v-if="imageStoryDirForeign" class="hint mt-2" style="color: var(--warn)">
          {{ t("当前图片版目录属于其他作品：继续生成会与旧书产物混在一起。如需为当前作品新建目录，请点「按当前作品重算目录」。") }}
        </p>
      </div>

      <!-- 计划与选项 -->
      <div class="card">
        <div class="card-head">
          <h3>{{ t("张数与费用") }}</h3>
          <div class="card-actions">
            <span v-if="imageStoryEstimate.exact" class="hint">
              {{ t("预计最多 {n} 张图片 ≈ {yuan} 元（命中缓存不重复计费）", { n: imageStoryEstimate.total, yuan: imageStoryEstimate.yuan.toFixed(1) }) }}
            </span>
            <span v-else class="hint">
              {{ t("粗估 ≈ {n} 张图片 ≈ {yuan} 元（命中缓存不重复计费）", { n: imageStoryEstimate.total, yuan: imageStoryEstimate.yuan.toFixed(1) }) }}
            </span>
          </div>
        </div>
        <p v-if="imageStoryEstimate.unbounded" class="hint mt-2">
          {{ t("当前不限上限，实际张数以剧本产出为准（上值为按每场景 2 张的粗估）。") }}
        </p>
        <p v-else-if="!imageStoryEstimate.exact && imageStoryState.options.shotsTotal > 0" class="hint mt-2">
          {{ t("已按总张数上限 {n} 封顶（粗估）。", { n: imageStoryState.options.shotsTotal }) }}
        </p>
        <div class="opt-grid">
          <label class="opt-item">
            <span>{{ t("每场景张数（0=不限）") }}</span>
            <input type="number" min="0" style="width: 80px" v-model.number="imageStoryState.options.shotsPerScene" :disabled="busy" />
          </label>
          <label class="opt-item">
            <span>{{ t("每章上限（0=不限）") }}</span>
            <input type="number" min="0" style="width: 80px" v-model.number="imageStoryState.options.shotsPerChapter" :disabled="busy" />
          </label>
          <label class="opt-item">
            <span>{{ t("总张数上限（0=不限，到达后暂停可续跑）") }}</span>
            <input type="number" min="0" style="width: 80px" v-model.number="imageStoryState.options.shotsTotal" :disabled="busy" />
          </label>
          <label class="opt-item">
            <span>{{ t("统一画风") }}</span>
            <input type="text" class="grow" v-model="imageStoryState.options.imageStyle" :placeholder="t('例：unified Japanese anime style, cel shading, clean line art')" :disabled="busy" />
          </label>
          <label class="opt-item" :title="t('只影响台词/旁白的写作风格，不影响画面；改画风不会让剧本重写')">
            <span>{{ t("剧本文风（留空用默认；改画风不会重写剧本）") }}</span>
            <input type="text" class="grow" v-model="imageStoryState.scriptStyle" :placeholder="t('例：冷峻简洁的短句对白')" :disabled="busy" />
          </label>
        </div>

        <!-- 配音/自检/BGM/SE/目标语言：从折叠里提到主配置区，直接可见并各带一句话说明 -->
        <div class="card-section">
          <div class="opt-grid">
            <label class="opt-item opt-stack" :title="t('复用主项目 TTS 配置与音色库：按台词行合成语音，产物随组装进入游戏')">
              <input type="checkbox" v-model="imageStoryState.useVoice" />
              <span class="opt-text">
                {{ t("配音（TTS）") }}
                <span class="hint">{{ t("开启后按台词行合成语音（TTS 计费，命中缓存不重复计费）；失败会进入下方失败清单，可用「重试失败项」补配") }}</span>
              </span>
            </label>
            <label class="opt-item opt-stack" :title="t('使用独立图像识别 API 核对生成图，不合格自动重生成 1 次（会增加费用与耗时）')">
              <input type="checkbox" v-model="imageStoryState.options.imageSelfCheck" :disabled="busy" />
              <span class="opt-text">
                {{ t("图像自检（多模态核对，不合格自动重生成）") }}
                <span class="hint">{{ t("使用独立图像识别 API 核对生成图，不合格自动重生成 1 次（会增加费用与耗时）") }}</span>
              </span>
            </label>
            <label class="opt-item opt-stack">
              <input type="checkbox" v-model="imageStoryState.useBgm" :disabled="busy" />
              <span class="opt-text">
                {{ t("背景音乐（BGM）") }}
                <span class="hint">{{ t("组装时按场景匹配项目 bgm 文件夹的音乐写入游戏（本地免费；切换开关后需重新点「开始生成」组装才生效）") }}</span>
              </span>
            </label>
            <label class="opt-item opt-stack">
              <input type="checkbox" v-model="imageStoryState.useSe" :disabled="busy" />
              <span class="opt-text">
                {{ t("环境音效（SE）") }}
                <span class="hint">{{ t("按场景氛围播放内置雨/雷/风等音效（本地免费；切换开关后需重新组装生效）") }}</span>
              </span>
            </label>
          </div>
          <div class="field-grid mt-3">
            <div class="field">
              <span>{{ t("目标语言（留空用原文；复用主项目翻译缓存）") }}</span>
              <select v-model="imageStoryState.options.language" :disabled="busy">
                <option value="">{{ t("不翻译（使用原文）") }}</option>
                <option v-for="l in LANGUAGES" :key="l.code" :value="l.code">{{ l.label }}</option>
              </select>
              <span class="hint">{{ t("选了语言会多跑一次翻译阶段，之后全部阶段都用译文") }}</span>
            </div>
          </div>
        </div>

        <details class="mt-2">
          <summary class="hint" style="cursor: pointer">{{ t("高级设置") }}</summary>
          <div class="opt-grid mt-2">
            <label class="opt-item" :title="t('固定所有图片生成的随机种子：同一种子下背景/CG/立绘的画风与角色更稳定一致。0 = 按小说标题自动派生')">
              <span>{{ t("固定种子（0 = 按标题自动派生）") }}</span>
              <input type="number" min="0" style="width: 100px" v-model.number="imageStoryState.options.imageSeed" :disabled="busy" />
            </label>
            <label class="opt-item" :title="t('图片小说模式不展示物品图：渲染端只出文字卡、鉴赏室也不收录，生成即浪费费用，故已禁用')">
              <input type="checkbox" v-model="imageStoryState.options.includeItems" disabled /> {{ t("生成物品图（默认关闭）") }}
              <span class="hint">{{ t("图片小说模式不展示物品图，已自动跳过（开启也不会生成）") }}</span>
            </label>
            <label class="opt-item" :title="t('图片小说模式暂不支持风格锚点：分镜不引用锚点参考图，为避免无效计费已停止生成锚点图')">
              <input type="checkbox" v-model="imageStoryState.options.styleAnchor" disabled /> {{ t("风格锚点（图片小说暂不支持，已自动跳过）") }}
              <span class="hint">{{ t("图片小说分镜不引用锚点参考图：开启也不会生成、不计费") }}</span>
            </label>
          </div>
        </details>
      </div>

      <!-- 分镜结果 -->
      <div v-if="imageStoryShots.length || imageStoryMissingShots.length" class="card">
        <div class="card-head">
          <h3>{{ t("分镜结果") }}</h3>
          <div class="card-actions">
            <span class="hint">{{ imageStoryShots.reduce((n, g) => n + g.shots.length, 0) }} {{ t("张") }}</span>
          </div>
        </div>
        <div v-for="group in imageStoryShots" :key="group.chapter" class="mb-3">
          <div class="stage-row-label" style="margin-bottom: 6px">
            <b>{{ group.title || t("第 {n} 章", { n: group.chapter + 1 }) }}</b>
            <span class="faint small">{{ group.shots.length }} {{ t("张") }}</span>
          </div>
          <div class="shot-grid">
            <div v-for="s in group.shots" :key="s.id" class="shot-cell">
              <LazyThumb :path="s.path" :alt="s.note" class="shot-thumb" @click="preview = { path: s.path, label: s.note }" />
              <div class="shot-actions">
                <button class="link-btn" @click="preview = { path: s.path, label: s.note }">{{ t("放大") }}</button>
                <button
                  class="link-btn"
                  :disabled="busy"
                  :title="t('无图像 API 或该分镜被当前张数设置排除时，点击会在日志中提示原因')"
                  @click="regenerateShot(s.id)"
                >
                  {{ t("重生成这张") }}
                </button>
              </div>
            </div>
          </div>
        </div>
        <!-- #1402：缺失块与 v-for 平级（此前误嵌在 group/shot-grid 内导致重复 N 次、零成功分镜时不可见） -->
        <div v-if="imageStoryMissingShots.length" class="mb-3">
          <div class="stage-row-label" style="margin-bottom: 6px">
            <b>{{ t("缺失分镜（{n} 张未生成）", { n: imageStoryMissingShots.length }) }}</b>
            <span class="faint small">{{ t("点「补跑缺失分镜」补跑（命中缓存不重复计费）") }}</span>
            <!-- #1403：独立补跑入口（不依赖 failed 列表；failed 为空时「重试失败项」不存在） -->
            <button class="btn secondary small" :disabled="busy" @click="retryFailedImages">{{ t("补跑缺失分镜") }}</button>
          </div>
          <p v-if="imageStoryState.options.shotsTotal > 0" class="hint mt-1">
            {{ t("已达总张数上限时缺失分镜不在计划内：请提高总张数上限后重试") }}
          </p>
          <div class="shot-grid">
            <div v-for="m in imageStoryMissingShots.slice(0, 24)" :key="m.id" class="shot-cell">
              <div class="shot-thumb" style="display: flex; align-items: center; justify-content: center; background: var(--panel); border: 1px dashed var(--border)">
                <span class="hint">{{ m.title || t("第 {n} 章", { n: m.chapter + 1 }) }} · {{ m.note }}</span>
              </div>
              <div class="shot-actions">
                <span class="hint">{{ m.id }}</span>
              </div>
            </div>
          </div>
          <p v-if="imageStoryMissingShots.length > 24" class="hint mt-1">
            {{ t("还有 {n} 张缺失分镜未列出", { n: imageStoryMissingShots.length - 24 }) }}
          </p>
        </div>
      </div>
      <div v-else class="card empty-next">
        <p class="hint">{{ t("还未生成任何分镜：点上方「开始生成」") }}</p>
      </div>

      <!-- 日志：常驻（无日志显示空态），新日志自动滚到底 -->
      <div class="card">
        <div class="card-head">
          <h3>{{ t("运行日志") }}</h3>
          <div class="card-actions">
            <span class="hint" style="align-self: center">{{ t("最近 {n} 条", { n: visibleLogs.length }) }}</span>
            <button class="btn secondary small" :disabled="!visibleLogs.length" @click="copyLogs">{{ t("复制") }}</button>
            <button class="btn ghost small" :disabled="!visibleLogs.length" @click="clearLogs">{{ t("清空") }}</button>
          </div>
        </div>
        <div ref="logPanelRef" class="log-panel image-story-log">
          <div v-for="(l, i) in visibleLogs" :key="`${i}:${l.at}`" class="log-line" :class="l.level">
            <span class="time">{{ formatTime(l.at) }}</span>
            <span class="step-badge">{{ t(l.step) }}</span>
            <span>{{ l.message }}</span>
          </div>
          <p v-if="!visibleLogs.length" class="faint small">{{ t("暂无日志：开始生成后会在这里实时滚动显示") }}</p>
        </div>
        <p v-if="copiedMsg" class="hint mt-2" style="color: var(--ok)">{{ copiedMsg }}</p>
      </div>
    </template>
  </div>

  <AssetPreview v-if="preview" :path="preview.path" :label="preview.label" @close="preview = null" />
</template>

<style scoped>
.shot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}
.shot-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.shot-thumb {
  width: 100%;
  aspect-ratio: 3 / 2;
  cursor: zoom-in;
}
.shot-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
/* 阶段看板复用全局 .steps，去掉它自带的下外边距 */
.stage-steps {
  margin-bottom: 0;
}
/* 日志常驻：比全局默认更高，便于查看；配合自动滚底 */
.image-story-log {
  max-height: min(40vh, 320px);
}
/* 勾选项「标题 + 说明」上下排布（与主配置区一致） */
.opt-stack {
  align-items: flex-start;
}
.opt-stack input[type="checkbox"] {
  margin-top: 2px;
}
.opt-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* div.field 不在全局 `label.field > span` 覆盖内，这里统一字段标题样式 */
.field > span {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 5px;
  font-weight: 500;
}
/* 全局 label.field > span 会命中尾部的 hint：还原为普通提示字重与间距 */
.field > .hint {
  display: block;
  font-weight: 400;
  margin-bottom: 0;
}
</style>
