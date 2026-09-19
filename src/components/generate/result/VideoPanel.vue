<script setup lang="ts">
import { t } from "../../../i18n";
import { isTauri } from "../../../utils/tauri";
import { sanitizeId } from "../../../core/render";
import { useGenerateController } from "../../../stores/generate";

// 结果区子面板：状态全部来自 generate store。
const {
  tab,
  busy,
  videoInput,
  videoPoints,
  queueRunning,
  assetBusy,
  runMode,
  checkVideos,
  importVideo,
  onVideoImportFile,
  copyText,
} = useGenerateController();

/** 视频推荐位由「剧本」阶段生成：此前本页没有任何重生成入口，用户找不到路径。
 * 这里引导到单阶段重跑并说明缓存语义（默认复用缓存，需覆盖要勾全量/填意见）。 */
function gotoScriptRegen(): void {
  if (busy.value || assetBusy.value || queueRunning.value) return;
  if (!window.confirm(t("视频推荐位是「剧本」阶段的一部分：重新生成需要重跑剧本阶段（有 LLM 时计费）。\n\n注意：已缓存章节默认复用缓存、不会覆盖推荐位；如需强制重生成，请在「剧本」行勾选「全量」或填写意见后再点「重新生成」。\n\n现在切到「单阶段重跑」吗？"))) return;
  runMode.value = "stage";
}
</script>

<template>
<div v-if="tab === 'video' || tab === 'asset'">
  <div class="card" v-if="videoPoints.length">
    <div class="card-head">
      <h3>{{ t("AI 推荐的视频演出位（{n} 个）", { n: videoPoints.length }) }}</h3>
      <div class="card-actions"><button class="btn secondary small" @click="checkVideos">{{ t("刷新状态") }}</button><button class="btn ghost small" :disabled="busy || !!assetBusy || queueRunning" :title="t('视频推荐位随剧本阶段生成：这里引导到单阶段重跑（默认复用缓存，需覆盖请勾全量）')" @click="gotoScriptRegen">{{ t("重新生成推荐位…") }}</button></div>
    </div>
    <p class="hint mb-4">{{ t("提示词粘贴到即梦/可灵生成 mp4，用「导入视频」或手动放入") }} <code>game/video/video_&lt;id&gt;.mp4</code> {{ t("，刷新后自动启用，零 API 费用。") }}</p>
    <div v-for="vp in videoPoints" :key="vp.id" style="border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; margin-bottom: 10px">
      <div class="row" style="justify-content: space-between">
        <span>
          <span class="tag" :class="vp.enabled ? 'ok' : ''">{{ vp.enabled ? t("已启用") : t("未生成") }}</span>
          <span style="font-weight: 600">{{ vp.title }}</span>
          <span style="color: var(--text-dim); font-size: 12px; margin-left: 8px">{{ t("第") }} {{ vp.chapter }} {{ t("章") }} · {{ vp.location }} · {{ vp.durationSecs }}s</span>
        </span>
        <div style="display: flex; gap: 8px">
          <button class="btn small" @click="copyText(vp.videoPrompt, t('视频提示词'))">{{ t("复制提示词") }}</button>
          <button class="btn small" :disabled="busy || !!assetBusy || queueRunning" @click="importVideo(vp)">{{ t("导入视频") }}</button>
        </div>
      </div>
      <p style="color: var(--text-dim); font-size: 12px; margin-top: 6px">{{ vp.description }}</p>
      <p style="font-size: 12px; margin-top: 6px; color: var(--text-dim)">{{ t("文件名：") }}<code>video_{{ sanitizeId(vp.id) }}.mp4</code></p>
    </div>
    <input v-if="!isTauri()" ref="videoInput" type="file" accept="video/*" style="display: none" @change="onVideoImportFile" />
  </div>
  <div v-else class="empty">
    <img src="/src/assets/empty-generate.png" alt="" style="width: 220px; opacity: 0.9; margin-bottom: 12px" />
    <p>{{ t("暂无视频推荐位（重新生成后出现）") }}</p>
    <button class="btn secondary small mt-3" :disabled="busy || !!assetBusy || queueRunning" @click="gotoScriptRegen">{{ t("重新生成推荐位…") }}</button>
  </div>
</div>
</template>
