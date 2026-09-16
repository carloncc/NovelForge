<script setup lang="ts">
import { computed, watch } from "vue";
import { t } from "../../../i18n";
import { projectState } from "../../../stores/project";
import LazyThumb from "../../LazyThumb.vue";
import { useGenerateController } from "../../../stores/generate";

// 结果区子面板：状态全部来自 generate store。
const {
  tab,
  busy,
  queueRunning,
  assetMap,
  assetTab,
  assetBusy,
  assetFeedback,
  voiceChapterFilter,
  voiceCharFilter,
  regenAbort,
  regenProgress,
  openPreview,
  regenPct,
  selected,
  selectedCount,
  toggleSelect,
  clearSelected,
  selectAllInTab,
  selectedVoice,
  selectedVoiceCount,
  toggleVoiceSelected,
  selectAllVoice,
  clearVoiceSelected,
  regenSelectedVoices,
  regenSelected,
  regenMissingImages,
  EMOTION_LABELS,
  reCutout,
  figureRows,
  itemRows,
  bgRows,
  cgRows,
  voiceRows,
  voiceChapterOptions,
  voiceChapterMismatch,
  voiceCharOptions,
  voiceLimit,
  voiceRowsShown,
  showNarrationVoice,
  ttsReady,
  regenFigureEmotion,
  regenAllFigure,
  regenThreeView,
  regenAction,
  regenCostume,
  regenItem,
  regenBg,
  regenCgRow,
  audioRef,
  playingVoiceKey,
  playVoice,
  regenVoice,
  regenCharVoice,
  regenMissingVoices,
  cleanupInvalidAssets,
  restoreAssetBackupNow,
  fileExistsLabel,
} = useGenerateController();

/** 素材重生成锁：管线/队列/素材任务任一在跑时，所有单项重生成都应禁用（此前只挡 assetBusy，
 * 生成进行中点单项按钮会走到 regenCtx 被拦，只留一条警告日志，看起来像按钮没反应）。 */
const regenLocked = computed(() => busy.value || queueRunning.value || !!assetBusy.value);

// 切换素材子标签时清空选择：选择集跨标签保留会让「重新生成已选」命中当前不可见的行（看不见的花费）
watch(assetTab, () => {
  clearSelected();
  clearVoiceSelected();
});
</script>

