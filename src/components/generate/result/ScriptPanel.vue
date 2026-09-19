<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../../i18n";
import { projectState } from "../../../stores/project";
import { tauri } from "../../../utils/tauri";
import { SCRIPT_MIN_KEPT_RATIO } from "../../../core/script";
import { useGenerateController } from "../../../stores/generate";

// 结果区子面板：状态全部来自 generate store。
const {
  tab,
  busy,
  queueRunning,
  scriptFiles,
  currentScript,
  scriptChapterFeedback,
  chapterForce,
  assetBusy,
  regenChapter,
  verifyReports,
  showTrivialVerify,
  verifyBusy,
  verifyReasonLabel,
  visibleVerifyIssues,
  trivialVerifyCount,
  charNameOfId,
  acceptVerifySpeaker,
  deleteVerifyLine,
  ignoreVerifyIssue,
} = useGenerateController();

/** 只列启用章节：停用章不参与生成，列出来点了也只会报"已停用" */
const enabledChapters = computed(() => projectState.novel?.chapters.filter((c) => c.enabled !== false) ?? []);

/** 章节显示名：标题已带「第X章」前缀时不再重复拼接 */
function chapterLabel(rep: { chapterIndex: number; title: string }): string {
  const base = (rep.title ?? "").trim() || t("未命名");
  return /^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回节]/.test(base)
    ? base
    : `${t("第")}${rep.chapterIndex + 1}${t("章")} ${base}`;
}
/** 逐章重写/核对操作锁：管线/队列/素材任务任一在跑时都禁用（runChapterFullRegen 的 fromQueue
 *  会绕过队列检查，队列间隙点击会插进第二条链） */
const regenLocked = computed(() => busy.value || queueRunning.value || !!assetBusy.value);

/** 清空意见：会影响所有章节（包含当前不可见章节）的意见与全量勾选，执行前确认 */
function clearScriptOpinions(): void {
  const feedbackCount = Object.values(scriptChapterFeedback.value).filter((v) => (v ?? "").trim()).length;
  const forceCount = Object.values(chapterForce.value).filter(Boolean).length;
  if (feedbackCount || forceCount) {
    if (!window.confirm(`将清空全部章节的${feedbackCount ? `意见（${feedbackCount} 章已填）` : ""}${feedbackCount && forceCount ? "与" : ""}${forceCount ? `「全量」勾选（${forceCount} 章）` : ""}（包含当前不可见的章节）。继续吗？`)) return;
  }
  scriptChapterFeedback.value = {};
  chapterForce.value = {};
}
</script>

