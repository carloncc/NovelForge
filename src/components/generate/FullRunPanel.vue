<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../i18n";
import { STAGE_LABELS, STAGE_ORDER } from "../../core/types";
import { goPage } from "../../stores/nav";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const {
  selectedStages,
  stageHint,
  start,
  busy,
  assetBusy,
  queueRunning,
  rerunChapters,
  toggleChapterRerun,
  toggleAllRerun,
  imagePlanText,
} = useGenerateController();

const stageCount = computed(() => STAGE_ORDER.filter((s) => selectedStages.value[s]).length);

/** 停用章不参与生成：计数只看启用章，避免「已勾选 12 章」实际只跑 10 章 */
function isChapterEnabled(index: number): boolean {
  return projectState.novel?.chapters.find((c) => c.index === index)?.enabled !== false;
}
const chapterSummary = computed(() => {
  if (rerunChapters.value === null) return t("全书");
  const n = rerunChapters.value.filter(isChapterEnabled).length;
  return `${t("已勾选")} ${n} ${t("章")}`;
});

/** 主按钮下方的范围说明：避免按钮写着「整书」实际只跑勾选章节；停用章不计入 */
const scopeHint = computed(() => {
  const scope = rerunChapters.value === null
    ? t("全书")
    : `${t("已勾选")} ${rerunChapters.value.filter(isChapterEnabled).length} ${t("章")}`;
  return `${t("阶段")} ${stageCount.value}/${STAGE_ORDER.length} · ${scope}`;
});
const rangeBusy = computed(() => busy.value || !!assetBusy.value || queueRunning.value);
</script>

<template>
    <div class="card">
      <!-- 阶段勾选直接可见：折叠摘要已删除，省掉一次「调整」点击 -->
      <div class="card-head">
        <h3>{{ t("本次执行阶段") }}</h3>
      </div>
      <div class="opt-grid stage-grid">
        <label v-for="s in STAGE_ORDER" :key="s" class="opt-item" :title="stageHint(s)">
          <input type="checkbox" v-model="selectedStages[s]" />
          {{ t(STAGE_LABELS[s]) }}
        </label>
      </div>
      <p class="hint">{{ t("未勾选的阶段会复用已有结果（卡片/剧本/素材），不会重新计费；若某阶段从未运行过则会提示需先运行。") }}</p>

      <!-- 唯一主按钮 -->
      <div class="row mt-3 items-center gap-3" style="flex-wrap: wrap">
        <button class="btn" :disabled="busy || !!assetBusy || queueRunning" @click="start">
          <span v-if="busy" class="spinner" />
          {{ busy ? t("生成中…") : t("开始生成") }}
        </button>
        <span class="hint">{{ scopeHint }}</span>
      </div>
      <!-- 图片总账：开始前先知道会生成多少张图（图像阶段勾选时才有意义） -->
      <p v-if="selectedStages.image" class="hint mt-2"><strong>{{ t("图片统计：") }}</strong>{{ imagePlanText }}</p>

      <template v-if="projectState.novel">
        <label class="opt-item mt-3">
          <input type="checkbox" v-model="projectState.options.extractAgent" />
          {{ t("Agent 模式（多步自主扫描 + 工具调用，超长小说更稳）") }}
        </label>
        <label class="opt-item mt-2" :title="t('单次请求塞太多字容易撞网关超时/500；0=自动（按语种估算，上限15万字）。已出现 500 时调小，如 40000')">
          <span>{{ t("提取分段") }}</span>
          <input type="number" v-model.number="projectState.options.extractChunkChars" min="0" step="5000" style="width: 90px" />
          <span class="hint">{{ t("字（0=自动）") }}</span>
        </label>
        <!-- 章节范围：勾选网格直接铺开，章节多时靠网格自身换行 -->
        <div class="card-head mt-4">
          <h3>{{ t("章节范围") }}</h3>
          <div class="card-actions">
            <button class="btn ghost small" :disabled="rangeBusy" @click="toggleAllRerun(true)">{{ t("全选") }}</button>
            <button class="btn ghost small" :disabled="rangeBusy" @click="toggleAllRerun(false)">{{ t("全不选") }}</button>
            <span class="hint">{{ chapterSummary }}</span>
          </div>
        </div>
        <p class="hint mb-3">{{ t("未勾选章节复用已有缓存；只勾选部分章节时，配音阶段仅生成这些章节的台词（适合分章节批量配音，避免一次性撞限流）。无缓存则跳过") }}</p>
        <div class="opt-grid chapter-grid">
          <label
            v-for="(ch, i) in projectState.novel.chapters"
            :key="i"
            class="opt-item"
            :class="{ 'is-off': ch.enabled === false }"
            :title="ch.enabled === false ? t('该章节已停用，不参与生成') : ch.title"
          >
            <input
              type="checkbox"
              :checked="rerunChapters === null || rerunChapters.includes(ch.index)"
              :disabled="ch.enabled === false || rangeBusy"
              @change="toggleChapterRerun(ch.index, ($event.target as HTMLInputElement).checked)"
            />
            <span class="text-ellipsis" :title="ch.title">{{ ch.title }}</span>
            <span v-if="ch.enabled === false" class="tag">{{ t("已停用") }}</span>
          </label>
        </div>
      </template>
    </div>
    <div v-if="!projectState.novel" class="card empty-next">
      <p class="hint">{{ t("还没有小说：导入小说（或加载示例小说）后再整书生成。") }}</p>
      <button class="btn small" @click="goPage('import')">{{ t("去导入小说") }}</button>
    </div>
</template>

<style scoped>
.chapter-grid .opt-item.is-off {
  opacity: 0.6;
}
</style>
