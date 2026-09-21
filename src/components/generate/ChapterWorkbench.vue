<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ChapterInfo } from "../../core/types";
import type { ChapterLight } from "../../composables/useChapterStatus";
import { emptyChapterLight, isChapterContentComplete } from "../../composables/useChapterStatus";
import { t } from "../../i18n";
import { useGenerateController } from "../../stores/generate";

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
  splitMetaText: string;
  splitOk: boolean;
  splitConfirmed: boolean;
  /** 图片总账文案：图片共 N 张 · 已生成 X · 待生成 Y（生成前可见，stores/generate 计算） */
  imageSummaryText: string;
  /** 有失败记录的章节（novel index）：列表优先展示并显示「失败」状态 */
  failedChapters: number[];
}>();

const emit = defineEmits<{
  regen: [novelIndex: number];
  /** 只重跑该章的某一部分（剧本 / 图像 / 配音），其余内容复用缓存 */
  regenPart: [novelIndex: number, part: "script" | "image" | "voice"];
  toggle: [novelIndex: number];
  select: [novelIndex: number, checked: boolean];
  runSelected: [];
  runQueue: [];
  stopQueue: [];
  previewSplit: [];
  prepare: [];
  updateIncludeVoice: [value: boolean];
  updateFeedback: [novelIndex: number, value: string];
  updateForce: [novelIndex: number, value: boolean];
}>();

// 工具栏「重跑选中」要对多章依次 await，emit 无法等待，因此这里直接调 store（页面拥有同一单例）
const { runChapterFullRegen, runChapterPartRegen } = useGenerateController();

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
 * 判定口径：失败 → 未生成 → 旧缓存 → 缺图 x/y → 缺配音 x/y → 已完成。
 * 图像关闭（total=0）与未配置 TTS（voiceSkipped）不参与判定，避免显示成「缺失」。
 */
function chipOf(l: ChapterLight, failed = false): { text: string; cls: string } {
  if (failed) return { text: t("失败"), cls: "err" };
  if (!l.script) return { text: t("未生成"), cls: "" };
  if (l.legacyScript) return { text: t("旧缓存"), cls: "warn" };
  if (l.imageTotal > 0 && l.imageDone < l.imageTotal) return { text: `${t("缺图")} ${l.imageDone}/${l.imageTotal}`, cls: "warn" };
  if (!l.voiceSkipped && l.voiceTotal > 0 && l.voiceDone < l.voiceTotal) return { text: `${t("缺配音")} ${l.voiceDone}/${l.voiceTotal}`, cls: "warn" };
  return { text: t("已完成"), cls: "ok" };
}

const failedSet = computed(() => new Set(props.failedChapters));

/** 单章排序权重：失败 → 未生成 → 缺图/缺配音/旧缓存 → 已完成 → 已停用（停用章沉底但可勾选） */
function rankOf(c: ChapterInfo): number {
  if (c.enabled === false) return 4;
  if (failedSet.value.has(c.index)) return 0;
  const l = lightOf(c.index);
  if (!l.script) return 1;
  if (l.legacyScript) return 2;
  if (l.imageTotal > 0 && l.imageDone < l.imageTotal) return 2;
  if (!l.voiceSkipped && l.voiceTotal > 0 && l.voiceDone < l.voiceTotal) return 2;
  return 3;
}

interface ChapterRow {
  chapter: ChapterInfo;
  isDisabled: boolean;
  chip: { text: string; cls: string };
}

/** 启用 / 已停用合并成一张列表：不再有单独小节，也不再有折叠或显示开关 */
const rows = computed<ChapterRow[]>(() =>
  [...props.chapters, ...props.disabledChapters]
    .map((chapter) => ({ chapter, rank: rankOf(chapter) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ chapter }) => ({
      chapter,
      isDisabled: chapter.enabled === false,
      chip: chipOf(lightOf(chapter.index), failedSet.value.has(chapter.index)),
    })),
);

const selectedCount = computed(() => props.selected.length);
const locked = computed(() => props.disabled || props.queueRunning);
/** 主按钮文案随选择变化：有勾选=生成选中，无勾选=补全未完成（唯一下一步动作） */
const primaryLabel = computed(() => (selectedCount.value ? t("生成选中") : t("补全未完成")));
function runPrimary(): void {
  if (selectedCount.value) emit("runSelected");
  else emit("runQueue");
}

