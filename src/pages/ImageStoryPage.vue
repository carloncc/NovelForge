<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { currentLang, t } from "../i18n";
import PageHead from "../components/PageHead.vue";
import LazyThumb from "../components/LazyThumb.vue";
import AssetPreview from "../components/AssetPreview.vue";
import { projectState } from "../stores/project";
import {
  imageStoryState,
  imageStoryEstimate,
  imageStoryShots,
  loadImageStoryState,
  runImageStory,
  stopImageStory,
  retryFailedImages,
  regenerateShot,
  startImageStoryPreview,
  exportImageStoryZip,
  setImageStoryDir,
  goImport,
} from "../stores/imageStory";
import { tauri, isTauri } from "../utils/tauri";
import { errMsg } from "../utils/errors";

const preview = ref<{ path: string; label: string } | null>(null);
const busy = computed(() => imageStoryState.running);
const failed = computed(() => imageStoryState.failed);

const enabledChapterCount = computed(() => projectState.novel?.chapters.filter((c) => c.enabled !== false).length ?? 0);

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(currentLang.value === "zh-CN" ? "zh-CN" : currentLang.value);
}

async function pickDir(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, defaultPath: imageStoryState.outputDir || projectState.outputDir });
    if (typeof picked === "string" && picked) setImageStoryDir(picked.replace(/\\/g, "/"));
  } catch (e) {
    imageStoryState.lastError = errMsg(e).slice(0, 200);
  }
}

onMounted(() => {
  void loadImageStoryState();
});
onBeforeUnmount(() => {
  void tauri.stopPreviewServer().catch(() => undefined);
});
</script>

