<script setup lang="ts">
import { t } from "../../i18n";
import StageStatusBoard from "../StageStatusBoard.vue";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const { busy, stageStatus, failedCounts, stageFeedback, stageForce, runStageRegen, goFullMode, imagePlanText } =
  useGenerateController();
</script>

<template>
    <div v-if="projectState.lastResult" class="card">
      <div class="card-head">
        <h3>{{ t("分阶段状态") }}</h3>
        <div class="card-actions">
          <span v-if="!busy" class="hint">{{ t("失败阶段重试将只补失败项") }}</span>
        </div>
      </div>
      <StageStatusBoard
        :statuses="stageStatus.stageStatus.value"
        :failed-counts="failedCounts"
        :feedback="stageFeedback"
        :force="stageForce"
        :busy="busy"
        @regen="runStageRegen"
      />

      <div class="opt-grid mt-4">
        <label class="opt-item" :title="t('关闭后恢复旧的严格单阶段：重新生成只跑该阶段，下游需手动依次重跑')">
          <input type="checkbox" v-model="projectState.options.autoCascadeDownstream" :disabled="busy" /> {{ t("跑完自动补齐下游") }}
        </label>
        <span class="opt-item" :title="t('图像开关在「生成内容」里设置，此处只显示当前状态')">
          <span>{{ t("下游图像") }}：</span>
          <span class="tag" :class="projectState.options.useImage ? 'ok' : 'warn'">{{ projectState.options.useImage ? t("已开启") : t("已关闭") }}</span>
          <span class="faint small">{{ t("（在「生成内容」中修改）") }}</span>
        </span>
        <span class="opt-item" :title="t('配音开关在「生成内容」里设置，此处只显示当前状态')">
          <span>{{ t("下游配音") }}：</span>
          <span class="tag" :class="projectState.options.useTts ? 'ok' : 'warn'">{{ projectState.options.useTts ? t("已开启") : t("已关闭") }}</span>
          <span class="faint small">{{ t("（在「生成内容」中修改）") }}</span>
        </span>
        <span class="opt-item" :title="t('组装是本地操作、不计费；但游戏文件里写死了剧本正文与图片/配音路径，动过剧本或资产就必须重新组装，预览才会更新')">
          <span>{{ t("组装为本地操作（不计费）：关闭「跑完自动补齐下游」后，需手动点「组装」刷新预览") }}</span>
        </span>
      </div>

      <p class="hint mt-2"><strong>{{ t("图片统计：") }}</strong>{{ imagePlanText }}</p>

      <details class="mt-3">
        <summary class="hint" style="cursor: pointer">{{ t("说明：重跑口径与计费") }}</summary>
        <p class="hint mt-2">
          {{ t("无意见且未勾全量＝只补缺失/失败项，不计费；填意见或勾全量＝全量重跑，计费；分章除外（点击即全书重分）。") }}<br />
          {{ t("单条立绘 / 单句配音的重生成请在下方「素材」页操作。") }}<br />
          {{ t("「重新生成」先只跑该阶段；跑完若下游还有内容没生成（图像/配音），会自动算好规模、确认一次后连续补齐，并重新组装刷新预览（复用缓存只补缺失，组装免费）。分章/翻译/提取属文本上游，仍只跑该阶段。需一次跑通多阶段请切到「整书生成」勾选阶段后开始。") }}
        </p>
      </details>
    </div>
    <div v-else class="card empty-next">
      <p class="hint">{{ t("还没有生成结果：先跑一次整书生成，再回来单独重跑某个阶段。") }}</p>
      <button class="btn small" @click="goFullMode">{{ t("去整书生成") }}</button>
    </div>
</template>