const legacyScriptCount = computed(() => props.chapters.filter((c) => lightOf(c.index).legacyScript).length);

/* ---- 工具栏浮层：唯一的批量入口（意见 / 分项重跑 / 全量 / 启停），行内不再有任何按钮 ---- */
const menuOpen = ref(false);
function closeMenu(): void {
  menuOpen.value = false;
}
function toggleMenu(): void {
  menuOpen.value = !menuOpen.value;
}
function onDocPointerDown(e: MouseEvent): void {
  const el = e.target as HTMLElement | null;
  if (el?.closest(".wb-toolbar-menu")) return;
  closeMenu();
}
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") closeMenu();
}
onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown);
});
watch(
  () => props.selected.length,
  (n) => {
    if (!n) closeMenu();
  },
);

const selection = computed(() => new Set(props.selected));
const selectedRows = computed(() => rows.value.filter((r) => selection.value.has(r.chapter.index)));
/** 重跑 / 全量只作用于选中且启用的章节：停用章不参与生成 */
const selectedEnabled = computed(() => selectedRows.value.filter((r) => !r.isDisabled).map((r) => r.chapter.index));
/** 启停二选一：全部选中都是停用章才显示「启用选中」，混选时按「停用选中」处理 */
const toggleLabel = computed(() => (selectedRows.value.length && selectedRows.value.every((r) => r.isDisabled) ? t("启用选中") : t("停用选中")));

