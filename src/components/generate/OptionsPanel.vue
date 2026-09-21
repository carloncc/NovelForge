<script setup lang="ts">
import { computed } from "vue";
import { t } from "../../i18n";
import { LANGUAGES } from "../../core/types";
import { projectState } from "../../stores/project";
import { useGenerateController } from "../../stores/generate";

const { styleRecognizing, pickStyleRef, styleRefSrc, onStyleRefFile, styleRefInput, cancelStyleRecognize } =
  useGenerateController();

/** 折叠状态下也能看到关键开关，避免「看不见的配置在生效」 */
const optionsSummary = computed(() => {
  const o = projectState.options;
  const m = (label: string, on: boolean) => `${label}${on ? "✓" : "×"}`;
  return [
    m(t("图像"), o.useImage),
    m(t("配音"), o.useTts),
    m(t("视频推荐位"), o.useVideoPoints),
    m(t("BGM 匹配"), o.useBgm),
    m(t("环境音效（SE）"), !!o.useSe),
    `${t("旁白")}${o.compressNarration ? t("精简") : t("忠实")}`,
  ].join(" · ");
});

/** 全量重跑开关：开启前二次确认，避免误勾后每一次生成都全价计费 */
function onSkipCacheChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.checked && !window.confirm(t("开启「跳过缓存（全量重跑）」后，之后每一次生成/重跑都会忽略缓存全量重生成（全价计费）。确定开启吗？"))) {
    input.checked = false;
    return;
  }
  projectState.options.skipCache = input.checked;
}
</script>

