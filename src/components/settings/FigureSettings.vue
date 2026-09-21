<script setup lang="ts">
import { t } from "../../i18n";
import { projectState } from "../../stores/project";
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("立绘") }}</h3>
      <span class="hint">{{ t("控制人物图的精细度与演出范围") }}</span>
    </div>

    <div class="opt-grid">
      <label class="opt-item opt-stack">
        <input type="checkbox" v-model="projectState.options.figureEmotions" />
        <span class="opt-text">
          {{ t("表情差分") }}
          <span class="hint">{{ t("关闭则每角色只生成默认表情") }}</span>
        </span>
      </label>
      <label class="opt-item opt-stack opt-col">
        <span class="opt-text">{{ t("人物图详细度") }}</span>
        <select v-model="projectState.options.figureDetail">
          <option value="full">{{ t("完整（默认）") }}</option>
          <option value="core">{{ t("核心（省图）") }}</option>
        </select>
        <span class="hint">{{ t("核心＝少图省钱；完整＝AI 全量表情＋服装＋动作") }}</span>
      </label>
      <label class="opt-item opt-stack">
        <input type="checkbox" v-model="projectState.options.figureActions" />
        <span class="opt-text">
          {{ t("人物动作（入场/情绪动作/镜头震动）") }}
          <span class="hint">{{ t("关闭后人物只做静态演出") }}</span>
        </span>
      </label>
      <label class="opt-item opt-stack">
        <input type="checkbox" v-model="projectState.options.characterPoses" />
        <span class="opt-text">
          {{ t("角色三视图与动作立绘") }}
          <span class="hint">{{ t("图生图，形象更一致") }}</span>
        </span>
      </label>
      <label class="opt-item opt-stack">
        <input type="checkbox" v-model="projectState.options.characterIntroCard" />
        <span class="opt-text">
          {{ t("角色登场资料卡") }}
          <span class="hint">{{ t("首次登场时弹出角色简介") }}</span>
        </span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.opt-stack {
  align-items: flex-start;
}
.opt-stack input[type="checkbox"] {
  margin-top: 2px;
}
.opt-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* 下拉类选项：标题在上、控件在下，与数值字段观感一致 */
.opt-col {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}
</style>