<template>
<div v-if="tab === 'script'">
  <div class="card">
    <div class="card-head">
      <h3>{{ t("分章剧本（按意见重写）") }}</h3>
      <div class="card-actions">
        <button class="btn ghost small" @click="clearScriptOpinions">{{ t("清空意见") }}</button>
      </div>
    </div>
      <p class="hint mb-3">{{ t("选择章节 → 填写意见（填了才按意见重写）或勾全量（直接重写）→ 点击「重新生成此章」。都不选=只补缺失。其余章节自动复用缓存。") }}</p>
    <div v-for="ch in enabledChapters" :key="ch.index" class="stage-row mb-2">
      <!-- min-width:0 + text-ellipsis：长章节标题此前会把整行撑破；title 保留全文可悬浮查看 -->
      <div class="stage-row-label" style="min-width: 0">
        <b class="text-ellipsis" :title="ch.title">{{ ch.title }}</b>
      </div>
      <input type="text" v-model="scriptChapterFeedback[ch.index]" :placeholder="t('意见（可选）：这一章节奏太慢，希望更快推进…')" />
      <label class="opt-item mb-0" :title="t('勾选后该章跳过缓存直接重写，不需要填意见')">
        <input type="checkbox" v-model="chapterForce[ch.index]" :disabled="regenLocked" />
        {{ t("全量") }}
      </label>
      <button class="btn small" :disabled="regenLocked" :title="t('无意见且未勾全量=只补缺失')" @click="regenChapter(ch.index)">{{ t("重新生成此章") }}</button>
    </div>
  </div>
  <div class="card" v-if="verifyReports.length">
    <div class="card-head">
      <h3>{{ t("保真核对（剧本 vs 原文）") }}</h3>
      <div class="card-actions">
        <label class="opt-item mb-0" :title="t('短句乱序多为误报，默认折叠')">
          <input type="checkbox" v-model="showTrivialVerify" />
          {{ t("显示短句乱序") }}
        </label>
      </div>
    </div>
    <p class="hint mb-3">{{ t("只改你确认的问题：说话人错→接受建议（免费改缓存）；多余的句→删除；误报→忽略。改完重跑「组装」刷新预览，配音在素材页补配。覆盖率低于 {pct}% 的章节管线已自动重写过一次。", { pct: Math.round(SCRIPT_MIN_KEPT_RATIO * 100) }) }}</p>
    <div v-for="rep in verifyReports" :key="rep.chapterIndex" class="mb-3">
      <div class="stage-row-label" style="margin-bottom: 6px">
        <b>{{ chapterLabel(rep) }}</b>
        <span class="tag" :class="rep.keptRatio >= SCRIPT_MIN_KEPT_RATIO ? 'ok' : 'warn'">{{ t("覆盖率") }}{{ Math.round(rep.keptRatio * 100) }}%（{{ rep.dialogueCount }}/{{ rep.originalQuoteCount }}）</span>
        <span v-if="visibleVerifyIssues(rep).length" class="tag err">{{ t("存疑") }}{{ visibleVerifyIssues(rep).length }}</span>
        <span v-else class="tag ok">{{ t("无存疑") }}</span>
        <span v-if="trivialVerifyCount(rep) && !showTrivialVerify" class="hint">{{ t("另有") }}{{ trivialVerifyCount(rep) }}{{ t("条短句乱序已折叠") }}</span>
      </div>
      <div v-for="iss in visibleVerifyIssues(rep)" :key="iss.key" class="asset-row">
        <div class="asset-row-head">
          <span class="tag" :class="iss.reason === 'context-mismatch' || iss.reason === 'third-person-self' ? 'err' : ''">{{ verifyReasonLabel(iss.reason) }}</span>
          <span style="color: var(--text-faint); font-size: 11px">{{ t("场景") }}{{ iss.sceneIndex + 1 }}#{{ iss.lineIndex + 1 }}</span>
          <span class="asset-name">「{{ iss.text }}」</span>
        </div>
        <p style="font-size: 12px; color: var(--text-dim); margin: 2px 0 6px">{{ iss.detail }}<template v-if="iss.suggestedSpeakerName"> → {{ t("建议") }}「{{ iss.suggestedSpeakerName }}」</template></p>
        <div class="row" style="gap: 6px">
          <button
            v-if="iss.reason === 'context-mismatch' && iss.suggestedSpeakerId"
            class="btn primary small"
            :disabled="!!verifyBusy || regenLocked"
            @click="acceptVerifySpeaker(rep, iss)"
          >{{ verifyBusy === iss.key ? t("处理中…") : `${t("接受：改成")}「${charNameOfId(iss.suggestedSpeakerId)}」` }}</button>
          <button
            v-if="iss.reason === 'not-in-source' || iss.reason === 'order-suspect'"
            class="btn small"
            :disabled="!!verifyBusy || regenLocked"
            @click="deleteVerifyLine(rep, iss)"
          >{{ t("删除该句") }}</button>
          <button class="btn ghost small" :disabled="!!verifyBusy || regenLocked" @click="ignoreVerifyIssue(rep, iss)">{{ t("忽略") }}</button>
        </div>
      </div>
    </div>
  </div>
  <div class="card" v-if="scriptFiles.length">
    <div class="row" style="justify-content: space-between">
      <select v-model="currentScript" style="flex: 1; max-width: 260px">
        <option v-for="f in scriptFiles" :key="f.name" :value="f.name">{{ f.name }}</option>
      </select>
      <button class="btn secondary small" @click="tauri.openInExplorer(projectState.outputDir + '/game/scene')">{{ t("打开剧本文件夹") }}</button>
    </div>
    <pre style="background: #fbf9ff; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; margin-top: 10px; max-height: 420px; overflow: auto; font-size: 12px; line-height: 1.7; white-space: pre-wrap">{{ scriptFiles.find((f) => f.name === currentScript)?.text }}</pre>
  </div>
  <div v-else class="empty">
    <img src="/src/assets/empty-generate.png" alt="" style="width: 220px; opacity: 0.9; margin-bottom: 12px" />
    <p>{{ t("暂无剧本文件（生成后出现）") }}</p>
  </div>
</div>
</template>