<template>
  <details class="card" open>
    <summary class="card-head">
      <h3>{{ t("生成内容") }}</h3>
      <span class="hint" style="margin-left: 10px">{{ optionsSummary }}</span>
    </summary>

    <!-- 一级只留「要不要生成什么」5 个总开关；立绘细节这类微调收进高级设置 -->
    <div class="opt-grid">
      <label class="opt-item">
        <input type="checkbox" v-model="projectState.options.useImage" /> {{ t("图像（立绘/背景/CG/物品）") }}
      </label>
      <label class="opt-item">
        <input type="checkbox" v-model="projectState.options.useTts" /> {{ t("配音（TTS）") }}
      </label>
      <label class="opt-item">
        <input type="checkbox" v-model="projectState.options.useVideoPoints" /> {{ t("视频推荐位") }}
      </label>
      <label class="opt-item" :title="t('扫描项目 bgm 文件夹匹配场景 BGM；需要背景音乐时保持开启（无 BGM 文件时不会输出音乐）')">
        <input type="checkbox" v-model="projectState.options.useBgm" /> {{ t("BGM 匹配") }}
      </label>
      <label class="opt-item" :title="t('按场景氛围播放雨/雷/风等内置音效；需要环境音时保持开启')">
        <input type="checkbox" v-model="projectState.options.useSe" /> {{ t("环境音效（SE）") }}
      </label>
    </div>

    <div class="card-section">
      <div class="field-grid">
        <label class="field">
          <span>{{ t("目标语言（先把小说翻译成该语言再生成，留空 = 用原文）") }}</span>
          <select v-model="projectState.options.language">
            <option value="">{{ t("不翻译（使用原文）") }}</option>
            <option v-for="l in LANGUAGES" :key="l.code" :value="l.code">{{ l.label }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ t("统一画风（留空用默认画风，所有立绘/背景/CG 保持一致）") }}</span>
          <input
            type="text"
            v-model="projectState.options.imageStyle"
            :placeholder="t('例：unified Japanese anime style, cel shading, clean line art')"
          />
        </label>
        <label class="field">
          <span>{{ t("剧本风格（留空不调整。例：古风典雅 / 幽默风趣 / 冷峻克制）") }}</span>
          <input type="text" v-model="projectState.options.scriptStyle" :placeholder="t('例：古风典雅，多用对仗与典雅意象')" />
        </label>
        <div class="field" :title="t('关闭（默认）＝忠实保留原文全部旁白/心理/环境描写（推荐，成品更接近原著）；开启＝精简提炼旁白，剧本更短、生成更快。开关会隔离剧本缓存，切换后需重新生成剧本')">
          <span>{{ t("旁白处理") }}</span>
          <label class="opt-item">
            <input type="checkbox" v-model="projectState.options.compressNarration" />
            {{ t("压缩旁白（更短更快，会精简原文描写）") }}
          </label>
        </div>
      </div>
      <div class="field-grid mt-3">
        <label class="field">
          <span>{{ t("风格参考图（上传图片 → AI 识别画风并自动填入上方）") }}</span>
          <div class="row">
            <button class="btn secondary small" :disabled="styleRecognizing" @click="pickStyleRef">
              <span v-if="styleRecognizing" class="spinner" />
              {{ styleRecognizing ? t("AI 识别中…") : styleRefSrc ? t("更换图片并重新识别") : t("上传图片，AI 识别画风") }}
            </button>
            <button v-if="styleRecognizing" class="btn ghost small" @click="cancelStyleRecognize">{{ t("取消") }}</button>
            <span v-if="styleRefSrc" class="tag ok">{{ t("已识别") }}</span>
            <button v-if="styleRefSrc" class="btn ghost small" @click="styleRefSrc = ''">{{ t("清除") }}</button>
            <input ref="styleRefInput" type="file" accept="image/*" style="display: none" @change="onStyleRefFile" />
          </div>
        </label>
        <div v-if="styleRefSrc" class="field" style="justify-self: start">
          <span>&nbsp;</span>
          <img
            :src="styleRefSrc"
            :alt="t('风格参考图')"
            style="width: 72px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid var(--border)"
          />
        </div>
      </div>
    </div>

    <details class="adv">
      <summary>{{ t("高级设置") }}</summary>
      <div class="opt-grid">
        <label class="opt-item" :title="t('关闭则每角色只生成默认表情')">
          <input type="checkbox" v-model="projectState.options.figureEmotions" /> {{ t("表情差分") }}
        </label>
        <label class="opt-item" :title="t('核心档：标准5表情、无服装差分，省图省钱；完整档：AI全量表情＋服装＋动作')">
          <span>{{ t("人物图详细度") }}</span>
          <select v-model="projectState.options.figureDetail">
            <option value="full">{{ t("完整（默认）") }}</option>
            <option value="core">{{ t("核心（省图）") }}</option>
          </select>
        </label>
        <label class="opt-item">
          <input type="checkbox" v-model="projectState.options.figureActions" /> {{ t("人物动作（入场/情绪动作/镜头震动）") }}
        </label>
        <label class="opt-item" :title="t('图生图，形象更一致')">
          <input type="checkbox" v-model="projectState.options.characterPoses" /> {{ t("角色三视图与动作立绘") }}
        </label>
        <label class="opt-item">
          <input type="checkbox" v-model="projectState.options.characterIntroCard" /> {{ t("角色登场资料卡") }}
        </label>
        <label class="opt-item" :title="t('先生成一张全项目画风基准图，背景/CG 以其为参考图，强制所有图片画风统一（推荐开启）')">
          <input type="checkbox" v-model="projectState.options.styleAnchor" /> {{ t("风格锚点（背景/CG 统一画风）") }}
        </label>
        <label class="opt-item" :title="t('使用独立图片识别 API 核对生成图，不合格自动重生成 1 次（会增加费用与耗时）')">
          <input type="checkbox" v-model="projectState.options.imageSelfCheck" /> {{ t("图像自检（多模态核对，不合格自动重生成）") }}
        </label>
        <label class="opt-item" :title="t('开启后所有生成/重跑都会忽略缓存全量重生成（全价计费）；开启时会二次确认')">
          <input type="checkbox" :checked="projectState.options.skipCache" @change="onSkipCacheChange" /> {{ t("跳过缓存（全量重跑）") }}
        </label>
      </div>
      <div class="field-grid">
        <label class="field">
          <span>{{ t("每章 CG 数上限") }}（0 = {{ t("不限制") }}）</span>
          <input type="number" v-model.number="projectState.options.cgPerChapter" min="0" placeholder="0" />
        </label>
        <label class="field">
          <span>{{ t("每章图像数上限") }}（0 = {{ t("不限制") }}）</span>
          <input type="number" v-model.number="projectState.options.imageBudgetPerChapter" min="0" placeholder="0" />
        </label>
        <label class="field">
          <span>{{ t("视频推荐点数上限") }}（0 = {{ t("不限制") }}）</span>
          <input type="number" v-model.number="projectState.options.videoPointsPerChapter" min="0" placeholder="0" />
        </label>
        <label class="field" :title="t('固定所有图片生成的随机种子：同一种子下背景/CG/立绘的画风与角色更稳定一致。0 = 按小说标题自动派生')">
          <span>{{ t("固定种子（0 = 按标题自动派生）") }}</span>
          <input type="number" v-model.number="projectState.options.imageSeed" min="0" />
        </label>
      </div>
    </details>
  </details>
</template>
