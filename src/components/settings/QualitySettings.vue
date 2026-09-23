<script setup lang="ts">
import { t } from "../../i18n";
import { projectState } from "../../stores/project";

/** 全量重跑开关：开启前二次确认，避免误勾后每一次生成都全价计费；取消要还原勾选态 */
function onSkipCacheChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (
    input.checked &&
    !window.confirm(
      t("开启「跳过缓存（全量重跑）」后，之后每一次生成/重跑都会忽略缓存全量重生成（全价计费）。确定开启吗？"),
    )
  ) {
    input.checked = false;
    return;
  }
  projectState.options.skipCache = input.checked;
}

/** #1362：number 输入 min=0 拦不住手动键入的负数；负数会被下游 >0 判定吞成「不限制」/回退默认种子，与显示值不一致。
 *  change 时钳到 >=0，与下游语义（0 = 不限制/自动派生）对齐。纯函数逻辑见 tests/unit-audit-u2-budget-clamp.ts */
function clampNonNegativeInt(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function onBudgetChange(key: "cgPerChapter" | "imageBudgetPerChapter" | "videoPointsPerChapter", e: Event): void {
  const el = e.target as HTMLInputElement;
  const clamped = clampNonNegativeInt(el.value);
  projectState.options[key] = clamped;
  if (el.value.trim() !== String(clamped)) el.value = String(clamped);
}

function onSeedChange(e: Event): void {
  const el = e.target as HTMLInputElement;
  const clamped = clampNonNegativeInt(el.value);
  projectState.options.imageSeed = clamped;
  if (el.value.trim() !== String(clamped)) el.value = String(clamped);
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <h3>{{ t("输出与质量") }}</h3>
      <span class="hint">{{ t("扩展输出、画风一致性与用量上限") }}</span>
    </div>

    <div class="card-section">
      <div class="card-head">
        <h3>{{ t("扩展输出") }}</h3>
        <span class="hint">{{ t("由「预设」统一控制，这里可单独覆盖") }}</span>
      </div>
      <div class="opt-grid">
        <label class="opt-item opt-stack">
          <input type="checkbox" v-model="projectState.options.useVideoPoints" />
          <span class="opt-text">
            {{ t("视频推荐位") }}
            <span class="hint">{{ t("在剧情点插入视频推荐") }}</span>
          </span>
        </label>
        <label class="opt-item opt-stack">
          <input type="checkbox" :checked="projectState.options.useBgm !== false" @change="(e: any) => { projectState.options.useBgm = (e.target as HTMLInputElement).checked; }" />
          <span class="opt-text">
            {{ t("BGM 匹配") }}
            <span class="hint">{{ t("扫描项目 bgm 文件夹匹配场景音乐（留空/缺省按开启处理）") }}</span>
          </span>
        </label>
        <label class="opt-item opt-stack">
          <input type="checkbox" :checked="projectState.options.useSe !== false" @change="(e: any) => { projectState.options.useSe = (e.target as HTMLInputElement).checked; }" />
          <span class="opt-text">
            {{ t("环境音效（SE）") }}
            <span class="hint">{{ t("按场景氛围播放内置雨/雷/风等音效（留空/缺省按开启处理）") }}</span>
          </span>
        </label>
      </div>
    </div>

    <div class="card-section">
      <div class="card-head">
        <h3>{{ t("质量控制") }}</h3>
        <span class="hint">{{ t("画风锚点、自动自检与随机种子") }}</span>
      </div>
      <div class="opt-grid">
        <label class="opt-item opt-stack">
          <input type="checkbox" v-model="projectState.options.styleAnchor" />
          <span class="opt-text">
            {{ t("风格锚点（背景/CG 统一画风）") }}
            <span class="hint">{{ t("先生成基准图，再作为背景/CG 的参考图") }}</span>
          </span>
        </label>
        <label class="opt-item opt-stack">
          <input type="checkbox" v-model="projectState.options.imageSelfCheck" />
          <span class="opt-text">
            {{ t("图像自检（多模态核对，不合格自动重生成）") }}
            <span class="hint">{{ t("会增加费用与耗时") }}</span>
          </span>
        </label>
        <label class="opt-item opt-stack">
          <input type="checkbox" :checked="projectState.options.skipCache" @change="onSkipCacheChange" />
          <span class="opt-text">
            {{ t("跳过缓存（全量重跑）") }}
            <span class="hint">{{ t("每一次生成都全价计费") }}</span>
          </span>
        </label>
      </div>
      <div class="field-grid mt-3">
        <label class="field">
          <span>{{ t("固定种子（0 = 按标题自动派生）") }}</span>
          <input type="number" min="0" placeholder="0" :value="projectState.options.imageSeed" @change="onSeedChange" />
          <span class="hint">{{ t("同一种子下画风与角色更稳定一致") }}</span>
        </label>
      </div>
    </div>

    <div class="card-section">
      <div class="card-head">
        <h3>{{ t("预算上限") }}</h3>
        <span class="hint">{{ t("超出上限的项直接跳过") }}</span>
      </div>
      <div class="field-grid">
        <label class="field">
          <span>{{ t("每章 CG 数上限（0 = 不限制）") }}</span>
          <input type="number" min="0" placeholder="0" :value="projectState.options.cgPerChapter" @change="(e) => onBudgetChange('cgPerChapter', e)" />
          <span class="hint">{{ t("超出上限的 CG 直接跳过") }}</span>
        </label>
        <label class="field">
          <span>{{ t("每章背景数上限（0 = 不限制）") }}</span>
          <input type="number" min="0" placeholder="0" :value="projectState.options.imageBudgetPerChapter" @change="(e) => onBudgetChange('imageBudgetPerChapter', e)" />
          <span class="hint">{{ t("仅限制背景图；立绘/物品不受限，CG 用上方单独上限") }}</span>
        </label>
        <label class="field">
          <span>{{ t("每场景视频推荐点数上限（0 = 不限制）") }}</span>
          <input type="number" min="0" placeholder="0" :value="projectState.options.videoPointsPerChapter" @change="(e) => onBudgetChange('videoPointsPerChapter', e)" />
          <span class="hint">{{ t("每个场景最多保留该数量，多场景合计可能超出；0 = 不限制") }}</span>
        </label>
      </div>
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
/* 小节标题要比卡片标题低一级：缩小字号并收紧与控件的间距 */
.card-section .card-head {
  margin-bottom: var(--space-3);
}
.card-section .card-head h3 {
  font-size: 13.5px;
}
</style>
