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

/** 章节显示名：标题已带「第X章」前缀时不再重复拼接（此前会显示成「第1章 第一章 黄昏的城门」） */
function titleOf(c: ChapterInfo): string {
  const base = (c.title ?? "").trim() || t("未命名");
  return /^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回节]/.test(base)
    ? base
    : `${t("第")}${c.index + 1}${t("章")} ${base}`;
}

/**
 * 单章状态：只给一个明确的中文结论，不再堆「剧本× 图像— 配音—」这类符号。
 * 判定口径：未生成 → 旧缓存 → 缺图 x/y → 缺配音 x/y → 已完成。
 * 图像关闭（total=0）与未配置 TTS（voiceSkipped）不参与判定，避免显示成「缺失」。
 */
function chipOf(l: ChapterLight): { text: string; cls: string } {
  if (!l.script) return { text: t("未生成"), cls: "" };
  if (l.legacyScript) return { text: t("旧缓存"), cls: "warn" };
  if (l.imageTotal > 0 && l.imageDone < l.imageTotal) return { text: `${t("缺图")} ${l.imageDone}/${l.imageTotal}`, cls: "warn" };
  if (!l.voiceSkipped && l.voiceTotal > 0 && l.voiceDone < l.voiceTotal) return { text: `${t("缺配音")} ${l.voiceDone}/${l.voiceTotal}`, cls: "warn" };
  return { text: t("已完成"), cls: "ok" };
}

