<script setup lang="ts">
import { computed } from "vue";
import type { ChapterInfo } from "../core/types";
import type { ChapterLight } from "../composables/useChapterStatus";
import { isChapterContentComplete } from "../composables/useChapterStatus";
import { t } from "../i18n";

const props = defineProps<{
  chapters: ChapterInfo[];
  disabledChapters: ChapterInfo[];
  lights: Record<number, ChapterLight>;
  feedback: Record<number, string>;
  force: Record<number, boolean>;
  disabled: boolean;
}>();

const emit = defineEmits<{ regen: [novelIndex: number]; toggle: [novelIndex: number] }>();

const empty: ChapterLight = {
  script: false,
  legacyScript: false,
  imageDone: 0,
  imageTotal: 0,
  voiceDone: 0,
  voiceTotal: 0,
  voiceSkipped: true,
};

const lightOf = (idx: number): ChapterLight => props.lights[idx] ?? empty;

function scriptText(l: ChapterLight): string {
  if (l.script) return l.legacyScript ? t("剧本（旧缓存）") : t("剧本✓");
  return t("剧本×");
}

function imageText(l: ChapterLight): string {
  if (!l.script || l.imageTotal === 0) return t("图像—");
  return `${t("图像")}${l.imageDone}/${l.imageTotal}`;
}

function voiceText(l: ChapterLight): string {
  if (l.voiceSkipped || l.voiceTotal === 0) return t("配音—");
  return `${t("配音")}${l.voiceDone}/${l.voiceTotal}`;
}

const incompleteCount = computed(
  () => props.chapters.filter((c) => !isChapterContentComplete(lightOf(c.index))).length,
);

defineExpose({ incompleteCount });
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 10px">
    <div
      v-for="c in chapters"
      :key="c.index"
      class="stage-row"
      :class="{ 'is-done': isChapterContentComplete(lightOf(c.index)) }"
    >
      <div class="stage-row-label" style="min-width: 0; flex: 1">
        <b class="text-ellipsis" :title="c.title">{{ t("第") }}{{ c.index + 1 }}{{ t("章") }} {{ c.title }}</b>
        <span class="stage-state-text" :class="lightOf(c.index).script ? 'done' : ''">{{ scriptText(lightOf(c.index)) }}</span>
        <span class="stage-state-text" :class="lightOf(c.index).imageTotal > 0 && lightOf(c.index).imageDone >= lightOf(c.index).imageTotal ? 'done' : ''">{{ imageText(lightOf(c.index)) }}</span>
        <span class="stage-state-text">{{ voiceText(lightOf(c.index)) }}</span>
        <span class="faint small">{{ (c.charCount ?? 0).toLocaleString() }}{{ t("字") }}</span>
      </div>
      <input
        type="text"
        :value="feedback[c.index] ?? ''"
        @input="(e) => (feedback[c.index] = (e.target as HTMLInputElement).value)"
        :placeholder="t('意见（可选）：本章节奏太慢…')"
        style="min-width: 140px; flex: 1"
      />
      <label class="opt-item mb-0" :title="t('勾选后该章跳过缓存直接重写（同范围图像同步强制），不需要填意见')">
        <input type="checkbox" :checked="!!force[c.index]" :disabled="disabled" @change="(e) => (force[c.index] = (e.target as HTMLInputElement).checked)" />
        {{ t("全量") }}
      </label>
      <button class="btn small" :disabled="disabled" :title="t('无意见且未勾全量=只补缺失')" @click="emit('regen', c.index)">
        {{ t("生成本章") }}
      </button>
      <button class="btn ghost small" :disabled="disabled" :title="t('停用后不再参与生成')" @click="emit('toggle', c.index)">
        {{ t("停用") }}
      </button>
    </div>
    <p v-if="!chapters.length" class="hint">{{ t("暂无章节：请先导入小说并运行 AI 分章") }}</p>
    <div v-if="disabledChapters.length" style="display: flex; flex-direction: column; gap: 10px; margin-top: 4px">
      <p class="hint" style="margin: 0">{{ t("已停用章节（不参与生成，可重新启用）：") }}</p>
      <div
        v-for="c in disabledChapters"
        :key="c.index"
        class="stage-row"
        style="opacity: 0.65"
      >
        <div class="stage-row-label" style="min-width: 0; flex: 1">
          <b class="text-ellipsis" :title="c.title">{{ t("第") }}{{ c.index + 1 }}{{ t("章") }} {{ c.title }}</b>
          <span class="faint small">{{ (c.charCount ?? 0).toLocaleString() }}{{ t("字") }}</span>
        </div>
        <button class="btn ghost small" :disabled="disabled" @click="emit('toggle', c.index)">
          {{ t("启用") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stage-row.is-done {
  border-color: var(--ok-soft, rgba(47, 158, 68, 0.25));
}
</style>