/** 意见写入所有选中章节：一致才回填，避免把上一章的意见显示成下一章的值 */
const menuFeedback = computed(() => {
  const list = props.selected;
  if (!list.length) return "";
  const first = props.feedback[list[0]] ?? "";
  return list.every((i) => (props.feedback[i] ?? "") === first) ? first : "";
});
function onMenuFeedback(value: string): void {
  for (const i of props.selected) emit("updateFeedback", i, value);
}
async function regenSelectedPart(part: "script" | "image" | "voice"): Promise<void> {
  closeMenu();
  for (const i of selectedEnabled.value) await runChapterPartRegen(i, part);
}
async function regenSelectedFull(): Promise<void> {
  closeMenu();
  for (const i of selectedEnabled.value) {
    emit("updateForce", i, true);
    try {
      await runChapterFullRegen(i);
    } finally {
      emit("updateForce", i, false);
    }
  }
}
function toggleSelected(): void {
  closeMenu();
  for (const i of props.selected) emit("toggle", i);
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("逐章生成") }}</h3>
      <div class="card-actions">
        <!-- 分章状态只读：非「已核对」口径时把下一步指向「生成设置」页 -->
        <span
          class="tag"
          :class="splitOk ? 'ok' : 'warn'"
          :title="splitOk ? undefined : t('到「生成设置」里重新分章或标记已核对')"
        >{{ splitMetaText }}</span>
        <span v-if="splitConfirmed" class="tag ok">{{ t("已核对") }}</span>
      </div>
    </div>

    <!-- 空态只留「AI 分章」（它自带分章＋提取），此时再提示「先提取卡片」是重复且无从下手的选择 -->
    <div v-if="!hasCards && rows.length" class="wb-notice">
      <div>
        <strong>{{ t("还缺角色 / 场景 / 物品卡") }}</strong>
        <p>{{ t("逐章生成需要先有卡片，才能把原文变成剧本与图像。") }}</p>
      </div>
      <button class="btn secondary small" :disabled="locked" @click="emit('prepare')">{{ t("先提取卡片") }}</button>
    </div>

    <!-- 工具栏四项：含配音 / 已选计数 / 重跑选中浮层 / 唯一主按钮 -->
    <div class="wb-toolbar">
      <label class="opt-item mb-0" :title="t('勾选后单章链路会把该章台词一起配音（会产生 TTS 费用）')">
        <input
          type="checkbox"
          :checked="includeVoice"
          :disabled="locked"
          @change="emit('updateIncludeVoice', ($event.target as HTMLInputElement).checked)"
        />
        {{ t("含配音") }}
      </label>
      <span class="hint">{{ t("已选") }} {{ selectedCount }} / {{ rows.length }}</span>
      <span class="grow" />
      <div class="wb-toolbar-menu">
        <button
          class="btn secondary small"
          :disabled="selectedCount === 0 || locked"
          :aria-expanded="menuOpen"
          aria-haspopup="true"
          @click="toggleMenu"
        >{{ t("重跑选中") }} ▾</button>
        <div v-if="menuOpen" class="wb-menu" role="menu" :aria-label="t('重跑选中')">
          <input
            class="wb-feedback"
            type="text"
            :value="menuFeedback"
            :placeholder="t('意见（可选）：本章节奏太慢…')"
            :disabled="locked"
            @input="onMenuFeedback(($event.target as HTMLInputElement).value)"
          />
          <div class="wb-menu-row">
            <button class="btn small" role="menuitem" :disabled="locked" @click="regenSelectedPart('script')">{{ t("重跑剧本") }}</button>
            <button class="btn small" role="menuitem" :disabled="locked" @click="regenSelectedPart('image')">{{ t("重跑图像") }}</button>
            <button class="btn small" role="menuitem" :disabled="locked" @click="regenSelectedPart('voice')">{{ t("重跑配音") }}</button>
          </div>
          <div class="wb-menu-row">
            <button class="btn small" role="menuitem" :disabled="locked" @click="regenSelectedFull">{{ t("全量重跑") }}</button>
            <button class="btn small" role="menuitem" :disabled="locked" @click="toggleSelected">{{ toggleLabel }}</button>
          </div>
        </div>
      </div>
      <button v-if="!queueRunning" class="btn" :disabled="locked" @click="runPrimary">{{ primaryLabel }}</button>
      <button v-else class="btn danger" @click="emit('stopQueue')">{{ t("停止队列") }}</button>
    </div>
    <p class="hint">{{ t("勾选章节后点主按钮生成；未勾选时按顺序补全未完成。分项重跑 / 全量 / 启停都在「重跑选中」里。") }}</p>
    <p class="hint"><strong>{{ t("图片统计：") }}</strong>{{ imageSummaryText }}</p>

    <!-- 一行细提示即可，不再占一个色块 -->
    <p v-if="legacyScriptCount" class="hint">
      <strong>{{ t("旧版剧本缓存未纳入校验") }}：</strong>{{ legacyScriptCount }}{{ t("章的剧本缓存没有指纹（旧版），场景/人物可能已过期，图像数按旧剧本估算；建议对这些章重跑一次「剧本」。") }}
    </p>

    <div v-if="!rows.length" class="wb-empty">
      <p class="hint mb-0">{{ t("还没有章节：点下方按钮用 AI 分章把小说切成可逐章生成的章节") }}</p>
      <button class="btn small" :disabled="locked" @click="emit('previewSplit')">{{ t("AI 分章") }}</button>
    </div>
    <div v-else class="wb-list">
      <div
        v-for="row in rows"
        :key="row.chapter.index"
        class="stage-row"
        :class="{ 'is-done': !row.isDisabled && isChapterContentComplete(lightOf(row.chapter.index)), 'is-off': row.isDisabled }"
      >
        <label class="wb-check" :title="t('加入「生成选中」批量队列')">
          <input
            type="checkbox"
            :checked="selected.includes(row.chapter.index)"
            :disabled="locked"
            @change="emit('select', row.chapter.index, ($event.target as HTMLInputElement).checked)"
          />
        </label>
        <div class="stage-row-label wb-title">
          <b class="text-ellipsis" :title="titleOf(row.chapter)">{{ titleOf(row.chapter) }}</b>
          <span class="tag" :class="row.chip.cls">{{ row.chip.text }}</span>
          <span v-if="row.isDisabled" class="tag">{{ t("已停用") }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wb-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
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
/* 已停用章沉底并淡化，但保留勾选框（供「启用选中」使用） */
.wb-list .stage-row.is-off {
  opacity: 0.6;
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
.wb-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
/* 浮层菜单：工具栏唯一的批量入口，absolute 不占常驻空间 */
.wb-toolbar-menu {
  position: relative;
  display: flex;
  align-items: center;
}
.wb-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
  padding: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-hover);
}
.wb-menu-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.wb-feedback {
  min-width: 140px;
  flex: 1;
}
</style>