<template>
  <div class="inner">
    <PageHead :title="t('图片小说')" :sub="t('纯图片模式：全屏插画随对话切换，没有立绘与人物演出 UI')">
      <button v-if="busy" class="btn danger" :disabled="imageStoryState.stopping" @click="stopImageStory">
        {{ imageStoryState.stopping ? t("正在停止…") : t("停止") }}
      </button>
    </PageHead>

    <div v-if="!projectState.novel" class="card empty-next">
      <p class="hint">{{ t("还没有小说：导入小说（或加载示例小说）后即可生成图片版。") }}</p>
      <button class="btn small" @click="goImport">{{ t("去导入小说") }}</button>
    </div>

    <template v-else>
      <!-- 项目与输出目录 -->
      <div class="card">
        <div class="card-head">
          <h3>{{ t("项目") }}</h3>
          <div class="card-actions">
            <span class="tag ok">{{ t("沿用主项目分章") }}（{{ enabledChapterCount }} {{ t("章") }}）</span>
            <span v-if="imageStoryState.cards" class="tag ok">{{ t("卡片已就绪") }}</span>
            <span v-if="imageStoryState.chapters.length" class="tag ok">{{ t("剧本") }} {{ imageStoryState.chapters.length }}</span>
          </div>
        </div>
        <div class="row items-center gap-2" style="flex-wrap: wrap">
          <input
            type="text"
            class="grow"
            :value="imageStoryState.outputDir"
            :title="imageStoryState.outputDir"
            @change="setImageStoryDir(($event.target as HTMLInputElement).value)"
          />
          <button v-if="isTauri()" class="link-btn" :disabled="busy" @click="pickDir">{{ t("选择目录") }}</button>
        </div>
        <p class="hint mt-2">{{ t("独立输出目录：与立绘版产物互不覆盖；缓存与状态各自独立。") }}</p>
      </div>

      <!-- 计划与选项 -->
      <div class="card">
        <div class="card-head">
          <h3>{{ t("张数与费用") }}</h3>
          <div class="card-actions">
            <span class="hint">
              {{ t("预计最多 {n} 张图片 ≈ {yuan} 元（命中缓存不重复计费）", { n: imageStoryEstimate.total, yuan: imageStoryEstimate.yuan.toFixed(1) }) }}
            </span>
          </div>
        </div>
        <div class="opt-grid">
          <label class="opt-item">
            <span>{{ t("每场景张数（0=不限）") }}</span>
            <input type="number" min="0" style="width: 80px" v-model.number="imageStoryState.options.shotsPerScene" />
          </label>
          <label class="opt-item">
            <span>{{ t("每章上限（0=不限）") }}</span>
            <input type="number" min="0" style="width: 80px" v-model.number="imageStoryState.options.shotsPerChapter" />
          </label>
          <label class="opt-item">
            <span>{{ t("总张数上限（0=不限，到达后暂停可续跑）") }}</span>
            <input type="number" min="0" style="width: 80px" v-model.number="imageStoryState.options.shotsTotal" />
          </label>
          <label class="opt-item">
            <span>{{ t("统一画风") }}</span>
            <input type="text" class="grow" v-model="imageStoryState.options.imageStyle" :placeholder="t('例：unified Japanese anime style, cel shading, clean line art')" />
          </label>
        </div>
        <details class="mt-2">
          <summary class="hint" style="cursor: pointer">{{ t("高级设置") }}</summary>
          <div class="opt-grid mt-2">
            <label class="opt-item" :title="t('固定所有图片生成的随机种子：同一种子下背景/CG/立绘的画风与角色更稳定一致。0 = 按小说标题自动派生')">
              <span>{{ t("固定种子（0 = 按标题自动派生）") }}</span>
              <input type="number" min="0" style="width: 100px" v-model.number="imageStoryState.options.imageSeed" />
            </label>
            <label class="opt-item" :title="t('使用独立图片识别 API 核对生成图，不合格自动重生成 1 次（会增加费用与耗时）')">
              <input type="checkbox" v-model="imageStoryState.options.imageSelfCheck" /> {{ t("图像自检（多模态核对，不合格自动重生成）") }}
            </label>
            <label class="opt-item">
              <input type="checkbox" v-model="imageStoryState.options.includeItems" /> {{ t("生成物品图（默认关闭）") }}
            </label>
            <label class="opt-item" :title="t('先生成一张全项目画风基准图，背景/CG 以其为参考图，强制所有图片画风统一（推荐开启）')">
              <input type="checkbox" v-model="imageStoryState.options.styleAnchor" /> {{ t("风格锚点（背景/CG 统一画风）") }}
            </label>
            <label class="opt-item">
              <span>{{ t("目标语言（留空用原文；复用主项目翻译缓存）") }}</span>
              <select v-model="imageStoryState.options.language">
                <option value="">{{ t("不翻译（使用原文）") }}</option>
                <option value="en">English</option>
                <option value="ja">日本語</option>
                <option value="ko">한국어</option>
              </select>
            </label>
          </div>
        </details>
      </div>

      <!-- 运行 -->
      <div class="card">
        <div class="row items-center gap-3" style="flex-wrap: wrap">
          <button class="btn" :disabled="busy" @click="runImageStory">
            <span v-if="busy" class="spinner" />
            {{ busy ? t("生成中…") : t("开始生成") }}
          </button>
          <span class="hint">{{ imageStoryState.stage || t("提取 → 分镜剧本 → 图片 → 组装（复用缓存，只补缺失）") }}</span>
          <span class="grow" />
          <span class="hint">{{ t("已生成 {n} 张", { n: imageStoryState.produced }) }}</span>
          <span v-if="failed.length" class="tag warn">{{ t("失败 {n} 张", { n: failed.length }) }}</span>
        </div>
        <div v-if="imageStoryState.progress" class="progress-bar mt-2">
          <div
            class="progress-fill"
            :style="{ width: `${Math.round((imageStoryState.progress.done / Math.max(1, imageStoryState.progress.total)) * 100)}%` }"
          />
        </div>
        <p v-if="imageStoryState.progress" class="hint mt-1">
          {{ imageStoryState.progress.done }}/{{ imageStoryState.progress.total }}
        </p>
        <p v-if="imageStoryState.lastError" class="hint mt-2" style="color: var(--err)">{{ imageStoryState.lastError }}</p>
        <div v-if="failed.length" class="vb-banner mt-2">
          <div>
            <strong>{{ t("失败 {n} 张", { n: failed.length }) }}</strong>
            <p class="hint">{{ failed.slice(0, 3).map((f) => `${f.label}：${f.message}`).join("；") }}</p>
          </div>
          <button class="btn secondary small" :disabled="busy" @click="retryFailedImages">{{ t("重试失败项") }}</button>
        </div>
      </div>

      <!-- 分镜结果 -->
      <div v-if="imageStoryShots.length" class="card">
        <div class="card-head">
          <h3>{{ t("分镜结果") }}</h3>
          <div class="card-actions">
            <button class="btn secondary small" :disabled="busy" @click="startImageStoryPreview">{{ t("预览") }}</button>
            <button class="btn secondary small" :disabled="busy || imageStoryState.zipBusy" @click="exportImageStoryZip">
              <span v-if="imageStoryState.zipBusy" class="spinner" /> {{ imageStoryState.zipBusy ? t("打包中…") : t("导出 zip") }}
            </button>
          </div>
        </div>
        <div v-for="group in imageStoryShots" :key="group.chapter" class="mb-3">
          <div class="stage-row-label" style="margin-bottom: 6px">
            <b>{{ group.title || `${t("第")}${group.chapter + 1}${t("章")}` }}</b>
            <span class="faint small">{{ group.shots.length }} {{ t("张") }}</span>
            <span v-if="imageStoryState.previewUrl" class="tag ok">{{ t("预览已启动") }}</span>
          </div>
          <div class="shot-grid">
            <div v-for="s in group.shots" :key="s.id" class="shot-cell">
              <LazyThumb :path="s.path" :alt="s.note" class="shot-thumb" @click="preview = { path: s.path, label: s.note }" />
              <div class="shot-actions">
                <button class="link-btn" @click="preview = { path: s.path, label: s.note }">{{ t("放大") }}</button>
                <button class="link-btn" :disabled="busy" @click="regenerateShot(s.id)">{{ t("重生成这张") }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="card empty-next">
        <p class="hint">{{ t("还未生成任何分镜：点「开始生成」") }}</p>
      </div>

      <!-- 日志 -->
      <div v-if="imageStoryState.logs.length" class="card">
        <div class="card-head">
          <h3>{{ t("运行日志") }}</h3>
        </div>
        <div class="log-panel" style="max-height: 200px">
          <div v-for="(l, i) in imageStoryState.logs" :key="`${i}:${l.at}`" class="log-line" :class="l.level">
            <span class="time">{{ formatTime(l.at) }}</span>
            <span class="step-badge">{{ t(l.step) }}</span>
            <span>{{ l.message }}</span>
          </div>
        </div>
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
</style>
