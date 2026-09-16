<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ChapterInfo } from "../../core/types";
import type { ChapterLight } from "../../composables/useChapterStatus";
import { emptyChapterLight, isChapterContentComplete } from "../../composables/useChapterStatus";
import { t } from "../../i18n";

const props = defineProps<{
  chapters: ChapterInfo[];
  disabledChapters: ChapterInfo[];
  lights: Record<number, ChapterLight>;
  feedback: Record<number, string>;
  force: Record<number, boolean>;
  selected: number[];
  disabled: boolean;
  queueRunning: boolean;
  includeVoice: boolean;
  hasCards: boolean;
  opinion: string;
  splitMetaText: string;
  splitOk: boolean;
  splitConfirmed: boolean;
  splitMinChapterChars: number;
  splitKeepSpecials: boolean;
}>();

const emit = defineEmits<{
  regen: [novelIndex: number];
  /** 只重跑该章的某一部分（剧本 / 图像 / 配音），其余内容复用缓存 */
  regenPart: [novelIndex: number, part: "script" | "image" | "voice"];
  toggle: [novelIndex: number];
  select: [novelIndex: number, checked: boolean];
  selectIncomplete: [];
  selectNone: [];
  runSelected: [];
  runQueue: [];
  stopQueue: [];
  append: [];
  previewSplit: [];
  confirmSplit: [];
  prepare: [];
  updateIncludeVoice: [value: boolean];
  updateOpinion: [value: string];
  updateFeedback: [novelIndex: number, value: string];
  updateForce: [novelIndex: number, value: boolean];
  updateSplitMinChapterChars: [value: number];
  updateSplitKeepSpecials: [value: boolean];
}>();

const opinionDraft = ref(props.opinion);
watch(
  () => props.opinion,
  (v) => {
    if (v !== opinionDraft.value) opinionDraft.value = v;
  },
);
function onOpinionInput(value: string): void {
  opinionDraft.value = value;
  emit("updateOpinion", value);
}

const lightOf = (idx: number): ChapterLight => props.lights[idx] ?? emptyChapterLight();
const incompleteCount = computed(
  () => props.chapters.filter((c) => !isChapterContentComplete(lightOf(c.index))).length,
);
const selectedCount = computed(() => props.selected.length);
const canRunQueue = computed(() => !props.disabled && !props.queueRunning && props.chapters.length > 0);
/** 仍是旧版无指纹剧本缓存的章节数：这些章的图像数按旧剧本估算，需要重跑剧本才准 */
const legacyScriptCount = computed(() => props.chapters.filter((c) => lightOf(c.index).legacyScript).length);