<template>
<div v-if="tab === 'asset'">
  <div v-if="!projectState.lastResult || !assetMap" class="empty">
    <img src="/src/assets/empty-generate.png" alt="" style="width: 220px; opacity: 0.9; margin-bottom: 12px" />
    <p>{{ t("暂无素材（生成后出现）。生成后可在本页对单张立绘、背景、CG、物品图或单句配音单独重新生成。") }}</p>
  </div>
  <template v-else>
    <div v-if="assetBusy" class="asset-regen-status">
      <span style="font-size: 12px; font-weight: 600; flex-shrink: 0">{{ assetBusy }}</span>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: regenPct + '%' }"></div>
      </div>
      <span class="asset-regen-label">
        <template v-if="regenProgress">{{ regenProgress.done }}/{{ regenProgress.total }} · {{ regenProgress.label }}</template>
        <template v-else>{{ t("准备中…") }}</template>
      </span>
      <button class="btn danger small" @click="regenAbort = true">{{ t("中断") }}</button>
    </div>
    <div class="asset-toolbar">
      <div class="asset-subtabs">
        <button class="asset-subtab" :class="{ active: assetTab === 'figure' }" @click="assetTab = 'figure'">{{ t("角色立绘") }}</button>
        <button class="asset-subtab" :class="{ active: assetTab === 'item' }" @click="assetTab = 'item'">{{ t("物品图") }}</button>
        <button class="asset-subtab" :class="{ active: assetTab === 'bg' }" @click="assetTab = 'bg'">{{ t("背景图") }}</button>
        <button class="asset-subtab" :class="{ active: assetTab === 'cg' }" @click="assetTab = 'cg'">CG</button>
        <button class="asset-subtab" :class="{ active: assetTab === 'voice' }" @click="assetTab = 'voice'">{{ t("配音") }}</button>
      </div>
      <div v-if="assetTab !== 'voice'" class="asset-toolbar-right">
        <span v-if="selectedCount" class="tag ok">{{ t("已选") }} {{ selectedCount }}</span>
        <button class="btn ghost small" @click="selectAllInTab">{{ t("全选本区") }}</button>
        <button class="btn ghost small" :disabled="!selectedCount" @click="clearSelected">{{ t("清空") }}</button>
        <button class="btn small" :disabled="!selectedCount || regenLocked" @click="regenSelected">{{ t("重新生成已选（") }}{{ selectedCount }}{{ t("）") }}</button>
        <button class="btn primary small" :disabled="regenLocked" @click="regenMissingImages">{{ t("补全缺失图片") }}</button>
        <button class="btn ghost small" :disabled="regenLocked" :title="t('剪枝误删映射时从自动备份恢复（剪枝前自动备份，最多保留 3 份）')" @click="restoreAssetBackupNow">{{ t("恢复映射") }}</button>
        <button class="btn ghost small" :disabled="regenLocked" :title="t('剪掉过期映射、迁移旧版CG、删除孤儿文件；缺失项下次运行自动补生成')" @click="cleanupInvalidAssets">{{ t("清理无效素材") }}</button>
      </div>
      <div v-else class="asset-toolbar-right">
        <span v-if="selectedVoiceCount" class="tag ok">{{ t("已选") }} {{ selectedVoiceCount }}</span>
        <button class="btn ghost small" @click="selectAllVoice(voiceRowsShown.map((r) => r.key))">{{ t("全选本区") }}</button>
        <button class="btn ghost small" :disabled="!selectedVoiceCount" @click="clearVoiceSelected">{{ t("清空") }}</button>
        <button
          class="btn small"
          :disabled="!selectedVoiceCount || regenLocked || !ttsReady"
          :title="ttsReady ? t('只重配勾选的台词（逐句覆盖，计费）') : t('配音（TTS）未配置 API')"
          @click="regenSelectedVoices"
        >{{ t("重配已选（") }}{{ selectedVoiceCount }}{{ t("）") }}</button>
      </div>
    </div>

    <div class="card mt-4 mb-0">
      <template v-if="assetTab === 'figure'">
        <div class="card-head">
          <h3>{{ t("角色立绘（三视图 → 立绘/表情/动作）") }}</h3>
        </div>
        <label class="field">
          <span>{{ t("对本区立绘的意见（可选）：") }}</span>
          <input type="text" v-model="assetFeedback.figure" :placeholder="t('如：让「林澈」眼神更锐利、制服更有质感')" />
        </label>
        <div v-for="row in figureRows" :key="row.id" class="asset-row">
          <div class="asset-row-head">
            <span class="asset-name">{{ row.name }}</span>
            <span style="color: var(--text-faint); font-size: 11px">{{ row.id }}</span>
            <span v-if="row.hasRef" class="tag ok" :title="t('已在「卡片编辑」中为该角色设置参考图，三视图/动作将基于参考图生成')">{{ t("有参考图") }}</span>
            <span class="asset-file">{{ fileExistsLabel(row.threeView) }}</span>
            <button class="btn small" :disabled="regenLocked" @click="regenThreeView(row.id)">{{ t("重新生成三视图（联动全部）") }}</button>
            <button class="btn secondary small" :disabled="regenLocked" @click="regenAllFigure(row.id)">{{ t("重新生成全部表情") }}</button>
          </div>
          <div class="asset-thumb-row">
            <div v-if="row.threeView" class="asset-thumb" :title="t('三视图（点击放大；有参考图时将基于参考图生成）')" @click="openPreview(row.threeView, `${row.name} · 三视图`)">
              <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`threeview:${row.id}`)" @change="toggleSelect(`threeview:${row.id}`)" /></label>
              <LazyThumb :path="row.threeView" :alt="t('三视图')" />
              <span class="thumb-label">{{ t("三视图") }}</span>
              <button class="btn ghost small" :disabled="regenLocked" @click.stop="reCutout('figure', `${row.id}_threeview`, row.threeView)">{{ t("抠图") }}</button>
            </div>
            <div v-for="e in row.emotions" :key="e.emo" class="asset-thumb" :class="{ missing: !e.file }" :title="`${EMOTION_LABELS[e.emo] ?? e.emo}（点击放大）`" @click="e.file && openPreview(e.file, `${row.name} · ${EMOTION_LABELS[e.emo] ?? e.emo}`)">
              <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`figure:${row.id}:${e.emo}`)" @change="toggleSelect(`figure:${row.id}:${e.emo}`)" /></label>
              <LazyThumb v-if="e.file" :path="e.file" :alt="EMOTION_LABELS[e.emo] ?? e.emo" />
              <span class="thumb-label">{{ EMOTION_LABELS[e.emo] ?? e.emo }}</span>
              <button class="btn ghost small" :disabled="regenLocked" @click.stop="regenFigureEmotion(row.id, e.emo)">{{ t("重生成") }}</button>
              <button v-if="e.file" class="btn ghost small" :disabled="regenLocked" @click.stop="reCutout('figure', e.emo === 'normal' ? row.id : `${row.id}_${e.emo}`, e.file)">{{ t("抠图") }}</button>
            </div>
          </div>
          <div v-if="row.costumes.length" style="border-top: 1px dashed var(--border); margin-top: 8px; padding-top: 8px">
            <div class="asset-thumb-row">
              <div v-for="ct in row.costumes" :key="ct.id" class="asset-thumb" :class="{ missing: !ct.file }" :title="`${ct.name}（点击放大）`" @click="ct.file && openPreview(ct.file, `${row.name} · ${ct.name}`)">
                <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`figure:${row.id}:ct_${ct.id}`)" @change="toggleSelect(`figure:${row.id}:ct_${ct.id}`)" /></label>
                <LazyThumb v-if="ct.file" :path="ct.file" :alt="ct.name" />
                <span class="thumb-label">{{ ct.name }}</span>
                <button class="btn ghost small" :disabled="regenLocked" @click.stop="regenCostume(row.id, ct.id, ct.name)">{{ t("重生成") }}</button>
                <button v-if="ct.file" class="btn ghost small" :disabled="regenLocked" @click.stop="reCutout('figure', `${row.id}_ct_${ct.id}`, ct.file)">{{ t("抠图") }}</button>
              </div>
            </div>
          </div>
          <div v-if="row.actions.length" style="border-top: 1px dashed var(--border); margin-top: 8px; padding-top: 8px">
            <div class="asset-thumb-row">
              <div v-for="a in row.actions" :key="a.id" class="asset-thumb" :class="{ missing: !a.file }" :title="`${a.name}（点击放大）`" @click="a.file && openPreview(a.file, `${row.name} · ${a.name}`)">
                <label class="asset-sel" @click.stop><input type="checkbox" :checked="selected.has(`action:${row.id}:${a.id}`)" @change="toggleSelect(`action:${row.id}:${a.id}`)" /></label>
                <LazyThumb v-if="a.file" :path="a.file" :alt="a.name" />
                <span class="thumb-label">{{ a.name }}</span>
                <button class="btn ghost small" :disabled="regenLocked" @click.stop="regenAction(row.id, a.id, a.name)">{{ t("重生成") }}</button>
                <button v-if="a.file" class="btn ghost small" :disabled="regenLocked" @click.stop="reCutout('figure', `${row.id}_act_${a.id}`, a.file)">{{ t("抠图") }}</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="assetTab === 'item'">
        <div class="card-head"><h3>{{ t("物品图") }}</h3></div>
        <label class="field">
          <span>{{ t("对本区物品图的意见（可选）：") }}</span>
          <input type="text" v-model="assetFeedback.item" :placeholder="t('如：物品要更有质感、更有光泽')" />
        </label>
        <div v-for="row in itemRows" :key="row.id" class="asset-row">
          <div class="asset-row-head">
            <span class="asset-name">{{ row.name }}</span>
            <span style="color: var(--text-faint); font-size: 11px">{{ row.id }}</span>
            <span class="asset-file">{{ fileExistsLabel(row.file) }}</span>
            <button class="btn small" :disabled="regenLocked" @click="regenItem(row.id)">{{ t("重新生成") }}</button>
          </div>
          <div class="asset-thumb-row">
            <div class="asset-thumb" :title="t('点击放大')" @click="row.file && openPreview(row.file, `${row.name} · 物品图`)">
              <LazyThumb v-if="row.file" :path="row.file" :alt="row.name" />
              <span class="thumb-label">{{ t("物品图") }}</span>
              <button v-if="row.file" class="btn ghost small" :disabled="regenLocked" @click.stop="reCutout('item', row.id, row.file)">{{ t("抠图") }}</button>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="assetTab === 'bg'">
        <div class="card-head"><h3>{{ t("背景图") }}</h3></div>
        <label class="field">
          <span>{{ t("对本区背景图的意见（可选）：") }}</span>
          <input type="text" v-model="assetFeedback.bg" :placeholder="t('如：画面更通透、更有纵深感')" />
        </label>
        <div v-for="row in bgRows" :key="row.sceneId" class="asset-row">
          <div class="asset-row-head">
            <span class="tag">{{ row.chapter }}</span>
            <span class="asset-name">{{ row.location }}</span>
            <span style="color: var(--text-faint); font-size: 11px">{{ row.sceneId }}</span>
            <span class="asset-file">{{ fileExistsLabel(row.file) }}</span>
            <button class="btn small" :disabled="regenLocked" @click="regenBg(row.sceneId)">{{ t("重新生成") }}</button>
          </div>
          <div class="asset-thumb-row">
            <div class="asset-thumb" :title="t('点击放大')" @click="row.file && openPreview(row.file, `背景 · ${row.location}`)">
              <LazyThumb v-if="row.file" :path="row.file" :alt="row.location" />
              <span class="thumb-label">{{ t("背景图") }}</span>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="assetTab === 'cg'">
        <div class="card-head"><h3>CG</h3></div>
        <label class="field">
          <span>{{ t("对本区 CG 的意见（可选）：") }}</span>
          <input type="text" v-model="assetFeedback.cg" :placeholder="t('如：构图更有冲击力、光影更戏剧化')" />
        </label>
        <div v-for="row in cgRows" :key="row.sceneId" class="asset-row">
          <div class="asset-row-head">
            <span class="tag">{{ row.chapter }}</span>
            <span class="asset-name">{{ row.title }}</span>
            <span style="color: var(--text-faint); font-size: 11px">{{ row.sceneId }}</span>
            <span class="asset-file">{{ fileExistsLabel(row.file) }}</span>
            <button class="btn small" :disabled="regenLocked" @click="regenCgRow(row.chapter, row.sceneId)">{{ t("重新生成") }}</button>
          </div>
          <div class="asset-thumb-row">
            <div class="asset-thumb" :title="t('点击放大')" @click="row.file && openPreview(row.file, `CG · ${row.title}`)">
              <LazyThumb v-if="row.file" :path="row.file" :alt="row.title" />
              <span class="thumb-label">CG</span>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="card-head">
          <h3>{{ t("配音") }}</h3>
          <div class="card-actions">
            <button class="btn primary small" :disabled="regenLocked || !ttsReady" :title="ttsReady ? t('检查全部台词：缺的补配、错配的重配，并清理孤儿文件') : t('配音（TTS）未配置 API')" @click="regenMissingVoices">
              {{ t("补全缺失/错配语音") }}
            </button>
            <button class="btn ghost small" v-for="c in voiceCharOptions" :key="c.value" @click="regenCharVoice(c.value)" :disabled="regenLocked || !ttsReady" :title="ttsReady ? '' : t('配音（TTS）未配置 API')">
              {{ t("重配「") }}{{ c.label }}{{ t("」全部") }}
            </button>
          </div>
        </div>
        <div v-if="!ttsReady" class="hint" style="margin: 0 0 10px">
          {{ t("重配配音需先在「API 配置」页配置 TTS 服务并填入 API Key；配置后可手动为任意角色/台词重新配音。") }}
        </div>
        <div class="row mb-3">
          <label class="field grow mb-0">
            <span>{{ t("章节筛选") }}</span>
            <select v-model="voiceChapterFilter">
              <option :value="0">{{ t("全部章节") }}</option>
              <option v-for="o in voiceChapterOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </label>
          <label class="field grow mb-0">
            <span>{{ t("角色筛选") }}</span>
            <select v-model="voiceCharFilter">
              <option value="">{{ t("全部角色") }}</option>
              <option v-for="c in voiceCharOptions" :key="c.value" :value="c.value">{{ c.label }}</option>
            </select>
          </label>
          <label class="opt-item mb-0" :title="t('打开后连同旁白/独白一起列出，否则单看对话会觉得剧情断裂')">
            <input type="checkbox" v-model="showNarrationVoice" />
            {{ t("显示旁白") }}
          </label>
        </div>
        <p v-if="voiceChapterMismatch" class="hint mb-3" style="color: var(--warn)">{{ voiceChapterMismatch }}</p>
        <div v-for="row in voiceRowsShown" :key="row.key" class="asset-row voice">
          <label style="display: flex; align-items: center; flex-shrink: 0" :title="t('勾选后可批量重配（只影响勾选的台词）')">
            <input type="checkbox" :checked="selectedVoice.has(row.key)" :disabled="regenLocked" @change="toggleVoiceSelected(row.key)" />
          </label>
          <div class="grow">
            <div class="flex items-center gap-2 wrap">
              <span class="tag">{{ row.chapter }}</span>
              <span style="font-weight: 600; font-size: 13px">{{ row.displayName }}</span>
              <span class="faint small">{{ row.scene }}</span>
              <span v-if="row.branch" class="faint small">{{ row.branch }}</span>
              <span class="tag" :class="row.file ? 'ok' : (row.failed ? 'err' : '')">{{ row.file ? t("已生成") : (row.failed ? t("配音失败") : t("未生成")) }}</span>
            </div>
            <div class="hint" style="word-break: break-all">{{ row.text }}</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button v-if="row.file" class="btn ghost small" @click="playVoice(row.key, row.file)">{{ playingVoiceKey === row.key ? t("⏸ 停止") : t("▶ 试听") }}</button>
            <button class="btn small" :disabled="regenLocked || !ttsReady" :title="ttsReady ? '' : t('配音（TTS）未启用或未配置 API')" @click="regenVoice(row.key)">{{ t("重配") }}</button>
          </div>
        </div>
        <div v-if="voiceRows.length > voiceLimit" style="text-align: center; margin-top: 8px">
          <button class="btn secondary small" @click="voiceLimit += 100">{{ t("显示更多（剩余") }} {{ voiceRows.length - voiceLimit }} {{ t("条）") }}</button>
        </div>
        <audio ref="audioRef" style="display: none" @ended="playingVoiceKey = ''"></audio>
        <div v-if="!voiceRows.length" class="empty">{{ t("该筛选下没有对白（或尚未生成配音）") }}</div>
      </template>
    </div>
  </template>
</div>
</template>