const incompleteCount = computed(
  () => props.chapters.filter((c) => !isChapterContentComplete(lightOf(c.index))).length,
);
const selectedCount = computed(() => props.selected.length);
const locked = computed(() => props.disabled || props.queueRunning);
/** 主按钮文案随选择变化：有勾选=生成选中，无勾选=补全未完成（唯一下一步动作） */
const primaryLabel = computed(() =>
  selectedCount.value ? `${t("生成选中")}（${selectedCount.value}）` : `${t("补全未完成")}${incompleteCount.value ? `（${incompleteCount.value}）` : ""}`,
);
function runPrimary(): void {
  if (selectedCount.value) emit("runSelected");
  else emit("runQueue");
}
/** 选择开关：把「全选未完成 / 清空选择」收敛成一个文本链接 */
function selectToggle(): void {
  if (selectedCount.value) emit("selectNone");
  else emit("selectIncomplete");
}
const legacyScriptCount = computed(() => props.chapters.filter((c) => lightOf(c.index).legacyScript).length);
defineExpose({ incompleteCount });
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("逐章生成") }}</h3>
      <div class="card-actions">
        <span class="tag" :class="splitOk ? 'ok' : 'warn'">{{ splitMetaText }}</span>
        <span v-if="splitConfirmed" class="tag ok">{{ t("已核对") }}</span>
      </div>
    </div>

    <div v-if="!hasCards" class="wb-notice">
      <div>
        <strong>{{ t("还缺角色 / 场景 / 物品卡") }}</strong>
        <p>{{ t("逐章生成需要先有卡片，才能把原文变成剧本与图像。") }}</p>
      </div>
      <button class="link-btn" :disabled="locked" @click="emit('prepare')">{{ t("先提取卡片") }}</button>
    </div>

    <!-- 唯一主按钮：勾选了章节=生成选中；未勾选=补全未完成 -->
    <div class="wb-toolbar wb-primary">
      <button class="link-btn" :disabled="locked" @click="selectToggle">
        {{ selectedCount ? t("清空选择") : `${t("全选未完成")}${incompleteCount ? `（${incompleteCount}）` : ""}` }}
      </button>
      <span class="hint">{{ t("已选") }} {{ selectedCount }} / {{ chapters.length }}</span>
      <span class="grow" />
      <label class="opt-item mb-0" :title="t('勾选后单章链路会把该章台词一起配音（会产生 TTS 费用）')">
        <input
          type="checkbox"
          :checked="includeVoice"
          :disabled="locked"
          @change="emit('updateIncludeVoice', ($event.target as HTMLInputElement).checked)"
        />
        {{ t("含配音") }}
      </label>
      <button v-if="!queueRunning" class="btn" :disabled="locked" @click="runPrimary">{{ primaryLabel }}</button>
      <button v-else class="btn danger" @click="emit('stopQueue')">{{ t("停止队列") }}</button>
    </div>
    <p class="hint">{{ t("勾选章节后点主按钮生成选中；未勾选时补全未完成。逐章意见 / 全量 / 分项重跑在该行「重跑」里。") }}</p>

    <details class="wb-adv">
      <summary class="hint">{{ t("分章设置与意见") }}</summary>
      <div class="wb-toolbar mt-3">
        <input
          class="grow"
          type="text"
          :value="opinionDraft"
          :placeholder="t('分章意见（可选）：如“第×章太长请拆分”…')"
          :disabled="locked"
          @input="onOpinionInput(($event.target as HTMLInputElement).value)"
        />
        <button class="btn small" :disabled="locked" @click="emit('previewSplit')">{{ t("AI 分章") }}</button>
        <button class="link-btn" :disabled="locked || !chapters.length" @click="emit('confirmSplit')">
          {{ splitConfirmed ? t("分章已核对") : t("标记为已核对") }}
        </button>
        <button class="link-btn" :disabled="locked" @click="emit('append')">{{ t("追加新章节") }}</button>
      </div>
      <div class="wb-toolbar mt-2">
        <label class="opt-item mb-0">
          <span>{{ t("碎章合并阈值") }}</span>
          <input
            type="number"
            :value="splitMinChapterChars"
            min="0"
            step="500"
            style="width: 90px"
            :disabled="locked"
            @input="emit('updateSplitMinChapterChars', Number(($event.target as HTMLInputElement).value))"
          />
          <span class="hint">{{ t("字") }}</span>
        </label>
        <label class="opt-item mb-0">
          <input
            type="checkbox"
            :checked="splitKeepSpecials"
            :disabled="locked"
            @change="emit('updateSplitKeepSpecials', ($event.target as HTMLInputElement).checked)"
          />
          {{ t("保留特殊章节") }}
        </label>
      </div>
    </details>

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
            :disabled="locked"
            @change="emit('select', c.index, ($event.target as HTMLInputElement).checked)"
          />
        </label>
        <div class="stage-row-label wb-title">
          <b class="text-ellipsis" :title="titleOf(c)">{{ titleOf(c) }}</b>
          <span class="tag" :class="chipOf(lightOf(c.index)).cls">{{ chipOf(lightOf(c.index)).text }}</span>
          <span class="faint small">{{ (c.charCount ?? 0).toLocaleString() }}{{ t("字") }}</span>
        </div>
        <details class="wb-more">
          <summary class="link-btn">{{ t("重跑") }}</summary>
          <div class="wb-more-body">
            <input
              class="wb-feedback"
              type="text"
              :value="feedback[c.index] ?? ''"
              :placeholder="t('意见（可选）：本章节奏太慢…')"
              :disabled="locked"
              @input="emit('updateFeedback', c.index, ($event.target as HTMLInputElement).value)"
            />
            <button class="btn small" :disabled="locked" @click="emit('regen', c.index)">{{ t("生成本章") }}</button>
            <label class="opt-item mb-0" :title="t('勾选后该章跳过缓存直接重写（同范围图像同步强制）')">
              <input
                type="checkbox"
                :checked="!!force[c.index]"
                :disabled="locked"
                @change="emit('updateForce', c.index, ($event.target as HTMLInputElement).checked)"
              />
              {{ t("全量") }}
            </label>
            <button class="btn small" :disabled="locked" :title="t('重写本章剧本，并按新剧本重画本章图片（不含配音）')" @click="emit('regenPart', c.index, 'script')">
              {{ t("剧本") }}
            </button>
            <button class="btn small" :disabled="locked" :title="t('只重画本章背景/CG，剧本与配音不动')" @click="emit('regenPart', c.index, 'image')">
              {{ t("图像") }}
            </button>
            <button class="btn small" :disabled="locked" :title="t('只重配本章台词配音，剧本与图像不动')" @click="emit('regenPart', c.index, 'voice')">
              {{ t("配音") }}
            </button>
            <button class="btn small" :disabled="locked" @click="emit('toggle', c.index)">{{ t("停用") }}</button>
          </div>
        </details>
      </div>
      <p v-if="!chapters.length" class="hint">
        {{ t("还没有章节：展开上方「分章设置与意见」点「AI 分章」把小说切成可逐章生成的章节。") }}
      </p>
    </div>

    <details v-if="disabledChapters.length" class="wb-adv">
      <summary class="hint">{{ t("已停用章节") }}（{{ disabledChapters.length }}）</summary>
      <div v-for="c in disabledChapters" :key="c.index" class="stage-row" style="opacity: 0.65">
        <div class="stage-row-label wb-title">
          <b class="text-ellipsis" :title="titleOf(c)">{{ titleOf(c) }}</b>
          <span class="faint small">{{ (c.charCount ?? 0).toLocaleString() }}{{ t("字") }}</span>
        </div>
        <button class="btn small" :disabled="locked" @click="emit('toggle', c.index)">{{ t("启用") }}</button>
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
.wb-primary {
  margin-top: 4px;
  margin-bottom: 6px;
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
/* 每章的「重跑」：默认收起为文本链接，展开后独占一行 */
.wb-more {
  position: relative;
}
.wb-more summary {
  list-style: none;
  cursor: pointer;
}
.wb-more summary::-webkit-details-marker {
  display: none;
}
.wb-more[open] {
  flex-basis: 100%;
}
.wb-more-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 8px 10px;
  background: var(--bg-card);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}
.wb-adv {
  margin-bottom: 10px;
}
.wb-adv summary {
  cursor: pointer;
}
</style>