function scriptText(l: ChapterLight): string {
  if (l.script) return l.legacyScript ? t("剧本·旧缓存") : t("剧本✓");
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
function imageDone(l: ChapterLight): boolean {
  return l.imageTotal > 0 && l.imageDone >= l.imageTotal;
}
defineExpose({ incompleteCount });
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("逐章生成") }}</h3>
      <div class="card-actions">
        <span class="tag" :class="splitOk ? 'ok' : 'warn'">{{ splitMetaText }}</span>
        <span v-if="splitConfirmed" class="tag ok">{{ t("已核对") }}</span>
        <button class="btn ghost small" :disabled="disabled || queueRunning" @click="emit('append')">
          {{ t("追加新章节") }}
        </button>
      </div>
    </div>

    <div v-if="!hasCards" class="wb-notice">
      <div>
        <strong>{{ t("还缺角色 / 场景 / 物品卡") }}</strong>
        <p>{{ t("逐章生成需要先有卡片，才能把原文变成剧本与图像。") }}</p>
      </div>
      <button class="btn small" :disabled="disabled || queueRunning" @click="emit('prepare')">{{ t("先提取卡片") }}</button>
    </div>

    <div class="wb-toolbar">
      <input
        class="grow"
        type="text"
        :value="opinionDraft"
        :placeholder="t('分章意见（可选）：如“第×章太长请拆分”…')"
        :disabled="disabled || queueRunning"
        @input="onOpinionInput(($event.target as HTMLInputElement).value)"
      />
      <button class="btn secondary small" :disabled="disabled || queueRunning" @click="emit('previewSplit')">
        {{ t("AI 分章") }}
      </button>
      <button
        class="btn ghost small"
        :disabled="disabled || queueRunning || !chapters.length"
        @click="emit('confirmSplit')"
      >
        {{ splitConfirmed ? t("分章已核对") : t("标记为已核对") }}
      </button>
    </div>
    <div class="wb-toolbar">
      <button class="btn ghost small" :disabled="disabled || queueRunning" @click="emit('selectIncomplete')">
        {{ t("全选未完成") }}<template v-if="incompleteCount">（{{ incompleteCount }}）</template>
      </button>
      <button class="btn ghost small" :disabled="disabled || queueRunning || !selectedCount" @click="emit('selectNone')">
        {{ t("清空选择") }}
      </button>
      <span class="hint">{{ t("已选") }} {{ selectedCount }} / {{ chapters.length }}</span>
      <span class="grow" />
      <label class="opt-item mb-0" :title="t('勾选后单章链路会把该章台词一起配音（会产生 TTS 费用）')">
        <input
          type="checkbox"
          :checked="includeVoice"
          :disabled="disabled || queueRunning"
          @change="emit('updateIncludeVoice', ($event.target as HTMLInputElement).checked)"
        />
        {{ t("含配音") }}
      </label>
      <button class="btn small" :disabled="disabled || queueRunning || !selectedCount" @click="emit('runSelected')">
        {{ t("生成选中") }}<template v-if="selectedCount">（{{ selectedCount }}）</template>
      </button>
      <button v-if="!queueRunning" class="btn secondary small" :disabled="!canRunQueue" @click="emit('runQueue')">
        {{ t("顺序补全未完成") }}
      </button>
      <button v-else class="btn danger small" @click="emit('stopQueue')">{{ t("停止队列") }}</button>
    </div>

    <p class="hint">
      {{ t("单章链＝剧本＋图像＋组装；勾「含配音」会连同该章台词一起配音。无意见且未勾全量＝只补缺失。") }}
    </p>
    <div v-if="legacyScriptCount" class="wb-notice">
      <div>
        <strong>{{ t("旧版剧本缓存未纳入校验") }}</strong>
        <p>{{ legacyScriptCount }}{{ t("章的剧本缓存没有指纹（旧版），场景/人物可能已过期，图像数按旧剧本估算；建议对这些章重跑一次「剧本」。") }}</p>
      </div>
    </div>
    <div class="wb-list">
      <div
        v-for="c in chapters"
        :key="c.index"
        class="stage-row"
        :class="{ 'is-done': isChapterContentComplete(lightOf(c.index)) }"
      >
        <label class="wb-check" :title="t('加入「生成选中」批量队列')">
          <input
            type="checkbox"
            :checked="selected.includes(c.index)"
            :disabled="disabled || queueRunning"
            @change="emit('select', c.index, ($event.target as HTMLInputElement).checked)"
          />
        </label>
        <div class="stage-row-label wb-title">
          <b class="text-ellipsis" :title="c.title">
            {{ t("第") }}{{ c.index + 1 }}{{ t("章") }} {{ c.title }}
          </b>
          <span class="stage-state-text" :class="lightOf(c.index).script ? 'done' : ''">
            {{ scriptText(lightOf(c.index)) }}
          </span>
          <span class="stage-state-text" :class="imageDone(lightOf(c.index)) ? 'done' : ''">
            {{ imageText(lightOf(c.index)) }}
          </span>
          <span class="stage-state-text">{{ voiceText(lightOf(c.index)) }}</span>
          <span class="faint small">{{ (c.charCount ?? 0).toLocaleString() }}{{ t("字") }}</span>
        </div>
        <input
          class="wb-feedback"
          type="text"
          :value="feedback[c.index] ?? ''"
          :placeholder="t('意见（可选）：本章节奏太慢…')"
          :disabled="disabled || queueRunning"
          @input="emit('updateFeedback', c.index, ($event.target as HTMLInputElement).value)"
        />
        <label class="opt-item mb-0" :title="t('勾选后该章跳过缓存直接重写（同范围图像同步强制）')">
          <input
            type="checkbox"
            :checked="!!force[c.index]"
            :disabled="disabled || queueRunning"
            @change="emit('updateForce', c.index, ($event.target as HTMLInputElement).checked)"
          />
          {{ t("全量") }}
        </label>
        <button class="btn small" :disabled="disabled || queueRunning" @click="emit('regen', c.index)">
          {{ t("生成本章") }}
        </button>
        <span class="wb-parts">
          <button
            class="btn ghost small"
            :disabled="disabled || queueRunning"
            :title="t('重写本章剧本，并按新剧本重画本章图片（不含配音）')"
            @click="emit('regenPart', c.index, 'script')"
          >
            {{ t("剧本") }}
          </button>
          <button
            class="btn ghost small"
            :disabled="disabled || queueRunning"
            :title="t('只重画本章背景/CG，剧本与配音不动')"
            @click="emit('regenPart', c.index, 'image')"
          >
            {{ t("图像") }}
          </button>
          <button
            class="btn ghost small"
            :disabled="disabled || queueRunning"
            :title="t('只重配本章台词配音，剧本与图像不动')"
            @click="emit('regenPart', c.index, 'voice')"
          >
            {{ t("配音") }}
          </button>
        </span>
        <button class="btn ghost small" :disabled="disabled || queueRunning" @click="emit('toggle', c.index)">
          {{ t("停用") }}
        </button>
      </div>
      <p v-if="!chapters.length" class="hint">
        {{ t("还没有章节：点上方「AI 分章」把小说切成可逐章生成的章节。") }}
      </p>
    </div>
    <details v-if="disabledChapters.length" class="wb-adv">
      <summary class="hint">{{ t("已停用章节") }}（{{ disabledChapters.length }}）</summary>
      <div v-for="c in disabledChapters" :key="c.index" class="stage-row" style="opacity: 0.65">
        <div class="stage-row-label wb-title">
          <b class="text-ellipsis">{{ t("第") }}{{ c.index + 1 }}{{ t("章") }} {{ c.title }}</b>
          <span class="faint small">{{ (c.charCount ?? 0).toLocaleString() }}{{ t("字") }}</span>
        </div>
        <button class="btn ghost small" :disabled="disabled || queueRunning" @click="emit('toggle', c.index)">
          {{ t("启用") }}
        </button>
      </div>
    </details>

    <details class="wb-adv">
      <summary class="hint">{{ t("分章设置") }}</summary>
      <div class="wb-toolbar">
        <label class="opt-item mb-0">
          <span>{{ t("碎章合并阈值") }}</span>
          <input
            type="number"
            :value="splitMinChapterChars"
            min="0"
            step="500"
            style="width: 90px"
            :disabled="disabled || queueRunning"
            @input="emit('updateSplitMinChapterChars', Number(($event.target as HTMLInputElement).value))"
          />
          <span class="hint">{{ t("字") }}</span>
        </label>
        <label class="opt-item mb-0">
          <input
            type="checkbox"
            :checked="splitKeepSpecials"
            :disabled="disabled || queueRunning"
            @change="emit('updateSplitKeepSpecials', ($event.target as HTMLInputElement).checked)"
          />
          {{ t("保留特殊章节") }}
        </label>
      </div>
    </details>
  </div>
</template>

<style scoped>
.wb-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.wb-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid var(--warn-soft, rgba(245, 159, 0, 0.35));
  background: var(--warn-soft, rgba(245, 159, 0, 0.12));
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  margin-bottom: 10px;
}
.wb-notice p {
  margin: 2px 0 0;
  font-size: 13px;
}
.wb-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wb-list .stage-row.is-done {
  border-color: var(--ok-soft, rgba(47, 158, 68, 0.25));
}
.wb-check {
  display: flex;
  align-items: center;
  padding-top: 2px;
}
.wb-title {
  min-width: 0;
  flex: 1;
}
.wb-feedback {
  min-width: 140px;
  flex: 1;
}
/* 每章「只重跑一部分」按钮组：与「生成本章」并列，用分隔线区分粒度 */
.wb-parts {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-left: 8px;
  border-left: 1px solid var(--border);
}
.wb-adv {
  margin-top: 10px;
}
.wb-adv summary {
  cursor: pointer;
}
</style>
